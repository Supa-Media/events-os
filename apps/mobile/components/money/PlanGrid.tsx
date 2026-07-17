/**
 * PlanGrid (PR4, "the plan IS the database") — ONE flat, inline-editable
 * table of EVERY cost on this event: Tasks/Supplies/Comms/any custom
 * currency-column module, paid vendors (Crew & Duties), and budget lines
 * (WP-3.1) — one row each, Item / Type / Category / Status / Planned /
 * Actual. This replaces the old two-surface split (a read-mostly "Cost
 * inventory" grid here + a separate "Edit plan" modal onto
 * `BudgetLineItemsEditor`) — there is now exactly one place to plan an
 * event's spend, and every edit writes straight back to that row's OWN home
 * table (`items.ts` / `engagements.ts` / `budgetLines.ts`); this component
 * never introduces a new ledger. `moneyViews.eventCostGrid` is the read
 * (source of truth stays in each row's home table).
 *
 * TYPE column (item rows only — vendor/plan-only rows show a static label):
 * a `SelectCell` of the modules that ALREADY have a currency-column row
 * SOMEWHERE on this event, per the grid's OWN payload (`row.module` /
 * `row.typeLabel` across every `event_item` row) — not a hardcoded module
 * list, so it never offers a target `items.convertEventItemModule` would
 * reject with `TARGET_HAS_NO_COST_COLUMN` (a module in this set is, by
 * construction, one this sweep found a currency column on). A brand-new
 * event with zero cost items yet has no grid-derived options to show, so the
 * ADD-ROW's own type picker (not the per-row Type cell, which simply has no
 * rows to render) falls back to the three built-in modules
 * (`FALLBACK_TYPE_OPTIONS`) every unmodified template ships with a `cost`
 * column on — a deliberate, narrow bootstrap for the empty-event case, not a
 * return to the old "always these 3" list.
 *
 * CATEGORY column: a `SelectCell` over the chapter's active
 * `budgetCategories` (`finances.listCategories`, same query
 * `BudgetLineItemsEditor` already uses) plus a synthetic "— Auto —" option
 * that clears the row's own override back to the module/vendor default-name
 * match (`collectEventPlannedRows`). When the row's resolved category came
 * from that default match (`categoryIsDefault`), its option label gets a
 * quiet "· auto" suffix so the picker itself shows why it's already set.
 *
 * ADD-ROW's Type picker unions `typeOptions` with `FALLBACK_TYPE_OPTIONS`
 * (deduped) rather than falling back only when the event has zero cost rows —
 * an event that already has one Task with a cost would otherwise never offer
 * "Supply"/"Comms" until a row in THAT module got a cost first, a chicken-
 * and-egg the per-row Type cell doesn't have (it only ever needs to offer
 * modules that already exist, since it's converting an EXISTING row).
 * `FALLBACK_TYPE_OPTIONS` is further filtered to the event's actually-ACTIVE
 * modules (`modules.listForEvent`'s `active` set) before joining the union —
 * a customized event that dropped a core module (e.g. Comms) must never
 * offer it here, or `addEventItem` → `requireActiveEventModule` rejects the
 * submit. While that query is still loading, the bare 3-module list is used
 * as-is (better an occasional stale offer than blocking Add-row on a second
 * round-trip).
 *
 * "Add row": Task/Supply/Comms/any other grid-derived module type creates a
 * REAL item there (`items.addEventItem`); "Plan only" creates a `budgetLines`
 * row (summoning a first ($0) budget via `finances.summonBudgetForRef` if
 * this ref has none yet — same flow `MoneyView`'s old "Add budget" button
 * used); "Vendor" still deep-links to Crew & Duties (a person picker is a
 * follow-up PR, not duplicated here). Converting an item INTO Vendor is out
 * of scope for this PR (same reason — needs the person picker).
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Icon,
  Row,
  SectionHeader,
  Select,
  SelectCell,
  Table,
  TableHeader,
} from "../ui";
import { colors } from "../../lib/theme";
import { alertError, alertInfo } from "../../lib/errors";

type GridData = FunctionReturnType<typeof api.moneyViews.eventCostGrid>;
type GridRow = GridData["rows"][number];
type TypeOption = { value: string; label: string };
type CategoryOption = { id: string; name: string };

/** The one-shot "which ref is this plan for" discriminator.
 *  - `event`: the full items ∪ vendors ∪ budgetLines grid (`eventCostGrid`).
 *  - `budget` (PR5): budget-lines ONLY — planning a budget directly
 *    (`BudgetCreateModal`) or a PROJECT ref (which has no `eventItems`/
 *    `engagements` to unify — schema-level, so it plans through its budget's
 *    lines alone, same as before PR4 unified the event side). `summon` is
 *    present only when this plan can lazily create its OWN budget on first
 *    add (mirrors the event path's `budgetId: null` + summon-on-add) — a
 *    caller that already guarantees a real `budgetId` (e.g. `BudgetCreateModal`,
 *    which only renders this once the budget exists) omits it. */
export type PlanGridSource =
  | { kind: "event"; eventId: Id<"events"> }
  | { kind: "budget"; summon?: { refKind: "project"; scopeRefId: Id<"projects"> } };

// Bootstrap-only fallback for an event with ZERO cost rows yet (so the
// grid-derived `typeOptions` set is empty) — see the module doc above. NEVER
// consulted once the event has at least one cost row of its own.
const FALLBACK_TYPE_OPTIONS: TypeOption[] = [
  { value: "planning_doc", label: "Task" },
  { value: "supplies", label: "Supply" },
  { value: "comms", label: "Comms" },
];

const AUTO_CATEGORY = "__auto__";

// Fixed pixel column widths (not flex) — the table scrolls horizontally
// below its natural width (`TABLE_WIDTH`) rather than squeezing seven
// columns into a narrow/native viewport, mirroring `EditableGrid.tsx`'s own
// `ScrollView horizontal` + fixed-width-column pattern for the same reason.
const COL_ITEM = 260;
const COL_TYPE = 100;
const COL_CATEGORY = 130;
const COL_STATUS = 90;
const COL_PLANNED = 110;
const COL_ACTUAL = 80;
const COL_CHEVRON = 24;
const TABLE_WIDTH =
  COL_ITEM + COL_TYPE + COL_CATEGORY + COL_STATUS + COL_PLANNED + COL_ACTUAL + COL_CHEVRON;

// Budget mode (PR5) — collapsed columns: no Type (every row IS a plan line,
// a repeated static label adds nothing), no Status/Actual (budget lines have
// neither — always "—" in event mode's grid). ACTION replaces CHEVRON: a
// budget line has no `sourceLink` to drill into, but (unlike an event-mode
// row, which "deletes" by zeroing its cost) `budgetLines.addLine`/`updateLine`
// reject a zero/negative amount outright — so this mode needs a REAL delete
// affordance, same as `BudgetLineItemsEditor` had.
const BCOL_ITEM = 220;
const BCOL_CATEGORY = 150;
const BCOL_PLANNED = 110;
const BCOL_ACTION = 32;
const BUDGET_TABLE_WIDTH = BCOL_ITEM + BCOL_CATEGORY + BCOL_PLANNED + BCOL_ACTION;

function dollarsToCents(text: string): number | null {
  const dollars = parseFloat(text);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

function parseRowId(id: string): { kind: "event_item" | "vendor" | "budget_line"; refId: string } {
  const [kind, refId] = id.split(":");
  return { kind: kind as "event_item" | "vendor" | "budget_line", refId };
}

export function PlanGrid({
  source,
  budgetId,
  capCents,
}: {
  source: PlanGridSource;
  /** The plan's current v2 budget row, if any. Event mode: the "Plan only"
   *  add-row's attach point (`budgetLines.addLine`), `null` until one is
   *  summoned (lazily, on first plan-only add). Budget mode: the budget
   *  itself — `null` only when `source.summon` is set (a budget-less
   *  project) and no budget has been summoned yet. */
  budgetId: Id<"budgets"> | null;
  /** The effective approval cap (`refMoney.budget.amountCents`) for the
   *  "Planned $X of $CAP" footer — `null` when no budget exists yet. */
  capCents: number | null;
}) {
  if (source.kind === "budget") {
    return <BudgetPlanGrid source={source} budgetId={budgetId} capCents={capCents} />;
  }
  const eventId = source.eventId;
  const router = useRouter();
  const data = useQuery(api.moneyViews.eventCostGrid, { eventId });
  const categoriesQuery = useQuery(api.finances.listCategories, {});
  // Add-row's Type-picker bootstrap needs to know which modules are
  // actually active on THIS event (not just which ones already have a cost
  // row) — see `FALLBACK_TYPE_OPTIONS`'s doc above. `undefined` while
  // loading; `activeModuleKeys` stays `null` in that window so the fallback
  // filter below is skipped rather than incorrectly treating "not loaded
  // yet" as "nothing active."
  const modulesData = useQuery(api.modules.listForEvent, { eventId });
  const [addOpen, setAddOpen] = useState(false);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const categoriesRaw = useMemo(() => categoriesQuery ?? [], [categoriesQuery]);
  const activeModuleKeys = useMemo(
    () => (modulesData ? new Set(modulesData.active.map((m) => m.key)) : null),
    [modulesData],
  );

  // Every module a currency-column row already exists for on THIS event —
  // the Type cell/add-row's option set (see module doc above).
  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.sourceKind === "event_item" && r.module) seen.set(r.module, r.typeLabel);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [rows]);

  // Item ids that produced MORE THAN ONE grid row (a module with >1 currency
  // column, rare) — their `label` is disambiguated server-side
  // ("Title — Column"), so editing it inline here would silently smuggle
  // that suffix into the real title. Those rows keep the Item cell
  // read-only; every other cell (Type/Category/Planned) stays editable.
  const multiColItemIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.sourceKind !== "event_item") continue;
      const { refId } = parseRowId(r.id);
      counts.set(refId, (counts.get(refId) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  }, [rows]);

  const categoryOptions: CategoryOption[] = useMemo(
    () => categoriesRaw.filter((c) => c.isActive).map((c) => ({ id: c.id, name: c.name })),
    [categoriesRaw],
  );

  if (data === undefined) {
    return (
      <View className="mt-4">
        <Text className="text-sm text-muted">Loading plan…</Text>
      </View>
    );
  }
  if (data.isTraining) return null;

  function goTo(link: string) {
    router.push(link as never);
  }

  return (
    <View className="mt-6">
      <SectionHeader
        title="Plan"
        count={data.rows.length}
        right={
          <Pressable
            onPress={() => setAddOpen((o) => !o)}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Icon name={addOpen ? "x" : "plus"} size={14} color={colors.accent} />
            <Text className="text-sm font-medium text-accent">
              {addOpen ? "Close" : "Add"}
            </Text>
          </Pressable>
        }
      />
      <Text className="mb-3 -mt-2 text-xs text-muted">
        Every cost on this event, one database. Edits write back home.
      </Text>

      {addOpen ? (
        <AddRow
          eventId={eventId}
          budgetId={budgetId}
          typeOptions={typeOptions}
          activeModuleKeys={activeModuleKeys}
          categoryOptions={categoryOptions}
          onDone={() => setAddOpen(false)}
        />
      ) : null}

      {data.rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="No costs yet"
          message="Tasks, supplies, comms, vendors, and budget lines with a cost will show up here."
        />
      ) : (
        // Fixed-width columns (not flex) inside a `View` pinned to
        // `TABLE_WIDTH`, itself inside a horizontal `ScrollView` — mirrors
        // `EditableGrid.tsx`'s own pattern for a multi-column table that
        // shouldn't squeeze on a narrow/native viewport (RN-web: a bare
        // `flexGrow`/`flexShrink` View would otherwise beat the fixed width;
        // pinning `flexGrow={0} flexShrink={0}` on the inner View avoids that).
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: TABLE_WIDTH, flexGrow: 0, flexShrink: 0 }}>
            <Table>
              <TableHeader>
                <HeaderCell width={COL_ITEM}>Item</HeaderCell>
                <HeaderCell width={COL_TYPE}>Type</HeaderCell>
                <HeaderCell width={COL_CATEGORY}>Category</HeaderCell>
                <HeaderCell width={COL_STATUS}>Status</HeaderCell>
                <HeaderCell width={COL_PLANNED} align="right">
                  Planned
                </HeaderCell>
                <HeaderCell width={COL_ACTUAL} align="right">
                  Actual
                </HeaderCell>
                <HeaderCell width={COL_CHEVRON}> </HeaderCell>
              </TableHeader>
              {data.rows.map((row, i) => (
                <GridRowView
                  key={row.id}
                  row={row}
                  last={i === data.rows.length - 1}
                  typeOptions={typeOptions}
                  categoryOptions={categoryOptions}
                  itemReadOnly={row.sourceKind === "event_item" && multiColItemIds.has(parseRowId(row.id).refId)}
                  onOpen={row.sourceLink ? () => goTo(row.sourceLink!) : undefined}
                />
              ))}
            </Table>
          </View>
        </ScrollView>
      )}

      {data.rows.length > 0 ? (
        <View className="mt-2 flex-row items-center justify-end gap-2 px-1">
          <Text className="text-xs text-muted">{capCents != null ? "Planned" : "Total"}</Text>
          <Text className="text-sm font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
            {formatCents(data.totalPlannedCents)}
          </Text>
          {capCents != null ? (
            <Text className="text-xs text-muted">of {formatCents(capCents)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function GridRowView({
  row,
  last,
  typeOptions,
  categoryOptions,
  itemReadOnly,
  onOpen,
}: {
  row: GridRow;
  last: boolean;
  typeOptions: TypeOption[];
  categoryOptions: CategoryOption[];
  itemReadOnly: boolean;
  onOpen?: () => void;
}) {
  return (
    <Row last={last}>
      <Cell width={COL_ITEM}>
        <ItemCell row={row} readOnly={itemReadOnly} />
      </Cell>
      <Cell width={COL_TYPE}>
        <TypeCell row={row} typeOptions={typeOptions} />
      </Cell>
      <Cell width={COL_CATEGORY}>
        <CategoryCell row={row} categoryOptions={categoryOptions} />
      </Cell>
      <Cell width={COL_STATUS}>
        {row.status ? (
          <Badge label={row.status} tone="neutral" />
        ) : (
          <Text className="text-xs text-faint">—</Text>
        )}
      </Cell>
      <Cell width={COL_PLANNED} align="right">
        <CostCell row={row} />
      </Cell>
      <Cell width={COL_ACTUAL} align="right">
        {row.actualCents == null ? (
          <Text className="text-sm text-faint">—</Text>
        ) : (
          <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
            {formatCents(row.actualCents)}
          </Text>
        )}
      </Cell>
      <Cell width={COL_CHEVRON} align="center">
        {onOpen ? (
          <Pressable onPress={onOpen} hitSlop={8} className="active:opacity-70">
            <Icon name="chevron-right" size={15} color={colors.muted} />
          </Pressable>
        ) : null}
      </Cell>
    </Row>
  );
}

/** Item — the row's "what is this" label. Inline-editable (blur-commit) for
 *  `event_item`/`budget_line` rows; a vendor row's label is a real person's
 *  name (read-only here — renamed on Crew & Duties). */
function ItemCell({ row, readOnly }: { row: GridRow; readOnly: boolean }) {
  const updateEventItem = useMutation(api.items.updateEventItem);
  const updateLine = useMutation(api.budgetLines.updateLine);
  const [title, setTitle] = useState(row.label);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setTitle(row.label);
  }, [row.label, focused]);

  const editable = !readOnly && row.sourceKind !== "vendor" && row.editable;

  async function commit() {
    const trimmed = title.trim();
    if (!trimmed || trimmed === row.label) {
      setTitle(row.label);
      return;
    }
    try {
      const { kind, refId } = parseRowId(row.id);
      if (kind === "event_item") {
        await updateEventItem({ itemId: refId as Id<"eventItems">, title: trimmed });
      } else if (kind === "budget_line") {
        await updateLine({ lineId: refId as Id<"budgetLines">, patch: { description: trimmed } });
      }
    } catch (err) {
      alertError(err);
      setTitle(row.label);
    }
  }

  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-1.5">
        {row.linked ? <Icon name="link" size={12} color={colors.muted} /> : null}
        {editable ? (
          <TextInput
            value={title}
            onChangeText={setTitle}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              void commit();
            }}
            onSubmitEditing={() => void commit()}
            className="flex-1 text-sm text-ink"
          />
        ) : (
          <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
            {row.label}
          </Text>
        )}
      </View>
      {row.possibleDuplicate ? (
        <View className="mt-0.5 flex-row items-center gap-1">
          <Icon name="alert-triangle" size={11} color={colors.warn} />
          <Text className="text-2xs text-warn">Possible duplicate</Text>
        </View>
      ) : null}
      {row.linked ? (
        <Text className="mt-0.5 text-2xs text-muted">Category linked from the finance plan</Text>
      ) : null}
    </View>
  );
}

/** Type — dropdown (item rows only) that CONVERTS the item to a different
 *  module (`items.convertEventItemModule`); a static label for vendor /
 *  plan-only rows (neither has a "module" to change). */
function TypeCell({ row, typeOptions }: { row: GridRow; typeOptions: TypeOption[] }) {
  const convertModule = useMutation(api.items.convertEventItemModule);

  if (row.sourceKind === "vendor") {
    return <Text className="text-sm text-muted">Vendor</Text>;
  }
  if (row.sourceKind === "budget_line") {
    return <Text className="text-sm text-muted">Plan only</Text>;
  }
  if (!row.editable) {
    return <Text className="text-sm text-ink">{row.typeLabel}</Text>;
  }

  async function handleChange(toModule: string) {
    if (toModule === row.module) return;
    try {
      const { refId } = parseRowId(row.id);
      await convertModule({ itemId: refId as Id<"eventItems">, toModule });
    } catch (err) {
      alertError(err);
    }
  }

  return (
    <SelectCell value={row.module ?? ""} options={typeOptions} onChange={(v) => void handleChange(v)} />
  );
}

/** Category — dropdown over the chapter's active categories, plus a synthetic
 *  clear option that resets the row's own override. For `event_item`/`vendor`
 *  rows that falls back to the module/vendor default-name match, so it reads
 *  "— Auto —"; a `budget_line` row has no default-match concept at all
 *  (`collectEventPlannedRows` never resolves one for it), so it reads
 *  "— No category —" there instead. Every row type carries a
 *  `budgetCategoryId`-shaped override on its own home table. */
function CategoryCell({ row, categoryOptions }: { row: GridRow; categoryOptions: CategoryOption[] }) {
  const updateEventItem = useMutation(api.items.updateEventItem);
  const updateEngagement = useMutation(api.engagements.update);
  const updateLine = useMutation(api.budgetLines.updateLine);

  const clearLabel = row.sourceKind === "budget_line" ? "— No category —" : "— Auto —";
  const options = [
    { value: AUTO_CATEGORY, label: clearLabel },
    ...categoryOptions.map((c) => ({
      value: c.id,
      label: row.categoryIsDefault && row.categoryId === c.id ? `${c.name} · auto` : c.name,
    })),
  ];
  const value = row.categoryId ?? AUTO_CATEGORY;

  if (!row.editable) {
    const current = options.find((o) => o.value === value);
    return (
      <Text className="text-sm text-ink" numberOfLines={1}>
        {current?.label ?? row.categoryName}
      </Text>
    );
  }

  async function handleChange(v: string) {
    const categoryId = v === AUTO_CATEGORY ? null : (v as Id<"budgetCategories">);
    try {
      const { kind, refId } = parseRowId(row.id);
      if (kind === "event_item") {
        await updateEventItem({ itemId: refId as Id<"eventItems">, budgetCategoryId: categoryId });
      } else if (kind === "vendor") {
        await updateEngagement({ engagementId: refId as Id<"engagements">, budgetCategoryId: categoryId });
      } else {
        await updateLine({ lineId: refId as Id<"budgetLines">, patch: { categoryId } });
      }
    } catch (err) {
      alertError(err);
    }
  }

  return <SelectCell value={value} options={options} onChange={(v) => void handleChange(v)} />;
}

function CostCell({ row }: { row: GridRow }) {
  const updateEventItem = useMutation(api.items.updateEventItem);
  const updateEngagement = useMutation(api.engagements.update);
  const updateLine = useMutation(api.budgetLines.updateLine);
  const [amount, setAmount] = useState((row.plannedCents / 100).toString());
  const [saving, setSaving] = useState(false);
  // Tracks whether the field is actively being typed into — gates the
  // resync effect below so an external update (a fresh query result after
  // someone ELSE's edit, or this cell's own successful commit re-rendering)
  // never stomps text the user is mid-typing.
  const [focused, setFocused] = useState(false);

  // Opus review, PR #216 ("stale-input smell"): `amount` used to be seeded
  // ONCE from `row.plannedCents` on mount and never resynced — a concurrent
  // edit from someone else (or a server-side rounding difference) would
  // leave this cell showing a stale figure until the component remounted.
  useEffect(() => {
    if (!focused) setAmount((row.plannedCents / 100).toString());
  }, [row.plannedCents, focused]);

  if (!row.editable) {
    return (
      <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {formatCents(row.plannedCents)}
      </Text>
    );
  }

  async function commit() {
    const cents = dollarsToCents(amount);
    if (cents === null) {
      alertError(new Error("Enter a valid amount."));
      setAmount((row.plannedCents / 100).toString());
      return;
    }
    if (cents === row.plannedCents) return;
    setSaving(true);
    try {
      // `event_item` ids are `event_item:<itemId>:<columnKey>` (the currency
      // COLUMN this figure belongs to — may not be "cost" for a chapter-
      // custom column, e.g. Permits' "fee"). `vendor`/`budget_line` ids have
      // no third segment; `colKey` is simply unused for those.
      const [kind, id, colKey] = row.id.split(":");
      if (kind === "event_item") {
        await updateEventItem({
          itemId: id as Id<"eventItems">,
          fields: { [colKey ?? "cost"]: cents / 100 },
        });
      } else if (kind === "vendor") {
        await updateEngagement({
          engagementId: id as Id<"engagements">,
          amountUsd: cents / 100,
        });
      } else {
        await updateLine({ lineId: id as Id<"budgetLines">, patch: { plannedCents: cents } });
      }
      // Opus review, PR #216 ("$0-edit UX gotcha"): a cleared/zeroed cost is
      // a REAL write, but rows with no cost never appear in this list — the
      // row will vanish on the next read. Say so, rather than a silent
      // disappearance with no explanation.
      if (cents === 0) {
        alertInfo("This row will disappear from the list — it no longer has a cost to show.");
      }
    } catch (err) {
      alertError(err);
      setAmount((row.plannedCents / 100).toString());
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="w-24 flex-row items-center justify-end rounded-md border border-border-strong bg-raised px-2">
      <Text className="text-sm text-faint">$</Text>
      <TextInput
        value={amount}
        onChangeText={setAmount}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void commit();
        }}
        onSubmitEditing={() => void commit()}
        editable={!saving}
        keyboardType="decimal-pad"
        className="flex-1 py-1.5 text-right text-sm text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      />
    </View>
  );
}

/** Add-row: Type picker (grid-derived modules, falling back to the 3
 *  built-ins on a brand-new event with no cost rows yet — see module doc) +
 *  "Plan only" (a `budgetLines` row, summoning a budget first if this ref has
 *  none) + "Vendor" (deep-links to Crew & Duties — needs a person picker). */
function AddRow({
  eventId,
  budgetId,
  typeOptions,
  activeModuleKeys,
  categoryOptions,
  onDone,
}: {
  eventId: Id<"events">;
  budgetId: Id<"budgets"> | null;
  typeOptions: TypeOption[];
  /** The event's actually-active module keys (`modules.listForEvent`), or
   *  `null` while that query is still loading — see `FALLBACK_TYPE_OPTIONS`'s
   *  doc above. */
  activeModuleKeys: Set<string> | null;
  categoryOptions: CategoryOption[];
  onDone: () => void;
}) {
  const router = useRouter();
  const addEventItem = useMutation(api.items.addEventItem);
  const addLine = useMutation(api.budgetLines.addLine);
  const summonBudget = useMutation(api.finances.summonBudgetForRef);

  const seenModules = new Set(typeOptions.map((o) => o.value));
  // Bootstrap fallback, narrowed to modules the event actually has active —
  // never offer one a customized event dropped (`requireActiveEventModule`
  // would reject the submit). Still loading `activeModuleKeys`? Use the bare
  // 3-module list as-is rather than blocking Add-row on a second round-trip.
  const fallbackOptions =
    activeModuleKeys != null
      ? FALLBACK_TYPE_OPTIONS.filter((o) => activeModuleKeys.has(o.value))
      : FALLBACK_TYPE_OPTIONS;
  const itemTypeOptions: TypeOption[] = [
    ...typeOptions,
    ...fallbackOptions.filter((o) => !seenModules.has(o.value)),
  ];
  const allTypeOptions: TypeOption[] = [
    ...itemTypeOptions,
    { value: "plan_only", label: "Plan only" },
    { value: "vendor", label: "Vendor" },
  ];

  const [type, setType] = useState(allTypeOptions[0].value);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  const isPlanOnly = type === "plan_only";
  const isVendor = type === "vendor";

  async function handleAdd() {
    if (isVendor) {
      router.push(`/event/${eventId}?tab=crew` as never);
      onDone();
      return;
    }
    const trimmed = title.trim();
    if (!trimmed) {
      alertError(new Error("Enter what this is for."));
      return;
    }
    const cents = dollarsToCents(amount);
    if (isPlanOnly && (cents === null || cents <= 0)) {
      alertError(new Error("Enter a valid planned amount."));
      return;
    }
    setSaving(true);
    try {
      if (isPlanOnly) {
        let bId = budgetId;
        if (!bId) bId = await summonBudget({ refKind: "event", scopeRefId: eventId });
        await addLine({
          budgetId: bId,
          description: trimmed,
          plannedCents: cents as number,
          ...(categoryId ? { categoryId: categoryId as Id<"budgetCategories"> } : {}),
        });
      } else {
        await addEventItem({
          eventId,
          module: type,
          title: trimmed,
          fields: cents !== null ? { cost: cents / 100 } : undefined,
        });
      }
      setTitle("");
      setAmount("");
      setCategoryId("");
      onDone();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-3 gap-2 rounded-lg border border-dashed border-border p-3">
      <Select value={type} options={allTypeOptions} onChange={setType} label="Type" />
      {isVendor ? (
        <Text className="text-xs text-muted">
          Vendors are added from Crew & Duties (picks a real person).
        </Text>
      ) : (
        <>
          <View className="flex-row items-center gap-2">
            <View className="flex-1">
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="What's this for?"
                placeholderTextColor={colors.faint}
                className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
              />
            </View>
            <View className="w-24">
              <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
                <Text className="text-base text-faint">$</Text>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0"
                  placeholderTextColor={colors.faint}
                  keyboardType="decimal-pad"
                  className="flex-1 py-2 text-base text-ink"
                />
              </View>
            </View>
          </View>
          {isPlanOnly ? (
            <View className="w-40">
              <Select
                value={categoryId}
                options={[
                  { value: "", label: "— No category —" },
                  ...categoryOptions.map((c) => ({ value: c.id, label: c.name })),
                ]}
                onChange={setCategoryId}
                placeholder="— No category —"
              />
            </View>
          ) : null}
        </>
      )}
      <View className="flex-row justify-end">
        <Button
          title={isVendor ? "Open Crew & Duties" : "Add"}
          icon="plus"
          size="sm"
          loading={saving}
          onPress={() => void handleAdd()}
        />
      </View>
    </View>
  );
}

// ── Budget mode (PR5) — budget-lines-only plan, replacing `BudgetLineItemsEditor`.
// Reuses `ItemCell`/`CategoryCell`/`CostCell` UNCHANGED — they already branch on
// `sourceKind === "budget_line"` (added in PR4 for the event grid's plan-only
// rows) and read/write via `budgetLines.updateLine`, so a synthetic `GridRow`
// built straight off `budgetLines.listLines` slots in with zero new code paths
// in those cells. Only the layout (3 columns + a real delete action, no Type/
// Status/Actual/Chevron) and the add-row (always "plan only", no Type picker)
// are new. ────────────────────────────────────────────────────────────────────

type LineSummary = FunctionReturnType<typeof api.budgetLines.listLines>[number];

/** Adapt a `budgetLines` row into the SAME `GridRow` shape `eventCostGrid`
 *  returns, so the event grid's own cell components can render/edit it
 *  as-is. Always `editable: true` — `BudgetLineItemsEditor` (what this
 *  replaces) never gated its inputs client-side either; an unauthorized
 *  write is rejected server-side (`requireLineWriteAccess`) and surfaces via
 *  the cell's own `alertError` catch, same as every other write in this file. */
function lineToGridRow(line: LineSummary, categoryName: string): GridRow {
  return {
    id: `budget_line:${line.id}`,
    sourceKind: "budget_line",
    module: null,
    typeLabel: "Budget lines",
    label: line.description,
    categoryName,
    categoryId: line.categoryId,
    categoryIsDefault: false,
    plannedCents: line.plannedCents,
    actualCents: null,
    status: null,
    editable: true,
    sourceLink: null,
    linked: false,
    possibleDuplicate: false,
  };
}

function BudgetPlanGrid({
  source,
  budgetId,
  capCents,
}: {
  source: Extract<PlanGridSource, { kind: "budget" }>;
  budgetId: Id<"budgets"> | null;
  capCents: number | null;
}) {
  const lines = useQuery(api.budgetLines.listLines, budgetId ? { budgetId } : "skip");
  const categoriesQuery = useQuery(api.finances.listCategories, {});
  const [addOpen, setAddOpen] = useState(false);

  const categoryOptions: CategoryOption[] = useMemo(
    () => (categoriesQuery ?? []).filter((c) => c.isActive).map((c) => ({ id: c.id, name: c.name })),
    [categoriesQuery],
  );
  const categoryNameById = useMemo(
    () => new Map(categoryOptions.map((c) => [c.id, c.name] as const)),
    [categoryOptions],
  );

  const rows: GridRow[] = useMemo(() => {
    if (!lines) return [];
    return lines
      .map((l) => lineToGridRow(l, l.categoryId ? (categoryNameById.get(l.categoryId) ?? "Uncategorized") : "Uncategorized"))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [lines, categoryNameById]);

  const totalPlannedCents = useMemo(
    () => rows.reduce((sum, r) => sum + r.plannedCents, 0),
    [rows],
  );

  // A budget-less project (`budgetId === null`, `source.summon` set) has no
  // lines to load yet — never "loading," just genuinely empty until the
  // first add summons a budget. Only a REAL budgetId's still-pending query
  // is a loading state.
  const loading = budgetId != null && lines === undefined;

  return (
    <View className="mt-6">
      <SectionHeader
        title="Plan"
        count={rows.length}
        right={
          <Pressable
            onPress={() => setAddOpen((o) => !o)}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Icon name={addOpen ? "x" : "plus"} size={14} color={colors.accent} />
            <Text className="text-sm font-medium text-accent">
              {addOpen ? "Close" : "Add"}
            </Text>
          </Pressable>
        }
      />
      <Text className="mb-3 -mt-2 text-xs text-muted">
        What you're planning to spend this budget on.
      </Text>

      {addOpen ? (
        <BudgetAddRow
          budgetId={budgetId}
          summon={source.summon}
          categoryOptions={categoryOptions}
          onDone={() => setAddOpen(false)}
        />
      ) : null}

      {loading ? (
        <Text className="text-sm text-muted">Loading plan…</Text>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="No plan lines yet"
          message="Break this budget down into what you're planning to spend it on."
        />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: BUDGET_TABLE_WIDTH, flexGrow: 0, flexShrink: 0 }}>
            <Table>
              <TableHeader>
                <HeaderCell width={BCOL_ITEM}>Item</HeaderCell>
                <HeaderCell width={BCOL_CATEGORY}>Category</HeaderCell>
                <HeaderCell width={BCOL_PLANNED} align="right">
                  Planned
                </HeaderCell>
                <HeaderCell width={BCOL_ACTION}> </HeaderCell>
              </TableHeader>
              {rows.map((row, i) => (
                <BudgetLineRowView
                  key={row.id}
                  row={row}
                  last={i === rows.length - 1}
                  categoryOptions={categoryOptions}
                />
              ))}
            </Table>
          </View>
        </ScrollView>
      )}

      {rows.length > 0 ? (
        <View className="mt-2 flex-row items-center justify-end gap-2 px-1">
          <Text className="text-xs text-muted">{capCents != null ? "Planned" : "Total"}</Text>
          <Text className="text-sm font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
            {formatCents(totalPlannedCents)}
          </Text>
          {capCents != null ? (
            <Text className="text-xs text-muted">of {formatCents(capCents)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One budget-line row: Item / Category / Planned (reusing the event grid's
 *  own cells verbatim) + a real delete action — `budgetLines.updateLine`
 *  rejects a zero/negative `plannedCents` outright (`assertPlannedCents`), so
 *  unlike an event-mode row this one can't "delete by zeroing the cost." */
function BudgetLineRowView({
  row,
  last,
  categoryOptions,
}: {
  row: GridRow;
  last: boolean;
  categoryOptions: CategoryOption[];
}) {
  const removeLine = useMutation(api.budgetLines.removeLine);
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    const { refId } = parseRowId(row.id);
    setRemoving(true);
    try {
      await removeLine({ lineId: refId as Id<"budgetLines"> });
    } catch (err) {
      alertError(err);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Row last={last}>
      <Cell width={BCOL_ITEM}>
        <ItemCell row={row} readOnly={false} />
      </Cell>
      <Cell width={BCOL_CATEGORY}>
        <CategoryCell row={row} categoryOptions={categoryOptions} />
      </Cell>
      <Cell width={BCOL_PLANNED} align="right">
        <CostCell row={row} />
      </Cell>
      <Cell width={BCOL_ACTION} align="center">
        <Pressable
          onPress={() => void handleRemove()}
          disabled={removing}
          hitSlop={8}
          accessibilityLabel={`Remove ${row.label}`}
          className="active:opacity-70"
        >
          <Icon name="x" size={15} color={colors.muted} />
        </Pressable>
      </Cell>
    </Row>
  );
}

/** Add-row (budget mode): always a plan-only line — no Type picker, since
 *  every row IS a `budgetLines` row here. Mirrors event mode's plan-only
 *  branch (lazily summons a budget via `summon` when `budgetId` is still
 *  `null` — a budget-less project's first add). */
function BudgetAddRow({
  budgetId,
  summon,
  categoryOptions,
  onDone,
}: {
  budgetId: Id<"budgets"> | null;
  summon?: { refKind: "project"; scopeRefId: Id<"projects"> };
  categoryOptions: CategoryOption[];
  onDone: () => void;
}) {
  const addLine = useMutation(api.budgetLines.addLine);
  const summonBudget = useMutation(api.finances.summonBudgetForRef);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    const trimmed = description.trim();
    if (!trimmed) {
      alertError(new Error("Enter what this line is for."));
      return;
    }
    const cents = dollarsToCents(amount);
    if (cents === null || cents <= 0) {
      alertError(new Error("Enter a valid planned amount."));
      return;
    }
    setSaving(true);
    try {
      let bId = budgetId;
      if (!bId) {
        if (!summon) {
          alertError(new Error("No budget to plan yet."));
          return;
        }
        bId = await summonBudget({ refKind: summon.refKind, scopeRefId: summon.scopeRefId });
      }
      await addLine({
        budgetId: bId,
        description: trimmed,
        plannedCents: cents,
        ...(categoryId ? { categoryId: categoryId as Id<"budgetCategories"> } : {}),
      });
      setDescription("");
      setAmount("");
      setCategoryId("");
      onDone();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-3 gap-2 rounded-lg border border-dashed border-border p-3">
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What's this for?"
            placeholderTextColor={colors.faint}
            className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
          />
        </View>
        <View className="w-24">
          <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
            <Text className="text-base text-faint">$</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0"
              placeholderTextColor={colors.faint}
              keyboardType="decimal-pad"
              className="flex-1 py-2 text-base text-ink"
            />
          </View>
        </View>
      </View>
      <View className="w-40">
        <Select
          value={categoryId}
          options={[
            { value: "", label: "— No category —" },
            ...categoryOptions.map((c) => ({ value: c.id, label: c.name })),
          ]}
          onChange={setCategoryId}
          placeholder="— No category —"
        />
      </View>
      <View className="flex-row justify-end">
        <Button title="Add" icon="plus" size="sm" loading={saving} onPress={() => void handleAdd()} />
      </View>
    </View>
  );
}
