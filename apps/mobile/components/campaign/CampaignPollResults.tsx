/**
 * POLL RESULTS — what recipients actually answered, on the campaign detail
 * screen.
 *
 * A poll's whole point is the answer, and until this existed the votes were
 * only observable in the database. `campaignPolls.getPollResults` returns one
 * tally per poll block in the campaign's document — question, per-option
 * counts, total, and a `truncated` flag when the count hit its scan cap.
 *
 * ── When it renders ────────────────────────────────────────────────────────
 * Only for a campaign that has actually gone out, and only when its document
 * contains a poll at all. Both conditions are checked BEFORE the query fires:
 * a draft has no recipients and therefore no votes, so querying would cost a
 * round trip to render an empty section that reads like a bug ("0 votes" on
 * something never sent).
 *
 * ── Bars, not a chart ──────────────────────────────────────────────────────
 * Proportions of a single question, 2-6 options, read at a glance — a labelled
 * bar is the honest shape for that, and it needs no charting dependency. Each
 * bar is scaled against the LEADING option rather than the total, so a
 * three-way split still fills the row and the ranking is visible; the exact
 * share is spelled out in the numbers beside it, which is where precision
 * belongs.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { findPollNodes } from "@events-os/shared";
import { Card, SectionHeader } from "../ui";

/** Statuses where a send has begun — the point at which votes can exist. */
const SENT_STATUSES = new Set(["sending", "sent", "failed"]);

/** True when `doc` carries at least one poll, EITHER format — the same
 *  shared, format-dual walk the backend now uses
 *  (`campaignPolls.ts#pollBlocksOf`), replacing this component's own
 *  blocks-only `kind === "poll"` sniff so the two can never disagree about
 *  what a poll is again (`@events-os/shared`'s `findPollNodes`, which is
 *  total and reads defensively — `doc` is `v.any()` on the wire). */
function hasPollBlock(doc: unknown): boolean {
  return findPollNodes(doc).length > 0;
}

export function CampaignPollResults({
  campaignId,
  status,
  doc,
}: {
  campaignId: Id<"campaigns">;
  status: string;
  doc: unknown;
}) {
  const shouldQuery = SENT_STATUSES.has(status) && hasPollBlock(doc);
  const results = useQuery(
    api.campaignPolls.getPollResults,
    shouldQuery ? { campaignId } : "skip",
  );

  if (!shouldQuery || !results || results.length === 0) return null;

  return (
    <View>
      <SectionHeader title="Poll results" count={results.length} />
      <View className="gap-3">
        {results.map((tally) => {
          const leader = Math.max(1, ...tally.options.map((o) => o.count));
          return (
            <Card key={tally.blockId}>
              <Text className="text-base font-semibold text-ink">{tally.question}</Text>
              <Text className="mb-3 text-xs text-muted">
                {tally.totalVotes === 1 ? "1 vote" : `${tally.totalVotes} votes`}
                {tally.truncated ? " · counted up to this email's cap" : ""}
              </Text>
              {tally.options.map((option) => {
                const share =
                  tally.totalVotes > 0
                    ? Math.round((option.count / tally.totalVotes) * 100)
                    : 0;
                return (
                  <View key={option.optionId} className="mb-2.5">
                    <View className="mb-1 flex-row items-baseline justify-between gap-3">
                      <Text className="flex-1 text-sm text-ink" numberOfLines={2}>
                        {option.label}
                      </Text>
                      <Text className="text-xs text-muted">
                        {option.count} · {share}%
                      </Text>
                    </View>
                    <View
                      className="h-2 overflow-hidden rounded-pill bg-sunken"
                      accessibilityRole="progressbar"
                      accessibilityLabel={`${option.label}: ${option.count} votes, ${share} percent`}
                    >
                      <View
                        className="h-2 rounded-pill bg-accent"
                        style={{ width: `${(option.count / leader) * 100}%` }}
                      />
                    </View>
                  </View>
                );
              })}
            </Card>
          );
        })}
      </View>
    </View>
  );
}
