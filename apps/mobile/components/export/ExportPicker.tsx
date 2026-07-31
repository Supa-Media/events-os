/**
 * ExportPicker — scope, datasets, sections, format, and filters for ONE
 * export request. Driven entirely off the shared registry
 * (`@events-os/shared#EXPORT_DATASET_LIST`/`EXPORT_GROUPS`/`allowedSections`)
 * — nothing here hardcodes a dataset list, so a dataset added to the registry
 * shows up here for free.
 *
 * ONE WIDE FLAT FILE PER DATASET (founder decision, 2026-07-31 — see the
 * registry's own module doc): ticking three datasets requests three
 * independent, self-contained CSVs, never a zip or a relational bundle. This
 * screen never implies otherwise — no "download as .zip" language anywhere.
 *
 * Reach gates TWO different things, and this component keeps them visually
 * distinct:
 *  - A dataset the caller's `giving`/`finance` reach can't satisfy (via
 *    `EXPORT_DATASETS[id].requires`) is entirely GREYED OUT with the reason —
 *    it can't be ticked at all.
 *  - A dataset that doesn't exist at the current scope (`supportsCentral:
 *    false` while exporting "central") is greyed the same way, a second
 *    reason the registry alone can't express.
 *  - The PEOPLE dataset's optional column SECTIONS are pre-filtered to
 *    `allowedSections(...)` — a section the caller can't fill is never even
 *    offered as a toggle, so there is nothing to silently narrow client-side
 *    (the job's own `omittedSectionIds` is the belt-and-suspenders server
 *    check for reach that changes between ticking and running).
 */
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  EXPORT_DATASET_LIST,
  EXPORT_DATASETS,
  EXPORT_GROUPS,
  allowedSections,
  satisfiesRequirement,
  type ExportDatasetDef,
  type ExportDatasetId,
  type ExportFilterKey,
  type ExportFilters,
  type ExportFormat,
  type ExportGroup,
  type ExportSectionId,
} from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Card, DateTimeField, FilterSelect, Pill, SectionHeader } from "../ui";

/**
 * The shared package's own `ExportScope` is typed as plain `string` (its
 * module doc explains why: `Id<>` is a Convex-only type and that package is
 * also imported by code that isn't). Every Convex call in this feature DOES
 * need the real branded id, so the mobile side uses this narrower alias
 * instead — same pattern as `giving/donors.tsx`'s local `GivingScope`.
 */
export type MobileExportScope = "central" | Id<"chapters">;

export interface ExportScopeOption {
  scope: MobileExportScope;
  label: string;
  giving: boolean;
  finance: boolean;
}

export interface ExportRequestArgs {
  scope: MobileExportScope;
  datasetIds: ExportDatasetId[];
  sectionIds: ExportSectionId[];
  format: ExportFormat;
  filters: ExportFilters;
}

const PERSONA_OPTIONS = [
  { value: "", label: "Any persona" },
  { value: "team", label: "Team" },
  { value: "volunteer", label: "Volunteer" },
  { value: "vendor", label: "Vendor" },
  { value: "guest", label: "Guest" },
  { value: "contact", label: "Contact" },
];

const DATASETS_BY_GROUP: Record<ExportGroup, ExportDatasetDef[]> = (() => {
  const map = {} as Record<ExportGroup, ExportDatasetDef[]>;
  for (const g of EXPORT_GROUPS) map[g] = [];
  for (const ds of EXPORT_DATASET_LIST) map[ds.group].push(ds);
  return map;
})();

function datasetGate(
  ds: ExportDatasetDef,
  scope: MobileExportScope,
  reach: { giving: boolean; finance: boolean },
): { allowed: boolean; reason?: string } {
  if (scope === "central" && !ds.supportsCentral) {
    return {
      allowed: false,
      reason: "Not available at the central/org level — switch to a chapter.",
    };
  }
  if (!satisfiesRequirement(ds.requires, reach)) {
    return {
      allowed: false,
      reason:
        ds.requires === "giving.view"
          ? "Needs development-desk access at this scope."
          : "Needs a finance role at this scope.",
    };
  }
  return { allowed: true };
}

export function ExportPicker({
  scopes,
  scope,
  onScopeChange,
  onSubmit,
  submitting,
  submitError,
  initialDatasetIds,
}: {
  scopes: ExportScopeOption[];
  scope: MobileExportScope;
  onScopeChange: (scope: MobileExportScope) => void;
  onSubmit: (args: ExportRequestArgs) => void | Promise<void>;
  submitting: boolean;
  submitError?: string | null;
  /** Prefills the ticked datasets — used by the Donors/Gifts/People entry
   *  points and a job row's "Re-run". Only read at mount; the caller
   *  remounts (a `key` change) to re-prefill later. */
  initialDatasetIds?: ExportDatasetId[];
}) {
  const current = scopes.find((s) => s.scope === scope);
  const reach = { giving: current?.giving ?? false, finance: current?.finance ?? false };

  const [selected, setSelected] = useState<Set<ExportDatasetId>>(
    () => new Set(initialDatasetIds ?? []),
  );
  const [sections, setSections] = useState<Partial<Record<ExportDatasetId, Set<ExportSectionId>>>>(
    {},
  );
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [dateOn, setDateOn] = useState(false);
  const [dateFrom, setDateFrom] = useState<number>(() => Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [dateTo, setDateTo] = useState<number>(() => Date.now());
  const [activeOnly, setActiveOnly] = useState(false);
  const [rosterOnly, setRosterOnly] = useState(false);
  const [persona, setPersona] = useState("");

  // A scope switch can revoke reach for something already ticked (e.g.
  // dropping from a giving-view chapter to one without) — drop it rather
  // than silently submitting a request the server would just narrow anyway.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<ExportDatasetId>();
      for (const id of prev) {
        if (datasetGate(EXPORT_DATASETS[id], scope, reach).allowed) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, reach.giving, reach.finance]);

  function toggleDataset(id: ExportDatasetId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Seed sections at their registry default the first time a dataset
        // with sections is ticked.
        if (EXPORT_DATASETS[id].sections.length > 0 && !sections[id]) {
          const allowed = allowedSections(id, reach);
          setSections((s) => ({
            ...s,
            [id]: new Set(allowed.filter((sec) => sec.defaultOn).map((sec) => sec.id)),
          }));
        }
      }
      return next;
    });
  }

  function toggleSection(datasetId: ExportDatasetId, sectionId: ExportSectionId) {
    setSections((prev) => {
      const cur = new Set(prev[datasetId] ?? []);
      if (cur.has(sectionId)) cur.delete(sectionId);
      else cur.add(sectionId);
      return { ...prev, [datasetId]: cur };
    });
  }

  const filterKeys = useMemo(() => {
    const keys = new Set<ExportFilterKey>();
    for (const id of selected) for (const k of EXPORT_DATASETS[id].filters) keys.add(k);
    return keys;
  }, [selected]);

  function buildFilters(): ExportFilters {
    const filters: ExportFilters = {};
    if (dateOn) {
      filters.from = dateFrom;
      filters.to = dateTo;
    }
    if (activeOnly) filters.activeOnly = true;
    if (rosterOnly) filters.rosterOnly = true;
    if (persona) filters.persona = persona;
    return filters;
  }

  async function handleSubmit() {
    if (selected.size === 0) return;
    const datasetIds = Array.from(selected);
    const sectionIds = Array.from(
      new Set(datasetIds.flatMap((id) => Array.from(sections[id] ?? []))),
    );
    await onSubmit({ scope, datasetIds, sectionIds, format, filters: buildFilters() });
  }

  return (
    <Card>
      <Text className="mb-1 font-display text-base text-ink">New export</Text>
      <Text className="mb-3 text-xs text-muted">
        Every dataset you tick becomes its OWN spreadsheet — one wide file per
        dataset, never a bundle or a zip. Pick what you need, then run it.
      </Text>

      {scopes.length > 1 ? (
        <View className="mb-3">
          <FilterSelect
            label="Scope"
            value={scope}
            options={scopes.map((s) => ({ value: s.scope, label: s.label }))}
            onChange={(v) => onScopeChange(v as MobileExportScope)}
            minWidth={220}
          />
        </View>
      ) : null}

      {EXPORT_GROUPS.map((group) => {
        const datasets = DATASETS_BY_GROUP[group];
        if (datasets.length === 0) return null;
        return (
          <View key={group} className="mb-4">
            <SectionHeader title={group} />
            <View className="gap-2">
              {datasets.map((ds) => {
                const gate = datasetGate(ds, scope, reach);
                const isSelected = selected.has(ds.id);
                const dsSections = gate.allowed ? allowedSections(ds.id, reach) : [];
                return (
                  <View key={ds.id}>
                    <DatasetRow
                      dataset={ds}
                      selected={isSelected}
                      allowed={gate.allowed}
                      reason={gate.reason}
                      onPress={() => toggleDataset(ds.id)}
                    />
                    {isSelected && gate.allowed && dsSections.length > 0 ? (
                      <View className="ml-6 mt-2 flex-row flex-wrap gap-2">
                        {dsSections.map((sec) => (
                          <Pill
                            key={sec.id}
                            label={
                              (sections[ds.id]?.has(sec.id) ?? false)
                                ? `${sec.label} ✓`
                                : sec.label
                            }
                            selected={sections[ds.id]?.has(sec.id) ?? false}
                            onPress={() => toggleSection(ds.id, sec.id)}
                          />
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}

      {filterKeys.size > 0 ? (
        <View className="mb-4">
          <SectionHeader title="Filters" />
          <View className="flex-row flex-wrap items-center gap-2">
            {filterKeys.has("dateRange") ? (
              <Pill
                label={dateOn ? "Filter by date ✓" : "Filter by date"}
                selected={dateOn}
                onPress={() => setDateOn((v) => !v)}
              />
            ) : null}
            {filterKeys.has("activeOnly") ? (
              <Pill
                label={activeOnly ? "Active only ✓" : "Active only"}
                selected={activeOnly}
                onPress={() => setActiveOnly((v) => !v)}
              />
            ) : null}
            {filterKeys.has("rosterOnly") ? (
              <Pill
                label={rosterOnly ? "Roster only ✓" : "Roster only"}
                selected={rosterOnly}
                onPress={() => setRosterOnly((v) => !v)}
              />
            ) : null}
            {filterKeys.has("persona") ? (
              <FilterSelect
                label="Persona"
                value={persona}
                options={PERSONA_OPTIONS}
                onChange={setPersona}
              />
            ) : null}
          </View>
          {filterKeys.has("dateRange") && dateOn ? (
            <View className="mt-2 flex-row flex-wrap items-center gap-3">
              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase text-faint">From</Text>
                <DateTimeField value={dateFrom} onChange={setDateFrom} />
              </View>
              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase text-faint">To</Text>
                <DateTimeField value={dateTo} onChange={setDateTo} />
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      <View className="mb-4 flex-row items-center gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted">Format</Text>
        <Pill label="CSV" selected={format === "csv"} onPress={() => setFormat("csv")} />
        <Pill label="JSON" selected={format === "json"} onPress={() => setFormat("json")} />
      </View>

      {submitError ? <Text className="mb-2 text-sm text-danger">{submitError}</Text> : null}

      <Button
        title={
          selected.size === 0
            ? "Select at least one dataset"
            : `Start export (${selected.size} file${selected.size === 1 ? "" : "s"})`
        }
        icon="download"
        onPress={() => void handleSubmit()}
        loading={submitting}
        disabled={selected.size === 0 || submitting}
      />
    </Card>
  );
}

function DatasetRow({
  dataset,
  selected,
  allowed,
  reason,
  onPress,
}: {
  dataset: ExportDatasetDef;
  selected: boolean;
  allowed: boolean;
  reason?: string;
  onPress: () => void;
}) {
  const inert = !allowed;
  return (
    <Card padding="sm" onPress={inert ? undefined : onPress} className={inert ? "opacity-50" : ""}>
      <View className="flex-row items-start gap-3">
        <View
          className={`mt-0.5 h-4 w-4 items-center justify-center rounded-sm border ${
            selected ? "border-accent bg-accent" : "border-border-strong bg-raised"
          }`}
        >
          {selected ? <View className="h-1.5 w-1.5 rounded-sm bg-white" /> : null}
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">{dataset.label}</Text>
          <Text className="text-xs text-muted">{dataset.description}</Text>
          {inert && reason ? (
            <Text className="mt-1 text-2xs font-semibold text-warn">{reason}</Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
