/**
 * BudgetLineItemsEditor — WP-3.1's "plan this budget" panel: rows of
 * [description | category | planned amount] under a budget, a live
 * "planned $X of $Y" indicator, add/remove. ESTIMATED-side only (never
 * touches `transactions` actuals — see `budgetPlanSummary`).
 *
 * Embedded inside `BudgetCreateModal` (works for both chapter AND central
 * budgets — the backend gates on the parent budget's own level). Needs a
 * real `budgetId`, so it only renders once the budget exists: while EDITING
 * an existing budget it shows immediately; right after CREATING a new one,
 * `BudgetCreateModal` keeps the modal open on the freshly-created budget so
 * this section is the very next thing the user sees — the "when a dollar
 * amount is entered, a budget panel comes up" trigger.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Button, Field, Icon, ProgressBar, Select, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

function dollarsToCents(text: string): number | null {
  const dollars = parseFloat(text);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export function BudgetLineItemsEditor({ budgetId }: { budgetId: Id<"budgets"> }) {
  const lines = useQuery(api.budgetLines.listLines, { budgetId });
  const summary = useQuery(api.budgetLines.budgetPlanSummary, { budgetId });
  const categories = useQuery(api.finances.listCategories, {}) ?? [];
  const categoryOptions = [
    { value: "", label: "— No category —" },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <View className="mt-4 border-t border-border pt-4">
      <SectionHeader title="Plan this budget" />
      <Text className="mb-3 -mt-2 text-sm text-muted">
        What are you gonna spend this money on? Break it down and categorize it.
      </Text>

      {summary ? (
        <View className="mb-3">
          <View className="mb-1 flex-row items-center justify-between">
            <Text className="text-sm font-medium text-ink">
              Planned {formatCents(summary.plannedCents)} of {formatCents(summary.totalCents)}
            </Text>
            {summary.overPlanned ? (
              <Text className="text-xs font-semibold text-danger">
                Over by {formatCents(Math.abs(summary.remainingCents))}
              </Text>
            ) : null}
          </View>
          <ProgressBar
            fraction={summary.totalCents > 0 ? summary.plannedCents / summary.totalCents : 0}
          />
        </View>
      ) : null}

      {lines === undefined ? (
        <Text className="py-2 text-sm text-muted">Loading plan…</Text>
      ) : lines.length === 0 ? (
        <Text className="py-2 text-sm text-muted">
          No lines yet — add your first one below.
        </Text>
      ) : (
        lines.map((line) => (
          <BudgetLineRow key={line.id} line={line} categoryOptions={categoryOptions} />
        ))
      )}

      <AddLineForm budgetId={budgetId} categoryOptions={categoryOptions} />
    </View>
  );
}

function BudgetLineRow({
  line,
  categoryOptions,
}: {
  line: {
    id: Id<"budgetLines">;
    description: string;
    categoryId: Id<"budgetCategories"> | null;
    plannedCents: number;
  };
  categoryOptions: { value: string; label: string }[];
}) {
  const updateLine = useMutation(api.budgetLines.updateLine);
  const removeLine = useMutation(api.budgetLines.removeLine);

  const [description, setDescription] = useState(line.description);
  const [amount, setAmount] = useState((line.plannedCents / 100).toString());
  const [removing, setRemoving] = useState(false);

  async function commitDescription() {
    const trimmed = description.trim();
    if (!trimmed || trimmed === line.description) {
      setDescription(line.description);
      return;
    }
    try {
      await updateLine({ lineId: line.id, patch: { description: trimmed } });
    } catch (err) {
      alertError(err);
      setDescription(line.description);
    }
  }

  async function commitAmount() {
    const cents = dollarsToCents(amount);
    if (cents === null) {
      alertError(new Error("Enter a valid planned amount."));
      setAmount((line.plannedCents / 100).toString());
      return;
    }
    if (cents === line.plannedCents) return;
    try {
      await updateLine({ lineId: line.id, patch: { plannedCents: cents } });
    } catch (err) {
      alertError(err);
      setAmount((line.plannedCents / 100).toString());
    }
  }

  async function handleCategoryChange(value: string) {
    try {
      await updateLine({
        lineId: line.id,
        patch: { categoryId: (value || null) as Id<"budgetCategories"> | null },
      });
    } catch (err) {
      alertError(err);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await removeLine({ lineId: line.id });
    } catch (err) {
      alertError(err);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <View className="flex-row items-center gap-2 border-t border-border py-2.5">
      <View className="flex-1">
        <TextInput
          value={description}
          onChangeText={setDescription}
          onBlur={() => void commitDescription()}
          onSubmitEditing={() => void commitDescription()}
          className="py-1 text-base text-ink"
        />
        <View className="mt-1 w-40">
          <Select
            value={line.categoryId ?? ""}
            options={categoryOptions}
            onChange={(v) => void handleCategoryChange(v)}
            placeholder="— No category —"
          />
        </View>
      </View>
      <View className="w-24">
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
          <Text className="text-base text-faint">$</Text>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            onBlur={() => void commitAmount()}
            onSubmitEditing={() => void commitAmount()}
            placeholder="0"
            placeholderTextColor={colors.faint}
            keyboardType="decimal-pad"
            className="flex-1 py-2 text-base text-ink"
          />
        </View>
      </View>
      <Pressable
        onPress={() => void handleRemove()}
        disabled={removing}
        hitSlop={6}
        accessibilityLabel={`Remove ${line.description}`}
        className="active:opacity-70"
      >
        <Icon name="x" size={15} color={colors.muted} />
      </Pressable>
    </View>
  );
}

function AddLineForm({
  budgetId,
  categoryOptions,
}: {
  budgetId: Id<"budgets">;
  categoryOptions: { value: string; label: string }[];
}) {
  const addLine = useMutation(api.budgetLines.addLine);
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    const trimmed = description.trim();
    if (!trimmed) {
      alertError(new Error("Enter what this line is for."));
      return;
    }
    const cents = dollarsToCents(amount);
    if (cents === null) {
      alertError(new Error("Enter a valid planned amount."));
      return;
    }
    setSaving(true);
    try {
      await addLine({
        budgetId,
        description: trimmed,
        plannedCents: cents,
        ...(categoryId ? { categoryId: categoryId as Id<"budgetCategories"> } : {}),
      });
      setDescription("");
      setCategoryId("");
      setAmount("");
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mt-2 border-t border-border pt-3">
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What's this for? (e.g. PA rental)"
            placeholderTextColor={colors.faint}
            className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
          />
          <View className="mt-2 w-40">
            <Select
              value={categoryId}
              options={categoryOptions}
              onChange={setCategoryId}
              placeholder="— No category —"
            />
          </View>
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
      <View className="mt-2 flex-row justify-end">
        <Button title="Add line" icon="plus" size="sm" loading={saving} onPress={() => void handleAdd()} />
      </View>
    </View>
  );
}
