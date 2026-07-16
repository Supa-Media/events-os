/**
 * Small display helpers shared by the manager + member Cards views. Every card
 * value comes from a `CardSummary` (`api.cards.listCards` / `api.cards.myCard`);
 * these turn the raw fields into the prototype's labels + badge tones. Money is
 * integer cents — formatted only at the leaves via `formatCents`.
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { CardStatus, CardType } from "@events-os/shared";
import { RECEIPT_GRACE_DAYS } from "@events-os/shared";
import type { BadgeTone, IconName } from "../../ui";

/** The read projection both card views render. */
export type CardSummary = FunctionReturnType<typeof api.cards.listCards>[number];
/** The pending/settled repayment a flag returns. */
export type RepaymentSummary = FunctionReturnType<
  typeof api.cards.flagPersonalCharge
>;
/** One row of the caller's own outstanding personal-charge repayments — the
 *  "You owe Public Worship" data source shared by `OwedBanner` + the per-charge
 *  list in `MemberCardsView` (D4). */
export type MyRepayment = FunctionReturnType<
  typeof api.cards.myPersonalRepayments
>[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** "virtual" → "Virtual". */
export function cardTypeLabel(type: CardType): string {
  return type === "physical" ? "Physical" : "Virtual";
}

/** "•••• •••• •••• 4821" (placeholder dots until Increase fills in a last4). */
export function maskedNumber(last4: string | null): string {
  return `•••• •••• •••• ${last4 ?? "••••"}`;
}

/** "exp 07/29" from a validity end, or the placeholder when open-ended. */
export function expLabel(validUntil: number | null): string {
  if (validUntil == null) return "exp ••/••";
  const d = new Date(validUntil);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `exp ${mm}/${yy}`;
}

/** `Jul 17` in the finance timezone. */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/** Whole days from `now` until `ts` (negative once past). */
export function daysUntil(ts: number, now = Date.now()): number {
  return Math.ceil((ts - now) / DAY_MS);
}

type StatusChip = { label: string; tone: BadgeTone; icon?: IconName };

/** The lifecycle badge shown in the cardholders table + member header. */
export function cardStatusBadge(status: CardStatus): StatusChip {
  switch (status) {
    case "locked":
      return { label: "Locked", tone: "warn", icon: "lock" };
    case "canceled":
      return { label: "Canceled", tone: "neutral", icon: "slash" };
    default:
      return { label: "Active", tone: "success", icon: "check" };
  }
}

/**
 * The receipts column: a card is "on the hook" once it has an active grace
 * window (`receiptGraceEndsAt`). Past due (or already locked) reads danger/warn;
 * still inside the {@link RECEIPT_GRACE_DAYS}-day window shows the countdown.
 */
export function receiptStatus(card: CardSummary): StatusChip {
  const grace = card.receiptGraceEndsAt;
  if (grace == null && card.status !== "locked") {
    return { label: "Up to date", tone: "success", icon: "check" };
  }
  if (card.status === "locked" || (grace != null && grace <= Date.now())) {
    return { label: "Receipt overdue", tone: "warn", icon: "flag" };
  }
  const days = grace != null ? daysUntil(grace) : RECEIPT_GRACE_DAYS;
  return { label: `Receipt due · ${days}d`, tone: "warn", icon: "flag" };
}

/** True once a card is "on the hook" for a receipt (drives the manager tile). */
export function hasReceiptDue(card: CardSummary): boolean {
  return card.receiptGraceEndsAt != null || card.status === "locked";
}
