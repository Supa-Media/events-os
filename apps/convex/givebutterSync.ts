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
 * ── NO CAMPAIGN-SCOPED TICKETS ENDPOINT ──────────────────────────────────────
 * Givebutter's v1 API has NO `GET /v1/campaigns/{id}/tickets` — that endpoint
 * 404s for every campaign (it was the production bug this file used to have).
 * `GET /v1/tickets` lists ALL sold tickets account-wide (Laravel-paginated) and
 * carries no campaign reference at all — only `transaction_id`. Campaign
 * ownership lives on the TRANSACTION (`GET /v1/transactions`, also
 * account-wide, has `campaign_id`). So a campaign sync is a TWO-SWEEP JOIN:
 * sweep `/v1/transactions` to build the set of transaction ids belonging to
 * this campaign, then sweep `/v1/tickets` and keep only tickets whose
 * `transaction_id` is in that set. `/v1/campaigns/{campaign}/items/tickets`
 * exists but describes ticket TYPES (tiers), not sold tickets — not used here.
 *
 * ── MONEY INVARIANT ──────────────────────────────────────────────────────────
 * TICKETS are DISPLAY ATTRIBUTION ONLY. A synced Givebutter ticket touches
 * EXACTLY three things: `eventPages` ticket rollups (`ticketsSoldCount` /
 * `revenueCents` / RSVP status counters), `ticketTypes.soldCount`, and `rsvps`.
 * The ticket path NEVER writes to `transactions`, `donations`, or the finance
 * ledger — Givebutter is the system of record for that money; double-booking a
 * TICKET into the ledger would corrupt every budget/reconcile total. Synced
 * orders carry NO Stripe fields; they are marked `externalProvider:"givebutter"`
 * + `externalRef` instead.
 *
 * DONATIONS are the ONE deliberate exception (see `applyGivebutterDonations`).
 * A Givebutter transaction's DONATION portion (the `subtype:"donation"` line
 * items nested on its sub-transactions — tickets and processing fees excluded)
 * is recorded as a
 * donor-CRM `gifts` row via the shared `recordGiftForDonor` primitive, tagged
 * with the event id, so it rolls into the event's `externalGiftsCents`/
 * `externalGiftsCount` "Given" total (Revenue stays ticket-only). This still
 * never touches `transactions` (the actuals ledger) — a `gifts` row is giving
 * HISTORY, not an actual — so budgets/reconcile are unaffected. Idempotency +
 * the no-double-count guard live in `applyGivebutterDonations`; the donation
 * amount derivation is documented on `donationCentsFromTransaction`.
 *
 * ── REFUNDS (v1 limitation) ──────────────────────────────────────────────────
 * The transaction sweep now skips transactions Givebutter has marked refunded
 * (`refunded === true` or the string `"true"` — the spec types the field as a
 * string, so we're conservative about which encodings count as refunded) —
 * newly-refunded transactions are excluded from the join BEFORE import, so
 * their tickets are never applied. But there is still no refund signal on the
 * ticket object itself and no webhook, so a transaction that gets refunded
 * AFTER its tickets have already been synced is NOT reflected: the mirror
 * order stays `paid` and the rollups stay counted. This is a documented v1
 * gap. The forward-compat fix is a full-list RECONCILIATION pass — re-sweep
 * transactions/tickets, diff against our `by_external_ref` mirror rows, and
 * void/refund the orders whose transaction has since gone refunded. See the
 * stub note on `applyGivebutterTickets`.
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
import { matchOrCreateDonor, recordGiftForDonor } from "./lib/givingDonors";

/** Givebutter API base. `Authorization: Bearer <GIVEBUTTER_API_KEY>`. */
const GIVEBUTTER_API_BASE = "https://api.givebutter.com/v1";

/** Hard cap on pages followed in one sync run (Laravel pagination). A campaign
 *  with more tickets than this can be re-synced to continue (dedup is total). */
const GIVEBUTTER_MAX_PAGES = 50;

/** Hard cap on pages followed while listing `/v1/campaigns` to resolve a
 *  code/slug to a numeric id. Smaller than the ticket cap — an org's campaign
 *  list is expected to be much shorter than any one campaign's ticket count. */
const GIVEBUTTER_CAMPAIGN_LOOKUP_MAX_PAGES = 10;

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

/**
 * The normalized shape of ONE Givebutter DONATION (the gift portion of a
 * transaction) the action hands the donation apply mutation. `externalId` is
 * the Givebutter TRANSACTION id (the gift dedup key, `gifts.externalRef`);
 * `donationCents` is the integer-cents donation portion (see
 * `donationCentsFromTransaction`); the donor identity fields feed
 * `matchOrCreateDonor`. Money is integer cents; `receivedAt` is ms.
 */
const gbDonationValidator = v.object({
  externalId: v.string(),
  donationCents: v.number(),
  donorName: v.string(),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  receivedAt: v.number(),
});

type GbDonation = {
  externalId: string;
  donationCents: number;
  donorName: string;
  email: string | null;
  phone: string | null;
  receivedAt: number;
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

/**
 * Self-heal: once a non-numeric campaign value (a code or slug, e.g. copied
 * from the campaign URL) resolves to Givebutter's numeric campaign id via
 * `/v1/campaigns`, persist the numeric id on the page so every future sync
 * (manual + cron) hits the tickets endpoint directly and skips the lookup.
 * One-time, best-effort — a no-op if the page vanished mid-run.
 */
export const setResolvedCampaignId = internalMutation({
  args: {
    eventId: v.id("events"),
    campaignId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { eventId, campaignId }) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) return null;
    await ctx.db.patch(page._id, {
      givebutterCampaignId: campaignId,
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
 *  2. NEW → match an EXISTING ACTIVE NATIVE `ticketTypes` row by normalized
 *     name first (so a native sellable tier and its Givebutter sales share
 *     ONE tier — never flips that row's `isActive`); only when no active
 *     native tier matches does this fall back to find-or-create the MIRROR
 *     `ticketTypes` row (matched by `externalProvider:"givebutter"` +
 *     normalized name; `isActive:false`). The admin promotes an old mirror to
 *     sellable via `setTicketTypeSellable`, after which future syncs match it
 *     natively (step 2's first branch) instead of minting more mirrors.
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

      // 2. Ticket type — match an ACTIVE NATIVE tier first (so native +
      //    Givebutter sales share ONE sellable tier once the admin has
      //    promoted/created one of this name), else find-or-create the
      //    inactive mirror as before.
      const siblings = await ctx.db
        .query("ticketTypes")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .take(100);
      const wantName = normalizeName(t.ticketTypeName);
      const nativeMatch = siblings.find(
        (tt) =>
          tt.isActive &&
          tt.externalProvider === undefined &&
          normalizeName(tt.name) === wantName,
      );
      let mirrorTypeId: Id<"ticketTypes">;
      if (nativeMatch) {
        // Native tier absorbs the synced sale as-is — never flip its
        // `isActive`, never mint a mirror alongside it.
        //
        // Intentionally NOT capacity-checked: the sale already happened on
        // Givebutter (the external system of record for it), so we must record
        // it here — dropping it would leave a real, paid attendee unable to be
        // scanned in at the door. `capacity` caps NATIVE checkout only (see
        // `remainingFor` in ticketing.ts); a matched native tier can therefore
        // read `soldCount > capacity` after a sync burst, which is truthful
        // (that many people really are coming) — the native page just shows
        // "0 left" and stops selling natively.
        mirrorTypeId = nativeMatch._id;
      } else {
        let mirror = siblings.find(
          (tt) =>
            tt.externalProvider === "givebutter" &&
            normalizeName(tt.name) === wantName,
        );
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
            // tickets so the scanner + rollups work for Givebutter buyers,
            // until (if ever) the admin promotes it via setTicketTypeSellable.
            isActive: false,
            externalProvider: "givebutter",
            createdAt: now,
            updatedAt: now,
          });
        }
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
            // Deliberately do NOT bump `updatedAt` to `now`: the activity feed
            // keys a ticket buyer's timestamp off the (stable) order purchase
            // time, and a re-sync touching updatedAt used to re-float an old
            // purchase to the top of the feed.
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
            // Stamp the REAL Givebutter purchase time (not `now`) so a first-
            // ever import doesn't post an old purchase as fresh in the feed.
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
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
          // Stamp the REAL Givebutter purchase time (not `now`) so a first-ever
          // import doesn't post an old purchase as fresh in the feed.
          createdAt: t.createdAt,
          updatedAt: t.createdAt,
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

/**
 * Apply one batch of normalized Givebutter DONATIONS (the gift portion of
 * transactions) to the donor-CRM ledger, attributed to `eventId`. This is the
 * ONE place the sync records MONEY as a gift — see the file-header MONEY
 * INVARIANT. Pure DB, testable without hitting Givebutter (mirrors
 * `applyGivebutterTickets`).
 *
 * IDEMPOTENT / NO DOUBLE-COUNT (the money-critical invariant):
 *  - Dedup by the Givebutter TRANSACTION id via `gifts.by_externalRef` — the
 *    SAME dedup key the CSV/canonical import uses (a Givebutter export row's
 *    `externalRef` IS its transaction id), so importing the CSV and running
 *    this sync are mutually idempotent and never double-record the same gift.
 *    A transaction whose gift already exists is skipped; only NEW rows add to
 *    the rollup, so re-running the sync leaves totals unchanged.
 *  - Each new gift is recorded via `recordGiftForDonor` with `eventId` set and
 *    NO `donationId`, so it bumps the event's `externalGiftsCents`/
 *    `externalGiftsCount` EXACTLY once (via that helper's event-rollup branch).
 *    A donation synced here NEVER carries `donationId` (that field is reserved
 *    for the native on-page donation dual-write, already counted in
 *    `donationsCents`), so the same dollar can never land in both rollups.
 *
 * The donor is match-or-created in the event's chapter scope (`page.chapterId`)
 * by email → phone → name, exactly like the CSV import + event dual-write.
 * Skips any donation with a non-positive amount. No-op (skips all) when the
 * event has no `eventPages` row.
 */
export const applyGivebutterDonations = internalMutation({
  args: {
    eventId: v.id("events"),
    donations: v.array(gbDonationValidator),
  },
  returns: v.object({ inserted: v.number(), skipped: v.number() }),
  handler: async (ctx, { eventId, donations }) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) return { inserted: 0, skipped: donations.length };
    const scope = page.chapterId;

    let inserted = 0;
    let skipped = 0;
    for (const d of donations) {
      if (!Number.isInteger(d.donationCents) || d.donationCents <= 0) {
        skipped += 1;
        continue;
      }
      const externalRef = d.externalId;
      // Dedup on the transaction id — a gift already recorded for this
      // transaction (by this sync OR a CSV import) is left untouched, so a
      // re-run only ever ADDS genuinely new donations.
      const existing = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", externalRef))
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }

      const donorId = await matchOrCreateDonor(ctx, {
        scope,
        name: d.donorName,
        email: d.email ?? undefined,
        phone: d.phone ?? undefined,
        source: "givebutter-import",
      });
      // `recordGiftForDonor` bumps the event's externalGiftsCents/Count because
      // `eventId` is set and `donationId` is NOT (the double-count firewall).
      await recordGiftForDonor(ctx, {
        donorId,
        amountCents: d.donationCents,
        receivedAt: d.receivedAt,
        method: "givebutter",
        eventId,
        externalRef,
      });
      inserted += 1;
    }
    return { inserted, skipped };
  },
});

// ── Fetch + normalize (the network side, no "use node") ──────────────────────

/** Raw Givebutter ticket object (the fields we read). NO campaign reference —
 *  only `transaction_id`, which is how a ticket is joined back to a campaign
 *  (via the transaction sweep — see the file-header note). */
interface GivebutterTicketRaw {
  id?: number | string;
  transaction_id?: number | string;
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

/** One Givebutter line item, found on a NESTED sub-transaction
 *  (`transaction.transactions[].line_items[]` — the LIST endpoint has NO
 *  top-level `line_items`; it lives one level down, verified against the live
 *  API). `subtype` is "donation" | "ticket" | "fee" and is the discriminator we
 *  use to isolate the donation portion (see `donationCentsFromTransaction`).
 *  Amounts are decimal dollars; `total` is the per-line amount after any promo
 *  discount. */
interface GivebutterLineItemRaw {
  type?: string | null;
  subtype?: string | null;
  price?: number | string | null;
  discount?: number | string | null;
  total?: number | string | null;
  quantity?: number | string | null;
}

/** Raw Givebutter transaction object (the fields we read). Carries the
 *  `campaign_id` a ticket lacks — this is the join key — plus donor identity and
 *  the NESTED `transactions[]` sub-transactions that hold the `line_items` money
 *  breakdown (the DONATION sync reads them). */
interface GivebutterTransactionRaw {
  id?: number | string;
  campaign_id?: number | string | null;
  // Live payloads carry a status ("pending" | "succeeded" | "refunded" | ...)
  // on the top-level object and the refund flag on NESTED sub-transactions —
  // not the flat `refunded` the OpenAPI spec describes. All three are read
  // (see `isRefundedTransaction`) so either encoding is caught.
  status?: string | null;
  refunded?: boolean | string | null;
  // Nested sub-transactions. Each carries its own `refunded` flag (read by
  // `isRefundedTransaction`) AND the populated `line_items` — the ONLY place the
  // list endpoint exposes the ticket/donation/fee money split (there is no
  // top-level `line_items` on the list payload).
  transactions?: Array<{
    refunded?: boolean | string | null;
    line_items?: GivebutterLineItemRaw[] | null;
  }>;
  // Donor identity for the donation gift's match-or-create.
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  transacted_at?: string | null;
}

interface GivebutterTransactionsPage {
  data?: GivebutterTransactionRaw[];
  links?: { next?: string | null };
}

/** Raw Givebutter campaign object (the fields we match against). */
interface GivebutterCampaignRaw {
  id?: number | string;
  code?: string | null;
  slug?: string | null;
}

interface GivebutterCampaignsPage {
  data?: GivebutterCampaignRaw[];
  links?: { next?: string | null };
}

/**
 * True when the configured campaign value is already the numeric Givebutter
 * campaign id — no `/v1/campaigns` lookup needed (current/fast-path
 * behavior, unchanged for every admin who entered the id correctly).
 */
function isNumericCampaignId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * Resolve a non-numeric campaign value (the CODE or the SLUG from the
 * campaign's public URL, e.g. `public-worship-field-day-um8he0`) to
 * Givebutter's numeric campaign id. Admins are told to paste "your Givebutter
 * campaign URL", which yields a slug, not the id the tickets endpoint
 * actually wants — this is the fix for that mismatch (404 on the raw slug).
 *
 * Lists `GET /v1/campaigns` (Laravel-paginated — follows `links.next`, capped
 * at `GIVEBUTTER_CAMPAIGN_LOOKUP_MAX_PAGES`) and matches case-insensitively
 * against each campaign's `id` (stringified), `code`, and `slug`. Returns the
 * numeric id string on a match, `null` when no campaign matches any page.
 */
async function resolveCampaignId(
  key: string,
  value: string,
): Promise<string | null> {
  const wanted = value.trim().toLowerCase();
  let url: string | null = `${GIVEBUTTER_API_BASE}/campaigns`;
  for (
    let page = 0;
    page < GIVEBUTTER_CAMPAIGN_LOOKUP_MAX_PAGES && url;
    page++
  ) {
    const res = await gbGet(key, url);
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} while looking up Givebutter campaign "${value}".`,
      );
    }
    const body = (await res.json()) as GivebutterCampaignsPage;
    for (const c of body.data ?? []) {
      const id =
        c.id !== undefined && c.id !== null && c.id !== ""
          ? String(c.id)
          : null;
      if (
        (id !== null && id.toLowerCase() === wanted) ||
        (c.code ?? "").toLowerCase() === wanted ||
        (c.slug ?? "").toLowerCase() === wanted
      ) {
        return id;
      }
    }
    url = nextPageUrl(body.links?.next);
  }
  return null;
}

/** GET a Givebutter API URL with bearer auth — the one fetch shape every
 *  endpoint here uses (campaign show/list, transactions, tickets). */
function gbGet(key: string, url: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
}

/** Short body snippet for a failed Givebutter response, so the recorded sync
 *  error says WHY (e.g. a validation message), not just the status code. */
async function gbErrorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text ? ` (${text.slice(0, 140)})` : "";
  } catch {
    return "";
  }
}

/**
 * Sanitize a Laravel `links.next` URL down to `<origin><path>?page=N`.
 * Givebutter's `/v1/transactions` paginator leaks internal model attributes
 * into the query string (`apiKey[incrementing]=1&keyable[...]=...`), and
 * following that URL verbatim gets rejected with HTTP 400 — page 1 succeeds,
 * page 2 fails (verified against the live API). Only the `page` param is
 * meaningful, so keep exactly that. Returns null (stop paginating) when
 * there's no next URL or no parseable page number.
 */
function nextPageUrl(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    const u = new URL(next);
    const page = u.searchParams.get("page");
    if (!page || !/^\d+$/.test(page)) return null;
    return `${u.origin}${u.pathname}?page=${page}`;
  } catch {
    return null;
  }
}

/** True when Givebutter marks a transaction refunded in ANY of its encodings:
 *  the top-level `status`, a flat `refunded` flag (the OpenAPI shape), or a
 *  nested sub-transaction's `refunded` (the live payload shape). */
function isRefundedTransaction(txn: GivebutterTransactionRaw): boolean {
  const flag = (v: boolean | string | null | undefined) =>
    v === true || v === "true";
  if ((txn.status ?? "").toLowerCase() === "refunded") return true;
  if (flag(txn.refunded)) return true;
  return (txn.transactions ?? []).some((t) => flag(t.refunded));
}

/**
 * Validate a numeric configured value against `GET /v1/campaigns/{id}`. 200 →
 * the value IS the numeric campaign id, used as-is (fast path, unchanged for
 * every admin who entered the id correctly). 404 → the value only LOOKS
 * numeric but is actually a campaign CODE or slug (e.g. "686283" could be a
 * code) — the caller falls through to `resolveCampaignId`. Any other non-ok
 * status is a hard failure.
 */
async function validateNumericCampaignId(
  key: string,
  value: string,
): Promise<"ok" | "not_found"> {
  const res = await gbGet(
    key,
    `${GIVEBUTTER_API_BASE}/campaigns/${encodeURIComponent(value)}`,
  );
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} looking up Givebutter campaign "${value}".`,
    );
  }
  // 200 alone means "use as-is" — no field off the body is needed.
  return "ok";
}

/**
 * Sweep `GET /v1/transactions` (Laravel-paginated, follows `links.next`,
 * capped at `GIVEBUTTER_MAX_PAGES`) for `campaignId`. Returns BOTH halves of
 * the campaign sync in ONE pass over the account-wide feed:
 *  - `ids` — the set of `String(id)` for the campaign's transactions, the join
 *    key a ticket lacks (see the file-header note), used by the ticket sweep;
 *  - `donations` — one normalized `GbDonation` per transaction that carries a
 *    donation portion (`normalizeTransactionDonation`), used by the donation
 *    apply. A tickets-only transaction yields no donation.
 * Skips transactions Givebutter has marked refunded in any encoding
 * (`isRefundedTransaction`) — a refunded transaction contributes NEITHER
 * tickets nor a donation gift.
 *
 * `truncated` is true when the cap was hit with more pages remaining — the
 * caller surfaces that as a warning, since a capped ACCOUNT-WIDE sweep means
 * this campaign's rows past the cap were silently missed (unlike the old
 * campaign-scoped endpoint, the cap no longer bounds just this campaign).
 */
async function sweepCampaignTransactions(
  key: string,
  campaignId: string,
): Promise<{ ids: Set<string>; donations: GbDonation[]; truncated: boolean }> {
  const ids = new Set<string>();
  const donations: GbDonation[] = [];
  let url: string | null = `${GIVEBUTTER_API_BASE}/transactions`;
  for (let page = 0; page < GIVEBUTTER_MAX_PAGES && url; page++) {
    const res = await gbGet(key, url);
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} fetching Givebutter transactions.${await gbErrorDetail(res)}`,
      );
    }
    const body = (await res.json()) as GivebutterTransactionsPage;
    for (const txn of body.data ?? []) {
      if (txn.id === undefined || txn.id === null || txn.id === "") continue;
      if (String(txn.campaign_id) !== campaignId) continue;
      if (isRefundedTransaction(txn)) continue;
      ids.add(String(txn.id));
      const donation = normalizeTransactionDonation(txn);
      if (donation) donations.push(donation);
    }
    url = nextPageUrl(body.links?.next);
  }
  console.log(
    `[givebutter] transaction sweep for campaign ${campaignId}: ${ids.size} matching ids, ${donations.length} with a donation portion`,
  );
  return { ids, donations, truncated: url !== null };
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
 * Derive the DONATION (gift) portion of a Givebutter transaction, in integer
 * cents. Returns 0 for a tickets-only order.
 *
 * ── DERIVATION (money-critical — verified against the LIVE API) ──────────────
 * On the `GET /v1/transactions` LIST payload the line items are NOT top-level —
 * each transaction has a nested `transactions[]` array of sub-transactions, and
 * every sub-transaction carries its own `line_items[]`, each typed by a
 * `subtype` of "donation" | "ticket" | "fee". We walk every sub-transaction's
 * items and sum the `total` (per-line amount, after any promo discount) of ONLY
 * the `subtype:"donation"` lines. This EXPLICITLY:
 *   - INCLUDES the donation the giver added (→ the event's Given total), and
 *   - EXCLUDES ticket lines (`subtype:"ticket"` — already counted as ticket
 *     `revenueCents` by the ticket sweep, so counting them here would overlap),
 *     and the processing-fee line (`subtype:"fee"`).
 * Confirmed live examples: a ticket($25)+donation($75)+fee($3.30) transaction
 * (`amount`=100) yields exactly 75; a pure donation ($100 + $2.24 fee) yields
 * 100; a pure ticket ($25 + $1.06 fee) yields 0.
 *
 * Do NOT use the top-level `amount`/`donated`/`fair_market_value_amount`/
 * `tax_deductible_amount` scalars: on a ticket+donation transaction both
 * `amount` and `donated` equal the FULL 100 (ticket included), so any of them
 * would double-count the ticket against `revenueCents`. Only the nested
 * `subtype:"donation"` line `total` isolates the gift.
 *
 * GROSS vs NET: `total` is the donation the giver chose, BEFORE Givebutter's
 * processing fee (its own separate `subtype:"fee"` line, so naturally excluded
 * — no fee/ticket subtraction needed). This is CONSISTENT with the rest of the
 * "raised" total: ticket `revenueCents` and native on-page `donationsCents` are
 * both gross, so all three legs of the goal numerator are gross/pre-fee.
 *
 * Money in / out: Givebutter amounts are decimal dollars; `Math.round(x * 100)`
 * → integer cents (mirrors `normalizeTicket`).
 */
function donationCentsFromTransaction(txn: GivebutterTransactionRaw): number {
  let dollars = 0;
  for (const sub of txn.transactions ?? []) {
    for (const li of sub.line_items ?? []) {
      if ((li.subtype ?? "").toLowerCase() !== "donation") continue;
      const raw = li.total ?? li.price ?? 0;
      const amount = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(amount) && amount > 0) dollars += amount;
    }
  }
  return Math.round(dollars * 100);
}

/**
 * Build a normalized donation from one raw transaction, or null when it carries
 * no donation portion (tickets-only, or an unparseable/idless row). The
 * transaction id is the gift dedup key (`gifts.externalRef`). Callers must have
 * already excluded refunded transactions (see `isRefundedTransaction`).
 */
function normalizeTransactionDonation(
  txn: GivebutterTransactionRaw,
): GbDonation | null {
  if (txn.id === undefined || txn.id === null || txn.id === "") return null;
  const donationCents = donationCentsFromTransaction(txn);
  if (donationCents <= 0) return null;
  const nameFromParts = `${txn.first_name ?? ""} ${txn.last_name ?? ""}`.trim();
  const donorName = (txn.name?.trim() || nameFromParts) || "Anonymous";
  const phone =
    txn.phone !== undefined && txn.phone !== null && String(txn.phone).trim()
      ? String(txn.phone).trim()
      : null;
  return {
    externalId: String(txn.id),
    donationCents,
    donorName,
    email: normalizeEmail(txn.email),
    phone,
    receivedAt:
      parseTimestamp(txn.created_at) ??
      parseTimestamp(txn.transacted_at) ??
      Date.now(),
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
 *
 * CAMPAIGN VALUE RESOLUTION: the configured value is often not the numeric id
 * — the UI hint says "found in your Givebutter campaign URL", which yields a
 * SLUG (e.g. `public-worship-field-day-um8he0`), and Givebutter also exposes a
 * short CODE, which can itself be all-digits (e.g. "686283"). So a numeric
 * value is first VALIDATED against `GET /v1/campaigns/{id}`
 * (`validateNumericCampaignId`): 200 → use as-is; 404 → it wasn't really the
 * id, fall through to the code/slug lookup below. A non-numeric value (or a
 * numeric one that 404'd) is resolved via `/v1/campaigns` (see
 * `resolveCampaignId`); on a match the resolved id is used for this run AND
 * persisted back onto the page (self-heal, one-time — see
 * `setResolvedCampaignId`), so every later sync skips both lookups entirely.
 *
 * TICKET FETCH: there is no campaign-scoped tickets endpoint (see the
 * file-header note), so this is a TWO-SWEEP JOIN — sweep `/v1/transactions`
 * for this campaign's (non-refunded) transaction ids, then sweep
 * `/v1/tickets` and keep only tickets whose `transaction_id` is in that set.
 * If the transaction sweep comes back empty, the ticket sweep is skipped
 * entirely (nothing could match).
 *
 * DONATION FETCH: the SAME transaction sweep also yields each transaction's
 * donation portion (`line_items` with `subtype:"donation"`); those are applied
 * via `applyGivebutterDonations` into the event's `externalGiftsCents` "Given"
 * total (Revenue stays ticket-only). Idempotent + no-double-count — see that
 * mutation + `donationCentsFromTransaction`.
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
    let campaignId = config.campaignId.trim();
    let resolved = false;
    if (isNumericCampaignId(campaignId)) {
      const status = await validateNumericCampaignId(key, campaignId);
      resolved = status === "ok";
    }
    if (!resolved) {
      const lookedUp = await resolveCampaignId(key, campaignId);
      if (!lookedUp) {
        throw new Error(
          "Campaign not found — enter the numeric ID, code, or slug from Givebutter.",
        );
      }
      if (lookedUp !== campaignId) {
        // Self-heal: persist the numeric id so future syncs (manual + cron)
        // skip both lookups entirely.
        await ctx.runMutation(internal.givebutterSync.setResolvedCampaignId, {
          eventId,
          campaignId: lookedUp,
        });
      }
      campaignId = lookedUp;
    }

    const {
      ids: transactionIds,
      donations,
      truncated: txnTruncated,
    } = await sweepCampaignTransactions(key, campaignId);
    let ticketsTruncated = false;
    let matched = 0;
    if (transactionIds.size > 0) {
      let url: string | null = `${GIVEBUTTER_API_BASE}/tickets`;
      for (let page = 0; page < GIVEBUTTER_MAX_PAGES && url; page++) {
        const res = await gbGet(key, url);
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status} fetching Givebutter tickets.${await gbErrorDetail(res)}`,
          );
        }
        const body = (await res.json()) as GivebutterTicketsPage;
        const rows = body.data ?? [];
        const normalized: GbTicket[] = [];
        for (const row of rows) {
          if (
            row.transaction_id === undefined ||
            row.transaction_id === null ||
            row.transaction_id === ""
          ) {
            continue;
          }
          if (!transactionIds.has(String(row.transaction_id))) continue;
          const t = normalizeTicket(row);
          if (t) normalized.push(t);
        }
        if (normalized.length > 0) {
          matched += normalized.length;
          await ctx.runMutation(
            internal.givebutterSync.applyGivebutterTickets,
            { eventId, tickets: normalized },
          );
        }
        url = nextPageUrl(body.links?.next);
      }
      ticketsTruncated = url !== null;
      console.log(
        `[givebutter] ticket sweep for event ${eventId}: ${matched} tickets matched campaign ${campaignId}`,
      );
    }

    // Donation portions of this campaign's transactions → the event's Given
    // total (`externalGiftsCents`). Applied whether or not the campaign sold
    // tickets (a pure-donation campaign has no ticket rows), and idempotently
    // (dedup on the transaction id — see `applyGivebutterDonations`). This runs
    // AFTER the ticket sweep so a mixed transaction's ticket half is mirrored
    // first, but the two never overlap (tickets → revenueCents, donation →
    // externalGiftsCents).
    if (donations.length > 0) {
      const donationResult = await ctx.runMutation(
        internal.givebutterSync.applyGivebutterDonations,
        { eventId, donations },
      );
      console.log(
        `[givebutter] donation apply for event ${eventId}: ${donationResult.inserted} recorded, ${donationResult.skipped} skipped`,
      );
    }

    // A capped ACCOUNT-WIDE sweep means rows past the cap were silently
    // missed — surface it as a sync warning instead of reporting clean
    // success with under-counted rollups. (Everything swept so far IS
    // applied; a later re-sync after Givebutter trims/reorders can catch up.)
    if (txnTruncated || ticketsTruncated) {
      errorMessage = `Givebutter returned more than ${GIVEBUTTER_MAX_PAGES} pages of ${
        txnTruncated ? "transactions" : "tickets"
      } — synced what was swept, but counts may be incomplete.`;
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
