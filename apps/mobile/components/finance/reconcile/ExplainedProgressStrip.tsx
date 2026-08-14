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
import { explainedStripMode } from "./gridView";

export type ExplainedProgress = {
  explainableCount: number;
  explainableCents: number;
  explainedCount: number;
  explainedCents: number;
};

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

  const { explainableCount, explainableCents, explainedCount, explainedCents } =
    progress;
  const remaining = mode === "remaining";
  // Guarded rather than assumed: `explainableCount > 0` here (mode would be
  // "hidden" otherwise), so this is only ever a division by a positive number.
  const fraction = Math.min(1, Math.max(0, explainedCount / explainableCount));

  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-x-2 gap-y-1">
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
          ? `${explainableCount} still to explain · ${compactCents(explainableCents)}`
          : `${explainedCount} of ${explainableCount} explained · ${compactCents(explainedCents)} of ${compactCents(explainableCents)}`}
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
  );
}
