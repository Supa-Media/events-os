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
import { ORG_TIME_ZONE, clampSubjectName } from "./givingNotificationRules";

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

export type DigestEmailPayload = {
  ruleName: string;
  cadence: "daily" | "weekly";
  /** The rule's own reach, for the subject line ("Central", a chapter name,
   *  or "All books"). */
  scopeLabel: string;
  periodStart: number;
  periodEnd: number;
  totalCents: number;
  giftCount: number;
  largest: NotificationGift | null;
  byScope: DigestBreakdownRow[];
  byMethod: DigestBreakdownRow[];
  /** The itemized gifts, newest first, capped. */
  gifts: NotificationGift[];
  /** How many gifts the totals counted but the list omitted. */
  omittedCount: number;
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

function breakdownHtml(title: string, rows: DigestBreakdownRow[]): string {
  if (rows.length === 0) return "";
  const body = rows
    .map((r) =>
      detailRow(
        r.label,
        `${esc(formatCents(r.cents))} <span style="color:${EMAIL_THEME.muted}">(${r.count})</span>`,
      ),
    )
    .join("");
  return (
    emailSubheading(esc(title), { size: 14, margin: "0 0 6px" }) +
    emailPanel(body, { margin: "0 0 16px" })
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
 * carries around), the biggest gift called out by name, then the two cuts that
 * answer "where did it come from" — by book and by source — and finally every
 * gift, each linking to its own donor.
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
  const subject =
    payload.giftCount === 0
      ? payload.countTruncated
        ? `Giving digest cut short — ${payload.scopeLabel}`
        : `No giving this ${period} — ${payload.scopeLabel}`
      : `${formatCents(payload.totalCents)} from ${payload.giftCount} ${
          payload.giftCount === 1 ? "gift" : "gifts"
        } this ${period} — ${payload.scopeLabel}`;

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
          : `Nothing was recorded in the giving ledger for this ${period}. That's the whole report — if you expected gifts here, that's worth a look.`,
        { margin: "0 0 16px" },
      ),
      emailRule(),
      emailParagraph(`Sent by the giving rule “${esc(payload.ruleName)}”.`, {
        size: 12,
        margin: "0",
      }),
    ].join("\n");
    return { subject, html: emailShell(inner) };
  }

  const largest = payload.largest;
  const inner = [
    header,
    emailPanel(
      [
        detailRow("Gifts", String(payload.giftCount)),
        detailRow("Total", esc(formatCents(payload.totalCents))),
        largest
          ? detailRow(
              "Largest",
              `${esc(formatCents(largest.amountCents))} — ${donorNameHtml(largest.donor)}`,
            )
          : "",
      ]
        .filter(Boolean)
        .join(""),
      { margin: "0 0 16px" },
    ),
    breakdownHtml("Where it went", payload.byScope),
    breakdownHtml("How it arrived", payload.byMethod),
    emailSubheading("Every gift", { size: 14, margin: "0 0 4px" }),
    payload.gifts.map(giftRowHtml).join(""),
    payload.omittedCount > 0
      ? emailParagraph(
          `…and ${payload.omittedCount} more, counted in the totals above. Open the gifts ledger to see them all.`,
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
