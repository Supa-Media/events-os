/**
 * Pure helpers for the Reconcile screen — status → inbox-state derivation, badge
 * tones, signed-money formatting, and the receipt-reminder timeline.
 *
 * Kept JSX-free so the derivations are trivially testable and the components
 * stay presentational. Everything money-shaped runs through `formatCents`.
 *
 * DATA NOTE: `listTransactions` (its `txnSummary` projection) returns only
 * `{id, postedAt, amountCents, flow, status, description, merchantName, fundId,
 * categoryId}` — there is no receipt/card/spender field yet. So the reconcile
 * "state", the receipt line, and the reminder timeline are all *derived from
 * `status` + `postedAt`* until real receipt tracking lands (finance Phase 3).
 */
import type { FunctionReturnType } from "convex/server";
import { formatCents, type TransactionStatus } from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { BadgeTone } from "../../ui";

/** One row of the reconcile inbox — the exact `listTransactions` page shape. */
export type TxnRow =
  FunctionReturnType<typeof api.finances.listTransactions>["page"][number];

/** The AI proposal shape `suggestCoding` returns (ids are strings on the wire). */
export type CodingSuggestion = {
  fundId?: string | null;
  categoryId?: string | null;
  eventId?: string | null;
  rationale?: string | null;
};

// ── Inbox state (derived from the stored status) ─────────────────────────────
export type ReconcileState = "uncategorized" | "receipt_due" | "ready";

/** Map a transaction status to the reconcile-inbox state shown as a row badge. */
export function stateForStatus(status: TransactionStatus): ReconcileState {
  if (status === "reconciled") return "ready";
  if (status === "categorized") return "receipt_due";
  return "uncategorized"; // "unreviewed" (excluded rows are dropped upstream)
}

export const STATE_BADGE: Record<
  ReconcileState,
  { label: string; tone: BadgeTone }
> = {
  uncategorized: { label: "Uncategorized", tone: "neutral" },
  receipt_due: { label: "Receipt due", tone: "warn" },
  ready: { label: "Ready", tone: "info" },
};

// ── Filter pills ─────────────────────────────────────────────────────────────
export type FilterKey = "needs_review" | "missing_receipt" | "ready";

export const FILTERS: {
  key: FilterKey;
  label: string;
  state: ReconcileState;
}[] = [
  { key: "needs_review", label: "Needs review", state: "uncategorized" },
  { key: "missing_receipt", label: "Missing receipt", state: "receipt_due" },
  { key: "ready", label: "Ready", state: "ready" },
];

// ── Receipt line state ───────────────────────────────────────────────────────
export type ReceiptState = "none" | "due" | "ok";

/** Derive the receipt-line state from status (proxy until receipts are tracked). */
export function receiptStateForStatus(status: TransactionStatus): ReceiptState {
  if (status === "reconciled") return "ok";
  if (status === "categorized") return "due";
  return "none";
}

export const RECEIPT_COPY: Record<
  ReceiptState,
  { text: string; tone: "faint" | "warn" | "success"; canUpload: boolean }
> = {
  none: {
    text: "No receipt yet — reminder sent to spender",
    tone: "faint",
    canUpload: true,
  },
  due: {
    text: "Receipt overdue · flagged today",
    tone: "warn",
    canUpload: true,
  },
  ok: {
    text: "Receipt attached · ready to reconcile",
    tone: "success",
    canUpload: false,
  },
};

// ── Money + dates ────────────────────────────────────────────────────────────
/** U+2212 true minus (matches the prototype), not an ASCII hyphen. */
const MINUS = "−";

/** Signed money: outflow renders `−$64.20`, inflow/transfer stays positive. */
export function signedMoney(amountCents: number, flow: string): string {
  const money = formatCents(amountCents);
  return flow === "outflow" ? `${MINUS}${money}` : money;
}

const TZ = "America/New_York";

/** `Jul 10` — the compact list/timeline date. */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: TZ,
  });
}

/** `Jul 10, 2026` — the detail-pane meta date. */
export function longDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: TZ,
  });
}

// ── Receipt-reminder timeline ────────────────────────────────────────────────
export type TimelineStepState = "done" | "active" | "pending";
export type TimelineStep = {
  title: string;
  sub: string;
  state: TimelineStepState;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the four-step receipt-reminder schedule (Purchased → End-of-day flag →
 * Day-3 escalate → Day-7 auto-lock). Real reminder scheduling lands in Phase 3;
 * until then the step states are derived from the charge's age, with the whole
 * schedule marked resolved once a receipt is attached (`ok`). Thresholds are in
 * days since the charge posted.
 */
export function receiptTimeline(
  postedAt: number,
  receipt: ReceiptState,
): TimelineStep[] {
  const thresholds = [0, 1, 3, 7];
  const dateAt = (days: number) => shortDate(postedAt + days * DAY_MS);
  const defs = [
    {
      title: "Purchased — reminder sent",
      sub: (d: string) => `${d} · reminder sent to spender`,
    },
    {
      title: "End of day — flagged",
      sub: (d: string) => `${d} · spender emailed again`,
    },
    {
      title: "Day 3 — escalate to finance manager",
      sub: (d: string) => `${d} · appears in the attention list`,
    },
    {
      title: "Day 7 — card auto-locks",
      sub: (d: string) => `${d} · unlocks the moment the receipt lands`,
    },
  ];

  // Receipt attached → the whole schedule is resolved.
  if (receipt === "ok") {
    return defs.map((def, i) => ({
      title: def.title,
      sub: def.sub(dateAt(thresholds[i])),
      state: "done" as const,
    }));
  }

  const daysSince = Math.max(0, Math.floor((Date.now() - postedAt) / DAY_MS));
  // The current step is the last threshold the charge has reached.
  const currentIndex = thresholds.reduce(
    (acc, t, i) => (daysSince >= t ? i : acc),
    0,
  );
  return defs.map((def, i) => ({
    title: def.title,
    sub: def.sub(dateAt(thresholds[i])),
    state: i < currentIndex ? "done" : i === currentIndex ? "active" : "pending",
  }));
}

/** Strip the prototype's leading em-dash from an AI rationale, if present. */
export function cleanRationale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/^\s*[—-]\s*/, "").trim() || null;
}
