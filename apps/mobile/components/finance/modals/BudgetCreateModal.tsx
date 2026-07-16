/**
 * BudgetCreateModal — create or edit a budget (type × cadence × tags × category).
 *
 * A budget is a flexible allocation. Pick its TYPE — one-time (attached to a
 * specific event or project) or recurring (monthly / quarterly / yearly) — the
 * period (year + month/quarter as the cadence needs), an amount in dollars, any
 * number of managed TAGS (the flexible rollup dimension), and optionally a
 * category. Central users can also choose the org-level (central) LEVEL. Money
 * is collected in dollars and sent as integer cents. There's no fund picker —
 * funds are backend-only (WP-1.4, "defund the UI"); every budget silently lands
 * on the chapter's one General Fund server-side.
 *
 * Backed by `createBudget` / `updateBudget` (v2 args: `type`, `refKind` +
 * `scopeRefId` for one-time, `tagIds`). The tag picker is fed by `listBudgetTags`
 * and can create a new custom tag inline via `createBudgetTag`. One-time event
 * budgets are auto-tagged (template + "events") by the backend; those show
 * read-only here.
 */
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BUDGET_TYPE_LABELS,
  type BudgetCadence,
  type BudgetRefKind,
  type BudgetType,
} from "@events-os/shared";
import { Badge, Button, Field, Icon, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { BudgetLineItemsEditor } from "./BudgetLineItemsEditor";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const TYPE_OPTIONS = (["one_time", "recurring"] as const).map((t) => ({
  value: t,
  label: BUDGET_TYPE_LABELS[t],
}));

// Recurring cadences the user picks between (one-time cadence is derived).
const RECURRING_CADENCE_OPTIONS: { value: BudgetCadence; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

// Order tag groups in the picker; `null`-kind tags fall under "Other".
const KIND_ORDER: (string | null)[] = ["team", "template", "events", "custom", null];
const KIND_HEADING: Record<string, string> = {
  team: "Teams",
  template: "Templates",
  events: "Events",
  custom: "Custom",
};

type TagOption = {
  id: Id<"budgetTags">;
  name: string;
  kind: string | null;
  level: "chapter" | "central";
};

export function BudgetCreateModal({
  budgetId,
  defaultYear,
  defaultMonth,
  canCentral = false,
  forceCentral = false,
  onClose,
}: {
  /** When set, edit this existing budget instead of creating a new one. */
  budgetId?: Id<"budgets"> | null;
  defaultYear: number;
  defaultMonth: number;
  /** Whether the caller may create org-level (central) budgets. */
  canCentral?: boolean;
  /**
   * Opened from the CENTRAL desk's "New budget" action: default to central
   * and lock the Level choice (no chapter-vs-central picker) — a central-desk
   * budget is always org-wide. Ignored while editing an existing budget
   * (its own `level` decides). Implies `canCentral`.
   */
  forceCentral?: boolean;
  onClose: () => void;
}) {
  const create = useMutation(api.finances.createBudget);
  const update = useMutation(api.finances.updateBudget);
  const createTag = useMutation(api.finances.createBudgetTag);
  const budgets = useQuery(api.finances.listBudgets) ?? [];
  const allTags = (useQuery(api.finances.listBudgetTags) ?? []) as TagOption[];
  const events = useQuery(api.events.list, { scope: "all" }) ?? [];
  const projects = useQuery(api.projects.list, {}) ?? [];

  const editing = budgetId
    ? budgets.find((b) => b.id === budgetId) ?? null
    : null;

  const [type, setType] = useState<BudgetType>("recurring");
  // For one-time budgets: which event/project it's attached to ("event:<id>" /
  // "project:<id>"), or null (an untethered one-time bucket).
  const [refSel, setRefSel] = useState<string | null>(null);
  // For recurring budgets: the chosen cadence.
  const [recurringCadence, setRecurringCadence] = useState<BudgetCadence>("monthly");
  // Chapter budget by default; central = an org-wide budget (central users
  // only). Opened from the central desk (`forceCentral`) defaults it on.
  const [central, setCentral] = useState(forceCentral);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [year, setYear] = useState(String(defaultYear));
  const [month, setMonth] = useState<number | null>(null);
  const [quarter, setQuarter] = useState<number | null>(1);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<Id<"budgetTags">[]>([]);
  const [saving, setSaving] = useState(false);
  // WP-3.1: once a BRAND-NEW budget is created, keep the modal open on it
  // (instead of closing) so "Plan this budget" is the very next thing the
  // user sees — the "when a dollar amount is entered, a budget panel comes
  // up" trigger. Editing an existing budget already has an id (`editing.id`)
  // so it shows the planner immediately; this state is only for a fresh create.
  const [createdBudgetId, setCreatedBudgetId] = useState<Id<"budgets"> | null>(null);
  const activeBudgetId = editing?.id ?? createdBudgetId;

  // Preload state once the budget being edited resolves.
  useEffect(() => {
    if (!editing) return;
    const t = editing.type ?? "recurring";
    setType(t);
    if (t === "one_time" && editing.refKind && editing.scopeRefId) {
      setRefSel(`${editing.refKind}:${editing.scopeRefId}`);
    } else {
      setRefSel(null);
    }
    if (t === "recurring") {
      setRecurringCadence(
        editing.cadence === "quarterly" || editing.cadence === "yearly"
          ? editing.cadence
          : "monthly",
      );
    }
    setCentral(editing.level === "central");
    setLabel(editing.label ?? "");
    setAmount((editing.amountCents / 100).toString());
    setYear(String(editing.year));
    setMonth(editing.month);
    setQuarter(editing.quarter ?? 1);
    setCategoryId(editing.categoryId ?? null);
    setTagIds(editing.tags.map((t) => t.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  const categories = useQuery(api.finances.listCategories, {}) ?? [];

  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.id, label: c.name })),
    [categories],
  );
  // The event/project picker: two grouped sections in one Select.
  const refOptions = useMemo(
    () => [
      { value: "", label: "— No specific event/project —" },
      ...(events.length ? [{ value: "h:events", label: "Events", header: true }] : []),
      ...events.map((e) => ({ value: `event:${e._id}`, label: e.name })),
      ...(projects.length
        ? [{ value: "h:projects", label: "Projects", header: true }]
        : []),
      ...projects.map((p) => ({ value: `project:${p._id}`, label: p.name })),
    ],
    [events, projects],
  );

  // Derive refKind + scopeRefId + the effective cadence from the current state.
  const refKind: BudgetRefKind | undefined =
    type === "one_time" && refSel
      ? (refSel.split(":")[0] as BudgetRefKind)
      : undefined;
  const scopeRefId =
    type === "one_time" && refSel ? refSel.slice(refSel.indexOf(":") + 1) : undefined;
  const cadence: BudgetCadence =
    type === "one_time"
      ? refKind === "project"
        ? "one_off"
        : "per_instance"
      : recurringCadence;

  const showQuarter = cadence === "quarterly";
  const showMonth =
    cadence === "monthly" || cadence === "per_instance" || cadence === "one_off";
  const isEventBudget = type === "one_time" && refKind === "event";

  // Tags usable at this budget's level: a central budget takes central tags
  // only; a chapter budget takes chapter + central tags.
  const level = central ? "central" : "chapter";
  const usableTags = useMemo(
    () => allTags.filter((t) => (level === "central" ? t.level === "central" : true)),
    [allTags, level],
  );
  const tagById = useMemo(
    () => new Map(allTags.map((t) => [t.id as string, t] as const)),
    [allTags],
  );
  // Auto-managed tags (template/events) on an event budget are read-only.
  const isReadOnlyTag = (kind: string | null) =>
    isEventBudget && (kind === "template" || kind === "events");

  function toggleTag(id: Id<"budgetTags">) {
    setTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleCreateTag(name: string) {
    const created = await createTag({
      name,
      kind: "custom",
      ...(central ? { central: true } : {}),
    });
    setTagIds((prev) => [...prev, created]);
  }

  async function submit() {
    const dollars = parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars < 0) {
      alertError(new Error("Enter a valid dollar amount."));
      return;
    }
    const amountCents = Math.round(dollars * 100);
    const yr = parseInt(year, 10);
    if (!Number.isInteger(yr)) {
      alertError(new Error("Enter a valid year."));
      return;
    }
    setSaving(true);
    try {
      const period = {
        year: yr,
        month: showMonth ? month ?? undefined : undefined,
        quarter: showQuarter ? quarter ?? undefined : undefined,
      };
      if (editing) {
        await update({
          budgetId: editing.id,
          patch: {
            amountCents,
            label: label.trim() || null,
            type,
            cadence,
            refKind: type === "one_time" ? refKind ?? null : null,
            scopeRefId: type === "one_time" ? scopeRefId ?? null : null,
            year: yr,
            month: showMonth ? month : null,
            quarter: showQuarter ? quarter : null,
            categoryId: (categoryId as Id<"budgetCategories"> | null) ?? null,
          },
          // Send the full current set so backend replaces links (auto tags kept).
          tagIds,
        });
        onClose();
      } else {
        const newBudgetId = await create({
          amountCents,
          type,
          cadence,
          ...(central ? { central: true } : {}),
          ...(type === "one_time" && refKind ? { refKind } : {}),
          ...(type === "one_time" && scopeRefId ? { scopeRefId } : {}),
          ...period,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(categoryId ? { categoryId: categoryId as Id<"budgetCategories"> } : {}),
          ...(tagIds.length ? { tagIds } : {}),
        });
        // WP-3.1: don't close — stay open on the new budget so "Plan this
        // budget" is the next thing the user sees.
        setCreatedBudgetId(newBudgetId);
      }
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  // WP-3.1: right after a FRESH create (not editing), swap the whole body for
  // the planning step — the top fields are now stale local state pointing at
  // nothing (`editing` stays null since the caller never passed this budget's
  // id in), so re-showing them risks a second, duplicate `create` on "Save".
  const justCreated = !editing && createdBudgetId != null;
  const createdBudget = justCreated
    ? budgets.find((b) => b.id === createdBudgetId) ?? null
    : null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              {editing ? "Edit budget" : justCreated ? "Plan this budget" : "New budget"}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          {justCreated && createdBudgetId ? (
            <>
              <ScrollView className="max-h-[560px] px-5 py-4">
                <Text className="mb-1 text-base text-ink">
                  {createdBudget?.label ?? "Budget"} created
                  {createdBudget ? ` — ${(createdBudget.amountCents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })}` : ""}
                </Text>
                <BudgetLineItemsEditor budgetId={createdBudgetId} />
              </ScrollView>
              <View className="flex-row justify-end border-t border-border px-5 py-4">
                <Button title="Done" onPress={onClose} />
              </View>
            </>
          ) : (
          <ScrollView className="max-h-[560px] px-5 py-4">
            <TextField
              label="Name"
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. Fall retreat, Equipment…"
            />
            <TextField
              label="Amount (USD)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
            />

            {editing ? (
              editing.level === "central" ? (
                <LockedCentralLevelField />
              ) : null
            ) : forceCentral ? (
              // Central-desk "New budget": always org-wide, no chapter option.
              <LockedCentralLevelField />
            ) : canCentral ? (
              <Select
                label="Level"
                value={central ? "central" : "chapter"}
                options={[
                  { value: "chapter", label: "Chapter" },
                  { value: "central", label: "Central (org-wide)" },
                ]}
                onChange={(v) => {
                  const isCentral = v === "central";
                  setCentral(isCentral);
                  // Drop chapter-level tags that a central budget can't carry.
                  if (isCentral) {
                    setTagIds((prev) =>
                      prev.filter((id) => tagById.get(id)?.level === "central"),
                    );
                  }
                }}
              />
            ) : null}

            <Select
              label="Type"
              value={type}
              options={TYPE_OPTIONS}
              onChange={(v) => setType(v as BudgetType)}
            />

            {type === "one_time" ? (
              <Select
                label="Event or project"
                value={refSel ?? ""}
                options={refOptions}
                onChange={(v) => setRefSel(v || null)}
                placeholder="— No specific event/project —"
              />
            ) : (
              <Select
                label="Cadence"
                value={recurringCadence}
                options={RECURRING_CADENCE_OPTIONS}
                onChange={(v) => setRecurringCadence(v as BudgetCadence)}
              />
            )}

            <View className="flex-row gap-3">
              <View className="flex-1">
                <TextField
                  label="Year"
                  value={year}
                  onChangeText={setYear}
                  keyboardType="number-pad"
                />
              </View>
              {showMonth ? (
                <View className="flex-1">
                  <Select
                    label="Month"
                    value={month == null ? "" : String(month)}
                    placeholder="Every month"
                    options={[
                      { value: "", label: "Every month" },
                      ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m })),
                    ]}
                    onChange={(v) => setMonth(v === "" ? null : parseInt(v, 10))}
                  />
                </View>
              ) : null}
              {showQuarter ? (
                <View className="flex-1">
                  <Select
                    label="Quarter"
                    value={quarter == null ? null : String(quarter)}
                    options={[1, 2, 3, 4].map((q) => ({
                      value: String(q),
                      label: `Q${q}`,
                    }))}
                    onChange={(v) => setQuarter(parseInt(v, 10))}
                  />
                </View>
              ) : null}
            </View>

            <TagPicker
              tags={usableTags}
              selectedIds={tagIds}
              onToggle={toggleTag}
              onCreate={handleCreateTag}
              isReadOnlyTag={isReadOnlyTag}
              autoTagNote={isEventBudget && !editing}
            />

            <Select
              label="Category (optional)"
              value={categoryId}
              options={[{ value: "", label: "— No category —" }, ...categoryOptions]}
              onChange={(v) => setCategoryId(v || null)}
              placeholder="— No category —"
            />

            {/* WP-3.1: editing an existing budget already has a real id, so
                the "plan this budget" breakdown shows inline right here. */}
            {editing ? <BudgetLineItemsEditor budgetId={editing.id} /> : null}
          </ScrollView>
          )}

          {!justCreated ? (
            <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
              <Button title="Cancel" variant="secondary" onPress={onClose} />
              <Button
                title={editing ? "Save budget" : "Create budget"}
                onPress={submit}
                loading={saving}
              />
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Read-only "Level: Central (org-wide)" field ──────────────────────────────
// Shown instead of the Chapter/Central Select whenever the level isn't a
// choice: editing an existing central budget, or creating one from the
// central desk (`forceCentral`).
function LockedCentralLevelField() {
  return (
    <Field label="Level">
      <View className="rounded-md border border-border-strong bg-sunken px-3 py-2.5">
        <Text className="text-base text-muted">Central (org-wide)</Text>
      </View>
    </Field>
  );
}

// ── Multi-select tag control ─────────────────────────────────────────────────
/**
 * A managed multi-tag picker: selected tags render as removable chips (auto
 * event tags are read-only), an expandable panel lists every usable tag grouped
 * by kind (with a Chapter/Central level badge), and an inline field creates a
 * new custom tag.
 */
function TagPicker({
  tags,
  selectedIds,
  onToggle,
  onCreate,
  isReadOnlyTag,
  autoTagNote,
}: {
  tags: TagOption[];
  selectedIds: Id<"budgetTags">[];
  onToggle: (id: Id<"budgetTags">) => void;
  onCreate: (name: string) => Promise<void>;
  isReadOnlyTag: (kind: string | null) => boolean;
  autoTagNote: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const selectedSet = new Set(selectedIds.map((id) => id as string));
  const byId = new Map(tags.map((t) => [t.id as string, t] as const));
  const selectedTags = selectedIds
    .map((id) => byId.get(id as string))
    .filter((t): t is TagOption => Boolean(t));

  // Group the usable tags by kind, in a stable order.
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    heading: kind ? KIND_HEADING[kind] : "Other",
    items: tags.filter((t) => t.kind === kind),
  })).filter((g) => g.items.length > 0);

  async function submitNewTag() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await onCreate(name);
      setNewName("");
    } catch (err) {
      alertError(err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Field label="Tags">
      {/* Selected chips */}
      {selectedTags.length > 0 ? (
        <View className="mb-2 flex-row flex-wrap gap-2">
          {selectedTags.map((t) => {
            const readOnly = isReadOnlyTag(t.kind);
            return (
              <View
                key={t.id}
                className={`flex-row items-center gap-1 rounded-pill border px-2.5 py-1 ${
                  readOnly ? "border-border bg-sunken" : "border-accent bg-accent-soft"
                }`}
              >
                <Text
                  className={`text-sm font-medium ${readOnly ? "text-muted" : "text-accent"}`}
                >
                  {t.name}
                </Text>
                {readOnly ? (
                  <Icon name="lock" size={11} color={colors.muted} />
                ) : (
                  <Pressable onPress={() => onToggle(t.id)} hitSlop={6}>
                    <Icon name="x" size={12} color={colors.accent} />
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      ) : null}

      {autoTagNote ? (
        <Text className="mb-2 text-xs text-muted">
          The event's template tag and an “Events” tag are added automatically.
        </Text>
      ) : null}

      {/* Expand/collapse the picker */}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        className="flex-row items-center justify-between rounded-md border border-border-strong bg-raised px-3 py-2.5"
      >
        <Text className="text-base text-muted">
          {selectedTags.length > 0 ? "Add or remove tags" : "Add tags…"}
        </Text>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
      </Pressable>

      {open ? (
        <View className="mt-1 overflow-hidden rounded-md border border-border bg-raised shadow-raised">
          {groups.length === 0 ? (
            <Text className="px-3 py-2.5 text-sm text-muted">
              No tags yet — create one below.
            </Text>
          ) : (
            groups.map((g) => (
              <View key={g.heading}>
                <View className="bg-sunken px-3 py-1.5">
                  <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                    {g.heading}
                  </Text>
                </View>
                {g.items.map((t) => {
                  const selected = selectedSet.has(t.id as string);
                  const readOnly = isReadOnlyTag(t.kind);
                  return (
                    <Pressable
                      key={t.id}
                      onPress={() => (readOnly ? undefined : onToggle(t.id))}
                      disabled={readOnly}
                      className="flex-row items-center justify-between px-3 py-2.5 web:hover:bg-sunken"
                    >
                      <View className="flex-1 flex-row items-center gap-2">
                        <Text
                          className={`text-base ${
                            selected ? "font-semibold text-accent" : "text-ink"
                          }`}
                          numberOfLines={1}
                        >
                          {t.name}
                        </Text>
                        <Badge
                          label={t.level === "central" ? "Central" : "Chapter"}
                          tone={t.level === "central" ? "info" : "neutral"}
                        />
                      </View>
                      {selected ? (
                        <Icon name="check" size={15} color={colors.accent} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ))
          )}

          {/* Inline create-tag row */}
          <View className="flex-row items-center gap-2 border-t border-border px-3 py-2.5">
            <View className="flex-1">
              <TextField
                value={newName}
                onChangeText={setNewName}
                placeholder="Create tag…"
                onSubmitEditing={submitNewTag}
              />
            </View>
            <Button
              title="Add"
              size="sm"
              variant="secondary"
              onPress={submitNewTag}
              loading={creating}
            />
          </View>
        </View>
      ) : null}
    </Field>
  );
}
