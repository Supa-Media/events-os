import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, Popover, useAnchor } from "../ui";
import { colors } from "../../lib/theme";
import { ProposalsInbox } from "./ProposalsInbox";
import { ScopePills, type ScopeChoice } from "./ScopePills";
import type { FullChart } from "./treeUtils";

/**
 * The slim floating chrome docked over the top of the full-bleed canvas: a
 * small page title, the scope pills, "who am I" context line, the "Edit
 * structure" toggle (when authorized), and a proposals-inbox indicator.
 *
 * The proposals inbox itself is UNCHANGED (`ProposalsInbox`, as merged) — it
 * just moves from "always inline above the tree" to "behind an indicator
 * button, opened in a popover", since the tree no longer has a fixed spot
 * above it to push down. `pendingProposals` is queried here (again — cheap;
 * Convex's client dedupes identical reactive queries) only to size the
 * badge; `ProposalsInbox` re-fetches the same query itself when opened.
 */
export function OrgChartToolbar({
  chart,
  scopeChoice,
  onScopeChange,
  canEditStructure,
  editMode,
  onToggleEditMode,
  meName,
  mySeatTitles,
}: {
  chart: FullChart;
  scopeChoice: ScopeChoice;
  onScopeChange: (v: ScopeChoice) => void;
  canEditStructure: boolean;
  editMode: boolean;
  onToggleEditMode: () => void;
  meName: string | null;
  mySeatTitles: string[];
}) {
  const pending = useQuery(api.seatProposals.pendingProposals, {});
  const pendingCount = pending?.length ?? 0;
  const { ref, anchor, visible, open, close } = useAnchor();

  return (
    <View className="m-3 gap-3 rounded-lg border border-border bg-raised/95 p-3 shadow-pop">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="font-display text-base text-ink">Org Chart</Text>
          {meName ? (
            <Text className="text-xs text-muted" numberOfLines={1}>
              <Text className="font-semibold text-ink">You: {meName}</Text>
              {mySeatTitles.length > 0 ? ` — ${mySeatTitles.join(", ")}` : null}
            </Text>
          ) : null}
        </View>

        <View className="flex-row items-center gap-2">
          <View ref={ref}>
            <ProposalsIndicatorButton count={pendingCount} onPress={open} />
          </View>
          {canEditStructure ? (
            <Button
              title={editMode ? "Done editing" : "Edit structure"}
              variant={editMode ? "primary" : "secondary"}
              size="sm"
              icon={editMode ? "check" : "edit-2"}
              onPress={onToggleEditMode}
            />
          ) : null}
        </View>
      </View>

      <ScopePills chart={chart} value={scopeChoice} onChange={onScopeChange} />

      <Popover visible={visible} anchor={anchor} onClose={close} width={360}>
        <View className="p-3">
          <ProposalsInbox />
        </View>
      </Popover>
    </View>
  );
}

function ProposalsIndicatorButton({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${count} pending proposals` : "Proposals"}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onPress}
      style={{ cursor: "pointer" } as any}
      className="h-9 w-9 items-center justify-center rounded-md border border-border bg-raised active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name="inbox" size={16} color={count > 0 ? colors.accent : colors.muted} />
      {count > 0 ? (
        <View
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            paddingHorizontal: 3,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text className="text-2xs font-bold text-white">{count > 9 ? "9+" : count}</Text>
        </View>
      ) : null}
    </View>
  );
}
