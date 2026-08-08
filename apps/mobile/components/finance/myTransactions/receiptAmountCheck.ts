/**
 * RECEIPT AMOUNT PRE-CHECK — "this receipt shows $42.17 but the charge is
 * $58.30; is this the right receipt, or a partial?"
 *
 * The single most likely send-back is "receipt must show exact amount" (owner,
 * 2026-08-08), and it is the one a machine can catch at ATTACH time, before a
 * reviewer ever spends attention on it. See `docs/plans/transaction-coding.md`
 * ("Mistake-proofing the editor").
 *
 * WHERE THE NUMBER COMES FROM, AND WHY IT ISN'T OCR YET. The plan wants this
 * driven by `receipts.ocrAmountCents`. That field is unreachable from this
 * screen today: every read in `apps/convex/receipts.ts` (`listForTransaction`,
 * `getReceipt`, `listReceipts`) is gated at bookkeeper+, and the entire point
 * of My Transactions is the cardholder who holds no finance role — so a
 * cardholder cannot see the OCR'd total of their own receipt. Until a
 * member-safe read exposes it, the comparison runs on the number the human
 * reads off the receipt they are looking at, which still fires the warning at
 * the right moment and still costs a reviewer nothing. The day the OCR total
 * is reachable, feed it to `receiptAmountMismatch` and the identical sentence
 * appears with nobody typing anything.
 */
import { formatCents } from "@events-os/shared";

/**
 * A typed dollar amount as whole cents — "$58.30", "58.30", "58" all read as
 * 5830. Returns `null` for anything that isn't a plain non-negative amount,
 * so a half-typed entry ("58.") warns about nothing rather than about the
 * wrong thing.
 */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  if (cleaned === "" || cleaned === ".") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * The warning to show when the receipt's total and the charge disagree, or
 * `null` when they match (silence is the reward for getting it right — a
 * form that congratulates every correct entry teaches people to stop
 * reading it).
 *
 * `chargeCents` is compared on magnitude: a card charge is stored as an
 * outflow and the receipt is always printed as a positive total.
 */
export function receiptAmountMismatch(
  receiptCents: number,
  chargeCents: number,
): string | null {
  const charge = Math.abs(chargeCents);
  const receipt = Math.abs(receiptCents);
  if (receipt === charge) return null;
  const tail =
    receipt < charge
      ? "is this the right receipt, or does it only cover part of the charge?"
      : "is this the right receipt, or does it cover more than this one charge?";
  return `This receipt shows ${formatCents(receipt)} but the charge is ${formatCents(charge)} — ${tail}`;
}
