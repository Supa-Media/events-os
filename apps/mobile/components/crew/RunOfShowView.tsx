import { View, Text } from "react-native";
import {
  buildRunOfShowSegments,
  isRunOfShowLive,
  runOfShowNowIndex,
} from "@events-os/shared";
import { Card } from "../ui";
import { canFormatEastern, formatTimeEastern } from "../../lib/format";
import { useNow } from "../../lib/useNow";

/** One sanitized run-of-show row off the crew briefing payload. */
export type CrewRunOfShowRow = {
  title: string;
  offsetMinutes: number;
  durationMinutes: number | null;
  notes: string | null;
};

/**
 * The volunteer-facing run of show: a mobile-first timeline of what's
 * happening and when, with every time pinned to Eastern (the org's home
 * timezone) so a phone in any timezone reads the same schedule. While the
 * event is live, the segment we should currently be on is highlighted
 * ("NOW" — or "UP NEXT" just before doors), driven by the same shared
 * segment-window math as the Day-of view. Read-only by design.
 */
export function RunOfShowView({
  eventDate,
  runOfShow,
}: {
  eventDate: number;
  runOfShow: CrewRunOfShowRow[];
}) {
  const now = useNow();
  if (runOfShow.length === 0) return null;

  const segments = buildRunOfShowSegments(eventDate, runOfShow);
  // Highlight only when the event is live-ish. Days ahead of the event a public
  // page shouldn't shout "UP NEXT" — the plain timeline is the answer. The rule
  // itself now lives in `@events-os/shared` so Day-of can't disagree with it.
  const liveish = isRunOfShowLive(segments, now);
  const nowIndex = liveish ? runOfShowNowIndex(segments, now) : -1;

  return (
    <View className="gap-3">
      <View className="gap-0.5">
        <Text className="font-display text-xl text-ink">Run of show</Text>
        <Text className="text-sm text-faint">
          {/* Only claim the Eastern pin when the runtime can actually honor
              it — on the rare runtime without timezone data the formatters
              fall back to device-local, and the label must say so. */}
          {canFormatEastern()
            ? "What's happening and when · all times Eastern (ET)."
            : "What's happening and when · times shown in your local time."}
        </Text>
      </View>
      <Card padding="sm">
        <View className="gap-1">
          {segments.map((seg, i) => {
            const isNow = i === nowIndex;
            const upcoming = isNow && now < seg.start;
            // Once a segment's window has closed (event live), let it recede.
            const past = liveish && !isNow && now >= seg.end;
            const startLabel = formatTimeEastern(seg.start);
            const timeLabel = seg.showEnd
              ? `${startLabel} – ${formatTimeEastern(seg.end)}`
              : startLabel;
            return (
              <View
                key={i}
                className={`flex-row gap-3 rounded-lg border px-3 py-2.5 ${
                  isNow
                    ? "border-accent bg-accent-soft"
                    : "border-transparent"
                }`}
              >
                <View className="w-[86px]">
                  <Text
                    className={`text-base font-bold ${
                      past ? "text-faint" : "text-accent"
                    }`}
                  >
                    {startLabel}
                  </Text>
                  {seg.showEnd ? (
                    <Text className="mt-0.5 text-xs font-semibold text-muted">
                      – {formatTimeEastern(seg.end)}
                    </Text>
                  ) : null}
                </View>
                <View className="flex-1">
                  {isNow ? (
                    <View
                      className="mb-1 self-start rounded-pill bg-accent px-2 py-0.5"
                      accessibilityLabel={`${upcoming ? "Up next" : "Happening now"}: ${seg.row.title} at ${timeLabel} Eastern`}
                    >
                      <Text className="text-2xs font-bold tracking-widest text-white">
                        {upcoming ? "UP NEXT" : "NOW"}
                      </Text>
                    </View>
                  ) : null}
                  <Text
                    className={`text-base font-semibold ${
                      past ? "text-faint" : "text-ink"
                    }`}
                  >
                    {seg.row.title}
                  </Text>
                  {seg.row.notes ? (
                    <Text
                      className={`mt-0.5 text-sm ${
                        past ? "text-faint" : "text-muted"
                      }`}
                    >
                      {seg.row.notes}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </Card>
    </View>
  );
}
