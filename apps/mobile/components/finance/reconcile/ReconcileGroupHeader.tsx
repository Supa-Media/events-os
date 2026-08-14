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
 * ── THE ACTION IS PINNED TO THE VIEWPORT, NOT TO THE TABLE ────────────────
 * That fixed width is ~1776px in a single-book scope, and `action` used to be
 * pushed to the far end of it with a `flex-1` spacer. On a laptop that put the
 * person band's "Send reminder" — the single affordance the founder named as
 * the thing he liked — roughly 500px past the right edge of the window, behind
 * a horizontal scroll gesture with no affordance pointing at it. Founder, on
 * the deployed build: "why can't I see the header?" It was rendered, and it
 * could not be seen.
 *
 * So the band's CONTENT is laid out at `contentWidth` — the visible width of
 * the grid's scroll container, measured by the caller — while the band's own
 * background and hairline still span the full table width so it keeps looking
 * like one band across every column when the grid is scrolled. The action then
 * lands inside the window at rest, where a person reading a column of bands
 * can actually see and press it.
 *
 * Unmeasured (`contentWidth` absent, which is every jsdom test and the first
 * frame) falls back to the old full-width layout, so nothing about the band
 * depends on a measurement having arrived.
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
  unfilteredCount,
  unfilteredTotalCents,
  progress,
  imageUrl = null,
  showAvatar = false,
  action = null,
  contentWidth = null,
}: {
  label: string;
  /** Over the whole match set — see the module doc. */
  count: number;
  totalCents: number;
  /** How many of `count` are on the loaded page. */
  shownCount: number;
  /** ── THE MONTH'S WHOLE SIZE (month bands only) ───────────────────────────
   *
   *  `count`/`totalCents` are the MATCH SET; these are the month before any
   *  filter or search. When they differ the band says both — "12 of 318
   *  charges · -$4,102 of -$88,201" — which is what makes the Publish button
   *  beside them honest: publishing acts on the month, not on the selection,
   *  and this is the band saying so rather than the button being taken away
   *  (which is what #707 did, and what the founder asked to have back).
   *
   *  Absent, or equal to the match-set figures, and the band prints one
   *  figure exactly as it always did. */
  unfilteredCount?: number;
  unfilteredTotalCents?: number;
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
  /** The VISIBLE width of the grid's horizontal scroller, so the band's
   *  content — and with it `action` — stays inside the window instead of
   *  being pushed to the far end of a ~1776px table. `null` (unmeasured)
   *  keeps the old full-width layout. See the module doc. */
  contentWidth?: number | null;
}) {
  const partial = shownCount < count;
  // ── TWO FIGURES WHEN THE GRID IS NARROWED ────────────────────────────────
  // Only when the server actually sent a baseline (month bands) AND it differs
  // from the match set. Equal figures print once, so an unfiltered grid is
  // untouched, and a person band — which has no baseline — can never start
  // comparing itself to anything.
  const narrowedCount = unfilteredCount != null && unfilteredCount !== count;
  const narrowedTotal =
    unfilteredTotalCents != null && unfilteredTotalCents !== totalCents;
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
      //
      // The OUTER view still fills the table's full width, so the band's
      // background and hairline run under every column when the grid is
      // scrolled right. Only its CONTENT is capped to the visible width — see
      // the module doc for why that is the fix and not a compromise.
      className="border-b border-border bg-sunken"
      accessibilityRole="header"
    >
    <View
      className="flex-row items-center gap-2 px-3 py-1.5"
      style={contentWidth != null ? { width: contentWidth } : undefined}
    >
      {showAvatar ? <Avatar name={label || "?"} size={20} uri={imageUrl} /> : null}
      <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
        {label}
      </Text>
      {/* "12 of 318 charges" while narrowed, plain "318 charges" otherwise.
          The band has to be able to name the WHOLE month, because the Publish
          button at the far end of it acts on the whole month. */}
      <Text
        className="text-2xs text-muted"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {narrowedCount
          ? `${count} of ${unfilteredCount} ${unfilteredCount === 1 ? "charge" : "charges"}`
          : `${count} ${count === 1 ? "charge" : "charges"}`}
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
      {/* The month's own money, in faint type beside the selection's. A
          separate node rather than one string, so the selection's figure keeps
          its warn/muted colouring and the month's reads plainly as context. */}
      {narrowedTotal ? (
        <Text
          className="text-2xs text-faint"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {`of ${formatCents(unfilteredTotalCents as number)}`}
        </Text>
      ) : null}
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
      {/* Pushed to the far end of the VISIBLE band, so the band's numbers
          stay left-aligned with every other band's and the button lands in one
          predictable place down a column of people — inside the window,
          which is the whole point (see the module doc). */}
      {action ? (
        <>
          <View className="flex-1" />
          {action}
        </>
      ) : null}
    </View>
    </View>
  );
}
