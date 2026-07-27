/**
 * People-CRM overhaul (2026-07-27) — the compact filter row that replaces the
 * People tab's old four-row header (title / persona segments / a stray
 * "Givers" pill / a full-width search box / 30 wrapping service chips). Three
 * anchored dropdowns (Persona / Services / More) sit next to the search box;
 * every selection also lands as a removable pill in `ActiveFilterPills`
 * below — the standard CRM "chip row + Clear all" pattern.
 *
 * Built on the same `useAnchor` + `Popover` plumbing every other grid filter
 * in this app already uses (`FilterSelect`, the grid's `SelectCell`) — no new
 * dropdown primitive, just new CONTENT (multi-select + counts + grouping)
 * inside the existing one.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { RosterStatus, Persona } from "@events-os/shared";
import { Icon, Popover } from "../ui";
import { useAnchor } from "../ui/useAnchor";
import { colors } from "../../lib/theme";
import { flattenServiceCatalog } from "../../lib/serviceCatalog";

export type PersonaFilter = Persona | "all";

/** Every rung of the ladder, in display order — mirrors the People tab's old
 *  segmented control order exactly, so nothing about the filter's MEANING
 *  changes, just its shape. */
const PERSONA_ORDER: PersonaFilter[] = ["all", "team", "volunteer", "vendor", "guest", "contact"];
const PERSONA_LABEL: Record<PersonaFilter, string> = {
  all: "All",
  team: "Team",
  volunteer: "Volunteers",
  vendor: "Vendors",
  guest: "Guests",
  contact: "Contacts",
};

export type PersonaCounts = {
  all: number;
  team: number;
  volunteer: number;
  vendor: number;
  guest: number;
  contact: number;
};

/** Generic trigger pill shared by every dropdown below — a compact
 *  rounded-pill button with a label, an optional active-count badge, and a
 *  chevron, matching `FilterSelect`'s trigger exactly. */
function DropdownTrigger({
  triggerRef,
  label,
  active,
  onPress,
}: {
  triggerRef: React.MutableRefObject<any>;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      ref={triggerRef}
      onPress={onPress}
      accessibilityRole="button"
      className={`flex-row items-center gap-1.5 self-start rounded-pill border px-3 py-1.5 active:bg-sunken web:hover:bg-sunken ${
        active ? "border-accent bg-accent-soft" : "border-border-strong bg-raised"
      }`}
    >
      <Text
        className={`text-sm font-semibold ${active ? "text-accent" : "text-ink"}`}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Icon name="chevron-down" size={14} color={active ? colors.accent : colors.muted} />
    </Pressable>
  );
}

// ── Persona dropdown — single-select over the ladder, each row showing its
// count (the SAME counts the summary row below renders, one source of truth
// via the `counts` prop from `people.counts`). ──────────────────────────────
export function PersonaDropdown({
  value,
  counts,
  onChange,
}: {
  value: PersonaFilter;
  counts: PersonaCounts | undefined;
  onChange: (next: PersonaFilter) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  return (
    <>
      <DropdownTrigger
        triggerRef={ref}
        label={`Persona: ${PERSONA_LABEL[value]}`}
        active={value !== "all"}
        onPress={open}
      />
      <Popover visible={visible} onClose={close} anchor={anchor} width={220}>
        {PERSONA_ORDER.map((key) => {
          const selected = key === value;
          return (
            <Pressable
              key={key}
              onPress={() => {
                onChange(key);
                close();
              }}
              className={`flex-row items-center justify-between px-3 py-2.5 active:bg-sunken web:hover:bg-sunken ${
                selected ? "bg-sunken" : "bg-raised"
              }`}
            >
              <Text className={`text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}>
                {PERSONA_LABEL[key]}
              </Text>
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-faint">{counts ? counts[key] : "…"}</Text>
                {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
              </View>
            </Pressable>
          );
        })}
      </Popover>
    </>
  );
}

/** Read-only-but-clickable summary row (founder spec: "Persona stays as
 *  counts, but compact — it's both a filter and a summary"). Drives the SAME
 *  `persona` state as the dropdown above, so either control keeps the other
 *  in sync. */
export function PersonaCountsRow({
  value,
  counts,
  onChange,
}: {
  value: PersonaFilter;
  counts: PersonaCounts | undefined;
  onChange: (next: PersonaFilter) => void;
}) {
  return (
    <View className="flex-row flex-wrap items-center gap-x-1">
      {PERSONA_ORDER.map((key, i) => {
        const active = key === value;
        return (
          <View key={key} className="flex-row items-center">
            {i > 0 ? <Text className="text-sm text-faint">{"  ·  "}</Text> : null}
            <Pressable onPress={() => onChange(key)} hitSlop={4} className="active:opacity-70">
              <Text className={`text-sm ${active ? "font-bold text-ink" : "text-muted"}`}>
                {PERSONA_LABEL[key]}{" "}
                <Text className={active ? "text-accent" : "text-faint"}>
                  {counts ? counts[key] : "…"}
                </Text>
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

// ── Services dropdown — multi-select, grouped by parent, searchable, each
// row showing the catalog's own usage count. OR semantics: picking a parent
// matches it AND every child (enforced server-side —
// `lib/serviceCatalog.ts#expandServiceIdsWithChildren` — this UI just shows
// what's selected). No "add new"/"manage" affordances here — those live in
// `ServiceOptionsPicker`; this is filter-only. ──────────────────────────────
export function ServicesDropdown({
  selectedIds,
  onChange,
}: {
  selectedIds: Id<"serviceOptions">[];
  onChange: (next: Id<"serviceOptions">[]) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [search, setSearch] = useState("");
  const tree = useQuery(api.serviceOptions.list, visible ? { includeInactive: false } : "skip");
  const flat = useMemo(() => (tree ? flattenServiceCatalog(tree) : []), [tree]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const q = search.trim().toLowerCase();
  const visibleRows = flat.filter((o) => !q || o.label.toLowerCase().includes(q));

  function toggle(id: Id<"serviceOptions">) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  return (
    <>
      <DropdownTrigger
        triggerRef={ref}
        label={selectedIds.length > 0 ? `Services (${selectedIds.length})` : "Services"}
        active={selectedIds.length > 0}
        onPress={open}
      />
      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="border-b border-border px-3 py-2">
          <View className="flex-row items-center gap-2 rounded-md border border-border-strong bg-raised px-2 py-1.5">
            <Icon name="search" size={13} color={colors.faint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search services…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              className="flex-1 text-sm text-ink"
            />
          </View>
        </View>
        {tree === undefined ? (
          <Text className="px-3 py-4 text-center text-sm text-muted">Loading…</Text>
        ) : visibleRows.length === 0 ? (
          <Text className="px-3 py-4 text-center text-sm text-muted">No matches.</Text>
        ) : (
          visibleRows.map((row) => {
            const isSelected = selected.has(row._id);
            return (
              <Pressable
                key={row._id}
                onPress={() => toggle(row._id)}
                className={`flex-row items-center justify-between px-3 py-2 active:bg-sunken web:hover:bg-sunken ${
                  row.parentId ? "pl-7" : ""
                }`}
              >
                <View className="flex-1 flex-row items-center gap-2">
                  <View
                    className={`h-4 w-4 items-center justify-center rounded border ${
                      isSelected ? "border-accent bg-accent" : "border-border-strong"
                    }`}
                  >
                    {isSelected ? <Icon name="check" size={11} color={colors.accentText} /> : null}
                  </View>
                  <Text
                    className={`flex-1 text-sm ${isSelected ? "font-semibold text-accent" : "text-ink"}`}
                    numberOfLines={1}
                  >
                    {row.label}
                  </Text>
                </View>
                <Text className="text-xs text-faint">{row.usageCount}</Text>
              </Pressable>
            );
          })
        )}
        <Pressable
          onPress={close}
          className="border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Text className="text-center text-sm font-semibold text-accent">Done</Text>
        </Pressable>
      </Popover>
    </>
  );
}

// ── "More" dropdown — Status (single-select) + Givers (toggle). The catch-
// all for filters that don't earn their own header slot, so the header never
// grows again as new filters show up. ───────────────────────────────────────
const STATUS_OPTIONS: { value: RosterStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "transitioning_in", label: "Transitioning in" },
  { value: "transitioning_out", label: "Transitioning out" },
  { value: "unavailable", label: "Unavailable" },
];

export function MoreFiltersDropdown({
  status,
  onChangeStatus,
  giversOnly,
  onChangeGiversOnly,
  showGivers,
}: {
  status: RosterStatus | null;
  onChangeStatus: (next: RosterStatus | null) => void;
  giversOnly: boolean;
  onChangeGiversOnly: (next: boolean) => void;
  /** The Givers overlay only exists for a caller with giving access at this
   *  chapter — hidden entirely otherwise, same as the old standalone chip. */
  showGivers: boolean;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const active = status !== null || giversOnly;
  return (
    <>
      <DropdownTrigger triggerRef={ref} label="More" active={active} onPress={open} />
      <Popover visible={visible} onClose={close} anchor={anchor} width={220}>
        <Text className="px-3 pt-2.5 pb-1 text-2xs font-bold uppercase tracking-wider text-faint">
          Status
        </Text>
        <Pressable
          onPress={() => onChangeStatus(null)}
          className={`flex-row items-center justify-between px-3 py-2 active:bg-sunken web:hover:bg-sunken ${
            status === null ? "bg-sunken" : ""
          }`}
        >
          <Text className={`text-sm ${status === null ? "font-semibold text-accent" : "text-ink"}`}>
            Any status
          </Text>
          {status === null ? <Icon name="check" size={15} color={colors.accent} /> : null}
        </Pressable>
        {STATUS_OPTIONS.map((o) => {
          const selected = status === o.value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChangeStatus(o.value)}
              className={`flex-row items-center justify-between px-3 py-2 active:bg-sunken web:hover:bg-sunken ${
                selected ? "bg-sunken" : ""
              }`}
            >
              <Text className={`text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}>
                {o.label}
              </Text>
              {selected ? <Icon name="check" size={15} color={colors.accent} /> : null}
            </Pressable>
          );
        })}
        {showGivers ? (
          <>
            <View className="mt-1 border-t border-border" />
            <Pressable
              onPress={() => onChangeGiversOnly(!giversOnly)}
              accessibilityRole="switch"
              accessibilityState={{ checked: giversOnly }}
              className="flex-row items-center justify-between px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
            >
              <View className="flex-row items-center gap-2">
                <Icon name="heart" size={13} color={colors.danger} />
                <Text className="text-sm text-ink">Givers only</Text>
              </View>
              <View
                className={`h-4 w-4 items-center justify-center rounded border ${
                  giversOnly ? "border-accent bg-accent" : "border-border-strong"
                }`}
              >
                {giversOnly ? <Icon name="check" size={11} color={colors.accentText} /> : null}
              </View>
            </Pressable>
          </>
        ) : null}
      </Popover>
    </>
  );
}

// ── Active filter pills — one removable pill per non-default filter, plus
// "Clear all". The standard CRM pattern: collapses "what's currently
// narrowing this list" into one legible row instead of leaving the user to
// reconstruct it from four separate controls. ──────────────────────────────
export type ActiveFilterChip = { key: string; label: string; onRemove: () => void };

export function ActiveFilterPills({
  chips,
  onClearAll,
}: {
  chips: ActiveFilterChip[];
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Pressable
          key={chip.key}
          onPress={chip.onRemove}
          className="flex-row items-center gap-1 rounded-pill border border-border-strong bg-sunken px-2.5 py-1 active:opacity-70"
        >
          <Text className="text-xs font-medium text-ink">{chip.label}</Text>
          <Icon name="x" size={11} color={colors.muted} />
        </Pressable>
      ))}
      <Pressable onPress={onClearAll} hitSlop={4} className="px-1.5 py-1 active:opacity-70">
        <Text className="text-xs font-semibold text-muted underline">Clear all</Text>
      </Pressable>
    </View>
  );
}
