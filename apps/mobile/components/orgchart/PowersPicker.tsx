/**
 * The ONE place a seat's powers are chosen. Opened from a seat's Powers tab,
 * from Add seat, and (pointed the other way) from the Powers directory.
 *
 * It replaces three controls that each showed powers differently: the seat
 * panel's per-domain editor (segmented ladders for some desks, checkbox cards
 * for others), and the flat checkbox lists in the Add seat and Edit seat
 * modals. Every power is now a switch on one searchable list, filtered by
 * area, so the answer to "where do I give someone X?" is always "search for
 * it here".
 *
 * Ladders didn't go away, they just stopped needing their own control: a
 * power another power implies shows as "Included with …" and its switch is
 * locked on, which is what the segmented control was expressing.
 *
 * Changes collect in a draft and save together (the caller decides how — a
 * seat saves per changed domain through `seats.setSeatDomainPowers`, Add seat
 * just keeps the set), so a stray tap never re-powers a seat mid-edit.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  POWER_DEFS,
  POWER_DOMAINS,
  POWER_DOMAIN_DEFS,
  powerDescription,
  powerLabel,
  type Power,
  type PowerDomain,
} from "@events-os/shared";
import { Badge, Button, Pill, Switch } from "../ui";
import { alertError } from "../../lib/errors";
import { OrgModal, SearchBox } from "./OrgModal";
import {
  groupByDomain,
  heldCountByDomain,
  holdersOf,
  powerDiff,
  powerState,
  searchPowers,
  type SeatChart,
} from "./powerPicker";

export function PowersPicker({
  visible,
  seatTitle,
  chart,
  initial,
  seatDefId,
  onSave,
  onClose,
}: {
  visible: boolean;
  seatTitle: string;
  chart: SeatChart;
  /** The seat's STORED powers when the picker opens. */
  initial: readonly string[];
  /** The seat being edited, so "also held by" leaves it out. Absent for a
   *  seat that doesn't exist yet (Add seat). */
  seatDefId?: string;
  onSave: (next: Power[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const directory = useQuery(api.seats.powersDirectory, visible ? {} : "skip");
  const [draft, setDraft] = useState<Set<string>>(() => new Set(initial));
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<PowerDomain | "all">("all");
  const [saving, setSaving] = useState(false);

  // Reset to the seat's real powers every time the picker opens.
  useEffect(() => {
    if (visible) {
      setDraft(new Set(initial));
      setQuery("");
      setDomain("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const shown = useMemo(() => searchPowers(query, domain, chart), [query, domain, chart]);
  const counts = useMemo(() => heldCountByDomain(draft, chart), [draft, chart]);
  const diff = powerDiff(initial, draft);
  const dirty = diff.added.length + diff.removed.length > 0;
  const heldCount = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

  function toggle(p: Power) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await onSave([...draft] as Power[]);
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  const summary = dirty
    ? [
        diff.added.length ? `Adding ${diff.added.map(powerLabel).join(", ")}` : "",
        diff.removed.length ? `Removing ${diff.removed.map(powerLabel).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "No changes yet.";

  return (
    <OrgModal
      visible={visible}
      wide
      title={`Powers for ${seatTitle}`}
      subtitle={`${heldCount} held${chart === "chapter" ? " · applies to this seat in every chapter" : ""}`}
      onClose={onClose}
      header={
        <View className="gap-2.5">
          <SearchBox
            value={query}
            onChangeText={setQuery}
            placeholder="Search powers, e.g. approve, donors, blog"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-1.5">
              <Pill label="All" size="sm" selected={domain === "all"} onPress={() => setDomain("all")} />
              {POWER_DOMAINS.map((d) => (
                <Pill
                  key={d}
                  size="sm"
                  label={POWER_DOMAIN_DEFS[d].label}
                  count={counts[d]}
                  selected={domain === d}
                  onPress={() => setDomain(d)}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      }
      footer={
        <>
          <Text className="mr-auto flex-1 text-xs text-muted" numberOfLines={2}>
            {summary}
          </Text>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Save changes" onPress={() => void save()} disabled={!dirty} loading={saving} />
        </>
      }
    >
      {shown.length === 0 ? (
        <Text className="px-5 py-8 text-sm text-muted">
          No power matches &ldquo;{query}&rdquo;. Try a verb like approve, see, or send.
        </Text>
      ) : (
        groupByDomain(shown).map((group) => (
          <View key={group.domain}>
            <Text className="bg-sunken px-5 py-1.5 text-2xs font-bold uppercase tracking-wider text-muted">
              {POWER_DOMAIN_DEFS[group.domain].label}
            </Text>
            {group.powers.map((p) => (
              <PowerRow
                key={p}
                power={p}
                state={powerState(draft, p)}
                others={directory ? holdersOf(p, directory, seatDefId).map((h) => h.seat.title) : null}
                onToggle={() => toggle(p)}
              />
            ))}
          </View>
        ))
      )}
    </OrgModal>
  );
}

function PowerRow({
  power,
  state,
  others,
  onToggle,
}: {
  power: Power;
  state: ReturnType<typeof powerState>;
  /** Titles of other seats holding it; `null` while loading. */
  others: string[] | null;
  onToggle: () => void;
}) {
  const included = state.kind === "included";
  const on = state.kind !== "off";
  const unique = others ? [...new Set(others)] : null;
  return (
    <Pressable
      onPress={included ? undefined : onToggle}
      disabled={included}
      className="flex-row items-center gap-4 border-t border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
    >
      <View className="flex-1 gap-1">
        <Text className="text-sm font-semibold text-ink">{powerLabel(power)}</Text>
        <Text className="text-xs text-muted">{powerDescription(power)}</Text>
        <View className="mt-0.5 flex-row flex-wrap gap-1.5">
          {included ? (
            <Badge tone="success" icon="check" label={`Included with ${powerLabel(state.via)}`} />
          ) : null}
          {unique === null ? null : unique.length === 0 ? (
            <Badge tone="accent" label="No other seat" />
          ) : (
            <Badge
              label={`Also: ${unique.slice(0, 2).join(", ")}${unique.length > 2 ? ` +${unique.length - 2}` : ""}`}
            />
          )}
          {POWER_DEFS[power].scope === "central" ? <Badge label="Central only" /> : null}
        </View>
      </View>
      <Switch
        value={on}
        onValueChange={onToggle}
        disabled={included}
        accessibilityLabel={powerLabel(power)}
      />
    </Pressable>
  );
}
