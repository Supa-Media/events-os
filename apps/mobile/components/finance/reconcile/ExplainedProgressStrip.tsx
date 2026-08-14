/**
 * HOW FAR THROUGH THE EXPLAINING THIS SELECTION IS — one line, under the
 * header: "142 of 418 explained · $61.0k of $88.0k".
 *
 * Reads `listReconcile`'s `explainedProgress`, which is computed over the
 * WHOLE match set rather than the loaded page (see its doc comment), so this
 * keeps telling the truth while the grid pages 100 rows of 418. It is the same
 * denominator the Explain screen's own meter uses — `explanationPopulation`,
 * by calling the same function server-side — so a month read here and the same
 * month read there cannot report different progress.
 *
 * ── THE ONE PLACE THE RAW FIGURE WOULD LIE ────────────────────────────────
 * `needs_explaining` is a filter whose whole predicate is "not yet explained",
 * so selecting it removes every explained row from the match set and the
 * numbers arrive as "0 of N · $0 of $X". That is correct backend behavior,
 * deliberately pinned by a test, and NOT something to fix server-side: a
 * progress figure over a selection has to describe that selection.
 *
 * It still cannot be printed as "0 of N explained", which reads as "nobody has
 * explained anything" — the exact opposite of the state that produced it (the
 * explained rows are absent because they are DONE). So under that filter this
 * strip RELABELS rather than suppresses: same rows, same numbers, stated as
 * what they actually are — the work left. Nothing is hidden from the reader,
 * and no figure on screen can be read as "no progress ever made". See
 * `explainedStripMode` for the rule itself.
 */
import { View, Text } from "react-native";
import { InfoTooltip } from "../../ui";
import { compactCents } from "../dashboard/compactCents";
import { explainedStripMode, showsBacklogSplit, type ExplainProgress } from "./gridView";

export type ExplainedProgress = ExplainProgress;

export function ExplainedProgressStrip({
  progress,
  activeFilters,
}: {
  progress: ExplainedProgress;
  /** The grid's active filter set — only consulted for `needs_explaining`,
   *  which is the one selection whose match set makes the raw sentence
   *  misleading. */
  activeFilters: readonly string[];
}) {
  const mode = explainedStripMode(progress, activeFilters);
  if (mode === "hidden") return null;

  // ── THE LIVE/BACKLOG SPLIT (carried over from the Explain screen's own
  // meter, founder-approved 2026-08-13) ─────────────────────────────────────
  // A selection holding 450 rows reconstructed from the org's imported 2024-25
  // records and 3 of this month's own reads as "3% explained" — the backlog
  // swamping the figure that is supposed to answer "did I finish THIS month".
  // So when both populations are present, the HEADLINE describes the live one
  // and the reconstructed backlog gets its own muted line underneath, sized
  // against its own denominator. When only one population exists the combined
  // figure already IS that population, and the single line below is the honest
  // answer on its own — see `showsBacklogSplit`.
  const split = showsBacklogSplit(progress);
  const { explainableCount, explainableCents, explainedCount, explainedCents } =
    split
      ? {
          explainableCount: progress.liveExplainableCount,
          explainableCents: progress.liveExplainableCents,
          explainedCount: progress.liveExplainedCount,
          explainedCents: progress.liveExplainedCents,
        }
      : progress;
  const remaining = mode === "remaining";
  // Guarded rather than assumed: `explainableCount > 0` here — either the
  // combined count (mode would be "hidden" otherwise) or, under `split`, the
  // live count, which `showsBacklogSplit` has just asserted is positive.
  const fraction = Math.min(1, Math.max(0, explainedCount / explainableCount));

  return (
    <View className="mb-3 flex-col gap-y-0.5">
    <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
      {/* A thin meter, not a chart — the sentence beside it is the figure;
          this only makes "most of the way" legible at a glance. Omitted in
          `remaining` mode, where a bar pinned at empty would reintroduce the
          very "no progress ever made" reading the relabel exists to remove. */}
      {remaining ? null : (
        <View className="h-1 w-20 overflow-hidden rounded-full bg-sunken">
          <View
            className="h-1 rounded-full bg-accent"
            style={{ width: `${fraction * 100}%` }}
          />
        </View>
      )}
      <Text className="text-xs text-muted">
        {remaining
          ? `${explainableCount}${split ? " of this month's rows" : ""} still to explain · ${compactCents(explainableCents)}`
          : `${explainedCount} of ${explainableCount}${split ? " of this month's rows" : ""} explained · ${compactCents(explainedCents)} of ${compactCents(explainableCents)}`}
      </Text>
      <InfoTooltip
        text={
          remaining
            ? "You're filtered to the rows that still need explaining, so this counts what's left — the ones already explained aren't in this view. Clear the “Needs explaining” filter to see progress over the whole selection."
            : "Across everything this view matches, not just the rows loaded on screen. Counts every charge that will publish with a blank next to it unless somebody says what it was for — inflows, internal transfers, excluded rows and self-explaining charges (fees, personal, refunds, cashback, interest) are never counted."
        }
        size={12}
      />
    </View>
      {/* SECONDARY, muted — the reconstructed backlog, shown so it is never
          mistaken for this month's own work but never allowed to borrow credit
          from the meter above it. Its own denominator, for the same reason it
          gets its own line. */}
      {split ? (
        <Text className="text-2xs text-faint">
          {remaining
            ? `+ ${progress.backlogExplainableCount} reconstructed rows from the org's imported 2024–25 records · ${compactCents(progress.backlogExplainableCents)}`
            : `+ ${progress.backlogExplainedCount} of ${progress.backlogExplainableCount} reconstructed rows from the org's imported 2024–25 records · ${compactCents(progress.backlogExplainedCents)} of ${compactCents(progress.backlogExplainableCents)}`}
        </Text>
      ) : null}
    </View>
  );
}
