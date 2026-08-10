/**
 * Turning a `gifts` row into the facts a notification email needs.
 *
 * Read-only, `QueryCtx`-only — it never patches a gift or a donor. Those five
 * derived things (donor lifetime, gift count, donor status, the scope
 * aggregates, the cross-chapter identity rollup, the territory launch pot)
 * hang off `lib/givingDonors.ts` and nothing else may touch them; a
 * notification is a reader, and readers stay readers.
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────
 * "Where did this come from" is the owner's question and the gift row already
 * answers it, in five different fields. `giftProvenance` reads them in
 * priority order and produces the one sentence a human wants. The case worth
 * naming: a gift bundled into a TICKET purchase. It arrives as a `donations`
 * row created by `giving.ts#createPaidDonationForOrder` off a paid
 * `ticketOrders.donationCents`, then dual-writes the gift — so the gift itself
 * looks exactly like a standalone event-page donation. The only honest way to
 * tell them apart is to walk back through the donation's rsvp to the ticket
 * order (`ticketOrders.by_rsvp`, an indexed read) and see whether an add-on of
 * that amount was actually bought there.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { appUrl } from "./siteUrl";
import type {
  NotificationDonor,
  NotificationGift,
} from "./givingNotificationEmails";
import type { GiftScope, RuleScope } from "./givingNotificationRules";

/** Path of a donor's record in the app — `apps/mobile/app/(app)/giving/donor/
 *  [id].tsx`. Kept here so there is one place to change if that route moves. */
export function donorPath(donorId: Id<"donors">): string {
  return `/giving/donor/${donorId}`;
}

/** Absolute deep link into a donor's record, or `null` when `APP_URL` is
 *  unset. In prod `APP_URL` is `https://publicworship.life/os`, so this
 *  resolves to `https://publicworship.life/os/giving/donor/<id>` — the `/os`
 *  prefix is the Cloudflare-routed base path the Expo web build is served
 *  under (`apps/mobile/app.config.js`'s `experiments.baseUrl`), and a link
 *  that drops it 404s. */
export function donorUrl(donorId: Id<"donors">): string | null {
  return appUrl(donorPath(donorId));
}

/** Human name for a book: a chapter's name, or "Central". */
export async function scopeLabel(
  ctx: QueryCtx,
  scope: GiftScope,
): Promise<string> {
  if (scope === "central") return "Central";
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Unknown chapter";
}

/** Human name for a RULE's reach — the same as a book's, plus the `"all"`
 *  sentinel. */
export async function ruleScopeLabel(
  ctx: QueryCtx,
  scope: RuleScope,
): Promise<string> {
  if (scope === "all") return "All books";
  return scopeLabel(ctx, scope);
}

/**
 * Did this gift ride in on a ticket purchase? Only a dual-written gift can
 * have, and only when the order it came from actually bought an add-on of that
 * size. Bounded: one `by_rsvp` index read.
 */
async function cameInOnATicketOrder(
  ctx: QueryCtx,
  donation: Doc<"donations">,
): Promise<boolean> {
  if (!donation.rsvpId) return false;
  const orders = await ctx.db
    .query("ticketOrders")
    .withIndex("by_rsvp", (q) => q.eq("rsvpId", donation.rsvpId))
    .take(10);
  return orders.some(
    (o) => o.status === "paid" && (o.donationCents ?? 0) === donation.amountCents,
  );
}

/** The one sentence that says how a gift arrived. */
export async function giftProvenance(
  ctx: QueryCtx,
  gift: Doc<"gifts">,
): Promise<string> {
  if (gift.donationId) {
    const donation = await ctx.db.get(gift.donationId);
    if (donation && (await cameInOnATicketOrder(ctx, donation))) {
      return "Added to a ticket purchase";
    }
    return "Given on an event page";
  }
  if (gift.sponsorshipId) return "Payment against a sponsorship";
  if (gift.pledgeId || gift.stripeInvoiceId) return "Recurring backer cycle";
  if (gift.externalRef?.startsWith("sale:")) {
    return "Split out of an in-person payment";
  }
  if (gift.externalRef?.startsWith("give:")) return "Given on the public /give page";
  if (gift.transactionId) return "Confirmed from a bank credit";
  if (gift.method === "in_kind") return "In-kind — paid on the org's behalf";
  if (gift.externalRef) return "Imported from an outside source";
  if (gift.recordedBy) return "Recorded by the giving desk";
  return "Recorded in the giving ledger";
}

function donorFacts(donor: Doc<"donors">): NotificationDonor {
  return {
    donorId: donor._id,
    name: donor.name,
    ...(donor.email ? { email: donor.email } : {}),
    lifetimeCents: donor.lifetimeCents,
    giftCount: donor.giftCount,
    // The rollup is bumped in the same transaction the gift is written in, so
    // a count of one means this gift IS the first one on this book.
    isFirstGift: donor.giftCount <= 1,
    url: donorUrl(donor._id),
  };
}

/**
 * Everything an email needs about one gift. Returns `null` when the donor is
 * gone (a merge or a delete raced the notification) — the caller drops the
 * gift rather than mailing a record with no name on it.
 *
 * `chapterNames` is an optional memo so a digest of fifty gifts across three
 * books does three chapter reads, not fifty.
 */
export async function buildNotificationGift(
  ctx: QueryCtx,
  gift: Doc<"gifts">,
  chapterNames?: Map<string, string>,
): Promise<NotificationGift | null> {
  const donor = await ctx.db.get(gift.donorId);
  if (!donor) return null;

  let label: string;
  const memoKey = gift.scope as string;
  if (chapterNames?.has(memoKey)) {
    label = chapterNames.get(memoKey) as string;
  } else {
    label = await scopeLabel(ctx, gift.scope);
    chapterNames?.set(memoKey, label);
  }

  let eventName: string | undefined;
  if (gift.eventId) {
    const event = await ctx.db.get(gift.eventId);
    if (event) eventName = event.name;
  }

  return {
    giftId: gift._id,
    amountCents: gift.amountCents,
    ...(gift.feeCoverageCents ? { feeCoverageCents: gift.feeCoverageCents } : {}),
    receivedAt: gift.receivedAt,
    method: gift.method,
    scopeLabel: label,
    ...(gift.note ? { note: gift.note } : {}),
    ...(eventName ? { eventName } : {}),
    provenance: await giftProvenance(ctx, gift),
    donor: donorFacts(donor),
  };
}
