/**
 * ManualTransactionModal — hand-enter an actual transaction.
 *
 * The unified `transactions` record is the ONLY source of "actual" money, so
 * this is how a bookkeeper records a charge or deposit that didn't sync from a
 * card/bank. Amount is collected in dollars and sent as a non-negative integer
 * of cents; direction is the `flow` (outflow/inflow), never a sign. An
 * optional category + the "For" picker (WP-U: one home per dollar — an event,
 * project, or recurring budget) attribute the spend for the rollups — there's
 * no fund picker (funds are backend-only, WP-1.4); the transaction silently
 * lands on the chapter's General Fund server-side. Backed by
 * `createManualTransaction`, which accepts a single `budgetId` — WP-wave4
 * (item 5): only an APPROVED budget's ref is offered by the picker at all
 * (`forPickerOptions` filters server-side), and the old "summon a $0 budget
 * on pick" flow is retired — picking an unbudgeted/unapproved ref is no
 * longer possible from here.
 */
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, DateTimeField, Field, Icon, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { buildForPickerItems } from "../reconcile/forPicker";

const FLOW_OPTIONS = [
  { value: "outflow", label: "Outflow (charge)" },
  { value: "inflow", label: "Inflow (deposit)" },
];

export function ManualTransactionModal({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.finances.createManualTransaction);
  const forOptions = useQuery(api.finances.forPickerOptions, {});

  const [merchant, setMerchant] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [flow, setFlow] = useState<"outflow" | "inflow">("outflow");
  const [postedAt, setPostedAt] = useState(Date.now());
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [forValue, setForValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const categories = useQuery(api.finances.listCategories, {}) ?? [];

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "— No category —" },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories],
  );
  const forItems = useMemo(
    () => (forOptions ? buildForPickerItems(forOptions) : [{ value: "", label: "None" }]),
    [forOptions],
  );

  async function submit() {
    const dollars = parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars < 0) {
      alertError(new Error("Enter a valid dollar amount."));
      return;
    }
    const amountCents = Math.round(dollars * 100);
    if (!merchant.trim() && !description.trim()) {
      alertError(new Error("Add a merchant or description."));
      return;
    }
    setSaving(true);
    try {
      await create({
        flow,
        amountCents,
        postedAt,
        ...(merchant.trim() ? { merchantName: merchant.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(categoryId ? { categoryId: categoryId as Id<"budgetCategories"> } : {}),
        ...(forValue ? { budgetId: forValue as Id<"budgets"> } : {}),
      });
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
            <Text className="font-display text-lg text-ink">Add transaction</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px] px-5 py-4">
            <TextField
              label="Merchant"
              value={merchant}
              onChangeText={setMerchant}
              placeholder="e.g. Home Depot"
            />
            <TextField
              label="Description (optional)"
              value={description}
              onChangeText={setDescription}
              placeholder="What was it for?"
            />

            <View className="flex-row gap-3">
              <View className="flex-1">
                <TextField
                  label="Amount (USD)"
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                />
              </View>
              <View className="flex-1">
                <Select
                  label="Direction"
                  value={flow}
                  options={FLOW_OPTIONS}
                  onChange={(v) => setFlow(v as "outflow" | "inflow")}
                />
              </View>
            </View>

            <Field label="Date">
              <DateTimeField value={postedAt} onChange={setPostedAt} />
            </Field>

            <Select
              label="Category (optional)"
              value={categoryId}
              options={categoryOptions}
              onChange={(v) => setCategoryId(v || null)}
              placeholder="— No category —"
            />
            <Select
              label="For (optional)"
              hint="Projects and events appear here once their budget is approved."
              value={forValue}
              options={forItems}
              onChange={(v) => setForValue(v || null)}
              placeholder="— None —"
            />
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button title="Add transaction" onPress={submit} loading={saving} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
