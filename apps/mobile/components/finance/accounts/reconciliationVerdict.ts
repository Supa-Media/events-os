/**
 * The three shapes the reconciliation answer can take, decided once.
 *
 * `ReconciliationSummary` used to branch on `verdict === "balanced"`,
 * `verdict === "balanced" && incomplete`, `differenceCents`, and
 * `missingTerms` inline, in four separate places in one JSX tree. That was
 * survivable while the panel showed all of its working: a reader who saw a
 * wrong headline still had the piles underneath to correct them with.
 *
 * The 2026-08-09 condense removed that safety net. The default view is now the
 * headline and almost nothing else, so a branch that picks the wrong one is no
 * longer a cosmetic slip — it is the entire message. Pulling the decision into
 * one dependency-free function makes it unit-testable without a renderer, and
 * makes the three cases impossible to get out of sync with each other.
 *
 * ── WHY THREE CASES AND NOT TWO ──────────────────────────────────────────────
 *
 * `balanced` and `gap` are the obvious pair. The third, `unknowable`, is the
 * one that keeps the panel honest: a difference of exactly zero is only a
 * reconciliation if every term on the money side has actually been read. With
 * Stripe never fetched, the cash side is short by whatever Stripe is holding —
 * which could be thousands — so a zero is a coincidence and reporting it as
 * "it adds up" is the worst failure this panel has, because it is confidently
 * wrong and looks exactly like being right.
 *
 * ── WHY NO COPY LIVES HERE ───────────────────────────────────────────────────
 *
 * This returns semantics — which case, which direction, which tone — and never
 * a sentence. Copy belongs beside the layout that has to fit it, and a test
 * that asserts on wording fails on every wording change while catching none of
 * the failures that matter. What matters is that a negative difference never
 * renders as "more cash than the books explain", that an exact match never
 * renders in an alarm colour, and that a zero we cannot vouch for never claims
 * to add up. Those are all here.
 */

/** Mirrors `ReconciliationVerdict` in `apps/convex/lib/reconciliationGap.ts`. */
export type GapVerdict = "balanced" | "cash_exceeds_books" | "books_exceed_cash";

/** Mirrors `ReconciliationTerm` in `apps/convex/lib/reconciliationGap.ts`. */
export type GapTerm = "stripe" | "givebutter";

export type CondensedVerdict = {
  /**
   * `balanced` — books and money agree AND every term was read.
   * `unknowable` — they agree, but a processor balance is missing, so the
   *   agreement proves nothing.
   * `gap` — they differ; `cashHigh` says which way.
   */
  kind: "balanced" | "unknowable" | "gap";
  /** Card tone. `unknowable` is warn, not success — it is not good news. */
  tone: "success" | "warn";
  /** Feather icon for the headline. */
  icon: "check-circle" | "help-circle" | "alert-triangle";
  /**
   * True when there is MORE cash than the books explain (unrecorded income),
   * false when the books claim money that is nowhere (a double count). Only
   * meaningful for `kind: "gap"`, and the sole reason this function exists:
   * the two send a treasurer to opposite ends of the app.
   */
  cashHigh: boolean;
  /**
   * The gap as a positive number of cents, for display beside a directional
   * label. Zero for `balanced` and `unknowable`, which deliberately show no
   * figure at all — "$0.00 unaccounted for" in a warning colour is an alarm
   * about nothing.
   */
  amountCents: number;
  /**
   * The vendors we have never read, named for the copy: "Stripe",
   * "Givebutter", or "Stripe or Givebutter". Empty string when nothing is
   * missing. Named rather than counted because which one it is decides where
   * the reader goes next.
   */
  missingLabel: string;
};

const VENDOR_LABEL: Record<GapTerm, string> = {
  stripe: "Stripe",
  givebutter: "Givebutter",
};

export function condenseVerdict(input: {
  verdict: GapVerdict;
  differenceCents: number;
  /** `missingTerms.length > 0` — a term on the money side was never read. */
  incomplete: boolean;
  missingTerms: readonly GapTerm[];
}): CondensedVerdict {
  const missingLabel = input.missingTerms
    .map((t) => VENDOR_LABEL[t])
    .join(" or ");

  // Trust the server's verdict rather than re-deriving it from the sign here.
  // `reconciliationGap.ts` owns that arithmetic and its sign convention; a
  // second implementation on the client is a second thing to keep in step.
  if (input.verdict === "balanced") {
    return input.incomplete
      ? {
          kind: "unknowable",
          tone: "warn",
          icon: "help-circle",
          cashHigh: false,
          amountCents: 0,
          missingLabel,
        }
      : {
          kind: "balanced",
          tone: "success",
          icon: "check-circle",
          cashHigh: false,
          amountCents: 0,
          missingLabel,
        };
  }

  return {
    kind: "gap",
    tone: "warn",
    icon: "alert-triangle",
    cashHigh: input.verdict === "cash_exceeds_books",
    amountCents: Math.abs(input.differenceCents),
    missingLabel,
  };
}
