/**
 * A seat's Powers tab: what the seat can do, one line each, grouped by area,
 * with the reason for any power it holds only because another implies it.
 *
 * Replaces the chip cloud AND the inline editor that used to stack under it
 * (the same powers shown twice, in two different shapes). Editing happens in
 * one place, `PowersPicker`; removing a single stored power is a tap on its
 * row. Both write through `seats.setSeatDomainPowers`, one domain at a time,
 * so no edit can strip a power in an area the editor didn't touch.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { POWER_DOMAIN_DEFS, powerLabel, type Power } from "@events-os/shared";
import { Button, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../../lib/confirmAction";
import { PowersPicker } from "./PowersPicker";
import { domainWrites, groupByDomain, powerState, type SeatChart } from "./powerPicker";
import { displayPowers } from "./treeUtils";

export function SeatPowersTab({
  seatDefId,
  seatTitle,
  chart,
  capabilities,
  canEdit,
}: {
  seatDefId: Id<"seatDefs">;
  seatTitle: string;
  chart: SeatChart;
  capabilities: readonly string[];
  /** Superuser or `org.chart.edit` — `seatDetail.canEditPowers`. */
  canEdit: boolean;
}) {
  const setDomainPowers = useMutation(api.seats.setSeatDomainPowers);
  const [pickerOpen, setPickerOpen] = useState(false);
  const held = displayPowers(capabilities, chart);

  async function applyPowers(next: readonly string[]) {
    for (const w of domainWrites(capabilities, next)) {
      await setDomainPowers({ seatDefId, domain: w.domain, powers: w.powers });
    }
  }

  function remove(p: Power) {
    confirmAction({
      title: `Remove "${powerLabel(p)}"?`,
      message: `${seatTitle} loses this power immediately, along with anything it included.`,
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () =>
        void applyPowers(capabilities.filter((c) => c !== p)).catch(alertError),
    });
  }

  return (
    <View className="gap-4">
      {held.length === 0 ? (
        <Text className="text-sm text-muted">No special powers. Standard member access.</Text>
      ) : (
        groupByDomain(held).map((group) => (
          <View key={group.domain} className="gap-1">
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {POWER_DOMAIN_DEFS[group.domain].label}
            </Text>
            {group.powers.map((p, i) => {
              const state = powerState(capabilities, p);
              return (
                <View
                  key={p}
                  className={`flex-row items-start gap-2 py-2 ${i > 0 ? "border-t border-border" : ""}`}
                >
                  <View className="flex-1">
                    <Text className="text-sm text-ink">{powerLabel(p)}</Text>
                    {state.kind === "included" ? (
                      <Text className="text-xs text-faint">Included with {powerLabel(state.via)}</Text>
                    ) : null}
                  </View>
                  {canEdit && state.kind === "granted" ? (
                    <Pressable
                      onPress={() => remove(p)}
                      hitSlop={8}
                      className="rounded-md p-1"
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${powerLabel(p)}`}
                    >
                      <Icon name="x" size={15} color={colors.faint} />
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))
      )}

      {canEdit ? (
        <Button
          title={held.length ? "Add or change powers" : "Add powers"}
          icon="plus"
          size="sm"
          onPress={() => setPickerOpen(true)}
          className="self-start"
        />
      ) : null}

      <PowersPicker
        visible={pickerOpen}
        seatTitle={seatTitle}
        chart={chart}
        initial={capabilities}
        seatDefId={seatDefId}
        onSave={applyPowers}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}
