/**
 * The two giving-notification emails: one gift, and a period of gifts.
 *
 * Built with `lib/emailShell.ts`'s fragment builders — the same shell every
 * other transactional mail in this backend is painted with (receipts,
 * reminders, card alerts, approval notices), so a recipient can't tell two
 * renderers produced their inbox. No colours are written here; they all come
 * off `EMAIL_THEME`. Not `@react-email/components`: that dependency exists in
 * this repo for exactly one thing, the vendored Tiptap→HTML *campaign*
 * renderer, and `apps/convex`'s tsconfig deliberately excludes `.tsx`.
 *
 * These functions are PURE — payload in, `{ subject, html }` out. Every fact
 * they render is gathered by `lib/givingNotificationContext.ts` first, so the
 * templates can be rendered in a test without a database and asserted
 * character by character. That test is the CI backstop for this file: HTML
 * built by string concatenation has no type system watching it, and an email
 * that renders wrong renders wrong silently.
 *
 * Money is always integer cents, formatted at the very last step through
 * `@events-os/shared`'s `formatCents`. Nothing here does arithmetic on a
 * formatted string.
 */
import { formatCents } from "@events-os/shared";
import {
  EMAIL_CLS,
  EMAIL_THEME,
  emailButtonRow,
  emailEyebrow,
  emailHeading,
  emailLink,
  emailPanel,
  emailParagraph,
  emailRule,
  emailShell,
  emailSubheading,
  emailTextStyle,
} from "./emailShell";
import { escapeHtml } from "./html";
import { giftMethodLabel } from "./giftLabels";
import {
  ORG_TIME_ZONE,
  cadencePeriodMs,
  clampSubjectName,
} from "./givingNotificationRules";

/**
 * How much longer than its nominal period a window may run before the email
 * stops calling it "this week".
 *
 * Not 1.0: run-hour jitter and DST routinely make a window a few hours longer
 * or shorter than the nominal period, and a subject that flipped its wording
 * over an hour's drift would be noise. 1.5 is past anything the clock does on
 * its own and inside anything a missed run produces (the shortest overrun a
 * dropped weekly tick can cause is a full extra week).
 */
export const LONG_WINDOW_FACTOR = 1.5;

// ── Payload shapes (what the context builder must produce) ──────────────────

export type NotificationDonor = {
  donorId: string;
  name: string;
  email?: string;
  /** Donor rollups AFTER this gift landed — `recordGiftForDonor` bumps them
   *  in the same transaction the gift is written in. */
  lifetimeCents: number;
  giftCount: number;
  /** Their first gift on this book. Drives the "first gift" flag the owner
   *  asked for — the whole point of a same-day notification is the thank-you
   *  that follows it. */
  isFirstGift: boolean;
  /** Deep link into the donor's record in the OS, or null when `APP_URL` is
   *  unset (see `lib/siteUrl.ts#appUrl` — callers omit rather than send a dead
   *  link). */
  url: string | null;
};

export type NotificationGift = {
  giftId: string;
  amountCents: number;
  /** What the donor added to absorb the processor's cut. Shown beside the
   *  gift, never folded into it — `gifts.feeCoverageCents`' invariant. */
  feeCoverageCents?: number;
  receivedAt: number;
  method: string;
  /** "Central", or the chapter's name. */
  scopeLabel: string;
  note?: string;
  /** The event this gift is attributed to, when it is. */
  eventName?: string;
  /** One line saying HOW this gift arrived — "Bundled with a ticket order",
   *  "Recurring backer cycle", "Split out of an in-person sale", … */
  provenance: string;
  /** The gift's stated date is well in the past, so the email must not claim
   *  the money just moved. See `isBackdatedGift`. */
  isBackdated: boolean;
  donor: NotificationDonor;
};

export type ImmediateEmailPayload = {
  ruleName: string;
  gift: NotificationGift;
};

export type DigestBreakdownRow = {
  label: string;
  cents: number;
  count: number;
};

/**
 * How long the org tells people a bank debit takes.
 *
 * ONE ORG, ONE NUMBER. This is the same figure the donor already has in
 * writing: `givingComms.onAchSubmitted` mails them "banks take about 2–4
 * business days to clear one" the moment they authorise the debit. A staff
 * digest quoting a different range would have the development team chasing a
 * gift the donor was told was still early — keep the two in step.
 */
export const ACH_CLEARING_WINDOW = "2–4 business days";

/** One in-flight ACH gift: authorised by the donor, not yet moved by the bank.
 *  Deliberately thinner than `NotificationGift` — a pending gift has no donor
 *  rollups, no first-gift flag and no donor record to link to, because none of
 *  those are true until the money lands. */
export type DigestPendingGift = {
  amountCents: number;
  /** PUBLIC-FORM INPUT. Escaped at render, like every other donor name here. */
  donorName: string;
  /** When the donor authorised the debit — the window bound for pending money,
   *  and the only date an unarrived gift has. */
  submittedAt: number;
  scopeLabel: string;
};

export type DigestEmailPayload = {
  ruleName: string;
  cadence: "daily" | "weekly";
  /** The rule's own reach, for the subject line ("Central", a chapter name,
   *  or "All books"). */
  scopeLabel: string;
  periodStart: number;
  periodEnd: number;
  /** Money that ARRIVED in the period PLUS in-flight ACH authorised in it. The
   *  headline figure, and what every breakdown below sums to. */
  totalCents: number;
  /** How much of `totalCents` is a bank debit that has NOT cleared. Zero on a
   *  period with no ACH in it, which is most of them. */
  pendingCents: number;
  /** Settled gifts PLUS pending ones — the "from N gifts" count, matching
   *  `totalCents`'s basis so the two can't tell different stories. */
  giftCount: number;
  /** How many of `giftCount` are still clearing. */
  pendingCount: number;
  largest: NotificationGift | null;
  /** By chapter — every gift's book, with Central named as Central. */
  byScope: DigestBreakdownRow[];
  /** By rails — card, cash, check. */
  byMethod: DigestBreakdownRow[];
  /** By KIND of giving — recurring, sponsorships, events, one-time. The cut the
   *  owner asked for; `lib/giftLabels.ts#giftType` puts every gift in exactly
   *  one bucket, which is why it sums. */
  byType: DigestBreakdownRow[];
  /** The itemized SETTLED gifts, newest first, capped. */
  gifts: NotificationGift[];
  /** The itemized IN-FLIGHT ACH gifts, newest authorisation first, capped. */
  pending: DigestPendingGift[];
  /** How many settled gifts the totals counted but the list omitted. */
  omittedCount: number;
  /** How many pending gifts the totals counted but the list omitted. */
  pendingOmittedCount: number;
  /** The window was CUT SHORT — it held more than one digest run reads, so the
   *  totals above are a FLOOR. The remainder is not lost: the watermark stopped
   *  where the read stopped, so the next digest picks it up. Said out loud
   *  rather than quietly under-reporting money. */
  countTruncated: boolean;
};

// ── Formatting ───────────────────────────────────────────────────────────────

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ORG_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ORG_TIME_ZONE,
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const esc = escapeHtml;

function giftDate(ts: number): string {
  return DATE_FMT.format(new Date(ts));
}

/** "Aug 4 – Aug 10, 2026" — the period a digest covers. */
export function formatPeriod(start: number, end: number): string {
  return `${DATE_FMT.format(new Date(start))} – ${DATE_FMT.format(new Date(end))}`;
}

/** The donor's name, hyperlinked into their record when we have a live app
 *  URL. Same degrade every other deep-linking email in this backend uses:
 *  plain text rather than a dead href. */
function donorNameHtml(donor: NotificationDonor): string {
  const name = esc(donor.name);
  return donor.url ? emailLink(donor.url, name) : name;
}

/** A `label: value` line inside a panel. */
function detailRow(label: string, valueHtml: string): string {
  const t = EMAIL_THEME;
  return (
    `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ margin: "0 0 4px" })}">` +
    `<span style="color:${t.muted}">${esc(label)}:</span> ` +
    `<span style="color:${t.ink}">${valueHtml}</span></div>`
  );
}

// ── The immediate email ──────────────────────────────────────────────────────

/**
 * One gift, the moment it lands. Leads with the amount because that is the
 * thing the recipient opened the mail to see, then everything needed to decide
 * whether to pick up the phone: who gave, how, to which book, against which
 * event, what they wrote, and how long they've been giving.
 */
export function renderImmediateGiftEmail(payload: ImmediateEmailPayload): {
  subject: string;
  html: string;
} {
  const { gift } = payload;
  const donor = gift.donor;
  const amount = formatCents(gift.amountCents);
  // CLAMPED. A donor name arrives from the public `/give` form and nothing else
  // bounds it, so an unclamped subject was a ten-thousand-character subject
  // waiting to happen. (The BODY is escaped, which is a different defence for a
  // different problem — a subject is not HTML.)
  const who = clampSubjectName(donor.name);
  // The subject is where a busy recipient triages, so the backdated case has to
  // be legible there and not only in the body.
  const subject = gift.isBackdated
    ? `Backdated gift recorded: ${amount} from ${who} — ${gift.scopeLabel}`
    : `${amount} from ${who} — ${gift.scopeLabel}`;

  const donorFacts: string[] = [
    donor.isFirstGift
      ? "First gift"
      : `${donor.giftCount} gifts · ${formatCents(donor.lifetimeCents)} lifetime`,
  ];
  if (donor.email) donorFacts.push(donor.email);

  const inner = [
    emailEyebrow(
      gift.isBackdated ? "A backdated gift was recorded" : "A gift just came in",
    ),
    emailHeading(esc(amount), { size: 34, margin: "0 0 4px" }),
    emailParagraph(
      `${donorNameHtml(donor)} · ${esc(gift.scopeLabel)}`,
      { strong: true, margin: "0 0 20px" },
    ),
    emailPanel(
      [
        detailRow("Source", esc(giftMethodLabel(gift.method))),
        detailRow("Book", esc(gift.scopeLabel)),
        detailRow(
          "Received",
          gift.isBackdated
            ? `${esc(giftDate(gift.receivedAt))} — recorded later, not today`
            : esc(giftDate(gift.receivedAt)),
        ),
        gift.eventName ? detailRow("Event", esc(gift.eventName)) : "",
        detailRow("How it arrived", esc(gift.provenance)),
        gift.feeCoverageCents
          ? detailRow(
              "Fees covered",
              `${esc(formatCents(gift.feeCoverageCents))} on top of the gift`,
            )
          : "",
        detailRow("Donor", esc(donorFacts.join(" · "))),
      ]
        .filter(Boolean)
        .join(""),
      { margin: "0 0 16px" },
    ),
    gift.note
      ? emailPanel(
          `${emailSubheading("Note", { size: 14, margin: "0 0 6px" })}${emailParagraph(esc(gift.note), { margin: "0" })}`,
          { margin: "0 0 16px" },
        )
      : "",
    donor.url
      ? emailButtonRow(donor.url, "Open this donor in the OS")
      : emailParagraph(
          "Set APP_URL on this deployment to get a link straight to the donor's record.",
          { margin: "0" },
        ),
    emailRule(),
    emailParagraph(`Sent by the giving rule “${esc(payload.ruleName)}”.`, {
      size: 12,
      margin: "0",
    }),
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html: emailShell(inner) };
}

// ── The digest email ─────────────────────────────────────────────────────────

/** `$1,200.00 (3)` — a breakdown row's money and how many gifts made it. */
function breakdownValue(cents: number, count: number): string {
  return `${esc(formatCents(cents))} <span style="color:${EMAIL_THEME.muted}">(${count})</span>`;
}

/**
 * One cut of the period, and its own TOTAL LINE.
 *
 * The total is not decoration. Every breakdown here partitions the same set of
 * gifts, so each one's parts must add up to the headline figure — and the only
 * way a reader can check that without a calculator is to see the section say so
 * itself. A breakdown whose parts silently don't sum to the total is worse than
 * no breakdown, because it is the one people quote in a meeting.
 *
 * Summed from the rows RENDERED rather than taken from the payload's headline,
 * deliberately: if a cut ever stopped covering every gift, this line would
 * disagree with the total above it in the email, loudly, instead of restating
 * the headline and hiding the gap.
 */
function breakdownHtml(title: string, rows: DigestBreakdownRow[]): string {
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => detailRow(r.label, breakdownValue(r.cents, r.count)))
    .join("");
  const cents = rows.reduce((sum, r) => sum + r.cents, 0);
  const count = rows.reduce((sum, r) => sum + r.count, 0);
  const total =
    `<div style="border-top:1px solid ${EMAIL_THEME.border};margin:8px 0 0;padding:8px 0 0">` +
    `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ strong: true, margin: "0" })}">` +
    `<span style="color:${EMAIL_THEME.muted}">Total:</span> ` +
    `<span style="color:${EMAIL_THEME.ink}">${breakdownValue(cents, count)}</span>` +
    `</div></div>`;
  return (
    emailSubheading(esc(title), { size: 14, margin: "0 0 6px" }) +
    emailPanel(body + total, { margin: "0 0 16px" })
  );
}

/**
 * One line saying the window ran long, when it did.
 *
 * A digest covering three weeks is not a mistake — a rule that missed runs
 * reports everything it missed, which is the guarantee that nothing goes
 * un-reported — but a reader comparing "this week" to last week's figure will
 * draw the wrong conclusion from it unless the email says so. The header dates
 * are already honest; this makes them impossible to skim past.
 */
function overrunNote(
  overrun: boolean,
  payload: DigestEmailPayload,
  period: string,
): string {
  if (!overrun) return "";
  return emailParagraph(
    `This digest covers a longer stretch than one ${period} — the dates above are the window it actually read. That happens when a run was missed or the rule was paused: rather than skip the gap, the next digest reports all of it. Don't compare this total to a normal ${period} without allowing for that.`,
    { size: 12, margin: "0 0 16px" },
  );
}

/**
 * The sentence that keeps this email honest.
 *
 * The headline total includes bank debits that have been authorised and not
 * paid, because the owner asked for ACH "in the mix" — which is right, it is
 * committed giving and a fundraising team should see it the week it happens.
 * The whole cost of that decision is that the headline is no longer a bank
 * balance, so this paragraph is not a footnote: it is the thing that makes the
 * number above it safe to quote.
 *
 * Four facts, in the order a reader needs them: how much isn't here yet, how
 * much IS, that a bank can still refuse it, and — the one that is easy to
 * forget to say — that a transfer which DOES clear is counted again, as a
 * settled gift, in the digest covering the day it lands.
 *
 * The refusal clause matters most: the failure path
 * (`checkout.session.async_payment_failed`) silently drops the amount from
 * every later digest and deliberately sends no correction, so the only warning
 * anyone ever gets that a figure might not survive is this line.
 *
 * The clearing clause is what stops the other mistake. Pending is windowed on
 * when the debit was AUTHORISED and a gift on when it ARRIVED, which are days
 * apart — so adding a quarter's digest headlines together over-counts every ACH
 * gift exactly once. Each digest is true about its own period; the sum of them
 * is not a total, and a reader has to be told that where they'd notice.
 *
 * Rendered directly under the headline, before the summary panel and before
 * every breakdown, so there is no reading order in which the total is seen
 * without it.
 */
function pendingNote(payload: DigestEmailPayload): string {
  if (payload.pendingCents <= 0) return "";
  const settled = payload.totalCents - payload.pendingCents;
  const n = payload.pendingCount;
  return emailPanel(
    emailParagraph(
      `<b>${esc(formatCents(payload.pendingCents))} of this total hasn't cleared the bank yet.</b> ` +
        `${n === 1 ? "One gift" : `${n} gifts`} came in by bank transfer (ACH), which takes about ` +
        `${esc(ACH_CLEARING_WINDOW)} to land — so it's committed, but it isn't in the account. ` +
        `<b>${esc(formatCents(settled))}</b> of the total has actually settled. ` +
        `A bank can still refuse a transfer; if one is, it simply drops out of the next digest. ` +
        `And when one clears you'll see it again — as a settled gift, in the digest covering the day it lands — ` +
        `so don't add these totals up across weeks.`,
      { margin: "0" },
    ),
    { margin: "0 0 16px" },
  );
}

/** One in-flight ACH gift. No donor link and no first-gift flag, deliberately —
 *  neither is a fact yet. See `DigestPendingGift`. */
function pendingRowHtml(gift: DigestPendingGift): string {
  const t = EMAIL_THEME;
  const meta = `Authorized ${giftDate(gift.submittedAt)} · ${gift.scopeLabel} · still clearing`;
  return (
    `<div style="padding:10px 0;border-bottom:1px solid ${t.border}">` +
    `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ strong: true })}">` +
    `${esc(formatCents(gift.amountCents))} — ${esc(gift.donorName)}` +
    `</div>` +
    `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ size: 12 })}">${esc(meta)}</div>` +
    `</div>`
  );
}

function giftRowHtml(gift: NotificationGift): string {
  const t = EMAIL_THEME;
  const meta = [
    giftMethodLabel(gift.method),
    gift.scopeLabel,
    giftDate(gift.receivedAt),
    ...(gift.eventName ? [gift.eventName] : []),
  ].join(" · ");
  return (
    `<div style="padding:10px 0;border-bottom:1px solid ${t.border}">` +
    `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ strong: true })}">` +
    `${esc(formatCents(gift.amountCents))} — ${donorNameHtml(gift.donor)}` +
    (gift.donor.isFirstGift
      ? ` <span style="color:${t.accent};font-weight:700">first gift</span>`
      : "") +
    `</div>` +
    `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ size: 12 })}">${esc(meta)}</div>` +
    `</div>`
  );
}

/**
 * A period of giving. Totals first (that's the number the fundraising team
 * carries around), the biggest gift called out by name, then three cuts of that
 * same money — by giving type, by chapter, by rails — and finally every gift,
 * each linking to its own donor.
 *
 * EACH CUT PARTITIONS THE WHOLE PERIOD and prints its own total, so all three
 * add up to the headline figure and a reader can see that they do. They are
 * three answers to three different questions about one number, not three
 * samples of it.
 *
 * An EMPTY weekly digest still renders, and says so plainly. See
 * `lib/givingNotificationRules.ts` for why that is deliberate and why the
 * daily one doesn't.
 */
export function renderDigestEmail(payload: DigestEmailPayload): {
  subject: string;
  html: string;
} {
  const period = payload.cadence === "weekly" ? "week" : "day";
  // "THIS WEEK" HAS TO BE TRUE. A window can legitimately run long — a rule
  // that missed a fortnight of runs reports the fortnight, so nothing
  // un-reported is skipped — and a subject reading "this week" over 21 days is
  // a lie in the one line most recipients read. Past the tolerance the subject
  // names the window's start instead, which is never wrong at any length.
  const span = payload.periodEnd - payload.periodStart;
  const overrun = span > LONG_WINDOW_FACTOR * cadencePeriodMs(payload.cadence);
  const when = payload.countTruncated
    ? // A CUT window is a SLICE of the period, not the period: the read stopped
      // partway and the rest is the next digest's. "this week" over a slice
      // overstates in exactly the direction the FLOOR caveat further down works
      // to correct, and a subject shouldn't need the paragraph underneath it to
      // walk it back.
      "so far"
    : overrun
      ? `since ${DATE_FMT.format(new Date(payload.periodStart))}`
      : `this ${period}`;
  // THE CAVEAT RIDES IN THE SUBJECT, not only in the body. A subject line is
  // where a busy recipient triages and, more to the point, it is what gets
  // quoted in a chat message and read aloud in a meeting by someone who never
  // opened the mail. A headline that silently folds in money the bank hasn't
  // moved is exactly the figure that ends up in a board deck as cash.
  const clearing =
    payload.pendingCents > 0
      ? ` (${formatCents(payload.pendingCents)} still clearing)`
      : "";
  const subject =
    payload.giftCount === 0
      ? payload.countTruncated
        ? `Giving digest cut short — ${payload.scopeLabel}`
        : `No giving ${when} — ${payload.scopeLabel}`
      : `${formatCents(payload.totalCents)} from ${payload.giftCount} ${
          payload.giftCount === 1 ? "gift" : "gifts"
        }${clearing} ${when} — ${payload.scopeLabel}`;

  const header = [
    emailEyebrow(esc(`${payload.cadence} giving digest`)),
    emailHeading(
      payload.giftCount === 0
        ? payload.countTruncated
          ? "This digest was cut short"
          : "No gifts came in"
        : esc(formatCents(payload.totalCents)),
      { size: payload.giftCount === 0 ? 26 : 34, margin: "0 0 4px" },
    ),
    emailParagraph(
      `${esc(formatPeriod(payload.periodStart, payload.periodEnd))} · ${esc(payload.scopeLabel)}`,
      { strong: true, margin: "0 0 20px" },
    ),
  ].join("\n");

  if (payload.giftCount === 0) {
    const inner = [
      header,
      emailParagraph(
        payload.countTruncated
          ? `Nothing matched this rule in the stretch of the ledger this digest was able to read — but the read stopped short of the whole ${period}, so this is not the same as "no giving". The next digest carries on from where this one stopped.`
          : `Nothing was recorded in the giving ledger ${when}. That's the whole report — if you expected gifts here, that's worth a look.`,
        { margin: "0 0 16px" },
      ),
      overrunNote(overrun, payload, period),
      emailRule(),
      emailParagraph(`Sent by the giving rule “${esc(payload.ruleName)}”.`, {
        size: 12,
        margin: "0",
      }),
    ].join("\n");
    return { subject, html: emailShell(inner) };
  }

  const largest = payload.largest;
  const hasPending = payload.pendingCents > 0;
  const inner = [
    header,
    // BEFORE the overrun note and before the panel: no reading order reaches
    // the total without the caveat.
    pendingNote(payload),
    overrunNote(overrun, payload, period),
    emailPanel(
      [
        detailRow("Gifts", String(payload.giftCount)),
        detailRow("Total", esc(formatCents(payload.totalCents))),
        // The two halves of that total, spelled out on the panel as well as in
        // the paragraph — the panel is what people screenshot.
        hasPending
          ? detailRow(
              "Settled",
              esc(formatCents(payload.totalCents - payload.pendingCents)),
            )
          : "",
        hasPending
          ? detailRow(
              "Still clearing",
              breakdownValue(payload.pendingCents, payload.pendingCount),
            )
          : "",
        largest
          ? detailRow(
              // Named for what it actually is whenever that could mislead: with
              // pending money in the period, the biggest gift OF THE PERIOD may
              // well be one of the ones that hasn't landed. See the reasoning
              // in `buildDigestPayload`.
              hasPending ? "Largest settled" : "Largest",
              `${esc(formatCents(largest.amountCents))} — ${donorNameHtml(largest.donor)}`,
            )
          : "",
      ]
        .filter(Boolean)
        .join(""),
      { margin: "0 0 16px" },
    ),
    // Type first: "how much of this recurs" is the question the rest of the
    // email can't answer and the one a fundraising team plans against.
    breakdownHtml("By giving type", payload.byType),
    breakdownHtml("By chapter", payload.byScope),
    breakdownHtml("How it arrived", payload.byMethod),
    // Guarded, because a period can now consist ENTIRELY of pending ACH — the
    // digest sends, the headline is real, and there is not one settled gift to
    // list. An "Every gift" heading over nothing reads as a bug.
    payload.gifts.length > 0
      ? emailSubheading("Every gift", { size: 14, margin: "0 0 4px" })
      : "",
    payload.gifts.map(giftRowHtml).join(""),
    payload.omittedCount > 0
      ? emailParagraph(
          `…and ${payload.omittedCount} more, counted in the totals above. Open the gifts ledger to see them all.`,
          { size: 12, margin: "12px 0 0" },
        )
      : "",
    // ITEMIZED SEPARATELY, never mixed into the list above. These rows are not
    // in the gifts ledger and will not be until the bank moves the money;
    // interleaving them with settled gifts would put a row in front of a
    // fundraiser that looks exactly like one they can thank someone for.
    payload.pending.length > 0
      ? emailSubheading("Still clearing", { size: 14, margin: "20px 0 4px" })
      : "",
    payload.pending.map(pendingRowHtml).join(""),
    payload.pendingOmittedCount > 0
      ? emailParagraph(
          `…and ${payload.pendingOmittedCount} more bank transfers still clearing, counted in the totals above.`,
          { size: 12, margin: "12px 0 0" },
        )
      : "",
    payload.countTruncated
      ? emailParagraph(
          "This period held more giving than one digest reads at a time, so the total above is a FLOOR, not the figure — open the gifts ledger for the real number. The rest has not been lost: the next digest carries on from exactly where this one stopped.",
          { size: 12, margin: "12px 0 0", strong: true },
        )
      : "",
    emailRule(),
    emailParagraph(`Sent by the giving rule “${esc(payload.ruleName)}”.`, {
      size: 12,
      margin: "0",
    }),
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html: emailShell(inner) };
}

/** Exported for the tests that assert a digest names its window in the org's
 *  timezone rather than the runner's. */
export function formatSentAt(ts: number): string {
  return DATE_TIME_FMT.format(new Date(ts));
}
