/**
 * Admin "Budget" tab — a typed, per-line budget for an event. A money-summary
 * strip (Income / Planned / Actual / Net) reconciles planned + actual spend
 * against the money that came IN (ticket revenue + donations), then the
 * line-item list lets you edit each line's actual, attach a receipt, and remove
 * it. An "Add line item" form appends new lines. Rendered by event/[id].tsx
 * when the Budget tool is open. NON-DISRUPTIVE to the coarse header budget.
 */
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Button,
  Card,
  Field,
  SectionHeader,
  Select,
  TextField,
} from "../../ui";
import { ToastView } from "../../ui/Toast";
import { useActionRunner } from "../../../lib/useActionToast";
import { colors } from "../../../lib/theme";
import { formatMoney, parseDollars } from "../ticketing/helpers";
import { BudgetLineRow } from "./BudgetLineRow";
import {
  BUDGET_CATEGORY_OPTIONS,
  type BudgetCategory,
} from "./helpers";

export default function BudgetTab({ eventId }: { eventId: Id<"events"> }) {
  const { run, toast, dismiss } = useActionRunner();
  const data = useQuery(api.budget.budgetSummary, { eventId });

  if (data === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading budget…</Text>
      </View>
    );
  }

  const { lineItems, plannedCents, actualCents, incomeCents, netCents } = data;

  return (
    <View>
      <ToastView toast={toast} onDismiss={dismiss} />

      <SectionHeader title="Money summary" />
      <View className="flex-row flex-wrap gap-2">
        <StatCard label="Income" value={formatMoney(incomeCents)} />
        <StatCard label="Planned" value={formatMoney(plannedCents)} />
        <StatCard label="Actual" value={formatMoney(actualCents)} />
        <StatCard
          label="Net"
          value={formatMoney(netCents)}
          // Over-budget (spent more than came in) reads red.
          tone={netCents < 0 ? "danger" : "default"}
        />
      </View>
      <Text className="mt-2 text-xs text-muted">
        Net = income (tickets + donations) − actual spend. Planned is your budget
        target; the header budget is separate.
      </Text>

      <SectionHeader title="Line items" count={lineItems.length} />
      <Card>
        {lineItems.length === 0 ? (
          <Text className="py-2 text-base text-muted">
            No budget lines yet — add your first one below.
          </Text>
        ) : (
          lineItems.map((line) => (
            <BudgetLineRow key={line._id} line={line} run={run} />
          ))
        )}
      </Card>

      <SectionHeader title="Add line item" />
      <AddLineItemForm eventId={eventId} run={run} />
    </View>
  );
}

/** One small stat tile in the money-summary strip. */
function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <Card padding="sm" className="min-w-[110px] flex-1">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text
        className={`mt-1 font-display text-xl ${
          tone === "danger" ? "text-danger" : "text-ink"
        }`}
      >
        {value}
      </Text>
    </Card>
  );
}

/** The "Add line item" form: label + category + planned amount. */
function AddLineItemForm({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ReturnType<typeof useActionRunner>["run"];
}) {
  const addLineItem = useMutation(api.budget.addLineItem);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<BudgetCategory>("other");
  const [planned, setPlanned] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setLabel("");
    setCategory("other");
    setPlanned("");
  }

  async function handleSubmit() {
    const trimmed = label.trim();
    if (!trimmed) {
      await run(() => Promise.reject(new Error("Enter a label for the line.")), {
        errorTitle: "Couldn't add line",
      });
      return;
    }
    const cents = parseDollars(planned);
    if (cents === null) {
      await run(
        () => Promise.reject(new Error("Enter a valid planned amount.")),
        { errorTitle: "Couldn't add line" },
      );
      return;
    }
    setSubmitting(true);
    const ok = await run(
      () =>
        addLineItem({
          eventId,
          label: trimmed,
          category,
          plannedCents: cents,
        }),
      { errorTitle: "Couldn't add line" },
    ).finally(() => setSubmitting(false));
    if (ok !== undefined) reset();
  }

  return (
    <Card>
      <TextField
        label="Label"
        value={label}
        onChangeText={setLabel}
        placeholder="PA rental, flyers, coffee…"
      />
      <Select
        label="Category"
        value={category}
        options={BUDGET_CATEGORY_OPTIONS}
        onChange={(v) => setCategory(v as BudgetCategory)}
      />
      <Field label="Planned amount">
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-3">
          <Text className="text-base text-faint">$</Text>
          <TextInput
            value={planned}
            onChangeText={setPlanned}
            placeholder="250"
            placeholderTextColor={colors.faint}
            keyboardType="numeric"
            className="flex-1 py-2.5 text-base text-ink"
          />
        </View>
      </Field>
      <View className="mt-1 flex-row justify-end">
        <Button
          title="Add line item"
          icon="plus"
          size="sm"
          loading={submitting}
          onPress={() => void handleSubmit()}
        />
      </View>
    </Card>
  );
}
