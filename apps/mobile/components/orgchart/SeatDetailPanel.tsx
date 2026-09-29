/**
 * The seat panel — slides over the chart when a box is selected. A header
 * (scope, the seat's name, Focus) over five tabs:
 *
 *   Overview  reports-to, seat size, training, remove   `SeatOverviewTab`
 *   Powers    what the seat can do + the picker          `SeatPowersTab`
 *   People    holders, open spots, proposals             `SeatPeopleTab`
 *   Duties    the real duties from Work → Duties         `SeatDuties`
 *   History   the structure log for this seat            `SeatHistoryTab`
 *
 * This replaced one long scroll that mixed all of those with a separate
 * "Edit structure" mode, which was the only place rename/move/remove lived.
 * There is no mode now: each tab shows its own controls to whoever the
 * backend says may use them — `seatDetail.canEditPowers` (superuser or
 * `org.chart.edit`) for structure and powers, `canFillSeats` for holders,
 * and the duty rows' own `canEdit` for duties. History is only offered to
 * chart editors, because only they may read the log.
 *
 * DUTIES come from `responsibilities.dutiesForSeat` — the REAL duties mapped
 * to this seat — never `detail.duties`, the seeded template strings the owner
 * calls "fake duties".
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Card, EmptyState } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { SeatDuties } from "./SeatDuties";
import { SeatHistoryTab } from "./SeatHistoryTab";
import { SeatOverviewTab } from "./SeatOverviewTab";
import { SeatPeopleTab } from "./SeatPeopleTab";
import { SeatPowersTab } from "./SeatPowersTab";
import { displayPowers, type ReportsTo, type SeatDetail, type SeatNode, type TreeNode } from "./treeUtils";

type Tab = "overview" | "powers" | "people" | "duties" | "history";

export function SeatDetailPanel({
  selected,
  scopeName,
  detail,
  reportsTo,
  chartSeats,
  onSeatRemoved,
  onFocusBranch,
}: {
  selected: TreeNode | null;
  scopeName: string;
  detail: SeatDetail | null | undefined;
  reportsTo: ReportsTo;
  /** Every seat in the selected seat's chart. */
  chartSeats: readonly SeatNode[];
  /** Called after a successful `removeSeat` so the screen can clear the
   *  now-nonexistent selection. */
  onSeatRemoved?: () => void;
  /** Collapse every branch except this seat's. Omitted when the seat has no
   *  reports, or by a caller with no collapse state of its own. */
  onFocusBranch?: () => void;
}) {
  // Kept across seat switches on purpose: someone working through powers
  // seat by seat wants to stay on Powers.
  const [tab, setTab] = useState<Tab>("overview");
  const duties = useQuery(
    api.responsibilities.dutiesForSeat,
    selected ? { seatDefId: selected.seat.defId } : "skip",
  );

  const canEdit = detail?.canEditPowers === true;
  useEffect(() => {
    if (tab === "history" && detail && !canEdit) setTab("overview");
  }, [tab, detail, canEdit]);

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

  const holderCount =
    detail.holders.length === 0
      ? "Vacant"
      : detail.holders.length === 1
        ? "One holder"
        : `${detail.holders.length} holders`;
  const powerCount = displayPowers(detail.capabilities, detail.chart).length;
  const titleOf = (slug: string) => chartSeats.find((s) => s.slug === slug)?.title ?? "another seat";

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "powers", label: "Powers", count: powerCount },
    { id: "people", label: "People", count: detail.holders.length },
    { id: "duties", label: "Duties", count: duties?.length },
    ...(canEdit ? [{ id: "history" as const, label: "History" }] : []),
  ];

  return (
    <Card>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {scopeName} · {holderCount}
      </Text>
      <View className="mt-1 flex-row items-center gap-2">
        <SeatTitle slug={detail.slug} title={detail.title} editable={canEdit && !detail.derived} />
        {onFocusBranch ? (
          <Button title="Focus" variant="secondary" size="sm" icon="crosshair" onPress={onFocusBranch} />
        ) : null}
      </View>
      {detail.derived ? (
        <Text className="mt-1 text-xs italic text-faint">
          Mirrors each chapter — computed, never assigned directly.
        </Text>
      ) : null}

      <View className="-mx-1 mt-3 flex-row flex-wrap border-b border-border">
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <Pressable
              key={t.id}
              onPress={() => setTab(t.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              className={`-mb-px border-b-2 px-2 py-2 ${on ? "border-accent" : "border-transparent"}`}
            >
              <Text className={`text-sm ${on ? "font-semibold text-ink" : "text-muted"}`}>
                {t.label}
                {t.count ? <Text className="text-xs text-faint"> {t.count}</Text> : null}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View className="pt-4">
        {tab === "overview" ? (
          <SeatOverviewTab
            seat={selected.seat}
            scope={selected.scope}
            maxHolders={detail.maxHolders}
            holders={detail.holders}
            derived={detail.derived}
            canEdit={canEdit}
            reportsTo={reportsTo}
            chartSeats={chartSeats}
            onRemoved={() => onSeatRemoved?.()}
          />
        ) : tab === "powers" ? (
          <SeatPowersTab
            seatDefId={detail.defId}
            seatTitle={detail.title}
            chart={detail.chart}
            capabilities={detail.capabilities}
            canEdit={canEdit && !detail.derived}
          />
        ) : tab === "people" ? (
          <SeatPeopleTab
            seatDefId={detail.defId}
            scope={selected.scope}
            seatTitle={detail.title}
            maxHolders={detail.maxHolders}
            holders={detail.holders}
            derived={detail.derived}
            canFill={detail.canFillSeats}
          />
        ) : tab === "duties" ? (
          <SeatDuties
            seatDefId={detail.defId}
            seatTitle={detail.title}
            duties={duties}
            derived={detail.derived}
          />
        ) : (
          <SeatHistoryTab slug={detail.slug} titleOf={titleOf} />
        )}
      </View>
    </Card>
  );
}

/** The seat's name. For a chart editor it IS the rename control: tap it,
 *  type, and it saves on Enter or when focus leaves. No pencil, no mode. */
function SeatTitle({ slug, title, editable }: { slug: string; title: string; editable: boolean }) {
  const rename = useMutation(api.seatStructure.renameSeat);
  const [value, setValue] = useState(title);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setValue(title);
  }, [title, focused]);

  if (!editable) {
    return <Text className="flex-1 font-display text-2xl text-ink">{title}</Text>;
  }

  async function save() {
    const next = value.trim();
    if (!next || next === title) {
      setValue(title);
      return;
    }
    try {
      await rename({ slug, title: next });
    } catch (err) {
      setValue(title);
      alertError(err);
    }
  }

  return (
    <TextInput
      value={value}
      onChangeText={setValue}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        void save();
      }}
      onSubmitEditing={() => void save()}
      returnKeyType="done"
      accessibilityLabel="Seat name"
      className={`flex-1 rounded-md border px-1.5 py-0.5 font-display text-2xl text-ink ${
        focused ? "border-accent bg-surface" : "border-transparent web:hover:border-border-strong"
      }`}
    />
  );
}
