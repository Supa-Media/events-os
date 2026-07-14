/**
 * Event "Gear" tool — this event's reservations against the chapter inventory.
 * The top lists what this event has claimed (asset name + qty + note, inline
 * edit/remove via {@link GearRow}); below, an "Add gear" form picks any chapter
 * asset, shows its current chapter-wide availability, and warns inline when the
 * requested quantity exceeds what's free. Rendered by event/[id].tsx when the
 * Gear tool is open. Reserving is an UPSERT, so re-adding an already-claimed
 * asset just updates this event's quantity.
 */
import { useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Card, Field, SectionHeader, Select, TextField } from "../../ui";
import { ToastView } from "../../ui/Toast";
import { useActionRunner } from "../../../lib/useActionToast";
import { colors } from "../../../lib/theme";
import { GearRow } from "./GearRow";
import {
  INVENTORY_CATEGORY_LABELS,
  type AssetRowData,
  type EventReservation,
} from "./helpers";

export default function GearTab({ eventId }: { eventId: Id<"events"> }) {
  const { run, toast, dismiss } = useActionRunner();
  const reservations = useQuery(api.inventory.listEventReservations, {
    eventId,
  }) as EventReservation[] | undefined;
  const assets = useQuery(api.inventory.listAssets, {}) as
    | AssetRowData[]
    | undefined;

  if (reservations === undefined || assets === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading gear…</Text>
      </View>
    );
  }

  return (
    <View>
      <ToastView toast={toast} onDismiss={dismiss} />

      <SectionHeader title="Reserved for this event" count={reservations.length} />
      <Card>
        {reservations.length === 0 ? (
          <Text className="py-2 text-base text-muted">
            No gear reserved yet — add from the chapter inventory below.
          </Text>
        ) : (
          reservations.map((r) => (
            <GearRow key={r._id} reservation={r} run={run} />
          ))
        )}
      </Card>

      <SectionHeader title="Add gear" />
      <AddGearForm eventId={eventId} assets={assets} run={run} />
    </View>
  );
}

/** The "Add gear" form: pick a chapter asset, a quantity, and an optional note. */
function AddGearForm({
  eventId,
  assets,
  run,
}: {
  eventId: Id<"events">;
  assets: AssetRowData[];
  run: ReturnType<typeof useActionRunner>["run"];
}) {
  const reserveAsset = useMutation(api.inventory.reserveAsset);
  const [assetId, setAssetId] = useState<string>(assets[0]?._id ?? "");
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const options = useMemo(
    () =>
      assets.map((a) => ({
        value: a._id as string,
        label: `${a.name} · ${INVENTORY_CATEGORY_LABELS[a.category]} (${a.available}/${a.quantity} free)`,
      })),
    [assets],
  );

  const selected = assets.find((a) => a._id === assetId) ?? null;
  const qtyNum = Number(qty.trim());
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= 1;
  // Warn (don't block — overbooking is allowed and surfaced) when the claim
  // exceeds what's currently free chapter-wide.
  const overClaim =
    selected != null && qtyValid && qtyNum > selected.available;

  if (assets.length === 0) {
    return (
      <Card>
        <Text className="py-2 text-base text-muted">
          No assets in the chapter inventory yet. Add gear from the Inventory
          screen first.
        </Text>
      </Card>
    );
  }

  async function handleSubmit() {
    if (!assetId) {
      await run(() => Promise.reject(new Error("Pick an asset to reserve.")), {
        errorTitle: "Couldn't reserve",
      });
      return;
    }
    if (!qtyValid) {
      await run(
        () => Promise.reject(new Error("Enter a whole number of at least 1.")),
        { errorTitle: "Couldn't reserve" },
      );
      return;
    }
    setSubmitting(true);
    const ok = await run(
      () =>
        reserveAsset({
          eventId,
          assetId: assetId as Id<"assets">,
          quantity: qtyNum,
          note: note.trim() || undefined,
        }),
      { errorTitle: "Couldn't reserve" },
    ).finally(() => setSubmitting(false));
    if (ok !== undefined) {
      setQty("1");
      setNote("");
    }
  }

  return (
    <Card>
      <Select
        label="Asset"
        value={assetId}
        options={options}
        onChange={setAssetId}
      />
      <Field label="Quantity">
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-3">
          <TextInput
            value={qty}
            onChangeText={setQty}
            placeholder="1"
            placeholderTextColor={colors.faint}
            keyboardType="number-pad"
            className="flex-1 py-2.5 text-base text-ink"
          />
        </View>
      </Field>
      {overClaim ? (
        <Text className="mb-2 text-sm text-danger">
          Claiming {qtyNum} but only {selected?.available} free — this will
          overbook the asset across events.
        </Text>
      ) : null}
      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        placeholder="e.g. for the second stage"
      />
      <View className="mt-1 flex-row justify-end">
        <Button
          title="Reserve"
          icon="plus"
          size="sm"
          loading={submitting}
          onPress={() => void handleSubmit()}
        />
      </View>
    </Card>
  );
}
