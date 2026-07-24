/**
 * The Campaigns-desk power control (founder requirement, 2026-07-24) — a
 * three-way None / Compose / Approve segmented control shown in a seat's
 * "Powers" section, ONLY to a caller allowed to edit powers (superuser or an
 * `org.editChart` holder). Sibling of `GivingPowerControl.tsx` — same shape,
 * same gate, same self-lockout guard, just a different pair of capabilities
 * (`campaigns.compose`/`campaigns.approve` instead of `giving.view`/
 * `giving.manage`). See that file's doc for the full rationale, which
 * applies here unchanged.
 *
 * Calls `seats.setSeatCampaignPower`, which rewrites ONLY these two
 * capabilities and never the finance/giving/org powers beside them.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";

export type CampaignPower = "none" | "compose" | "approve";

/** The seat's current campaign power, derived from its capabilities —
 *  `approve` wins over `compose` (an approver can always do everything a
 *  composer can). */
export function campaignPowerOf(capabilities: readonly string[]): CampaignPower {
  if (capabilities.includes("campaigns.approve")) return "approve";
  if (capabilities.includes("campaigns.compose")) return "compose";
  return "none";
}

const OPTIONS: { value: CampaignPower; label: string }[] = [
  { value: "none", label: "None" },
  { value: "compose", label: "Compose" },
  { value: "approve", label: "Approve" },
];

export function CampaignPowerControl({
  seatDefId,
  capabilities,
}: {
  seatDefId: Id<"seatDefs">;
  capabilities: readonly string[];
}) {
  const setPower = useMutation(api.seats.setSeatCampaignPower);
  const current = campaignPowerOf(capabilities);
  const [saving, setSaving] = useState<CampaignPower | null>(null);

  async function choose(next: CampaignPower) {
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
    <View className="mt-3 gap-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        Campaigns desk access
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
        Compose: open the desk, draft, and send once approved. Approve: also
        review and decide on others' campaigns (never their own — a
        different approver is always required).
      </Text>
    </View>
  );
}
