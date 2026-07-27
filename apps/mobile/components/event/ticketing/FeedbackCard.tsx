/**
 * Feedback — an event's form-survey responses (PW Forms consolidation).
 * Today this is exactly the Eden-style anonymous attendee survey shape:
 * responses carry an `eventId` but no `personId` (see
 * `formSubmissions.ts`'s module doc), so there's no guest identity to show —
 * just the aggregate rating distribution (`summaryForEvent`) and the raw
 * response list. Mirrors `GivingCard`'s read-only-ledger shape.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Card } from "../../ui";
import { formatDate } from "../../../lib/format";

const RATING_TONE: Record<string, "success" | "warn" | "danger" | "neutral"> = {
  Excellent: "success",
  Good: "success",
  Fair: "warn",
  Poor: "danger",
};

/** "rating_overall" → "Overall", "rating_picnic_blanket_layout" → "Picnic
 *  Blanket Layout" — a generic fallback label for any rating key this event's
 *  survey happens to carry, since the Feedback card doesn't load the full
 *  form catalog (that's a backend-only module) just to get nice labels. */
function labelForRatingKey(key: string): string {
  const stripped = key === "rating_overall" ? "overall" : key.replace(/^rating_/, "");
  return stripped
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function FeedbackCard({ eventId }: { eventId: Id<"events"> }) {
  const summary = useQuery(api.formSubmissions.summaryForEvent, { eventId });
  const submissions = useQuery(api.formSubmissions.listForEvent, { eventId });

  const ratingEntries = Object.entries(summary?.ratings ?? {});

  return (
    <Card>
      <View className="flex-row items-baseline gap-2">
        <Text className="font-display text-2xl text-ink">
          {summary === undefined ? "…" : summary.totalSubmissions}
        </Text>
        <Text className="text-sm text-muted">
          survey response{summary?.totalSubmissions === 1 ? "" : "s"}
        </Text>
      </View>

      {summary === undefined ? (
        <Text className="py-3 text-base text-muted">Loading feedback…</Text>
      ) : summary.totalSubmissions === 0 ? (
        <Text className="py-3 text-base text-muted">
          No survey responses yet — import or share a feedback form to collect some.
        </Text>
      ) : (
        <>
          {ratingEntries.length > 0 ? (
            <View className="gap-2 border-t border-border py-3">
              {ratingEntries.map(([key, r]) => (
                <View key={key} className="gap-1">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm font-semibold text-ink">
                      {labelForRatingKey(key)}
                    </Text>
                    {r.average !== null ? (
                      <Text className="text-xs text-muted">
                        avg {r.average.toFixed(1)} / 4
                      </Text>
                    ) : null}
                  </View>
                  <View className="flex-row flex-wrap gap-1.5">
                    {Object.entries(r.counts).map(([value, count]) => (
                      <Badge
                        key={value}
                        label={`${value} · ${count}`}
                        tone={RATING_TONE[value] ?? "neutral"}
                      />
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View className="border-t border-border py-3">
            <Text className="mb-2 text-sm font-semibold text-ink">Responses</Text>
            {submissions === undefined ? (
              <Text className="text-sm text-muted">Loading responses…</Text>
            ) : (
              submissions.map((sub) => (
                <View key={sub._id} className="border-t border-border py-2 first:border-t-0">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm text-ink" numberOfLines={1}>
                      {sub.title}
                    </Text>
                    <Text className="text-xs text-faint">{formatDate(sub.submittedAt)}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </Card>
  );
}
