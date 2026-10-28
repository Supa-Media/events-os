/**
 * The Duties page's list: one scannable row per duty (title, cadence, seats,
 * how many people it reaches, whether a how-to exists), optionally grouped.
 * Tapping a row opens it in `DutyDetailPanel`. Below `compact` width the
 * columns fold under the title so a phone gets the same facts without
 * scrolling sideways.
 */
import { View, Text, Pressable } from "react-native";
import { RESPONSIBILITY_CADENCE_LABELS } from "@events-os/shared";
import { Icon } from "../ui";
import { colors, spacing } from "../../lib/theme";
import {
  attentionReason,
  type DutyFacts,
  type DutyGroup,
} from "./dutyFilters.logic";

const COL = { cadence: 104, seats: 250, people: 70, howTo: 84 } as const;
const MAX_CHIPS = 3;

/** Pastel per cadence — the same families the theme uses for categories. */
const CADENCE_BG: Record<string, string> = {
  daily: colors.accentSoft,
  weekly: colors.sky,
  biweekly: colors.sky,
  monthly: colors.mint,
  quarterly: colors.lavender,
  yearly: colors.peach,
  ad_hoc: colors.sunken,
};

export function DutyList({
  groups,
  selectedId,
  onSelect,
  foreignIds,
  compact,
}: {
  groups: DutyGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Duties authored by another chapter (read-only here). */
  foreignIds: ReadonlySet<string>;
  compact: boolean;
}) {
  return (
    <View>
      {compact ? null : (
        <View className="flex-row items-center border-b border-border bg-sunken px-4 py-2.5" style={{ gap: spacing.md }}>
          <HeaderText flex>Duty</HeaderText>
          <HeaderText width={COL.cadence}>Cadence</HeaderText>
          <HeaderText width={COL.seats}>Seats</HeaderText>
          <HeaderText width={COL.people}>People</HeaderText>
          <HeaderText width={COL.howTo}>How-to</HeaderText>
        </View>
      )}
      {groups.map((g) => (
        <View key={g.key}>
          {g.label ? (
            <View className="flex-row items-center gap-2 border-b border-border px-4 pb-1.5 pt-4">
              <Text className="text-sm font-bold text-ink">{g.label}</Text>
              <Text className="text-xs text-muted">{g.items.length}</Text>
              {g.vacant ? (
                <View className="rounded-pill bg-accent-soft px-2 py-0.5">
                  <Text className="text-2xs font-bold text-accent">Vacant seat</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {g.items.map((d) => (
            <DutyListRow
              key={`${g.key}:${d.id}`}
              duty={d}
              selected={d.id === selectedId}
              foreign={foreignIds.has(d.id)}
              compact={compact}
              onPress={() => onSelect(d.id)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function HeaderText({
  children,
  width,
  flex,
}: {
  children: string;
  width?: number;
  flex?: boolean;
}) {
  return (
    <Text
      style={flex ? { flex: 1 } : { width }}
      className="text-2xs font-bold uppercase tracking-wider text-muted"
    >
      {children}
    </Text>
  );
}

function DutyListRow({
  duty,
  selected,
  foreign,
  compact,
  onPress,
}: {
  duty: DutyFacts;
  selected: boolean;
  foreign: boolean;
  compact: boolean;
  onPress: () => void;
}) {
  const reason = attentionReason(duty);
  const cadence = (
    <View
      className="self-start rounded-pill px-2.5 py-0.5"
      style={{ backgroundColor: CADENCE_BG[duty.cadence] }}
    >
      <Text className="text-xs font-bold text-ink">
        {RESPONSIBILITY_CADENCE_LABELS[duty.cadence]}
      </Text>
    </View>
  );
  const seats = (
    <View className="flex-row flex-wrap" style={{ gap: 4 }}>
      {duty.seats.slice(0, MAX_CHIPS).map((s) => (
        <View
          key={s.id}
          className={`rounded-pill px-2 py-0.5 ${
            s.holders === 0
              ? "border border-dashed border-accent bg-raised"
              : "border border-border bg-sunken"
          }`}
        >
          <Text
            className={`text-xs font-semibold ${s.holders === 0 ? "text-accent" : "text-ink"}`}
            numberOfLines={1}
          >
            {s.title}
          </Text>
        </View>
      ))}
      {duty.seats.length > MAX_CHIPS ? (
        <View className="rounded-pill border border-border px-2 py-0.5">
          <Text className="text-xs font-semibold text-muted">
            +{duty.seats.length - MAX_CHIPS}
          </Text>
        </View>
      ) : null}
      {duty.seats.length === 0 && duty.legacyRoles.length > 0 ? (
        <Text className="text-xs text-muted">{duty.legacyRoles.join(", ")} (legacy)</Text>
      ) : null}
      {duty.directCount > 0 ? (
        <View className="rounded-pill bg-sky px-2 py-0.5">
          <Text className="text-xs font-semibold text-ink">
            {duty.directCount} {duty.directCount === 1 ? "person" : "people"}
          </Text>
        </View>
      ) : null}
    </View>
  );
  const people = (
    <Text
      className={`text-sm font-bold ${duty.holders === 0 ? "text-accent" : "text-ink"}`}
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {duty.holders}
    </Text>
  );
  const howTo = (
    <Text
      className={`text-xs font-semibold ${duty.hasHowTo ? "text-success" : "text-muted"}`}
    >
      {duty.hasHowTo ? "Written" : "Missing"}
    </Text>
  );

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`border-b border-border px-4 py-3 active:bg-sunken web:hover:bg-sunken ${
        selected ? "bg-accent-soft" : "bg-raised"
      }`}
      style={
        selected
          ? { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 13 }
          : undefined
      }
    >
      <View className="flex-row items-center" style={{ gap: spacing.md }}>
        <View className="flex-1" style={{ gap: 3 }}>
          <View className="flex-row items-center gap-1.5">
            {foreign ? <Icon name="lock" size={12} color={colors.muted} /> : null}
            <Text className="flex-1 text-sm font-semibold text-ink">
              {duty.title || "Duty"}
            </Text>
          </View>
          {reason ? (
            <Text className="text-xs font-semibold text-accent">{reason}</Text>
          ) : null}
          {compact ? (
            <View style={{ gap: spacing.xs, marginTop: 4 }}>
              <View className="flex-row flex-wrap items-center" style={{ gap: spacing.sm }}>
                {cadence}
                <Text className="text-xs text-muted">
                  {duty.holders} {duty.holders === 1 ? "person" : "people"} ·{" "}
                  {duty.hasHowTo ? "How-to written" : "No how-to"}
                </Text>
              </View>
              {seats}
            </View>
          ) : null}
        </View>
        {compact ? (
          <Icon name="chevron-right" size={15} color={colors.muted} />
        ) : (
          <>
            <View style={{ width: COL.cadence }}>{cadence}</View>
            <View style={{ width: COL.seats }}>{seats}</View>
            <View style={{ width: COL.people }}>{people}</View>
            <View style={{ width: COL.howTo }}>{howTo}</View>
          </>
        )}
      </View>
    </Pressable>
  );
}
