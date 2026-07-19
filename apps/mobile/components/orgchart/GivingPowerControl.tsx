/**
 * The Giving-desk power control (owner decision 2026-07-19) — a three-way
 * None / View / Manage segmented control shown in a seat's "Powers" section,
 * ONLY to a caller allowed to edit powers (superuser or an `org.editChart`
 * holder). Unlike the full "Edit structure" mode (`StructureEditor.tsx`), this
 * is always available to an eligible editor without toggling edit mode — the
 * owner wanted a fast, per-role giving toggle straight from the org chart.
 *
 * Calls `seats.setSeatGivingPower`, which rewrites ONLY the three giving
 * capabilities on the shared seat def and never the finance/org powers beside
 * them — so this control can't accidentally strip an unrelated power. The seat
 * def is shared across every chapter, so one change applies everywhere the
 * seat is occupied. Convex reactivity refreshes the panel's `seatDetail` (and
 * therefore this control's `capabilities`) automatically once the mutation
 * commits — no manual refetch. Failures surface the backend's `ConvexError`
 * message verbatim (`alertError`), matching every other org-chart surface.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";

export type GivingPower = "none" | "view" | "manage";

/** The seat's current giving power, derived from its capabilities — `manage`
 *  wins over `view` (a manager can always see what they manage). */
export function givingPowerOf(capabilities: readonly string[]): GivingPower {
  if (capabilities.includes("giving.manage")) return "manage";
  if (capabilities.includes("giving.view")) return "view";
  return "none";
}

const OPTIONS: { value: GivingPower; label: string }[] = [
  { value: "none", label: "None" },
  { value: "view", label: "View" },
  { value: "manage", label: "Manage" },
];

export function GivingPowerControl({
  seatDefId,
  capabilities,
}: {
  seatDefId: Id<"seatDefs">;
  capabilities: readonly string[];
}) {
  const setPower = useMutation(api.seats.setSeatGivingPower);
  const current = givingPowerOf(capabilities);
  const [saving, setSaving] = useState<GivingPower | null>(null);

  async function choose(next: GivingPower) {
    if (next === current || saving !== null) return;
    setSaving(next);
    try {
      await setPower({ seatDefId, power: next });
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(null);
    }
  }

  return (
    <View className="mt-1 gap-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        Giving desk access
      </Text>
      <View className="flex-row gap-2">
        {OPTIONS.map((opt) => {
          const selected = current === opt.value;
          const isSaving = saving === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => void choose(opt.value)}
              disabled={saving !== null}
              className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-md border px-3 py-2 ${
                selected ? "border-accent bg-accent-soft" : "border-border bg-raised"
              } ${saving !== null && !isSaving ? "opacity-50" : ""}`}
            >
              {isSaving ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : null}
              <Text
                className={`text-sm font-semibold ${
                  selected ? "text-accent" : "text-muted"
                }`}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text className="text-xs text-muted">
        View: see donors &amp; dashboards. Manage: record gifts, edit donors,
        import.
      </Text>
    </View>
  );
}
