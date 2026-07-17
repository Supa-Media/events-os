import { ActivityIndicator, Text, View } from "react-native";
import { SEAT_ROOT } from "@events-os/shared";
import { Avatar, Badge, Card, EmptyState, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";
import {
  avatarNameFor,
  capabilityLabel,
  type ReportsTo,
  type SeatDetail,
  type TreeNode,
} from "./treeUtils";

/**
 * The seat detail panel — right side on wide screens, full-width below the
 * tree on narrow (the caller decides layout; this just renders the content
 * column). Shows scope + holder-count, the seat title, who holds it, its
 * duties, its powers (capabilities translated to plain language), and who it
 * reports to (computed client-side in `treeUtils.computeReportsTo`).
 */
export function SeatDetailPanel({
  selected,
  scopeName,
  detail,
  reportsTo,
}: {
  selected: TreeNode | null;
  scopeName: string;
  detail: SeatDetail | null | undefined;
  reportsTo: ReportsTo;
}) {
  if (!selected) {
    return (
      <EmptyState
        icon="git-branch"
        title="Select a seat"
        message="Tap any box in the chart to see who holds it, their duties, and what they can do."
      />
    );
  }

  if (detail === undefined) {
    return (
      <Card>
        <View className="items-center justify-center py-10">
          <ActivityIndicator color={colors.accent} />
        </View>
      </Card>
    );
  }

  if (detail === null) {
    return <EmptyState icon="alert-circle" title="Seat not found" />;
  }

  const holderCountLabel =
    detail.holders.length === 0
      ? "Vacant"
      : detail.holders.length === 1
        ? "One holder"
        : "Multiple holders";

  return (
    <Card>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {scopeName} · {holderCountLabel}
      </Text>
      <Text className="mt-1 font-display text-2xl text-ink">{detail.title}</Text>
      {detail.derived ? (
        <Text className="mt-1 text-xs italic text-faint">
          Mirrors each chapter — computed, never assigned directly.
        </Text>
      ) : null}

      <SectionHeader title="Held by" />
      {detail.holders.length === 0 ? (
        <Text className="text-sm italic text-faint">Vacant</Text>
      ) : (
        <View className="gap-2.5">
          {detail.holders.map((h) => (
            <View key={h.personId} className="flex-row items-center gap-2.5">
              <Avatar name={avatarNameFor(h.name)} uri={h.imageUrl} size={28} />
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {h.name}
              </Text>
            </View>
          ))}
        </View>
      )}

      <SectionHeader title="Duties" />
      {detail.duties.length === 0 ? (
        <Text className="text-sm text-muted">None attached yet.</Text>
      ) : (
        <View className="gap-1.5">
          {detail.duties.map((d, i) => (
            <View key={i} className="flex-row items-start gap-2">
              <Text className="mt-0.5 text-sm text-muted">·</Text>
              <Text className="flex-1 text-sm text-ink">{d}</Text>
            </View>
          ))}
        </View>
      )}

      <SectionHeader title="Powers" />
      {detail.capabilities.length === 0 ? (
        <Text className="text-sm text-muted">No special powers — standard member access.</Text>
      ) : (
        <View className="flex-row flex-wrap gap-1.5">
          {detail.capabilities.map((c) => (
            <Badge key={c} label={capabilityLabel(c)} tone="accent" />
          ))}
        </View>
      )}

      <SectionHeader title="Reports to" />
      {reportsTo === null ? (
        <Text className="text-sm text-muted">
          {selected.scope === "central" && selected.seat.parentSlug === SEAT_ROOT
            ? "Top of the org chart."
            : "Nothing further up — every seat above is either vacant or held by the same person."}
        </Text>
      ) : (
        <View className="gap-1">
          <Text className="text-sm font-semibold text-ink">
            {reportsTo.seatTitle}
            <Text className="font-normal text-muted"> · {reportsTo.scopeLabel}</Text>
          </Text>
          <View className="mt-1 gap-2">
            {reportsTo.holders.map((h) => (
              <View key={h.personId} className="flex-row items-center gap-2">
                <Avatar name={avatarNameFor(h.name)} uri={h.imageUrl} size={22} />
                <Text className="text-sm text-ink">{h.name}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </Card>
  );
}
