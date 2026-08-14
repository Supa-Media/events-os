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
 *
 * And a month holding BOTH live rows and rows reconstructed from the org's
 * imported 2024–25 records splits the two, headline on the live half — see
 * `showsBacklogSplit` and the block that reads it below. A combined "3 of 453
 * explained" is the figure that makes a finished month look abandoned.
 */
import type { ReactNode } from "react";
import { View, Text } from "react-native";
import { formatCents } from "@events-os/shared";
import { Avatar } from "../../ui";
import { showsBacklogSplit, type ExplainProgress } from "./gridView";

export function ReconcileGroupHeader({
  label,
  count,
  totalCents,
  shownCount,
  progress,
  imageUrl = null,
  showAvatar = false,
  action = null,
}: {
  label: string;
  /** Over the whole match set — see the module doc. */
  count: number;
  totalCents: number;
  /** How many of `count` are on the loaded page. */
  shownCount: number;
  /** This group's own progress, server-computed over the whole match set. */
  progress: ExplainProgress;
  /** PERSON BANDS ONLY — the cardholder's face and, when the caller may send
   *  one, their nudge button.
   *
   *  The chase list this band replaces put a person's avatar, their name, their
   *  outstanding tally and a "Send reminder" beside each other, and the founder
   *  named that presentation as the thing worth keeping ("I actually do like
   *  the way it looks because it does it by person"). The band has to look like
   *  it, or moving the chase into the grid trades a screen people like for one
   *  they don't.
   *
   *  `action` is a slot rather than a nudge prop: this component knows nothing
   *  about seats, rate limits or Convex actions, and shouldn't start to. The
   *  screen owns all of that and hands down a rendered button. */
  imageUrl?: string | null;
  showAvatar?: boolean;
  action?: ReactNode;
}) {
  const partial = shownCount < count;
  // ── THE LIVE/BACKLOG SPLIT, IN A BAND ────────────────────────────────────
  // A month holding 450 rows reconstructed from the org's imported 2024-25
  // records and 3 of its own would read "3 of 453 explained" — the figure that
  // makes a finished month look abandoned, and the reason `monthCodingWorklist`
  // grew a split in the first place. When both populations are present the
  // headline describes the LIVE one and the backlog is named beside it in faint
  // type. `showsBacklogSplit` is the shared rule the progress strip above the
  // grid also applies, so the band and the strip cannot disagree about whether
  // the split is in force.
  const split = showsBacklogSplit(progress);
  const explainableCount = split
    ? progress.liveExplainableCount
    : progress.explainableCount;
  const explainedCount = split
    ? progress.liveExplainedCount
    : progress.explainedCount;
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
      {showAvatar ? <Avatar name={label || "?"} size={20} uri={imageUrl} /> : null}
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
            ? `✓ all explained${split ? " (this month's own rows)" : ""}`
            : `${explainedCount} of ${explainableCount}${split ? " of this month's rows" : ""} explained`}
        </Text>
      ) : null}
      {/* The reconstructed backlog, named but never folded into the headline
          above — imported 2024–25 records still owe a human purpose, they just
          are not what "did I finish this month" is asking about. */}
      {split ? (
        <Text
          className="text-2xs text-faint"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {`+ ${progress.backlogExplainedCount} of ${progress.backlogExplainableCount} imported`}
        </Text>
      ) : null}
      {/* Pushed to the far end, so the band's numbers stay left-aligned with
          every other band's and the button lands in one predictable place down
          a column of people. */}
      {action ? (
        <>
          <View className="flex-1" />
          {action}
        </>
      ) : null}
    </View>
  );
}
