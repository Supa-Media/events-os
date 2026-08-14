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
import type { ActionCtx, MutationCtx } from "./_generated/server";
// Triggers-wrapped builder for `applyGivebutterTickets`/
// `applyGivebutterDonations` below (insert `rsvps`/`people` via
// `matchOrCreateDonor`) — see `lib/peopleAggregate.ts`'s module doc.
import { internalMutation as triggerInternalMutation } from "./lib/peopleAggregate";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { requireEvent } from "./lib/context";
import { newGuestToken, newTicketCode } from "./ticketing";
import { RSVP_STATUSES } from "./schema/ticketing";
import { matchOrCreateDonor, recordGiftForDonor } from "./lib/givingDonors";
import type { GivingScope } from "./lib/givingAccess";
import { linkRsvpToPerson } from "./lib/rsvpPeople";

/** Givebutter API base. `Authorization: Bearer <GIVEBUTTER_API_KEY>`. */
const GIVEBUTTER_API_BASE = "https://api.givebutter.com/v1";

/** Hard cap on pages followed in one sync run (Laravel pagination). A campaign
 *  with more tickets than this can be re-synced to continue (dedup is total). */
const GIVEBUTTER_MAX_PAGES = 50;

/** Hard cap on pages followed while listing `/v1/campaigns` to resolve a
 *  code/slug to a numeric id. Smaller than the ticket cap — an org's campaign
 *  list is expected to be much shorter than any one campaign's ticket count. */
const GIVEBUTTER_CAMPAIGN_LOOKUP_MAX_PAGES = 10;

/** Tickets handed to `applyGivebutterTickets` in one call. The sweep now
 *  collects every matched ticket before applying any (so a transaction's
 *  tickets can be repriced together), and this keeps each mutation's write set
 *  bounded regardless of how large that collection got. A transaction is never
 *  split across two batches, so this is a floor rather than a hard cap. */
const TICKET_APPLY_BATCH = 50;

/** Manual-sync throttle: ignore a re-request within this window of the last one
 *  (guards a double-tap / impatient operator from stacking redundant syncs). */
const SYNC_THROTTLE_MS = 60_000;

/** The cron stops polling a campaign once its event ended more than this ago.
 *  The manual button still works forever (no date gate). */
const CRON_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How many donor rows one PERSON may hold before the legacy-backfill guard
 *  stops widening (see that guard). One row per scope is the shape this is
 *  built for — a handful of chapters plus central — so this is a runaway
 *  backstop, not a working limit. */
const SIBLING_DONOR_SCAN_LIMIT = 50;

/**
 * Every gift held by any donor row belonging to the SAME PERSON as `donorId` —
 * the reach the legacy-backfill guard needs (see its comment).
 *
 * MEMOIZED PER SYNC RUN, and that is not a nicety. The donation loop this
 * serves is unbounded — attaching a campaign replays its entire history — and
 * an unmemoized version costs up to 50 donor reads plus 200 gifts each, per
 * donation. A campaign backfill would walk into Convex's per-transaction
 * document ceiling and fail the whole batch rather than one row. Repeat donors
 * are the common case, so the cache does most of the work.
 */
async function siblingGiftHistory(
  ctx: MutationCtx,
  donorId: Id<"donors">,
  cache: Map<Id<"donors">, Doc<"gifts">[]>,
): Promise<Doc<"gifts">[]> {
  const cached = cache.get(donorId);
  if (cached) return cached;
  const donorRow = await ctx.db.get(donorId);
  const siblingIds = new Set<Id<"donors">>([donorId]);
  if (donorRow?.identityId) {
    const identityId = donorRow.identityId;
    for (const sib of await ctx.db
      .query("donors")
      .withIndex("by_identity", (q) => q.eq("identityId", identityId))
      .take(SIBLING_DONOR_SCAN_LIMIT)) {
      siblingIds.add(sib._id);
    }
  }
  // Normalized, because `by_email` stores the normalized form and an
  // unnormalized probe silently finds nothing.
  const donorEmail = normalizeEmail(donorRow?.email);
  if (donorEmail) {
    for (const sib of await ctx.db
      .query("donors")
      .withIndex("by_email", (q) => q.eq("email", donorEmail))
      .take(SIBLING_DONOR_SCAN_LIMIT)) {
      siblingIds.add(sib._id);
    }
  }
  const history: Doc<"gifts">[] = [];
  for (const sibId of siblingIds) {
    history.push(
      ...(await ctx.db
        .query("gifts")
        .withIndex("by_donor", (q) => q.eq("donorId", sibId))
        .take(200)),
    );
  }
  // Cached under every sibling id: the next donation from any row of this
  // person is answered without a single extra read.
  for (const sibId of siblingIds) cache.set(sibId, history);
  return history;
}

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
export const applyGivebutterTickets = triggerInternalMutation({
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
          // Person-centric audiences Phase 1 item 2 — best-effort (see
          // `lib/rsvpPeople.ts`'s doc comment).
          await linkRsvpToPerson(ctx, {
            rsvpId,
            chapterId,
            name: t.attendeeName,
            email,
            phone: t.phone,
          });
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
        // Person-centric audiences Phase 1 item 2 — matches by phone/name only
        // (no email on this branch); best-effort (see `lib/rsvpPeople.ts`).
        await linkRsvpToPerson(ctx, {
          rsvpId,
          chapterId,
          name: t.attendeeName,
          phone: t.phone,
        });
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
 *  - A donation that has been RECLASSIFIED out of the gifts ledger (recorded as
 *    tickets, say) has no gift row for the lookup above to find, so it would
 *    otherwise be re-inserted forever. `givebutterConvertedDonations` is the
 *    durable tombstone that says "seen, and deliberately recorded elsewhere";
 *    it is consulted before the donor is even matched, and reported as
 *    `converted` rather than as a warning (see the guard's own comment).
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
export const applyGivebutterDonations = triggerInternalMutation({
  args: {
    /** The event whose campaign these came from. Absent for GENERAL giving —
     *  see `general` below. */
    eventId: v.optional(v.id("events")),
    /**
     * GIVING THAT BELONGS TO NO EVENT — the org's own Givebutter campaign,
     * where recurring givers land.
     *
     * Until this existed, `syncAllGivebutterCampaigns` only ever swept
     * campaigns attached to an event page, so a donation to the general
     * Public Worship campaign was never booked at all — while its money still
     * counted on the cash side of the reconciliation (`givebutterUndeposited
     * Cents` is derived from Givebutter's own transactions, not from ours).
     * The result was $50.00 of real recurring giving showing up as
     * "unaccounted for" on the accounts page, with nothing naming it. Founder,
     * 2026-08-14: "our system doesn't count recurring giving or stuff like
     * that from Givebutter."
     *
     * Books at `"central"`, the same scope `/give` uses for a gift with no
     * territory behind it (`givingDonations.ts`): the org's campaign is not a
     * chapter's campaign, and counting its recurring givers as New York's
     * would overstate one book's giving with money the whole org raised.
     */
    general: v.optional(v.boolean()),
    donations: v.array(gbDonationValidator),
  },
  returns: v.object({
    inserted: v.number(),
    skipped: v.number(),
    legacyCollisions: v.number(),
    converted: v.number(),
  }),
  handler: async (ctx, { eventId, general, donations }) => {
    // ONE loop, two provenances. The guards below — the externalRef dedup, the
    // converted-donation suppression, the legacy-backfill twin check — are the
    // hard-won part of this mutation, and a second copy of them for general
    // giving is exactly how two paths come to disagree about what is already
    // in the books. So only the SCOPE and the event link vary; everything
    // after this block is shared verbatim.
    let scope: GivingScope;
    if (eventId) {
      const page = await ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .unique();
      if (!page) {
        return {
          inserted: 0,
          skipped: donations.length,
          legacyCollisions: 0,
          converted: 0,
        };
      }
      scope = page.chapterId;
    } else if (general) {
      scope = "central";
    } else {
      // Neither an event nor general is not a provenance we can book against,
      // and guessing one would file somebody's giving in an arbitrary book.
      return {
        inserted: 0,
        skipped: donations.length,
        legacyCollisions: 0,
        converted: 0,
      };
    }

    let inserted = 0;
    let skipped = 0;
    let legacyCollisions = 0;
    let converted = 0;
    /** Per-run memo for the legacy-backfill guard's sibling lookup — see
     *  `siblingGiftHistory`. Lives outside the loop deliberately. */
    const historyCache = new Map<Id<"donors">, Doc<"gifts">[]>();
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

      // ── RECLASSIFIED-DONATION GUARD ──────────────────────────────────────
      // The dedup above answers "is there a gift row for this transaction?"
      // and treats that as "is this money in the books?". Those are the same
      // question right up until a donation is correctly recorded as something
      // that is NOT a gift — and then the absence of a gift row means the
      // opposite of what the lookup assumes.
      //
      // Pop The Balloon's Venmo collection is that case: one $820 Givebutter
      // payment that was really 41 ticket sales, collected by hand and
      // forwarded as a lump. It is now a `ticketOrders` row, so `by_externalRef`
      // above finds nothing and, without this, the next sync would insert the
      // $820 all over again — the same money counted once as tickets and once
      // as a resurrected gift.
      //
      // So the reclassification leaves a DURABLE record
      // (`givebutterConvertedDonations`) and this consults it. Checked BEFORE
      // `matchOrCreateDonor` deliberately: a converted donation must not even
      // manufacture a donor row for a person who did not give.
      //
      // Distinct from the legacy-collision guard below in what it means and in
      // how it is reported. A collision says "recorded under another key, go
      // retire the stale row" and is surfaced as a sync warning. This says
      // "recorded in another LAYER, on purpose, permanently" — there is nothing
      // for an operator to do, so it is counted and logged and never becomes a
      // warning that would sit on the page forever.
      const convertedRow = await ctx.db
        .query("givebutterConvertedDonations")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", externalRef))
        .first();
      if (convertedRow) {
        // Suppressed on the TRANSACTION ID alone, whatever the amount now
        // reads: the id is the transaction's identity, so a re-insert would be
        // a double-count regardless. An amount that disagrees is still worth
        // saying out loud — it means the reclassification and the live payload
        // describe the same transaction differently, which someone should look
        // at even though suppressing is still the right call.
        if (convertedRow.amountCents !== d.donationCents) {
          console.warn(
            `[givebutter] converted donation ${externalRef} was recorded as ` +
              `${convertedRow.amountCents}¢ but the API now reports ${d.donationCents}¢ — ` +
              `still suppressed (${convertedRow.convertedTo}).`,
          );
        }
        converted += 1;
        continue;
      }

      const donorId = await matchOrCreateDonor(ctx, {
        scope,
        name: d.donorName,
        email: d.email ?? undefined,
        phone: d.phone ?? undefined,
        source: "givebutter-import",
      });

      // ── LEGACY-BACKFILL GUARD ────────────────────────────────────────────
      // The dedup above is an exact key match, and that is not enough on its
      // own: a one-time CSV backfill (2026-07-19) wrote its gifts keyed
      // `gb:txn:<CSV Reference Number>` — the 10-digit number the Givebutter
      // EXPORT prints — while this sync keys on the API's own 16-character
      // transaction id. Different id spaces for the same transaction, so the
      // lookup misses and the donation is recorded a SECOND time. Attaching
      // Pop The Balloon's campaign did exactly that: $665 of duplicate giving,
      // repaired by a 2026-08 one-off since removed.
      //
      // So: before inserting, check whether this donor already holds a
      // legacy-keyed gift for the same money on the same UTC day. Scoped to
      // `gb:txn:`-prefixed rows deliberately — it can never suppress against
      // this sync's own rows, so two genuine same-amount gifts on one day
      // still both land (the mistake that cost a real $500 bank deposit
      // earlier in this reconciliation was exactly that kind of collapse).
      //
      // ── ACROSS EVERY DONOR ROW FOR THE PERSON, NOT JUST THIS ONE ─────────
      // This guard used to read `by_donor` on `donorId` alone, and that made
      // it dependent on donor matching having worked — which is exactly what
      // fails when the two imports run at different SCOPES.
      //
      // That is not hypothetical: on 2026-08-14 an API sync ran at `central`
      // against a July CSV backfill that had landed at New York.
      // `findDonorInScope` looks up `by_scope_and_email`, so the central
      // lookup could not see the New York donor and minted a second row for
      // the same person — same name, same email — and this guard then read
      // that fresh row's empty history and found nothing to collide with.
      // 88 gifts totalling $7,324.75 were re-inserted, and the org's
      // reconciliation page reported $7,228.25 "unaccounted for" the next
      // morning. Three defenses in a row (externalRef, this guard, donor
      // matching) all fell to one changed variable.
      //
      // So the lookup now spans every donor row that belongs to the same
      // PERSON: the cross-chapter identity layer (`donorIdentities`, which
      // `matchOrCreateDonor` already attaches on both its branches) is the
      // right notion of sameness here, with email as the fallback for a row
      // that predates the layer. Bounded: one person's donor rows and their
      // gift histories, never a table scan.
      // BOTH lookups, unioned — never `else`. `matchOrCreateDonor` calls
      // `syncDonorIdentity` on every path, so the freshly minted donor ALWAYS
      // has an `identityId` and an `else if` would make the email branch dead
      // for exactly the rows this guard exists for. And `syncDonorIdentity`
      // attaches only the donor it is handed, so a legacy sibling written
      // before the identity layer has no `identityId` at all and is invisible
      // to `by_identity` — email is what finds it. Each alone misses the case
      // the other catches.
      const priorForDonor = await siblingGiftHistory(ctx, donorId, historyCache);
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const legacyTwin = priorForDonor.find(
        (g) =>
          String(g.externalRef ?? "").startsWith("gb:txn:") &&
          g.amountCents === d.donationCents &&
          day(g.receivedAt) === day(d.receivedAt),
      );
      if (legacyTwin) {
        // Reported, never silently dropped — the caller raises it as a sync
        // warning so an operator retires the backfill row rather than
        // wondering why a donation is missing.
        legacyCollisions += 1;
        continue;
      }
      // `recordGiftForDonor` bumps the event's externalGiftsCents/Count because
      // `eventId` is set and `donationId` is NOT (the double-count firewall).
      await recordGiftForDonor(ctx, {
        donorId,
        amountCents: d.donationCents,
        receivedAt: d.receivedAt,
        method: "givebutter",
        eventId,
        externalRef,
        // A MIRROR, not an arrival. This loop is unbounded — attaching a
        // campaign backfills its entire donation history in one pass, which is
        // precisely the thousand-email case. Givebutter donations still reach
        // the digest; the live rails that DO fire immediately (`/give`, event
        // pages, ticket add-ons, Stripe recurring) are the ones where the write
        // really is one payment landing once.
        notify: false,
      });
      inserted += 1;
    }
    return { inserted, skipped, legacyCollisions, converted };
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
  // ── The two fields the undeposited-balance derivation stands on ────────────
  // `payout_id` is the Givebutter payout this transaction was settled in, or
  // null while it is still awaiting one. `payout` is what Givebutter will
  // actually REMIT for it (decimal dollars, net of their fee) — as opposed to
  // `amount`, which is what the giver paid. See
  // `fetchGivebutterUndepositedCents`.
  payout_id?: number | string | null;
  payout?: number | string | null;
  amount?: number | string | null;
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
): Promise<{
  ids: Set<string>;
  donations: GbDonation[];
  ticketMoneyByTxn: Map<string, number>;
  truncated: boolean;
}> {
  const ids = new Set<string>();
  const donations: GbDonation[] = [];
  const ticketMoneyByTxn = new Map<string, number>();
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
      // Recorded ONLY when positive. A zero here means "this payload carried no
      // readable ticket line items", not "these tickets were free" — and the
      // two must not be confused, because allocating zero would wipe the list
      // price off every ticket in the transaction. Absent = keep list price.
      const ticketCents = ticketCentsFromTransaction(txn);
      if (ticketCents > 0) ticketMoneyByTxn.set(String(txn.id), ticketCents);
    }
    url = nextPageUrl(body.links?.next);
  }
  console.log(
    `[givebutter] transaction sweep for campaign ${campaignId}: ${ids.size} matching ids, ${donations.length} with a donation portion`,
  );
  return { ids, donations, ticketMoneyByTxn, truncated: url !== null };
}

/**
 * The TICKET money a transaction actually collected, in integer cents.
 *
 * The sibling of `donationCentsFromTransaction`, read from the same nested
 * `transactions[].line_items[]`, and it exists because a ticket's own `price`
 * on `GET /v1/tickets` is the tier's LIST price — not what the buyer paid.
 * Pop The Balloon issued per-person promo codes; six Legacy/Team tickets listed
 * at $50 were comped or sold for $20, and the mirror booked all six at $50.
 * That overstated one event's revenue by $315 against money Givebutter never
 * took. The line item's `total` is post-discount, so it is the honest figure.
 *
 * INCLUDES `subtype:"bundle"` alongside `subtype:"ticket"`. A bundle (Pop The
 * Balloon's $40 "His & Hers") carries the money for admissions that are
 * themselves priced at $0 — the ticket sweep imports the two $0 admissions and
 * never sees the bundle row, so counting bundle money here is what lets
 * `allocateTicketMoney` push it back onto the tickets it paid for. Excludes
 * `subtype:"fee"` (the processor's cut, not revenue) and `subtype:"donation"`
 * (already the gift half, counted by `donationCentsFromTransaction`).
 */
function ticketCentsFromTransaction(txn: GivebutterTransactionRaw): number {
  let dollars = 0;
  for (const sub of txn.transactions ?? []) {
    for (const li of sub.line_items ?? []) {
      const subtype = (li.subtype ?? "").toLowerCase();
      if (subtype !== "ticket" && subtype !== "bundle") continue;
      const raw = li.total ?? li.price ?? 0;
      const amount = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(amount) && amount > 0) dollars += amount;
    }
  }
  return Math.round(dollars * 100);
}

/**
 * Spread one transaction's actual ticket money across the tickets it bought,
 * returning the per-ticket cents index-aligned to `tickets`.
 *
 * PRO-RATA BY LIST PRICE, because a mixed basket's discount belongs to the tier
 * it was applied to — a $50 tier and a $20 tier in one order should not absorb
 * the same share. Where every list price is 0 (a bundle's admissions) the money
 * splits EQUALLY, which is what makes a $40 "His & Hers" read as two $20 seats
 * rather than two free ones plus $40 of revenue that lands nowhere.
 *
 * The remainder from integer division is handed out largest-fraction-first, so
 * the allocation sums to `totalCents` EXACTLY. A few cents adrift here would
 * compound into an event's revenue rollup and, through
 * `reconciliation.ts#accountBalances`, into book value.
 *
 * Returns null when there is nothing trustworthy to allocate — no tickets, or a
 * transaction the sweep recorded no ticket money for — and the caller then
 * keeps the list price it already had. Falling back to today's behaviour is
 * always safe; inventing a split is not.
 */
function allocateTicketMoney(
  tickets: GbTicket[],
  totalCents: number | undefined,
): number[] | null {
  if (tickets.length === 0) return null;
  // `undefined` or 0 both mean the sweep read no ticket money for this
  // transaction — an older/partial payload, not a free ticket. Keep what the
  // tickets already carry rather than zeroing real revenue.
  if (totalCents === undefined || totalCents <= 0) return null;
  const faceTotal = tickets.reduce((sum, t) => sum + t.priceCents, 0);
  // A transaction whose tickets already add up to what was collected needs no
  // restatement — the overwhelmingly common, undiscounted case.
  if (faceTotal === totalCents) return tickets.map((t) => t.priceCents);

  const weights = faceTotal > 0 ? tickets.map((t) => t.priceCents) : tickets.map(() => 1);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal <= 0) return null;

  const exact = weights.map((w) => (totalCents * w) / weightTotal);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
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

// ── Undeposited balance (the reconciliation panel's "At Givebutter" pile) ────

/**
 * How much money Givebutter is holding for us right now, in integer cents.
 * Returns null when no API key is configured (the caller leaves the cached
 * figure alone) and throws on a fetch/parse failure (the caller logs it — a
 * processor being unreachable is not a reason to fail a reconciliation run).
 *
 * ── WHY THIS IS DERIVED AND NOT READ ─────────────────────────────────────────
 * Givebutter publishes no balance endpoint. Probed live against the production
 * key on 2026-08-08: `/v1/balance`, `/v1/balances`, `/v1/wallet` and
 * `/v1/accounts` all 404; `/v1/account` returns the org profile (name, logo,
 * socials) and no money at all; `/v1/funds` returns an empty array. So the
 * figure has to be built from the two endpoints that DO exist.
 *
 * ── THE DERIVATION, AND WHY IT IS THE WHOLE BALANCE ──────────────────────────
 * Every transaction carries a `payout_id`, set when Givebutter settles it. So
 * the money Givebutter still holds is exactly the succeeded transactions that
 * have not been assigned to a payout yet.
 *
 * The obvious hole in that — money assigned to a payout that is still IN FLIGHT,
 * which would belong to neither side — was checked and is empty: all 15 payouts
 * on `/v1/payouts` were `paid`, $12,940.45 in total, with nothing pending or in
 * transit. If Givebutter ever does hold an unpaid payout, this figure will
 * understate by it. That is the known limit of the derivation, and it is stated
 * here rather than guessed at.
 *
 * ── EVIDENCE IT IS RIGHT ─────────────────────────────────────────────────────
 * On 2026-08-08 this returned exactly $75.00, which is the figure the founder
 * independently read off the Givebutter dashboard. It was three $25 tickets
 * across two transactions (2026-08-07 and 2026-08-08) plus five $0.00 rows left
 * over from 2025.
 *
 * ── `payout` AND NOT `amount` ────────────────────────────────────────────────
 * `payout` is what Givebutter will send us; `amount` is what the giver paid, and
 * the difference is Givebutter's fee, which never becomes ours. The cash side of
 * a reconciliation is money we can actually point at, so it takes the remittable
 * figure.
 *
 * That same difference is now BOOKED as an expense — see
 * `fetchGivebutterFeeEntries` below and `processorFees.ts`. Until 2026-08-10 it
 * was not, and it sat in the reconciliation gap instead: revenue was recorded
 * gross while only the net ever banked, so the books ran $29.30 ahead of the
 * cash with nothing naming the difference.
 *
 * ── STATUS FILTER ────────────────────────────────────────────────────────────
 * `succeeded` only, by exact match rather than "not refunded": a `pending` or
 * `failed` transaction is not money Givebutter is holding FOR US, and the point
 * of this number is what they will remit. `isRefundedTransaction` is not enough
 * on its own here — it would let a pending charge through.
 */
export async function fetchGivebutterUndepositedCents(
  ctx: ActionCtx,
): Promise<number | null> {
  const key = await resolveGivebutterApiKey(ctx);
  if (!key) return null;

  let url: string | null = `${GIVEBUTTER_API_BASE}/transactions`;
  let dollars = 0;
  let page = 0;
  for (; page < GIVEBUTTER_MAX_PAGES && url; page++) {
    const res = await gbGet(key, url);
    if (!res.ok) {
      throw new Error(
        `Givebutter transactions ${res.status}${await gbErrorDetail(res)}`,
      );
    }
    const body = (await res.json()) as GivebutterTransactionsPage;
    for (const txn of body.data ?? []) {
      if ((txn.status ?? "").toLowerCase() !== "succeeded") continue;
      if (txn.payout_id !== null && txn.payout_id !== undefined) continue;
      // `?? 0` is tolerable HERE and is NOT in the fee sweep below, which is
      // worth stating because the two lines look identical. This figure is a
      // DISPLAY total of money not yet remitted, and `payout` is the ADDEND: an
      // unreadable one makes the number too SMALL, understating a pile of cash,
      // which pushes the reconciliation gap toward "there is money we cannot
      // account for" — the safe direction, and one an operator actually sees.
      // In `normalizeGivebutterFee` the same idiom makes `payout` a zero
      // SUBTRAHEND and books the entire gift as an expense, so there an
      // unreadable value is skipped instead. Same idiom, opposite blast radius.
      const raw = txn.payout ?? 0;
      const amount = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(amount)) dollars += amount;
    }
    url = nextPageUrl(body.links?.next);
  }
  // A truncated sweep is a WRONG balance, not a slightly-short one, so it is
  // refused rather than written. The transaction feed is newest-first and
  // undeposited rows cluster at the new end, so a capped sweep would usually
  // look right — which is exactly what makes shipping it dangerous. At
  // GIVEBUTTER_MAX_PAGES × 20/page this is thousands of transactions against an
  // account that had 267 in its lifetime and is being wound down, so the cap
  // should never be reached; if it is, something has changed and the honest
  // response is to keep showing the last known figure with its ageing "as of".
  if (url) {
    throw new Error(
      `Givebutter returned more than ${GIVEBUTTER_MAX_PAGES} pages of transactions; refusing to report a partial balance`,
    );
  }
  return Math.round(dollars * 100);
}

// ── Givebutter's fee, as an expense ─────────────────────────────────────────

/** One transaction's fee, in the shape `processorFees.ts` books rows from. */
export type GivebutterFeeEntry = {
  /** Givebutter's transaction id, `gb:`-prefixed — see `processorFeeEntries`. */
  transactionId: string;
  /** YYYY-MM (UTC) of the transaction, the bucket the fee rolls up into. */
  month: string;
  /** `amount - payout`, always > 0 (zero-fee rows are dropped, not stored). */
  feeCents: number;
  /** `amount` — what the giver paid, i.e. what the fee came out of. */
  grossCents: number;
  occurredAt: number;
  /** The giver's name, so a fee row can be checked against a named gift. */
  description?: string;
};

/**
 * What one fee sweep saw: the fee-bearing entries, and how many transactions it
 * actually READ to find them.
 *
 * `scanned` is carried out separately because on this rail the two numbers are
 * 267 and 1, and a caller reporting only the second cannot distinguish "read the
 * whole account, one gift's fee wasn't covered" from "the feed returned one row
 * and we booked from it". Reporting only fee-bearing entries would destroy the
 * one signal that tells a broken read from a normal quiet one — which is the
 * same argument the truncation refusal below rests on.
 *
 * `scanned` counts EVERY transaction in the feed, succeeded or not — 267 on this
 * account today, of which 263 succeeded. Deliberately counted before the status
 * filter, because its job is to answer "did we read the account?", not "how many
 * were bookable": a feed that returns only refunded rows has still been read,
 * and a feed that returns nothing has not. `processorFees.ts#withZeroedMonths`
 * leans on exactly that distinction to refuse to reverse a month on the strength
 * of a read that saw nothing at all.
 */
export type GivebutterFeeSweep = {
  entries: GivebutterFeeEntry[];
  scanned: number;
};

/**
 * One raw transaction → its fee entry, or null when it carries no fee we bear.
 *
 * The pure core of the sweep below, exported so the arithmetic can be tested
 * against real payload shapes without a network. Null means "nothing to book",
 * and covers every legitimate reason: not succeeded, refunded, no id, the giver
 * covered the fee (the overwhelmingly common case), a money field we cannot
 * read, or no readable date.
 *
 * ── AN UNREADABLE FIELD IS NOT A ZERO ────────────────────────────────────────
 * `payout` is the SUBTRAHEND, so coercing a missing one to `0` does not lose a
 * little precision at the edges — it books the ENTIRE gift as a fee. A null
 * `payout` on the $1,000.00 gift below would write a $1,000.00 "Givebutter
 * processing fees" expense row, `feeOrigin`-stamped so `finances.ts#needsBudget`
 * never surfaces it and nobody is ever asked to confirm it, and move the
 * reconciliation gap by the same $1,000.00.
 *
 * And a missing `payout` is a shape we must assume this endpoint can produce.
 * `payout` is what Givebutter will REMIT for a transaction; `payout_id` is the
 * settlement it went out in, and is null until then. On the payloads we have
 * seen, `payout` is present on unsettled rows too — `fetchGivebutterUndepositedCents`
 * sums it over exactly those (`payout_id == null`) and that is where the $75.00
 * held figure comes from — so "populated only once settled" would be wrong. What
 * we do NOT have is any guarantee it is always present, on every plan, for every
 * transaction state, forever. The guard does not depend on knowing which:
 * "we cannot read what they will remit" and "they will remit nothing" are
 * opposite facts, and only one of them is an expense. So an absent, empty or
 * unparseable `amount` or `payout` is SKIPPED and warned about — exactly the way
 * an unreadable date is a few lines below — and never coerced.
 */
export function normalizeGivebutterFee(
  txn: GivebutterTransactionRaw,
): GivebutterFeeEntry | null {
  // BOTH conditions, not either — see this function's callers and the header of
  // `fetchGivebutterFeeEntries` for why neither test is sufficient alone.
  if ((txn.status ?? "").toLowerCase() !== "succeeded") return null;
  if (isRefundedTransaction(txn)) return null;
  if (txn.id === undefined || txn.id === null || txn.id === "") return null;

  /** Decimal dollars, or null when the field is absent, empty or unparseable. */
  const dollars = (value: number | string | null | undefined): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const grossDollars = dollars(txn.amount);
  const payoutDollars = dollars(txn.payout);
  if (grossDollars === null || payoutDollars === null) {
    console.warn(
      `[givebutter] transaction ${txn.id} has an unreadable amount ` +
        `(${JSON.stringify(txn.amount)}) or payout (${JSON.stringify(txn.payout)}); ` +
        `skipped rather than read as zero`,
    );
    return null;
  }

  // Rounded to cents BEFORE subtracting. Both fields arrive as decimal dollars,
  // and differencing them as floats first leaves a stray fraction on values that
  // are exact in cents: 1000 - 970.7 is 29.299999999999955, which rounds to the
  // right answer here but would not on every pair, and `Math.round` of a
  // near-miss is precisely how a ledger acquires a one-cent error nobody can
  // trace. Rounding each side first makes the subtraction integer arithmetic.
  const grossCents = Math.round(grossDollars * 100);
  const feeCents = grossCents - Math.round(payoutDollars * 100);
  if (feeCents <= 0) return null;
  // A "fee" that consumes the ENTIRE gift is not a fee.
  //
  // Equivalently: `payout` must be positive. A transaction remitting nothing at
  // all is not a Givebutter fee schedule, it is a reversal or a broken read —
  // and it is also exactly what the old `?? 0` coercion produced, so refusing it
  // keeps the worst outcome unreachable by a SECOND route rather than trusting
  // one guard. That redundancy is real and it earns its keep: `Number("   ")`
  // and `Number([])` are both `0`, so whitespace and an empty array parse
  // cleanly past the readability check above and are caught only here.
  //
  // Deliberately stated as "the fee cannot be the whole gift" rather than as a
  // percentage ceiling: there is no evidence for any particular threshold, and
  // inventing one is its own wrong number. Note the limit of that, so nobody
  // reads "two guards" as "airtight" — both collapse to "`payout` parses to a
  // positive number below `amount`", so a parseable-but-WRONG payout still books
  // (`"1"` on a $1,000 gift books a $999.00 fee past both, silently). Detecting
  // that needs a plausibility model we do not have.
  if (feeCents >= grossCents) {
    console.warn(
      `[givebutter] transaction ${txn.id} implies a ${feeCents}¢ fee on a ` +
        `${grossCents}¢ gift — the whole of it. Skipped rather than booked; ` +
        `payout was ${JSON.stringify(txn.payout)}.`,
    );
    return null;
  }

  const occurredAt =
    parseTimestamp(txn.transacted_at) ?? parseTimestamp(txn.created_at);
  // A fee with no date cannot be put in a month, and guessing one would file
  // real money under a period it did not happen in.
  if (occurredAt == null) {
    console.warn(
      `[givebutter] transaction ${txn.id} has a ${feeCents}¢ fee but no readable date; skipped`,
    );
    return null;
  }

  const name =
    txn.name ?? [txn.first_name, txn.last_name].filter(Boolean).join(" ").trim();
  return {
    transactionId: `gb:${txn.id}`,
    month: new Date(occurredAt).toISOString().slice(0, 7),
    feeCents,
    grossCents,
    occurredAt,
    ...(name ? { description: name } : {}),
  };
}

/**
 * Every Givebutter fee we have actually borne, one entry per transaction.
 * Returns null when no API key is configured (the caller leaves the books
 * alone) and throws on a fetch/parse failure or a truncated sweep.
 *
 * ── THIS IS READ, NOT DERIVED — WHICH IS NOT OBVIOUS, SO: ────────────────────
 * `processorFees.ts` forbids inferring a fee by subtracting recorded revenue
 * from banked deposits, because that yields "fees MINUS unrecorded sales" and
 * writes a wrong number into the ledger. This function subtracts, so it is
 * worth being precise about what from what.
 *
 * `amount` and `payout` are BOTH Givebutter's own per-transaction figures, on
 * the same object, in the same payload: what the giver paid, and what Givebutter
 * will remit for it. Their difference is Givebutter's stated cut of that one
 * transaction. Our books are not an input, so an unrecorded gift cannot move it
 * — which is exactly the failure the rule exists to prevent. The forbidden
 * derivation compares THEIR deposits to OUR revenue; this compares two of theirs.
 *
 * ── EVIDENCE IT IS THE RIGHT PAIR, WITH ITS AS-OF DATE ───────────────────────
 * Two different totals for this account appear in this codebase and they are
 * $50.00 apart. Both are correct; they are AS OF DIFFERENT DATES, and neither
 * is usable without one.
 *
 *   AS OF 2026-08-07 (the export this sweep's arithmetic was checked against,
 *   263 succeeded transactions):
 *     Σ`amount` $12,994.75 − Σ`payout` $12,965.45 = $29.30 of fee
 *
 *   AS OF 2026-08-10 (live, after two $25.00 ticket sales landed):
 *     Σ`amount` $13,044.75 − Σ`payout` $13,015.45 = $29.30 of fee
 *     and Σ`payout` $13,015.45 = $12,940.45 paid out + $75.00 still held
 *
 * The $50.00 between them is those two tickets, whose givers covered the fee —
 * so they move `amount` and `payout` by the same $50.00 and the fee is $29.30
 * in both readings. `processorFees.ts`'s header quotes the 2026-08-10 pair; this
 * one quotes the export it was verified against. They tie, and now say so.
 *
 * That $29.30 is one transaction: a $1,000.00 gift remitted as $970.70 in payout
 * `RX3CUU` on 2025-06-05. Every other giver covered the fee, so their `payout`
 * equals their `amount` to the cent and contributes nothing here.
 *
 * ── WHY MOST ROWS PRODUCE NOTHING ────────────────────────────────────────────
 * Givebutter asks the giver to cover the fee and they almost always do, so
 * `payout === amount` and there is no expense to book. A zero is therefore the
 * NORMAL case, not a missing read, and zero-fee rows are dropped rather than
 * stored as $0.00 evidence nobody needs. This is also why the sweep reports how
 * many transactions it SCANNED and not just how many carried a fee: on this
 * account those numbers are 267 and 1, and an operator has to be able to tell a
 * quiet month from a broken read. A dry run here should report
 * `chargesScanned: 267` — every transaction in the feed, of which 263 succeeded.
 *
 * ── THE SCOPE IS THE WHOLE ACCOUNT, DELIBERATELY ─────────────────────────────
 * `sweepCampaignTransactions` filters transactions to ONE `campaign_id`; this
 * does not, and the asymmetry is intentional rather than an oversight.
 *
 * That campaign filter exists because the ticket sweep has to attach what it
 * finds to a specific `eventPages` row — it is a JOIN KEY, not a claim that
 * off-campaign money isn't ours. The cash side of the reconciliation is
 * account-wide in every other respect: `fetchGivebutterUndepositedCents` sums
 * `payout` across the whole account, and Givebutter remits to one bank account
 * per account, not per campaign. Scoping the FEE to a campaign while the cash
 * it is measured against stays account-wide would put an off-campaign uncovered
 * fee straight back into the reconciliation gap as an unexplained discrepancy —
 * the exact thing booking these fees was meant to remove.
 *
 * The condition under which this becomes wrong is a Givebutter account SHARED
 * between orgs or chapters, because `processorFees.ts#upsertFeeRows` books every
 * fee row to the NY chapter. If that ever happens, the fee sweep and the
 * undeposited-balance derivation must be scoped TOGETHER — scoping the fee alone
 * would be strictly worse than today.
 *
 * ── STATUS FILTER, AND WHY A REFUND IS SKIPPED RATHER THAN NETTED ────────────
 * `succeeded` AND not refunded — both tests, because neither is sufficient.
 * Status alone is not: this file documents (see `GivebutterTransactionRaw`) that
 * live payloads carry the refund flag on NESTED sub-transactions while the
 * top-level `status` stays `succeeded`, which is why `isRefundedTransaction`
 * exists and why `sweepCampaignTransactions` uses it. `isRefundedTransaction`
 * alone is not either — it would let a pending charge through, which is
 * `fetchGivebutterUndepositedCents`'s stated reason for matching on status.
 *
 * WHETHER GIVEBUTTER RETURNS ITS FEE ON A REFUND, WE DO NOT KNOW. An earlier
 * version of this comment asserted that it does. That was never checked, and
 * Stripe's precedent is the opposite — Stripe keeps its cut on a refund, which
 * is exactly why `processorFees.ts#feeTypeLabel` carries `payment_refund`. So
 * it is recorded here as OPEN, with the consequence of each way of being wrong:
 *
 *   · if Givebutter DOES return the fee, skipping is simply correct;
 *   · if Givebutter KEEPS it, skipping UNDER-books a real cost by that fee.
 *
 * Skipping is still the right default, because those two errors are not
 * symmetric. An under-booked fee stays VISIBLE: it lands in the reconciliation
 * gap, which is the instrument built to surface precisely this class of missing
 * expense (see `lib/reconciliationGap.ts`). An over-booked one does not — fee
 * rows are `feeOrigin`-stamped, so `needsBudget` never asks anyone about them
 * and a fabricated expense would sit in the ledger unreviewed forever. A
 * refunded transaction's `payout` is unknown territory besides: a zeroed one
 * would book the entire gross as a fee, so excluding refunds is a guard as much
 * as a judgement.
 *
 * Nothing turns on it on this deployment today — no refunded transaction here
 * carries an uncovered fee. Close it by refunding a fee-uncovered test gift and
 * reading `payout` back before that stops being true.
 */
export async function fetchGivebutterFeeEntries(
  ctx: ActionCtx,
): Promise<GivebutterFeeSweep | null> {
  const key = await resolveGivebutterApiKey(ctx);
  if (!key) return null;

  const entries: GivebutterFeeEntry[] = [];
  let scanned = 0;
  let url: string | null = `${GIVEBUTTER_API_BASE}/transactions`;
  let page = 0;
  for (; page < GIVEBUTTER_MAX_PAGES && url; page++) {
    const res = await gbGet(key, url);
    if (!res.ok) {
      throw new Error(
        `Givebutter transactions ${res.status}${await gbErrorDetail(res)}`,
      );
    }
    const body = (await res.json()) as GivebutterTransactionsPage;
    for (const txn of body.data ?? []) {
      // Counted BEFORE the filter, so this is "how many transactions did we
      // read", not "how many carried a fee". The second number is `entries`.
      scanned++;
      const entry = normalizeGivebutterFee(txn);
      if (entry) entries.push(entry);
    }
    url = nextPageUrl(body.links?.next);
  }
  // Same refusal as the balance sweep, for the same reason: a truncated read
  // is a WRONG total, not a short one, and this one would silently under-book
  // an expense. See `fetchGivebutterUndepositedCents`.
  if (url) {
    throw new Error(
      `Givebutter returned more than ${GIVEBUTTER_MAX_PAGES} pages of transactions; refusing to book a partial fee total`,
    );
  }
  console.log(
    `[givebutter] fee sweep read ${scanned} transactions across ${page} page(s); ` +
      `${entries.length} carried a fee we bore`,
  );
  return { entries, scanned };
}

/** Parse a Givebutter ISO timestamp to ms, or null when absent/unparseable.
 *
 *  THE RUNTIME'S TIMEZONE IS LOAD-BEARING for the fee sweep, because a fee
 *  row's month IS its accounting period. Givebutter's timestamps normally carry
 *  a `Z`, which is unambiguous; a NAIVE one ("2026-06-30 20:15:00") is read by
 *  `Date.parse` in LOCAL time, so under `TZ=America/New_York` that transaction
 *  buckets into 2026-07 rather than 2026-06. Convex actions run UTC, so
 *  production is correct today and the months we book match Givebutter's own
 *  UTC-based export. It is still worth knowing that a month-boundary
 *  transaction is the one figure here that a treasurer could legitimately see
 *  differently in Givebutter's dashboard if that dashboard is showing them a
 *  local-time day. */
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
  /** Set when the donation apply hit CSV-backfill rows it refused to duplicate;
   *  reported alongside a clean sync rather than instead of one. */
  let legacyCollisionWarning: string | null = null;
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
      ticketMoneyByTxn,
      truncated: txnTruncated,
    } = await sweepCampaignTransactions(key, campaignId);
    let ticketsTruncated = false;
    let matched = 0;
    if (transactionIds.size > 0) {
      // COLLECTED WHOLE, then applied — not page by page as this used to be.
      // Restating a discounted price needs every ticket of a transaction in
      // hand at once (see `allocateTicketMoney`), and `GET /v1/tickets` gives
      // no guarantee that siblings land on the same page. Bounded by
      // GIVEBUTTER_MAX_PAGES, so this is a page count's worth of small objects.
      const byTxn = new Map<string, GbTicket[]>();
      let url: string | null = `${GIVEBUTTER_API_BASE}/tickets`;
      for (let page = 0; page < GIVEBUTTER_MAX_PAGES && url; page++) {
        const res = await gbGet(key, url);
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status} fetching Givebutter tickets.${await gbErrorDetail(res)}`,
          );
        }
        const body = (await res.json()) as GivebutterTicketsPage;
        for (const row of body.data ?? []) {
          if (
            row.transaction_id === undefined ||
            row.transaction_id === null ||
            row.transaction_id === ""
          ) {
            continue;
          }
          const txnId = String(row.transaction_id);
          if (!transactionIds.has(txnId)) continue;
          const t = normalizeTicket(row);
          if (!t) continue;
          const bucket = byTxn.get(txnId);
          if (bucket) bucket.push(t);
          else byTxn.set(txnId, [t]);
          matched += 1;
        }
        url = nextPageUrl(body.links?.next);
      }
      ticketsTruncated = url !== null;

      // Restate list prices to what was actually collected, then apply in
      // bounded batches. A transaction is never split across batches, so a
      // partial failure can't leave one order priced and its sibling not.
      let restated = 0;
      let batch: GbTicket[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await ctx.runMutation(internal.givebutterSync.applyGivebutterTickets, {
          eventId,
          tickets: batch,
        });
        batch = [];
      };
      for (const [txnId, tickets] of byTxn) {
        const allocation = allocateTicketMoney(tickets, ticketMoneyByTxn.get(txnId));
        if (allocation) {
          tickets.forEach((t, i) => {
            if (t.priceCents !== allocation[i]) restated += 1;
            t.priceCents = allocation[i];
          });
        }
        if (batch.length + tickets.length > TICKET_APPLY_BATCH) await flush();
        batch.push(...tickets);
      }
      await flush();

      console.log(
        `[givebutter] ticket sweep for event ${eventId}: ${matched} tickets matched campaign ${campaignId}` +
          (restated > 0 ? `, ${restated} repriced from the transaction's line items` : ""),
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
        `[givebutter] donation apply for event ${eventId}: ${donationResult.inserted} recorded, ${donationResult.skipped} skipped, ${donationResult.legacyCollisions} legacy collisions, ${donationResult.converted} reclassified`,
      );
      if (donationResult.legacyCollisions > 0) {
        // Not an error — the money IS recorded, just under the CSV backfill's
        // key rather than this sync's. Surfaced so the stale rows get retired
        // instead of the gap being mistaken for a sync failure.
        legacyCollisionWarning =
          `${donationResult.legacyCollisions} donation(s) already recorded by the 2026-07 CSV backfill under a ` +
          `different key — left alone to avoid double-counting. Retire those gift rows to let the sync own them.`;
      }
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
    // A truncated sweep is the more serious of the two, so it wins the single
    // status slot; otherwise the collision warning takes it.
    if (errorMessage === null) errorMessage = legacyCollisionWarning;
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
/**
 * Every campaign id an event page has claimed — the set general giving must
 * NOT touch.
 *
 * ALL pages, not the active ones `listActiveGivebutterPages` returns. That
 * query's staleness window decides what is worth re-syncing; this decides what
 * is SOMEBODY ELSE'S, and a campaign does not stop belonging to its event
 * because the event finished. Reading the narrower list here would let a past
 * event's donations be re-booked as central giving — the same money in two
 * books.
 */
export const listClaimedGivebutterCampaignIds = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const pages = await ctx.db.query("eventPages").take(500);
    const ids: string[] = [];
    for (const page of pages) {
      const id = page.givebutterCampaignId?.trim();
      if (id) ids.push(id);
    }
    return ids;
  },
});

/**
 * Book the giving that belongs to no event — the org's own campaign, where
 * recurring givers land.
 *
 * ── THE MONEY THIS EXISTS FOR ───────────────────────────────────────────────
 * `syncAllGivebutterCampaigns` only ever sweeps campaigns attached to an event
 * page, so a donation to the general Public Worship campaign was never booked
 * at all. Its money still counted on the CASH side, because
 * `fetchGivebutterUndepositedCents` derives that from Givebutter's own
 * transactions rather than from our records — so the reconciliation reported
 * real recurring giving as "$50.00 unaccounted for", with nothing naming it.
 * Founder, 2026-08-14: "our system doesn't count recurring giving or stuff like
 * that from Givebutter… if you could find a way to sync it, just so that this
 * can go back to zero."
 *
 * ── IT TAKES NO CAMPAIGN ID, ON PURPOSE ─────────────────────────────────────
 * The obvious shape is a configured "general campaign" setting. It was not
 * taken, for two reasons. Somebody has to find the id and keep it current, and
 * a setting that is wrong or empty fails SILENTLY — the money simply stays
 * unbooked, which is the exact failure being fixed. And it answers only the
 * campaign somebody remembered: a second campaign, a Givebutter page made for
 * one appeal, next year's recurring plan, all go missing the same way.
 *
 * So the rule is stated as what is actually true: A GIVEBUTTER TRANSACTION THAT
 * NO EVENT CLAIMS IS GIVING TO THE ORG. Nothing to configure, and a campaign
 * nobody has told us about is swept the first time it takes money.
 *
 * ── WHAT IT REFUSES TO TOUCH ────────────────────────────────────────────────
 *  · A transaction on a campaign an event page claims — that is the event
 *    sync's, and booking it here would put one payment in two books.
 *  · A transaction carrying TICKET money. Tickets are revenue, not giving, and
 *    they need an event to belong to; a transaction with line items is either
 *    an event's (so, above) or something nobody has modelled yet, and inventing
 *    a gift out of it would misstate what was sold. Left for a human.
 *  · Anything refunded or unsuccessful — `sweepUnclaimedTransactions` applies
 *    the same status rule as the balance derivation, so what is booked and what
 *    is counted as held agree by construction.
 *
 * Everything else is booked through the SAME mutation the event path uses, with
 * `general: true` — so the dedup, the converted-donation suppression and the
 * legacy-backfill twin guard are the identical code, not a second copy that
 * drifts.
 *
 * IDEMPOTENT: `applyGivebutterDonations` dedups on the Givebutter transaction
 * id, so re-running books nothing twice — which is what lets this sit on a cron
 * beside the event sweep.
 */
type UndepositedAuditResult = {
  undepositedCents: number;
  unbookedCents: number;
  rows: {
    campaignId: string;
    payoutCents: number;
    ticketCents: number;
    donationCents: number;
    bookedAs: string;
    bookedCents: number | null;
    claimedByEvent: boolean;
  }[];
};

/** Is this Givebutter transaction already in the books, and as what? */
export const lookupGivebutterBooking = internalQuery({
  args: { externalIds: v.array(v.string()) },
  returns: v.array(
    v.object({
      externalId: v.string(),
      bookedAs: v.union(
        v.literal("gift"),
        v.literal("ticketOrder"),
        v.literal("converted"),
        v.literal("nothing"),
      ),
      bookedCents: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, { externalIds }) => {
    const out: {
      externalId: string;
      bookedAs: "gift" | "ticketOrder" | "converted" | "nothing";
      bookedCents: number | null;
    }[] = [];
    for (const externalId of externalIds) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", externalId))
        .first();
      if (gift) {
        out.push({ externalId, bookedAs: "gift", bookedCents: gift.amountCents });
        continue;
      }
      const converted = await ctx.db
        .query("givebutterConvertedDonations")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", externalId))
        .first();
      if (converted) {
        out.push({
          externalId,
          bookedAs: "converted",
          bookedCents: converted.amountCents,
        });
        continue;
      }
      const order = await ctx.db
        .query("ticketOrders")
        .withIndex("by_external_ref", (q) => q.eq("externalRef", externalId))
        .first();
      if (order) {
        out.push({
          externalId,
          bookedAs: "ticketOrder",
          bookedCents: order.totalCents ?? null,
        });
        continue;
      }
      out.push({ externalId, bookedAs: "nothing", bookedCents: null });
    }
    return out;
  },
});

/**
 * WHAT IS THE MONEY GIVEBUTTER IS HOLDING, AND IS IT IN OUR BOOKS?
 *
 * `fetchGivebutterUndepositedCents` returns ONE NUMBER — the sum of succeeded
 * transactions with no payout — and that number lands on the accounts page as
 * a pile of cash. When the reconciliation gap is roughly that pile's size, the
 * only question worth asking is which of those transactions the books have
 * never seen, and a total cannot answer it.
 *
 * It has now cost two wrong guesses. The gap was theorised as unbooked general
 * giving; the general sweep found all 89 such donations already booked. Before
 * that it was theorised as a single $6.00 repayment that turned out to be two
 * $3.00 charges. Both were reasoning about production from the outside. This
 * itemizes it instead: every undeposited transaction, what it is made of, and
 * exactly what the books hold against it.
 *
 *   gh workflow run run-convex-function.yml -f function=givebutterSync:undepositedAudit
 *
 * NAMES NOBODY — amounts, campaign and booking status only. It goes into a CI
 * log, which is a worse place for a giver's name than any screen in the app.
 */
export const undepositedAudit = internalAction({
  args: {},
  returns: v.object({
    undepositedCents: v.number(),
    unbookedCents: v.number(),
    rows: v.array(
      v.object({
        campaignId: v.string(),
        payoutCents: v.number(),
        ticketCents: v.number(),
        donationCents: v.number(),
        bookedAs: v.string(),
        bookedCents: v.union(v.number(), v.null()),
        claimedByEvent: v.boolean(),
      }),
    ),
  }),
  // EXPLICIT RETURN TYPE, and the `claimed` annotation below, because this
  // action calls queries in its OWN file through `internal.givebutterSync.*`.
  // TypeScript then has to infer the generated api's type from a value that
  // depends on it, gives up, and reports `implicitly has type 'any'` here AND
  // in unrelated files that merely touch the same generated types. Annotating
  // the two crossing points breaks the cycle.
  handler: async (ctx): Promise<UndepositedAuditResult> => {
    const key = await resolveGivebutterApiKey(ctx);
    if (!key) throw new Error("No Givebutter API key configured.");

    const claimedIds: string[] = await ctx.runQuery(
      internal.givebutterSync.listClaimedGivebutterCampaignIds,
      {},
    );
    const claimed = new Set<string>(claimedIds);

    // Same filter as the balance derivation, so this itemizes exactly the pile
    // the accounts page counts: succeeded, and not yet assigned to a payout.
    const held: GivebutterTransactionRaw[] = [];
    let url: string | null = `${GIVEBUTTER_API_BASE}/transactions`;
    for (let page = 0; page < GIVEBUTTER_MAX_PAGES && url; page++) {
      const res = await gbGet(key, url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching Givebutter transactions.`);
      }
      const body = (await res.json()) as GivebutterTransactionsPage;
      for (const txn of body.data ?? []) {
        if (txn.id === undefined || txn.id === null || txn.id === "") continue;
        if (String(txn.status ?? "").toLowerCase() !== "succeeded") continue;
        const payoutId = txn.payout_id ?? txn.payout ?? null;
        if (payoutId !== null && payoutId !== undefined && payoutId !== "") continue;
        held.push(txn);
      }
      url = nextPageUrl(body.links?.next);
    }

    const ids = held.map((t) => String(t.id));
    const bookings: {
      externalId: string;
      bookedAs: string;
      bookedCents: number | null;
    }[] = await ctx.runQuery(internal.givebutterSync.lookupGivebutterBooking, {
      externalIds: ids,
    });
    const byId = new Map(bookings.map((b) => [b.externalId, b]));

    let undepositedCents = 0;
    let unbookedCents = 0;
    const rows: UndepositedAuditResult["rows"] = held.map((txn) => {
      const rawPayout = txn.payout ?? txn.amount ?? 0;
      const payoutCents = Math.round(
        (typeof rawPayout === "number" ? rawPayout : Number(rawPayout)) * 100,
      );
      const booking = byId.get(String(txn.id));
      undepositedCents += payoutCents;
      if (booking?.bookedAs === "nothing") unbookedCents += payoutCents;
      return {
        campaignId: String(txn.campaign_id ?? ""),
        payoutCents,
        ticketCents: ticketCentsFromTransaction(txn),
        donationCents: donationCentsFromTransaction(txn),
        bookedAs: booking?.bookedAs ?? "nothing",
        bookedCents: booking?.bookedCents ?? null,
        claimedByEvent: claimed.has(String(txn.campaign_id ?? "")),
      };
    });

    console.log(
      `[givebutter] undeposited audit: ${rows.length} transactions, ` +
        `${undepositedCents}c held, ${unbookedCents}c of it not in the books.`,
    );
    return { undepositedCents, unbookedCents, rows };
  },
});

export const syncGeneralGivebutterGiving = internalAction({
  args: {},
  returns: v.object({
    swept: v.number(),
    inserted: v.number(),
    skipped: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const key = await resolveGivebutterApiKey(ctx);
    if (!key) {
      console.warn(
        "[givebutter] general giving sync skipped: no API key configured",
      );
      return { swept: 0, inserted: 0, skipped: 0, truncated: false };
    }

    const claimed: string[] = await ctx.runQuery(
      internal.givebutterSync.listClaimedGivebutterCampaignIds,
      {},
    );
    const { donations, truncated } = await sweepUnclaimedTransactions(
      key,
      new Set(claimed),
    );

    let inserted = 0;
    let skipped = 0;
    if (donations.length > 0) {
      const result = await ctx.runMutation(
        internal.givebutterSync.applyGivebutterDonations,
        { general: true, donations },
      );
      inserted = result.inserted;
      skipped = result.skipped;
      console.log(
        `[givebutter] general giving: ${result.inserted} recorded, ` +
          `${result.skipped} skipped, ${result.legacyCollisions} legacy collisions, ` +
          `${result.converted} reclassified`,
      );
    }
    if (truncated) {
      console.warn(
        "[givebutter] general giving sweep hit the page cap — some " +
          "transactions were not examined; the next run continues from a " +
          "fresh read.",
      );
    }
    return { swept: donations.length, inserted, skipped, truncated };
  },
});

/**
 * Every donation on a campaign no event claims, plus whether the page cap cut
 * the read short.
 *
 * Mirrors `sweepCampaignTransactions`, with the campaign test INVERTED and one
 * extra refusal: a transaction carrying ticket money is skipped outright rather
 * than having its donation half taken. A mixed transaction belongs to an event
 * that has not been linked yet, and taking half of it would book giving for a
 * payment whose other half nobody has modelled.
 */
async function sweepUnclaimedTransactions(
  key: string,
  claimedCampaignIds: Set<string>,
): Promise<{ donations: GbDonation[]; truncated: boolean }> {
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
      if (claimedCampaignIds.has(String(txn.campaign_id))) continue;
      if (isRefundedTransaction(txn)) continue;
      // Ticket money present ⇒ not ours to book. See the doc above.
      if (ticketCentsFromTransaction(txn) > 0) continue;
      const donation = normalizeTransactionDonation(txn);
      if (donation) donations.push(donation);
    }
    url = nextPageUrl(body.links?.next);
  }
  return { donations, truncated: url !== null };
}

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
