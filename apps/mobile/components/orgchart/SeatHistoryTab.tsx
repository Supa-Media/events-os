/**
 * A seat's History tab: the structure log (`seatStructure.structureLog`,
 * narrowed to this seat) in plain sentences. Only chart editors can read the
 * log, so the panel only offers this tab to them.
 *
 * Covers renames, moves, size changes, and power changes (the picker's writes
 * are logged as `updateSeat`). Changes to who HOLDS the seat are not in this
 * log; they live on the seat's assignments and proposals.
 */
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { isPower, powerLabel } from "@events-os/shared";
import { colors } from "../../lib/theme";

type Snapshot = {
  title?: string;
  parentSlug?: string;
  maxHolders?: number;
  capabilities?: string[];
};

/** One log row as a sentence. Exported for tests. */
export function describeChange(
  mutation: string,
  before: Snapshot | undefined,
  after: Snapshot | undefined,
  titleOf: (slug: string) => string,
): string[] {
  switch (mutation) {
    case "addSeat":
      return ["Created this seat"];
    case "removeSeat":
      return ["Removed this seat"];
    case "renameSeat":
      return [`Renamed from "${before?.title ?? "?"}" to "${after?.title ?? "?"}"`];
    case "reparentSeat":
      return [
        `Moved from under ${titleOf(before?.parentSlug ?? "")} to under ${titleOf(after?.parentSlug ?? "")}`,
      ];
    case "updateSeat": {
      const lines: string[] = [];
      if (after?.maxHolders !== undefined) {
        lines.push(after.maxHolders === 1 ? "Set to one person" : "Opened to several people");
      }
      if (after?.capabilities) {
        const b = new Set(before?.capabilities ?? []);
        const a = new Set(after.capabilities);
        const label = (p: string) => (isPower(p) ? powerLabel(p) : p);
        const added = [...a].filter((p) => !b.has(p)).map(label);
        const removed = [...b].filter((p) => !a.has(p)).map(label);
        if (added.length) lines.push(`Gave it ${added.join(", ")}`);
        if (removed.length) lines.push(`Took away ${removed.join(", ")}`);
      }
      return lines.length ? lines : ["Updated this seat"];
    }
    default:
      return ["Changed this seat"];
  }
}

export function SeatHistoryTab({
  slug,
  titleOf,
}: {
  slug: string;
  titleOf: (slug: string) => string;
}) {
  const log = useQuery(api.seatStructure.structureLog, { slug, limit: 500 });

  if (log === undefined) return <ActivityIndicator color={colors.accent} />;
  if (log.length === 0) {
    return <Text className="text-sm text-muted">No changes to this seat in the recent log.</Text>;
  }
  return (
    <View>
      {log.map((row, i) => (
        <View key={row.logId} className={`gap-0.5 py-2.5 ${i > 0 ? "border-t border-border" : ""}`}>
          {describeChange(row.mutation, row.before as Snapshot, row.after as Snapshot, titleOf).map(
            (line) => (
              <Text key={line} className="text-sm text-ink">
                {line}
              </Text>
            ),
          )}
          <Text className="text-xs text-faint">
            {row.editorName ?? "A superuser"} ·{" "}
            {new Date(row.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </Text>
        </View>
      ))}
    </View>
  );
}
