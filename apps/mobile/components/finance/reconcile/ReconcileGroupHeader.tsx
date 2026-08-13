/**
 * A GROUP HEADER ROW — one band spanning the whole grid, before each group's
 * rows: "June 2024 · 40 charges · -$8,412.19".
 *
 * Rendered inside the grid's fixed-width scroll container, so it spans exactly
 * the columns currently on screen and needs no width of its own — which is
 * what makes it correct in both frames the grid has: panel closed (all
 * columns) and panel open (Cardholder / What it was for / Documentation
 * dropped, ~676px narrower).
 *
 * `count` and `totalCents` come from `listReconcile`'s `groups`, which covers
 * the WHOLE match set rather than the loaded page — a header reading "3 rows"
 * because only 3 of its 40 fit on the page is the dead number this area keeps
 * repairing. When the page genuinely holds only part of a group, the band says
 * so ("12 shown") instead of quietly printing either figure as if it were the
 * other.
 *
 * ── WHAT THIS HEADER CANNOT SAY YET, AND WHY IT DOESN'T GUESS ─────────────
 * A month band should carry that month's own explained progress — that is what
 * would let month grouping retire the Explain screen's per-month meter. It
 * doesn't, because the figure is not derivable from what the backend returns:
 * `groups[]` carries `key`/`label`/`count`/`totalCents` and no explained
 * fields, and `explainedProgress` is a single total over the entire match set,
 * not per group.
 *
 * The two ways to fake it are both worse than the absence:
 *   - Counting the page's own rows would be wrong the moment a group exceeds
 *     the 100-row page, which is every real month.
 *   - Recomputing the population client-side is not even possible: the
 *     denominator is `explanationPopulation`, which reads `feeOrigin`,
 *     `source`, `sourceCategory` and both refund pointers off the transaction
 *     — none of which `reconcileRow` ships (by design; see `txnSummaryFields`).
 *
 * The fix is ~8 lines in `finances.ts#listReconcile`, entirely inside the
 * grouping loop that already visits every matched row: accumulate
 * `explainableCount`/`explainableCents`/`explainedCount`/`explainedCents` per
 * group with the same `explanationPopulation(tr)` / `codingState === "approved"`
 * test the whole-set `explainedProgress` block runs three lines earlier, and
 * add the four fields to the `groups` element validator. Zero extra reads.
 * Until that lands this band stays silent about progress rather than shipping
 * a number that would have to be unlearned.
 */
import { View, Text } from "react-native";
import { formatCents } from "@events-os/shared";

export function ReconcileGroupHeader({
  label,
  count,
  totalCents,
  shownCount,
}: {
  label: string;
  /** Over the whole match set — see the module doc. */
  count: number;
  totalCents: number;
  /** How many of `count` are on the loaded page. */
  shownCount: number;
}) {
  const partial = shownCount < count;
  return (
    <View
      // `border-b` only: the row (or column header) above already draws its
      // own bottom hairline, and a `border-y` here would stack two of them.
      className="flex-row items-center gap-2 border-b border-border bg-sunken px-3 py-1.5"
      accessibilityRole="header"
    >
      <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
        {label}
      </Text>
      <Text
        className="text-2xs text-muted"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {`${count} ${count === 1 ? "charge" : "charges"}`}
      </Text>
      {partial ? (
        <Text className="text-2xs text-faint">{`${shownCount} shown`}</Text>
      ) : null}
      <Text
        className={`text-2xs font-semibold ${
          totalCents < 0 ? "text-warn" : "text-muted"
        }`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(totalCents)}
      </Text>
    </View>
  );
}
