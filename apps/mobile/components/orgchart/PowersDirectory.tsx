/**
 * The Powers directory — the org chart's answer to "who can do this?".
 * Opened from the toolbar's Powers button.
 *
 * Until this existed, powers could only be read seat by seat, so checking who
 * can approve budgets meant opening every box. Here you pick a power and see
 * every seat that holds it, directly or through another power, read at each
 * seat's own scope. A chart editor can grant it to another seat or take a
 * direct grant away from one, through the same one-domain-at-a-time write the
 * picker uses (`seats.setSeatDomainPowers`).
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  POWER_DEFS,
  POWER_DOMAIN_DEFS,
  powerDescription,
  powerLabel,
  type Power,
} from "@events-os/shared";
import { Badge, Button, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../../lib/confirmAction";
import { OrgModal, SearchBox } from "./OrgModal";
import {
  domainWrites,
  groupByDomain,
  holdersOf,
  offerablePowers,
  matchesQuery,
  type DirectorySeat,
} from "./powerPicker";

const chartLabel = (c: "central" | "chapter") => (c === "central" ? "Central" : "Every chapter");

export function PowersDirectory({
  visible,
  canEdit,
  onClose,
}: {
  visible: boolean;
  /** Superuser or `org.chart.edit` — may grant and remove. */
  canEdit: boolean;
  onClose: () => void;
}) {
  const directory = useQuery(api.seats.powersDirectory, visible ? {} : "skip");
  const setDomainPowers = useMutation(api.seats.setSeatDomainPowers);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Power | null>(null);
  const [granting, setGranting] = useState(false);
  const [seatQuery, setSeatQuery] = useState("");

  const powers = useMemo(
    () => offerablePowers("central").filter((p) => matchesQuery(p, query)),
    [query],
  );

  async function write(seat: DirectorySeat, next: string[]) {
    for (const w of domainWrites(seat.capabilities, next)) {
      await setDomainPowers({
        seatDefId: seat.defId as Id<"seatDefs">,
        domain: w.domain,
        powers: w.powers,
      });
    }
  }

  function grant(p: Power, seat: DirectorySeat) {
    confirmAction({
      title: `Give ${seat.title} "${powerLabel(p)}"?`,
      message:
        seat.chart === "chapter"
          ? `Every chapter's ${seat.title} gets it right away.`
          : `${seat.title} gets it right away.`,
      confirmLabel: "Give power",
      onConfirm: () =>
        void write(seat, [...seat.capabilities, p])
          .then(() => setGranting(false))
          .catch(alertError),
    });
  }

  function revoke(p: Power, seat: DirectorySeat) {
    confirmAction({
      title: `Take "${powerLabel(p)}" from ${seat.title}?`,
      message: "It stops working right away, along with anything it included.",
      confirmLabel: "Take away",
      destructive: true,
      onConfirm: () => void write(seat, seat.capabilities.filter((c) => c !== p)).catch(alertError),
    });
  }

  function close() {
    setSelected(null);
    setGranting(false);
    setQuery("");
    onClose();
  }

  // ── Detail: one power ──────────────────────────────────────────────────
  if (selected) {
    const holders = directory ? holdersOf(selected, directory) : [];
    const holderIds = new Set(holders.map((h) => h.seat.defId));
    const candidates = (directory ?? []).filter(
      (s) =>
        !holderIds.has(s.defId) &&
        (s.chart === "central" || POWER_DEFS[selected].scope !== "central") &&
        s.title.toLowerCase().includes(seatQuery.trim().toLowerCase()),
    );
    return (
      <OrgModal
        visible={visible}
        wide
        title={powerLabel(selected)}
        subtitle={`${POWER_DOMAIN_DEFS[POWER_DEFS[selected].domain].label} · ${holders.length} ${
          holders.length === 1 ? "seat" : "seats"
        }`}
        onClose={close}
        header={
          <View className="gap-2">
            <Text className="text-sm text-muted">{powerDescription(selected)}</Text>
            <View className="flex-row flex-wrap gap-2">
              <Button
                title="All powers"
                variant="ghost"
                size="sm"
                icon="arrow-left"
                onPress={() => {
                  setSelected(null);
                  setGranting(false);
                }}
              />
              {canEdit && !granting ? (
                <Button title="Give to a seat" size="sm" icon="plus" onPress={() => setGranting(true)} />
              ) : null}
            </View>
            {granting ? (
              <SearchBox value={seatQuery} onChangeText={setSeatQuery} placeholder="Find a seat" autoFocus />
            ) : null}
          </View>
        }
      >
        {directory === undefined ? (
          <View className="py-8">
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : granting ? (
          candidates.map((s) => (
            <Pressable
              key={s.defId}
              onPress={() => grant(selected, s)}
              className="flex-row items-center justify-between border-t border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
            >
              <View className="flex-1">
                <Text className="text-sm text-ink">{s.title}</Text>
                <Text className="text-xs text-faint">{chartLabel(s.chart)}</Text>
              </View>
              <Icon name="plus" size={16} color={colors.accent} />
            </Pressable>
          ))
        ) : holders.length === 0 ? (
          <Text className="px-5 py-8 text-sm text-muted">No seat holds this yet.</Text>
        ) : (
          holders.map(({ seat, via }) => (
            <View key={seat.defId} className="flex-row items-center gap-3 border-t border-border px-5 py-3">
              <View className="flex-1">
                <Text className="text-sm text-ink">{seat.title}</Text>
                <Text className="text-xs text-faint">
                  {chartLabel(seat.chart)} · {via ? `included with ${powerLabel(via)}` : "given directly"}
                </Text>
              </View>
              {canEdit && !via ? (
                <Button title="Take away" variant="ghost" size="sm" onPress={() => revoke(selected, seat)} />
              ) : null}
            </View>
          ))
        )}
      </OrgModal>
    );
  }

  // ── List: every power ──────────────────────────────────────────────────
  return (
    <OrgModal
      visible={visible}
      wide
      title="Powers"
      subtitle="Who can do what across the org. Pick one to see every seat that has it."
      onClose={close}
      header={<SearchBox value={query} onChangeText={setQuery} placeholder="Search all powers" />}
    >
      {groupByDomain(powers).map((group) => (
        <View key={group.domain}>
          <Text className="bg-sunken px-5 py-1.5 text-2xs font-bold uppercase tracking-wider text-muted">
            {POWER_DOMAIN_DEFS[group.domain].label}
          </Text>
          {group.powers.map((p) => {
            const count = directory ? holdersOf(p, directory).length : null;
            return (
              <Pressable
                key={p}
                onPress={() => setSelected(p)}
                className="flex-row items-center gap-3 border-t border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
              >
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink">{powerLabel(p)}</Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {powerDescription(p)}
                  </Text>
                </View>
                {count === null ? null : (
                  <Badge tone={count === 0 ? "warn" : "neutral"} label={`${count} ${count === 1 ? "seat" : "seats"}`} />
                )}
                <Icon name="chevron-right" size={16} color={colors.faint} />
              </Pressable>
            );
          })}
        </View>
      ))}
      {powers.length === 0 ? (
        <Text className="px-5 py-8 text-sm text-muted">No power matches &ldquo;{query}&rdquo;.</Text>
      ) : null}
    </OrgModal>
  );
}
