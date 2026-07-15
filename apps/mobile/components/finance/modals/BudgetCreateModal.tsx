/**
 * BudgetCreateModal — create or edit a budget (scope × cadence × category).
 *
 * A budget is a flexible allocation: pick WHAT it's attached to (scope), how
 * often it recurs (cadence), the period (year + month/quarter as the cadence
 * needs), an amount in dollars, and optionally narrow it to a fund + category
 * (+ a team when the scope is team). Money is collected in dollars and sent as
 * integer cents. Backed by `createBudget` / `updateBudget`; the fund / category
 * / team pickers come from `listFunds` / `listCategories` / `listTeams`.
 */
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BUDGET_CADENCES,
  BUDGET_CADENCE_LABELS,
  BUDGET_SCOPES,
  BUDGET_SCOPE_LABELS,
  type BudgetCadence,
  type BudgetScope,
} from "@events-os/shared";
import { Button, Field, Icon, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SCOPE_OPTIONS = BUDGET_SCOPES.map((s) => ({
  value: s,
  label: BUDGET_SCOPE_LABELS[s],
}));
const CADENCE_OPTIONS = BUDGET_CADENCES.map((c) => ({
  value: c,
  label: BUDGET_CADENCE_LABELS[c],
}));

export function BudgetCreateModal({
  budgetId,
  defaultYear,
  defaultMonth,
  onClose,
}: {
  /** When set, edit this existing budget instead of creating a new one. */
  budgetId?: Id<"budgets"> | null;
  defaultYear: number;
  defaultMonth: number;
  onClose: () => void;
}) {
  const create = useMutation(api.finances.createBudget);
  const update = useMutation(api.finances.updateBudget);
  const funds = useQuery(api.finances.listFunds) ?? [];
  const teams = useQuery(api.finances.listTeams) ?? [];
  const budgets = useQuery(api.finances.listBudgets) ?? [];

  const editing = budgetId
    ? budgets.find((b) => b.id === budgetId) ?? null
    : null;

  const [scope, setScope] = useState<BudgetScope>("bucket");
  const [cadence, setCadence] = useState<BudgetCadence>("monthly");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [year, setYear] = useState(String(defaultYear));
  const [month, setMonth] = useState<number | null>(null);
  const [quarter, setQuarter] = useState<number | null>(1);
  const [fundId, setFundId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Preload state once the budget being edited resolves.
  useEffect(() => {
    if (!editing) return;
    setScope(editing.scope);
    setCadence(editing.cadence);
    setLabel(editing.label ?? "");
    setAmount((editing.amountCents / 100).toString());
    setYear(String(editing.year));
    setMonth(editing.month);
    setQuarter(editing.quarter ?? 1);
    setFundId(editing.fundId ?? null);
    setCategoryId(editing.categoryId ?? null);
    setTeamId(editing.teamId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  // Categories narrow to the chosen fund (all categories when none selected).
  const categories =
    useQuery(
      api.finances.listCategories,
      fundId ? { fundId: fundId as Id<"funds"> } : {},
    ) ?? [];

  const fundOptions = useMemo(
    () => funds.map((f) => ({ value: f.id, label: f.name })),
    [funds],
  );
  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.id, label: c.name })),
    [categories],
  );
  const teamOptions = useMemo(
    () => teams.map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const showQuarter = cadence === "quarterly";
  const showMonth = cadence === "monthly" || cadence === "per_instance" || cadence === "one_off";

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
            scope,
            cadence,
            year: yr,
            month: showMonth ? month : null,
            quarter: showQuarter ? quarter : null,
            fundId: (fundId as Id<"funds"> | null) ?? null,
            categoryId: (categoryId as Id<"budgetCategories"> | null) ?? null,
            teamId: scope === "team" ? (teamId as Id<"financeTeams"> | null) ?? null : null,
          },
        });
      } else {
        await create({
          amountCents,
          scope,
          cadence,
          ...period,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(fundId ? { fundId: fundId as Id<"funds"> } : {}),
          ...(categoryId ? { categoryId: categoryId as Id<"budgetCategories"> } : {}),
          ...(scope === "team" && teamId
            ? { teamId: teamId as Id<"financeTeams"> }
            : {}),
        });
      }
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

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
              {editing ? "Edit budget" : "New budget"}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px] px-5 py-4">
            <TextField
              label="Name"
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. Development team, Equipment…"
            />
            <TextField
              label="Amount (USD)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
            />

            <View className="flex-row gap-3">
              <View className="flex-1">
                <Select
                  label="Scope"
                  value={scope}
                  options={SCOPE_OPTIONS}
                  onChange={(v) => setScope(v as BudgetScope)}
                />
              </View>
              <View className="flex-1">
                <Select
                  label="Cadence"
                  value={cadence}
                  options={CADENCE_OPTIONS}
                  onChange={(v) => setCadence(v as BudgetCadence)}
                />
              </View>
            </View>

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

            {scope === "team" ? (
              teamOptions.length > 0 ? (
                <Select
                  label="Team"
                  value={teamId}
                  options={teamOptions}
                  onChange={setTeamId}
                  placeholder="Select a team…"
                />
              ) : (
                <Field label="Team">
                  <Text className="text-sm text-muted">No finance teams yet.</Text>
                </Field>
              )
            ) : null}

            <Select
              label="Fund (optional)"
              value={fundId}
              options={[{ value: "", label: "— No fund —" }, ...fundOptions]}
              onChange={(v) => {
                setFundId(v || null);
                setCategoryId(null);
              }}
              placeholder="— No fund —"
            />
            <Select
              label="Category (optional)"
              value={categoryId}
              options={[{ value: "", label: "— No category —" }, ...categoryOptions]}
              onChange={(v) => setCategoryId(v || null)}
              placeholder="— No category —"
            />
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button
              title={editing ? "Save budget" : "Create budget"}
              onPress={submit}
              loading={saving}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
