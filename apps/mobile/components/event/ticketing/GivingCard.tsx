/**
 * Giving — the "support this event" master toggle lives in Page setup; this
 * card shows the running total + count, the donation ledger, and an inline
 * "Record donation" form for money that came in off-Stripe (cash at the merch
 * table, a check, etc.). Amounts are entered in dollars, stored as integer
 * cents. Card donations arrive automatically via Stripe and appear here too.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Card, Field, Icon, Pill, TextField } from "../../ui";
import type { BadgeTone } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { confirmAction, formatMoney, parseDollars } from "./helpers";

type Donation = Doc<"donations">;
type Method = "cash" | "other";

type Props = {
  eventId: Id<"events">;
  page: Doc<"eventPages">;
  run: ActionRunner["run"];
};

const METHOD_LABEL: Record<string, string> = {
  card: "Card",
  cash: "Cash",
  other: "Other",
};

const STATUS_TONE: Record<string, BadgeTone> = {
  paid: "success",
  pending: "warn",
  refunded: "neutral",
  canceled: "neutral",
  expired: "neutral",
};

export function GivingCard({ eventId, page, run }: Props) {
  const donations = useQuery(api.giving.listDonationsAdmin, { eventId });
  const recordDonation = useMutation(api.giving.recordDonation);
  const removeDonation = useMutation(api.giving.removeDonation);

  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  function resetForm() {
    setAmount("");
    setMethod("cash");
    setName("");
    setNote("");
  }

  async function handleSubmit() {
    const cents = parseDollars(amount);
    if (cents === null || cents <= 0) {
      await run(
        () => Promise.reject(new Error("Enter an amount greater than $0.")),
        { errorTitle: "Couldn't record donation" },
      );
      return;
    }
    const ok = await run(
      () =>
        recordDonation({
          eventId,
          amountCents: cents,
          method,
          name: name.trim() || undefined,
          note: note.trim() || undefined,
        }),
      { errorTitle: "Couldn't record donation" },
    );
    if (ok !== undefined) {
      resetForm();
      setAdding(false);
    }
  }

  function handleRemove(d: Donation) {
    confirmAction({
      title: "Remove donation?",
      message: `${formatMoney(d.amountCents)} from ${d.name} will be deleted${
        d.status === "paid" ? " and the total adjusted" : ""
      }.`,
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(() => removeDonation({ donationId: d._id }), {
          errorTitle: "Couldn't remove donation",
        }),
      destructive: true,
    });
  }

  const total = page.donationsCents ?? 0;
  const count = page.donationsCount ?? 0;
  const rows = donations ?? [];

  return (
    <Card>
      <View className="flex-row items-baseline gap-2">
        <Text className="font-display text-2xl text-ink">
          {formatMoney(total)}
        </Text>
        <Text className="text-sm text-muted">
          raised · {count} gift{count === 1 ? "" : "s"}
        </Text>
      </View>

      {donations === undefined ? (
        <Text className="py-3 text-base text-muted">Loading donations…</Text>
      ) : rows.length === 0 && !adding ? (
        <Text className="py-3 text-base text-muted">
          No donations yet — enable Giving on the page, or record a cash gift below.
        </Text>
      ) : (
        rows.map((d) => (
          <View key={d._id} className="border-t border-border py-3">
            <View className="flex-row items-center gap-3">
              <View className="flex-1">
                <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                  {formatMoney(d.amountCents)} · {d.name}
                </Text>
                <Text className="mt-0.5 text-sm text-muted" numberOfLines={1}>
                  {METHOD_LABEL[d.method] ?? d.method}
                  {d.note ? ` · ${d.note}` : ""}
                </Text>
              </View>
              <Badge
                label={d.status === "paid" ? "Paid" : d.status}
                tone={STATUS_TONE[d.status] ?? "neutral"}
              />
              <Pressable
                onPress={() => handleRemove(d)}
                hitSlop={6}
                accessibilityLabel={`Remove donation from ${d.name}`}
                className="active:opacity-70"
              >
                <Icon name="x" size={15} color={colors.muted} />
              </Pressable>
            </View>
          </View>
        ))
      )}

      {adding ? (
        <View className="border-t border-border py-3">
          <Text className="mb-2 text-sm font-semibold text-ink">
            Record a donation
          </Text>
          <TextField
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            placeholder="$25"
            keyboardType="numeric"
          />
          <Field label="Method">
            <View className="flex-row gap-2">
              <Pill
                label="Cash"
                selected={method === "cash"}
                onPress={() => setMethod("cash")}
              />
              <Pill
                label="Other"
                selected={method === "other"}
                onPress={() => setMethod("other")}
              />
            </View>
          </Field>
          <TextField
            label="From (optional)"
            value={name}
            onChangeText={setName}
            placeholder="Anonymous"
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="Merch table, check #123…"
          />
          <View className="mt-3 flex-row justify-end gap-2">
            <Button
              title="Cancel"
              variant="secondary"
              size="sm"
              onPress={() => {
                resetForm();
                setAdding(false);
              }}
            />
            <Button
              title="Record donation"
              icon="check"
              size="sm"
              onPress={() => void handleSubmit()}
            />
          </View>
        </View>
      ) : (
        <View className="mt-2 flex-row">
          <Button
            title="Record donation"
            icon="plus"
            variant="secondary"
            size="sm"
            onPress={() => setAdding(true)}
          />
        </View>
      )}
    </Card>
  );
}
