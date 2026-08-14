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
 * ── THE MONTH'S OWN PROGRESS ──────────────────────────────────────────────
 * A month band carries that month's explained progress, which is what lets
 * month grouping stand in for the Explain screen's per-month meter.
 *
 * It comes from the SERVER (`groups[].explainable*` / `explained*`), computed
 * in the same loop that builds the group and with the same two predicates the
 * whole-set `explainedProgress` uses — so this band and that month on the
 * Explain screen cannot report different numbers.
 *
 * It is not computed here, and could not be. Counting the page's own rows
 * would be wrong the moment a group exceeds the 100-row page, which is every
 * real month; and recomputing the population client-side is impossible, since
 * the denominator reads `feeOrigin`, `source`, `sourceCategory` and both
 * refund pointers off the transaction — none of which `reconcileRow` ships,
 * by design.
 *
 * A group with nothing explainable in it (all fees, all transfers) shows no
 * progress at all rather than "0 of 0", which reads as failure.
 */
import { View, Text } from "react-native";
import { formatCents } from "@events-os/shared";

export function ReconcileGroupHeader({
  label,
  count,
  totalCents,
  shownCount,
  explainableCount,
  explainedCount,
}: {
  label: string;
  /** Over the whole match set — see the module doc. */
  count: number;
  totalCents: number;
  /** How many of `count` are on the loaded page. */
  shownCount: number;
  /** This group's own progress, server-computed over the whole match set. */
  explainableCount: number;
  explainedCount: number;
}) {
  const partial = shownCount < count;
  // Nothing in this group can carry an explanation (a month of fees and
  // transfers) — say nothing rather than "0 of 0", which reads as a failure
  // to do work that was never owed.
  const showProgress = explainableCount > 0;
  const done = showProgress && explainedCount >= explainableCount;
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
      {showProgress ? (
        <Text
          className={`text-2xs ${done ? "font-semibold text-success" : "text-muted"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {done
            ? "✓ all explained"
            : `${explainedCount} of ${explainableCount} explained`}
        </Text>
      ) : null}
    </View>
  );
}
