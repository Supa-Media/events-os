/**
 * Shared add/edit form for a ticket tier. Price is entered as a dollar string
 * and converted to integer cents on submit; capacity and max-per-order are
 * optional non-negative counts.
 */
import { useState } from "react";
import { View } from "react-native";
import type { Doc } from "@events-os/convex/_generated/dataModel";
import { Button, TextField } from "../../ui";
import { parseDollars } from "./helpers";

type TicketType = Doc<"ticketTypes">;

export type FormValues = {
  name: string;
  priceCents: number;
  description?: string;
  capacity: number | null;
  maxPerOrder: number | null;
};

/** Optional non-negative integer field ("" → null, unparsable → null). */
function parseCount(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const n = Math.floor(Number(trimmed));
  return Number.isNaN(n) || n < 0 ? null : n;
}

export function TicketTypeForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: TicketType;
  submitLabel: string;
  onSubmit: (values: FormValues) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [price, setPrice] = useState(
    initial ? (initial.priceCents / 100).toString() : "",
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [capacity, setCapacity] = useState(
    initial?.capacity != null ? String(initial.capacity) : "",
  );
  const [maxPerOrder, setMaxPerOrder] = useState(
    initial?.maxPerOrder != null ? String(initial.maxPerOrder) : "",
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const priceCents = price.trim() === "" ? 0 : parseDollars(price);
    if (priceCents === null) return; // unparsable price — leave the form open
    setSubmitting(true);
    await onSubmit({
      name: name.trim() || "General Admission",
      priceCents,
      description,
      capacity: parseCount(capacity),
      maxPerOrder: parseCount(maxPerOrder),
    });
    setSubmitting(false);
  }

  return (
    <View className="mt-3">
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="General Admission"
      />
      <TextField
        label="Price"
        value={price}
        onChangeText={setPrice}
        placeholder="0 = free"
        keyboardType="decimal-pad"
        hint="In dollars — e.g. 12 or 12.50."
      />
      <TextField
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="What's included (optional)"
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <TextField
            label="Capacity"
            value={capacity}
            onChangeText={setCapacity}
            placeholder="Unlimited"
            keyboardType="numeric"
          />
        </View>
        <View className="flex-1">
          <TextField
            label="Max per order"
            value={maxPerOrder}
            onChangeText={setMaxPerOrder}
            placeholder="10"
            keyboardType="numeric"
          />
        </View>
      </View>
      <View className="flex-row justify-end">
        <Button
          title={submitLabel}
          size="sm"
          loading={submitting}
          onPress={() => void handleSubmit()}
        />
      </View>
    </View>
  );
}
