/**
 * The org chart's Powers editor — every power on a seat, editable in place.
 *
 * Until now only two desks were editable from the seat panel (Giving and
 * Emails, each with its own bespoke segmented control), and everything else —
 * finance, the org chart itself, data export, door check-in — could only be
 * changed by entering the separate "Edit structure" mode, where powers appear
 * as a flat checkbox list of every string in the vocabulary with no grouping
 * and no indication of what implies what. So the powers a person most wanted to
 * hand out were the ones with no obvious way to hand them out.
 *
 * This renders EVERY domain from the registry (`POWER_DOMAIN_DEFS`), which
 * means a power added to `powers.ts` shows up here with no change to this file
 * — the previous arrangement needed a new hand-written control per desk, which
 * is exactly why most domains never got one.
 *
 * Two shapes, chosen by the registry rather than by this component:
 *  - A LADDER domain (Giving, Emails) renders as a segmented control, because
 *    its rungs are strictly ordered and exactly one is held.
 *  - A SET domain (Finance, Events, Organization, Data) renders as toggles,
 *    because its powers are independent.
 *
 * DERIVED POWERS ARE SHOWN, NOT HIDDEN, and are not togglable. A seat storing
 * `finance.edit` really does grant `finance.cards.edit`, and an editor who
 * can't see that is being lied to — but letting them "turn off" something the
 * rules grant would be a lie of a different kind, since the write would be a
 * no-op. They read as included, with the power that grants them named.
 *
 * SCOPE-AWARE: a chapter seat never lists a central-only power (the org's bank
 * accounts have no chapter equivalent), matching the read-only chip list.
 *
 * Writes go through `seats.setSeatDomainPowers`, which replaces one domain and
 * preserves the rest verbatim — so editing Finance can never strip an email
 * power by omission. Convex reactivity refreshes `seatDetail` (and therefore
 * this component's `capabilities`) once the mutation commits; failures surface
 * the backend's `ConvexError` message verbatim, like every other org-chart
 * surface.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  POWER_DEFS,
  POWER_DOMAINS,
  POWER_DOMAIN_DEFS,
  expandPowers,
  ladderRungOf,
  powerDescription,
  powerLabel,
  powersInDomain,
  type Power,
  type PowerDomain,
} from "@events-os/shared";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";

/** A power's state on this seat: stored outright, implied by something stored,
 *  or absent. */
type PowerState = "granted" | "derived" | "off";

/** Which stored power implies `power`, for the "via …" note on a derived row.
 *  Returns the first stored power whose own expansion contains it — enough to
 *  answer "why do I have this?" without listing every path. */
function impliedBy(
  stored: readonly string[],
  power: Power,
): Power | null {
  for (const s of stored) {
    if (s === power) continue;
    if (expandPowers([s]).has(power)) return s as Power;
  }
  return null;
}

function Segmented({
  options,
  current,
  saving,
  onChoose,
}: {
  options: { value: string; label: string }[];
  current: string;
  saving: string | null;
  onChoose: (value: string) => void;
}) {
  return (
    <View className="flex-row gap-2">
      {options.map((opt) => {
        const selected = current === opt.value;
        const isSaving = saving === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChoose(opt.value)}
            disabled={saving !== null}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-md border px-3 py-2 ${
              selected ? "border-accent bg-accent-soft" : "border-border bg-raised"
            } ${saving !== null && !isSaving ? "opacity-50" : ""}`}
          >
            {isSaving ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Text
              className={`text-sm font-semibold ${selected ? "text-accent" : "text-muted"}`}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PowerToggle({
  power,
  state,
  via,
  busy,
  disabled,
  onToggle,
}: {
  power: Power;
  state: PowerState;
  via: Power | null;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const derived = state === "derived";
  const on = state !== "off";
  return (
    <Pressable
      onPress={derived ? undefined : onToggle}
      disabled={derived || disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: derived || disabled }}
      className={`flex-row items-start gap-2.5 rounded-md border px-3 py-2 ${
        on ? "border-accent bg-accent-soft" : "border-border bg-raised"
      } ${derived ? "opacity-70" : ""} ${disabled && !busy ? "opacity-50" : ""}`}
    >
      <View
        className={`mt-0.5 h-4 w-4 items-center justify-center rounded border ${
          on ? "border-accent bg-accent" : "border-border"
        }`}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : on ? (
          <Text className="text-2xs font-bold text-white">✓</Text>
        ) : null}
      </View>
      <View className="flex-1">
        <Text className={`text-sm font-semibold ${on ? "text-accent" : "text-ink"}`}>
          {powerLabel(power)}
        </Text>
        <Text className="text-xs text-muted">{powerDescription(power)}</Text>
        {derived ? (
          <Text className="mt-0.5 text-2xs font-semibold uppercase tracking-wider text-muted">
            {via ? `Included with "${powerLabel(via)}"` : "Included automatically"}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function PowersEditor({
  seatDefId,
  capabilities,
  chart,
}: {
  seatDefId: Id<"seatDefs">;
  capabilities: readonly string[];
  chart: "central" | "chapter";
}) {
  const setDomainPowers = useMutation(api.seats.setSeatDomainPowers);
  const [busy, setBusy] = useState<string | null>(null);

  const stored = capabilities;
  const granted = expandPowers(stored);

  async function write(domain: PowerDomain, powers: Power[], busyKey: string) {
    if (busy !== null) return;
    setBusy(busyKey);
    try {
      await setDomainPowers({ seatDefId, domain, powers });
    } catch (err) {
      alertError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <View className="mt-2 gap-4">
      {POWER_DOMAINS.map((domain) => {
        const def = POWER_DOMAIN_DEFS[domain];
        // Scope rule 3: a chapter seat can't reach a central-only resource, so
        // offering it here would be offering something that does nothing.
        const powers = powersInDomain(domain).filter(
          (p) => chart === "central" || POWER_DEFS[p].scope !== "central",
        );
        if (powers.length === 0) return null;

        return (
          <View key={domain} className="gap-2">
            <View className="gap-0.5">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                {def.label}
              </Text>
              <Text className="text-xs text-muted">{def.description}</Text>
            </View>

            {def.ladder ? (
              <Segmented
                options={[
                  { value: "none", label: "None" },
                  ...def.ladder.map((r) => ({ value: r.value, label: r.label })),
                ]}
                current={ladderRungOf(stored, domain)}
                saving={busy?.startsWith(`${domain}:`) ? busy.slice(domain.length + 1) : null}
                onChoose={(value) => {
                  const rung = def.ladder!.find((r) => r.value === value);
                  void write(domain, rung ? [rung.power] : [], `${domain}:${value}`);
                }}
              />
            ) : (
              <View className="gap-1.5">
                {powers.map((power) => {
                  const isStored = stored.includes(power);
                  const state: PowerState = isStored
                    ? "granted"
                    : granted.has(power)
                      ? "derived"
                      : "off";
                  return (
                    <PowerToggle
                      key={power}
                      power={power}
                      state={state}
                      via={state === "derived" ? impliedBy(stored, power) : null}
                      busy={busy === `${domain}:${power}`}
                      disabled={busy !== null}
                      onToggle={() => {
                        // Send the domain's MINIMAL set: everything currently
                        // stored in this domain, with `power` flipped. Implied
                        // powers are never written — they come back derived.
                        const current = stored.filter(
                          (c) => POWER_DEFS[c as Power]?.domain === domain,
                        ) as Power[];
                        const next = isStored
                          ? current.filter((c) => c !== power)
                          : [...current, power];
                        void write(domain, next, `${domain}:${power}`);
                      }}
                    />
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
