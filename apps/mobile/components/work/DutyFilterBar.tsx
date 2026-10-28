/**
 * The Duties page's controls: the view tabs, search, the seat / chart / sort /
 * group dropdowns, cadence and flag chips, and a row of removable pills for
 * whatever is currently narrowing the list. Purely presentational — the rules
 * live in `dutyFilters.logic.ts` and the state in `DutiesGrid`.
 */
import { View, Text, Pressable } from "react-native";
import {
  RESPONSIBILITY_CADENCE_LABELS,
} from "@events-os/shared";
import {
  FilterSelect,
  Icon,
  Pill,
  TextField,
  type FilterSelectOption,
} from "../ui";
import { colors, spacing } from "../../lib/theme";
import {
  DUTY_CADENCES,
  EMPTY_DUTY_FILTERS,
  hasActiveFilters,
  type DutyFilters,
  type DutyGroupBy,
  type DutySort,
  type DutyView,
} from "./dutyFilters.logic";

const VIEWS: { key: DutyView; label: string }[] = [
  { key: "all", label: "All duties" },
  { key: "attention", label: "Needs attention" },
  { key: "mine", label: "My seats" },
  { key: "howto", label: "Missing how-to" },
];

const FLAGS: { key: "vacantOnly" | "noHowTo" | "directOnly"; label: string }[] = [
  { key: "vacantOnly", label: "Has a vacant seat" },
  { key: "noHowTo", label: "No how-to" },
  { key: "directOnly", label: "Assigned to people directly" },
];

const SORT_OPTIONS: FilterSelectOption[] = [
  { value: "title", label: "A to Z" },
  { value: "cadence", label: "Most frequent first" },
  { value: "most", label: "Most people first" },
  { value: "fewest", label: "Fewest people first" },
];

const GROUP_OPTIONS: FilterSelectOption[] = [
  { value: "none", label: "None" },
  { value: "cadence", label: "Cadence" },
  { value: "seat", label: "Seat" },
];

const CHART_OPTIONS: FilterSelectOption[] = [
  { value: "", label: "Central + chapter" },
  { value: "central", label: "Central seats" },
  { value: "chapter", label: "Chapter seats" },
];

export function DutyFilterBar({
  filters,
  onChange,
  sort,
  onSort,
  groupBy,
  onGroupBy,
  viewCounts,
  cadenceCounts,
  seats,
  shown,
  total,
}: {
  filters: DutyFilters;
  onChange: (next: DutyFilters) => void;
  sort: DutySort;
  onSort: (s: DutySort) => void;
  groupBy: DutyGroupBy;
  onGroupBy: (g: DutyGroupBy) => void;
  viewCounts: Record<DutyView, number>;
  /** Per cadence, within the current view. */
  cadenceCounts: Record<string, number>;
  seats: { id: string; title: string; chart: "central" | "chapter"; vacant: boolean }[];
  shown: number;
  total: number;
}) {
  const set = (patch: Partial<DutyFilters>) => onChange({ ...filters, ...patch });

  const seatOptions: FilterSelectOption[] = [{ value: "", label: "Any seat" }];
  for (const chart of ["central", "chapter"] as const) {
    const inChart = seats.filter((s) => s.chart === chart);
    if (inChart.length === 0) continue;
    seatOptions.push({
      value: `header:${chart}`,
      label: chart === "central" ? "Central" : "Chapter",
      header: true,
    });
    for (const s of inChart) {
      seatOptions.push({ value: s.id, label: s.vacant ? `${s.title} (vacant)` : s.title });
    }
  }
  const seatTitle = seats.find((s) => s.id === filters.seatId)?.title;

  const pills: { key: string; label: string; clear: () => void }[] = [];
  if (filters.query.trim()) {
    pills.push({ key: "q", label: `“${filters.query.trim()}”`, clear: () => set({ query: "" }) });
  }
  for (const c of filters.cadences) {
    pills.push({
      key: `c:${c}`,
      label: RESPONSIBILITY_CADENCE_LABELS[c],
      clear: () => set({ cadences: filters.cadences.filter((x) => x !== c) }),
    });
  }
  if (filters.seatId) {
    pills.push({ key: "seat", label: `Seat: ${seatTitle ?? "?"}`, clear: () => set({ seatId: null }) });
  }
  if (filters.chart) {
    pills.push({
      key: "chart",
      label: filters.chart === "central" ? "Central seats" : "Chapter seats",
      clear: () => set({ chart: null }),
    });
  }
  for (const f of FLAGS) {
    if (filters[f.key]) pills.push({ key: f.key, label: f.label, clear: () => set({ [f.key]: false }) });
  }

  return (
    <View style={{ gap: spacing.md }}>
      <View
        accessibilityRole="tablist"
        className="flex-row flex-wrap border-b border-border"
      >
        {VIEWS.map((v) => {
          const active = filters.view === v.key;
          return (
            <Pressable
              key={v.key}
              onPress={() => set({ view: v.key })}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              className={`-mb-px flex-row items-center gap-2 border-b-2 px-3 py-2.5 ${
                active ? "border-accent" : "border-transparent"
              } web:hover:bg-sunken`}
            >
              <Text
                className={`text-sm ${active ? "font-bold text-ink" : "font-semibold text-muted"}`}
              >
                {v.label}
              </Text>
              <View
                className={`rounded-pill px-2 py-px ${active ? "bg-accent-soft" : "bg-sunken"}`}
              >
                <Text
                  className={`text-2xs font-bold ${active ? "text-accent" : "text-muted"}`}
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {viewCounts[v.key]}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View
        className="rounded-lg border border-border bg-raised p-3"
        style={{ gap: spacing.sm }}
      >
        <View className="flex-row flex-wrap items-center" style={{ gap: spacing.sm }}>
          <View style={{ flexGrow: 999, flexShrink: 1, flexBasis: 260, minWidth: 0 }}>
            <TextField
              placeholder="Search duties, seats, people…"
              value={filters.query}
              onChangeText={(query) => set({ query })}
              autoCapitalize="none"
              accessibilityLabel="Search duties"
            />
          </View>
          <FilterSelect
            label="Seat"
            value={filters.seatId ?? ""}
            options={seatOptions}
            onChange={(v) => set({ seatId: v || null })}
            minWidth={240}
          />
          <FilterSelect
            label="Chart"
            value={filters.chart ?? ""}
            options={CHART_OPTIONS}
            onChange={(v) => set({ chart: v === "central" || v === "chapter" ? v : null })}
          />
          <FilterSelect
            label="Sort"
            value={sort}
            options={SORT_OPTIONS}
            onChange={(v) => onSort(v as DutySort)}
          />
          <FilterSelect
            label="Group"
            value={groupBy}
            options={GROUP_OPTIONS}
            onChange={(v) => onGroupBy(v as DutyGroupBy)}
          />
        </View>

        <View className="flex-row flex-wrap items-center" style={{ gap: spacing.xs }}>
          <Text className="mr-1 text-2xs font-bold uppercase tracking-wider text-muted">
            Cadence
          </Text>
          {DUTY_CADENCES.filter(
            (c) => (cadenceCounts[c] ?? 0) > 0 || filters.cadences.includes(c),
          ).map((c) => {
            const active = filters.cadences.includes(c);
            return (
              <Pill
                key={c}
                size="sm"
                label={RESPONSIBILITY_CADENCE_LABELS[c]}
                count={cadenceCounts[c] ?? 0}
                selected={active}
                onPress={() =>
                  set({
                    cadences: active
                      ? filters.cadences.filter((x) => x !== c)
                      : [...filters.cadences, c],
                  })
                }
              />
            );
          })}
          <View className="mx-1 h-5 w-px bg-border" />
          {FLAGS.map((f) => (
            <Pill
              key={f.key}
              size="sm"
              label={f.label}
              selected={filters[f.key]}
              onPress={() => set({ [f.key]: !filters[f.key] })}
            />
          ))}
        </View>

        {hasActiveFilters(filters) ? (
          <View
            className="flex-row flex-wrap items-center border-t border-border pt-3"
            style={{ gap: spacing.xs }}
          >
            <Text className="mr-1 text-sm text-muted">
              Showing <Text className="font-bold text-ink">{shown}</Text> of {total}
            </Text>
            {pills.map((p) => (
              <Pressable
                key={p.key}
                onPress={p.clear}
                accessibilityLabel={`Remove filter ${p.label}`}
                className="flex-row items-center gap-1.5 rounded-pill border border-brand-200 bg-accent-soft px-2.5 py-1 active:opacity-80"
              >
                <Text className="text-xs font-semibold text-accent">{p.label}</Text>
                <Icon name="x" size={11} color={colors.accent} />
              </Pressable>
            ))}
            <Pressable
              onPress={() => onChange({ ...EMPTY_DUTY_FILTERS, view: filters.view })}
              className="px-1 py-1"
            >
              <Text className="text-xs font-semibold text-accent underline">
                Clear all
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}
