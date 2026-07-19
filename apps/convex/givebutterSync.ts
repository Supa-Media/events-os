/**
 * Givebutter live ticket sync (PR B) — poll-only v1.
 *
 * Public Worship sells some events on Givebutter (a campaign per event). This
 * module pulls a campaign's tickets into NATIVE mirror rows so the app's
 * attendance surfaces — the door scanner, the guest list, the tickets/revenue
 * rollups on `eventPages` — work for Givebutter buyers exactly as they do for
 * native Stripe buyers. Two entry points: a manual "Sync now" button
 * (`requestGivebutterSync`) and a 15-minute cron (`syncAllGivebutterCampaigns`).
 *
 * DESIGN (mirrors `increase.ts`): the network fetch lives in an ACTION; the DB
 * apply is a pure `internalMutation` (`applyGivebutterTickets`) so the mapping is
 * testable WITHOUT hitting Givebutter. Every function DEGRADES to a logged no-op
 * (never throws) when no API key is configured — same pattern as Increase. The
 * key is resolved via `resolveGivebutterApiKey` (PR E): the in-app superuser
 * setting (`integrationSettings.readGivebutterApiKey`) takes precedence, else
 * the `GIVEBUTTER_API_KEY` deployment env var, else the no-op degrade.
 * There is NO webhook (Givebutter has no ticket/refund webhooks) — this is a
 * pull. The manual button has NO date gate, so pointing an old campaign id at a
 * past event simply backfills it; the cron alone stops polling dead campaigns.
 *
 * ── MONEY INVARIANT ──────────────────────────────────────────────────────────
 * A synced Givebutter order is DISPLAY ATTRIBUTION ONLY. It touches EXACTLY three
 * things: `eventPages` rollups (`ticketsSoldCount` / `revenueCents` / RSVP
 * status counters), `ticketTypes.soldCount`, and `rsvps`. It NEVER writes to
 * `transactions`, `gifts`, `donations`, `donors`, or `people` — Givebutter is
 * the system of record for that money; double-booking it into the ledger would
 * corrupt every budget/reconcile total. Synced orders carry NO Stripe fields;
 * they are marked `externalProvider:"givebutter"` + `externalRef` instead.
 *
 * ── REFUNDS (v1 limitation) ──────────────────────────────────────────────────
 * Givebutter exposes NO refund webhook or refund flag on the ticket object, so a
 * refunded/voided ticket is NOT reflected here: the mirror order stays `paid` and
 * the rollups stay counted. This is a documented v1 gap. The forward-compat fix
 * is a full-list RECONCILIATION pass — re-list the campaign's tickets, diff
 * against our `by_external_ref` mirror rows, and void/refund the orders whose
 * Givebutter ticket has disappeared or gone refunded — but that requires a
 * reliable "this ticket was refunded" signal Givebutter does not expose today.
 * See the stub note on `applyGivebutterTickets`.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { requireEvent } from "./lib/context";
import { newGuestToken, newTicketCode } from "./ticketing";
import { RSVP_STATUSES } from "./schema/ticketing";

/** Givebutter API base. `Authorization: Bearer <GIVEBUTTER_API_KEY>`. */
const GIVEBUTTER_API_BASE = "https://api.givebutter.com/v1";

/** Hard cap on pages followed in one sync run (Laravel pagination). A campaign
 *  with more tickets than this can be re-synced to continue (dedup is total). */
const GIVEBUTTER_MAX_PAGES = 50;

/** Manual-sync throttle: ignore a re-request within this window of the last one
 *  (guards a double-tap / impatient operator from stacking redundant syncs). */
const SYNC_THROTTLE_MS = 60_000;

/** The cron stops polling a campaign once its event ended more than this ago.
 *  The manual button still works forever (no date gate). */
const CRON_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Trim + lowercase for name matching (mirror-type dedup by ticket-type name). */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The normalized shape of ONE Givebutter ticket the action hands to the apply
 * mutation. All money is integer cents; all timestamps are ms. The raw
 * Givebutter object (dollars, ISO strings, first/last name) is normalized in the
 * action so the mutation is pure DB.
 */
const gbTicketValidator = v.object({
  // The Givebutter ticket id, stringified. The dedup identity: the order's
  // `externalRef` is `gb:ticket:<externalId>`.
  externalId: v.string(),
  // Ticket-type name (`title`) — the mirror `ticketTypes` row is keyed on it.
  ticketTypeName: v.string(),
  attendeeName: v.string(),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  priceCents: v.number(),
  checkedInAt: v.union(v.number(), v.null()),
  createdAt: v.number(),
});

type GbTicket = {
  externalId: string;
  ticketTypeName: string;
  attendeeName: string;
  email: string | null;
  phone: string | null;
  priceCents: number;
  checkedInAt: number | null;
  createdAt: number;
};

// ── Config reads (internalQuery) ─────────────────────────────────────────────

/** Read a page's sync config (campaign id) by event. Null when there's no page
 *  or no campaign id wired up — the action then no-ops. */
export const getSyncConfig = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.union(
    v.object({ campaignId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { eventId }) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page || !page.givebutterCampaignId) return null;
    return { campaignId: page.givebutterCampaignId };
  },
});

/**
 * List every event whose page has a Givebutter campaign id AND whose event
 * hasn't ended more than 7 days ago — the cron's work list. Bounded read
 * (`.take(500)`); the date gate is what stops the cron from polling dead
 * campaigns forever (the manual button ignores it). "End" is the page's
 * `endDate` when set, else the event's start (`eventDate`).
 */
export const listActiveGivebutterPages = internalQuery({
  args: {},
  returns: v.array(v.object({ eventId: v.id("events") })),
  handler: async (ctx) => {
    const pages = await ctx.db.query("eventPages").take(500);
    const now = Date.now();
    const out: Array<{ eventId: Id<"events"> }> = [];
    for (const page of pages) {
      if (!page.givebutterCampaignId) continue;
      const event = await ctx.db.get(page.eventId);
      if (!event) continue;
      const endRef = page.endDate ?? event.eventDate;
      if (now - endRef > CRON_STALE_AFTER_MS) continue;
      out.push({ eventId: page.eventId });
    }
    return out;
  },
});

// ── Sync bookkeeping (internalMutation) ──────────────────────────────────────

/** Stamp `givebutterLastSyncedAt` + record/clear `givebutterLastSyncError` after
 *  a run. `error: null` clears the field on success (null-sentinel). No-op when
 *  the page vanished. */
export const finishGivebutterSync = internalMutation({
  args: {
    eventId: v.id("events"),
    error: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { eventId, error }) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) return null;
    await ctx.db.patch(page._id, {
      givebutterLastSyncedAt: Date.now(),
      givebutterLastSyncError: error ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── Apply (pure DB, the testable core) ───────────────────────────────────────

/**
 * Apply one API page of normalized Givebutter tickets to the native tables.
 * IDEMPOTENT: dedups on `ticketOrders.by_external_ref` (`gb:ticket:<id>`). Page
 * counters are accumulated across the batch and written in a SINGLE `eventPages`
 * patch at the end (never per-ticket).
 *
 * Per ticket:
 *  1. EXISTING order (by external ref) → CHECK-IN RECONCILIATION ONLY: if
 *     Givebutter now reports a check-in and the native ticket is still `valid`,
 *     flip it to `checked_in` (+ timestamp). Never reverses a check-in. No
 *     counter/money changes. (This is also the seam a future REFUND
 *     reconciliation pass would hook into — see the file-header note — but v1
 *     has no refund signal from Givebutter, so a refunded ticket stays `paid`.)
 *  2. NEW → find-or-create the MIRROR `ticketTypes` row (matched by
 *     `externalProvider:"givebutter"` + normalized name; `isActive:false`).
 *  3. RSVP: match-or-create by email (email-less → see the branch below).
 *  4. Insert the mirror `ticketOrders` row (`paid`, no Stripe fields).
 *  5. Insert the `tickets` row with a REAL native code (door scanner works).
 *  6. Accumulate soldCount / rollup / RSVP-counter deltas.
 *  7. NEVER schedule any email.
 */
export const applyGivebutterTickets = internalMutation({
  args: {
    eventId: v.id("events"),
    tickets: v.array(gbTicketValidator),
  },
  returns: v.object({
    inserted: v.number(),
    reconciled: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, { eventId, tickets }) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) return { inserted: 0, reconciled: 0, skipped: tickets.length };
    const chapterId = page.chapterId;

    // Accumulators for ONE page patch at the end.
    let ticketsSoldDelta = 0;
    let revenueCentsDelta = 0;
    const rsvpCounterDelta: Record<(typeof RSVP_STATUSES)[number], number> = {
      going: 0,
      maybe: 0,
      not_going: 0,
    };
    // Mirror-type soldCount deltas (a page can hold several tickets of one type,
    // and a freshly-created mirror type too) → one patch per type at the end.
    const soldDelta = new Map<Id<"ticketTypes">, number>();

    let inserted = 0;
    let reconciled = 0;
    let skipped = 0;

    for (const t of tickets) {
      const externalRef = `gb:ticket:${t.externalId}`;
      // Defensive re-normalize (the action normalizes too): lowercase/trim is
      // the dedup key for `by_event_email` and what we persist, so an
      // un-normalized email can never mint a duplicate RSVP.
      const email = normalizeEmail(t.email);

      // 1. Dedup — existing order → check-in reconciliation only.
      const existingOrder = await ctx.db
        .query("ticketOrders")
        .withIndex("by_external_ref", (q) => q.eq("externalRef", externalRef))
        .unique();
      if (existingOrder) {
        if (t.checkedInAt !== null) {
          const nativeTicket = await ctx.db
            .query("tickets")
            .withIndex("by_order", (q) => q.eq("orderId", existingOrder._id))
            .first();
          if (nativeTicket && nativeTicket.status === "valid") {
            await ctx.db.patch(nativeTicket._id, {
              status: "checked_in",
              checkedInAt: t.checkedInAt,
            });
            reconciled += 1;
          }
        }
        continue;
      }

      // 2. Mirror ticket type — match-or-create.
      const siblings = await ctx.db
        .query("ticketTypes")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .take(100);
      const wantName = normalizeName(t.ticketTypeName);
      let mirror = siblings.find(
        (tt) =>
          tt.externalProvider === "givebutter" &&
          normalizeName(tt.name) === wantName,
      );
      let mirrorTypeId: Id<"ticketTypes">;
      if (mirror) {
        mirrorTypeId = mirror._id;
      } else {
        const now = Date.now();
        mirrorTypeId = await ctx.db.insert("ticketTypes", {
          eventId,
          chapterId,
          name: t.ticketTypeName,
          priceCents: t.priceCents,
          currency: "usd",
          soldCount: 0,
          sortOrder: siblings.length,
          // A mirror type is NEVER natively sellable — it only anchors synced
          // tickets so the scanner + rollups work for Givebutter buyers.
          isActive: false,
          externalProvider: "givebutter",
          createdAt: now,
          updatedAt: now,
        });
      }

      // 3. RSVP — match-or-create by email.
      const now = Date.now();
      let rsvpId: Id<"rsvps"> | undefined;
      if (email) {
        const existingRsvp = await ctx.db
          .query("rsvps")
          .withIndex("by_event_email", (q) =>
            q.eq("eventId", eventId).eq("email", email),
          )
          .first();
        if (existingRsvp) {
          rsvpId = existingRsvp._id;
          // Upgrade to going/ticket (a purchase proves attendance) without a
          // duplicate row; shift the status counters if it moved.
          if (existingRsvp.status !== "going") {
            rsvpCounterDelta[existingRsvp.status] -= 1;
            rsvpCounterDelta.going += 1;
          }
          await ctx.db.patch(existingRsvp._id, {
            status: "going",
            source: "ticket",
            // A completed purchase proves the buyer controls this email — same
            // rule as fulfill's Stripe path.
            emailVerified: true,
            updatedAt: now,
          });
        } else {
          rsvpId = await ctx.db.insert("rsvps", {
            eventId,
            chapterId,
            name: t.attendeeName,
            email,
            phone: t.phone ?? undefined,
            status: "going",
            token: newGuestToken(),
            source: "ticket",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          });
          rsvpCounterDelta.going += 1;
        }
      } else {
        // EMAIL-LESS Givebutter ticket. `rsvps.email` is optional (PR A landed),
        // so we create a name/phone-only RSVP — an email-less attendee is a
        // first-class guest. NO `emailVerified` (there's no address to prove;
        // mirrors the attendance importer's email-less rows). The mirror order +
        // ticket are created below regardless.
        rsvpId = await ctx.db.insert("rsvps", {
          eventId,
          chapterId,
          name: t.attendeeName,
          phone: t.phone ?? undefined,
          status: "going",
          token: newGuestToken(),
          source: "ticket",
          createdAt: now,
          updatedAt: now,
        });
        rsvpCounterDelta.going += 1;
      }

      // 4. Mirror order — paid, one line, NO Stripe fields.
      const orderId = await ctx.db.insert("ticketOrders", {
        eventId,
        chapterId,
        rsvpId,
        name: t.attendeeName,
        email: email ?? "",
        items: [
          {
            ticketTypeId: mirrorTypeId,
            name: t.ticketTypeName,
            quantity: 1,
            unitPriceCents: t.priceCents,
          },
        ],
        totalCents: t.priceCents,
        currency: "usd",
        status: "paid",
        externalProvider: "givebutter",
        externalRef,
        createdAt: t.createdAt,
        updatedAt: now,
      });

      // 5. Ticket row — REAL native code (door scanner must work for GB buyers).
      let code = newTicketCode();
      const clash = await ctx.db
        .query("tickets")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (clash) code = newTicketCode();
      await ctx.db.insert("tickets", {
        eventId,
        chapterId,
        orderId,
        ticketTypeId: mirrorTypeId,
        ticketTypeName: t.ticketTypeName,
        attendeeName: t.attendeeName,
        attendeeEmail: email ?? "",
        code,
        status: t.checkedInAt !== null ? "checked_in" : "valid",
        checkedInAt: t.checkedInAt ?? undefined,
        createdAt: now,
      });

      // 6. Accumulate bumps.
      soldDelta.set(mirrorTypeId, (soldDelta.get(mirrorTypeId) ?? 0) + 1);
      ticketsSoldDelta += 1;
      revenueCentsDelta += t.priceCents;
      inserted += 1;
    }

    // Apply mirror-type soldCount deltas — one patch per touched type.
    for (const [typeId, delta] of soldDelta) {
      if (delta === 0) continue;
      const tt = await ctx.db.get(typeId);
      if (tt) await ctx.db.patch(typeId, { soldCount: tt.soldCount + delta });
    }

    // Single page patch for the whole batch.
    if (
      ticketsSoldDelta !== 0 ||
      revenueCentsDelta !== 0 ||
      rsvpCounterDelta.going !== 0 ||
      rsvpCounterDelta.maybe !== 0 ||
      rsvpCounterDelta.not_going !== 0
    ) {
      await ctx.db.patch(page._id, {
        ticketsSoldCount: page.ticketsSoldCount + ticketsSoldDelta,
        revenueCents: page.revenueCents + revenueCentsDelta,
        goingCount: Math.max(0, page.goingCount + rsvpCounterDelta.going),
        maybeCount: Math.max(0, page.maybeCount + rsvpCounterDelta.maybe),
        notGoingCount: Math.max(
          0,
          page.notGoingCount + rsvpCounterDelta.not_going,
        ),
      });
    }

    return { inserted, reconciled, skipped };
  },
});

// ── Fetch + normalize (the network side, no "use node") ──────────────────────

/** Raw Givebutter ticket object (the fields we read). */
interface GivebutterTicketRaw {
  id?: number | string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  price?: number | string | null;
  checked_in_at?: string | null;
  created_at?: string | null;
}

interface GivebutterTicketsPage {
  data?: GivebutterTicketRaw[];
  links?: { next?: string | null };
  meta?: { current_page?: number; last_page?: number };
}

/**
 * Resolve the Givebutter API key for a sync run: the in-app superuser setting
 * (`integrationSettings.readGivebutterApiKey`, PR E) takes precedence, else
 * the deployment env var, else `null` (the caller degrades to a no-op).
 * Actions have no `ctx.db`, so the setting is read via `ctx.runQuery`.
 */
async function resolveGivebutterApiKey(ctx: ActionCtx): Promise<string | null> {
  const stored = await ctx.runQuery(
    internal.integrationSettings.readGivebutterApiKey,
    {},
  );
  return stored ?? process.env.GIVEBUTTER_API_KEY ?? null;
}

/** Parse a Givebutter ISO timestamp to ms, or null when absent/unparseable. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Normalize one raw ticket. Returns null for a row without an id (skipped). */
function normalizeTicket(raw: GivebutterTicketRaw): GbTicket | null {
  if (raw.id === undefined || raw.id === null || raw.id === "") return null;
  const priceDollars =
    typeof raw.price === "number" ? raw.price : Number(raw.price ?? 0);
  const priceCents = Math.round(
    (Number.isFinite(priceDollars) ? priceDollars : 0) * 100,
  );
  const nameFromParts = `${raw.first_name ?? ""} ${raw.last_name ?? ""}`.trim();
  const attendeeName = (raw.name?.trim() || nameFromParts) || "Guest";
  const ticketTypeName = raw.title?.trim() || "General Admission";
  const phone =
    raw.phone !== undefined && raw.phone !== null && String(raw.phone).trim()
      ? String(raw.phone).trim()
      : null;
  return {
    externalId: String(raw.id),
    ticketTypeName,
    attendeeName,
    email: normalizeEmail(raw.email),
    phone,
    priceCents,
    checkedInAt: parseTimestamp(raw.checked_in_at),
    createdAt: parseTimestamp(raw.created_at) ?? Date.now(),
  };
}

/**
 * Sync ONE campaign into native mirror rows — the shared body behind both the
 * manual button (`syncGivebutterCampaign`) and the cron
 * (`syncAllGivebutterCampaigns`). Pure helper (not registered) so the cron calls
 * it directly rather than action→action (per Convex guidelines).
 *
 * DEGRADES to a logged no-op when no API key is configured (stored setting OR
 * env — see `resolveGivebutterApiKey`) or there's no campaign configured. On a
 * fetch/parse failure it records the error string on the page
 * (`givebutterLastSyncError`); on success it clears it. Follows Laravel
 * pagination (`links.next`) up to a hard page cap; applies each API page as it
 * arrives so a mid-run failure still persists earlier pages.
 */
async function syncOneCampaign(
  ctx: ActionCtx,
  eventId: Id<"events">,
): Promise<void> {
  const key = await resolveGivebutterApiKey(ctx);
  if (!key) {
    console.warn(
      "[givebutter] sync skipped: no API key configured (setting or env)",
    );
    return;
  }

  const config = await ctx.runQuery(internal.givebutterSync.getSyncConfig, {
    eventId,
  });
  if (!config) return; // no page / no campaign id → nothing to sync

  let errorMessage: string | null = null;
  try {
    let url: string | null = `${GIVEBUTTER_API_BASE}/campaigns/${encodeURIComponent(
      config.campaignId,
    )}/tickets`;
    for (let page = 0; page < GIVEBUTTER_MAX_PAGES && url; page++) {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as GivebutterTicketsPage;
      const rows = body.data ?? [];
      const normalized: GbTicket[] = [];
      for (const row of rows) {
        const t = normalizeTicket(row);
        if (t) normalized.push(t);
      }
      if (normalized.length > 0) {
        await ctx.runMutation(internal.givebutterSync.applyGivebutterTickets, {
          eventId,
          tickets: normalized,
        });
      }
      url = body.links?.next ?? null;
    }
  } catch (err) {
    errorMessage =
      err instanceof Error ? err.message : "Givebutter sync failed.";
    console.error(
      `[givebutter] sync failed for event ${eventId}:`,
      errorMessage,
    );
  }

  await ctx.runMutation(internal.givebutterSync.finishGivebutterSync, {
    eventId,
    error: errorMessage,
  });
}

/** Manual-button entry: sync one campaign now. Scheduled by
 *  `requestGivebutterSync` (a registered ref the scheduler can reach). No-ops
 *  cleanly without an API key. */
export const syncGivebutterCampaign = internalAction({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    await syncOneCampaign(ctx, eventId);
    return null;
  },
});

/**
 * Cron entry (every 15 min): sync every campaign whose event hasn't ended more
 * than 7 days ago. No-ops entirely when no API key is configured (stored
 * setting OR env — see `resolveGivebutterApiKey`). The manual button keeps
 * working forever regardless of the date gate.
 */
export const syncAllGivebutterCampaigns = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!(await resolveGivebutterApiKey(ctx))) {
      console.warn(
        "[givebutter] cron sync skipped: no API key configured (setting or env)",
      );
      return null;
    }
    const pages = await ctx.runQuery(
      internal.givebutterSync.listActiveGivebutterPages,
      {},
    );
    for (const { eventId } of pages) {
      await syncOneCampaign(ctx, eventId);
    }
    return null;
  },
});

// ── Manual trigger (public mutation) ─────────────────────────────────────────

/**
 * "Sync now" — schedule a manual sync of this event's Givebutter campaign.
 * Chapter-gated (`requireEvent`). Throttled: a request within 60s of the last
 * sync is skipped. NO date gate — pointing an old campaign id at a past event IS
 * the Givebutter backfill. Stamps `givebutterLastSyncedAt` optimistically so the
 * throttle holds against a double-tap even before the async sync completes.
 */
export const requestGivebutterSync = mutation({
  args: { eventId: v.id("events") },
  returns: v.object({
    scheduled: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This event has no public page yet.",
      });
    }
    if (!page.givebutterCampaignId) {
      throw new ConvexError({
        code: "NO_CAMPAIGN",
        message: "Set a Givebutter campaign id before syncing.",
      });
    }
    const now = Date.now();
    if (
      page.givebutterLastSyncedAt !== undefined &&
      now - page.givebutterLastSyncedAt < SYNC_THROTTLE_MS
    ) {
      return { scheduled: false, reason: "throttled" as const };
    }
    // Optimistic stamp so a rapid second tap is throttled before the async sync
    // finishes (the action re-stamps on completion).
    await ctx.db.patch(page._id, {
      givebutterLastSyncedAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.givebutterSync.syncGivebutterCampaign,
      { eventId },
    );
    return { scheduled: true };
  },
});
