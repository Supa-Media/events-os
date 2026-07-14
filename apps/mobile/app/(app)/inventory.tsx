/**
 * INVENTORY — the chapter's gear registry (the first chapter-level typed
 * entity). Each asset shows its name, category, an `available / quantity` chip,
 * an overbooked warning when events have claimed more than exist, a "Not yet
 * acquired" badge + toggle for Chapter-Kit targets, a condition dot, and a
 * freeform prep `stateNote`. Add assets with the bottom form; edit any field
 * inline; attach a photo via the CoverPhotoPicker-style storage flow.
 *
 * Gated admin-or-lead in the nav (logistics-lead domain) AND in-screen here, so
 * a member/volunteer who deep-links lands on a friendly restricted state rather
 * than the registry. Reservations against these assets happen per-event from the
 * event's Gear tool.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  InlineText,
  Narrow,
  Screen,
  SectionHeader,
  Select,
  TextField,
} from "../../components/ui";
import { ToastView } from "../../components/ui/Toast";
import { useActionRunner, type ActionRunner } from "../../lib/useActionToast";
import { colors } from "../../lib/theme";
import { confirmAction } from "../../components/event/ticketing/helpers";
import {
  INVENTORY_CATEGORY_LABELS,
  INVENTORY_CATEGORY_OPTIONS,
  type AssetRowData,
} from "../../components/event/gear/helpers";
import {
  ASSET_CONDITION_LABELS,
  type AssetCondition,
  type InventoryCategory,
} from "@events-os/shared";

/** Condition → dot color. Unset renders a hollow (faint) dot. */
const CONDITION_COLOR: Record<AssetCondition, string> = {
  ok: colors.success,
  needs_attention: colors.warn,
  broken: colors.danger,
};
/** Tap-cycle order for the condition dot: none → ok → needs → broken → none. */
const CONDITION_CYCLE: (AssetCondition | null)[] = [
  null,
  "ok",
  "needs_attention",
  "broken",
];

export default function InventoryScreen() {
  const { run, toast, dismiss } = useActionRunner();
  const org = useQuery(api.org.nav);
  const assets = useQuery(api.inventory.listAssets, {}) as
    | AssetRowData[]
    | undefined;

  // In-screen guard: the registry is the logistics-lead domain (admin or lead).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Inventory is restricted"
            message="Only chapter admins and leads can manage the gear registry."
          />
        </Narrow>
      </Screen>
    );
  }

  if (assets === undefined || org === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <ToastView toast={toast} onDismiss={dismiss} />

        <View className="mb-1 flex-row items-center gap-2">
          <Text className="font-display text-2xl text-ink">Inventory</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Registry ({assets.length})
          </Text>
        </View>
        <Text className="mb-3 text-sm text-muted">
          Your chapter's gear. Events reserve from here — two overlapping events
          can't both claim the one battery. Reserve gear from an event's Gear
          tool.
        </Text>

        <SectionHeader title="Assets" count={assets.length} />
        <Card>
          {assets.length === 0 ? (
            <Text className="py-2 text-base text-muted">
              No assets yet — add your first below.
            </Text>
          ) : (
            assets.map((asset) => (
              <AssetRow key={asset._id} asset={asset} run={run} />
            ))
          )}
        </Card>

        <SectionHeader title="Add asset" />
        <AddAssetForm run={run} />
      </Narrow>
    </Screen>
  );
}

/** One asset row: photo, name, category, availability, badges, prep note. */
function AssetRow({ asset, run }: { asset: AssetRowData; run: ActionRunner["run"] }) {
  const update = useMutation(api.inventory.updateAsset);
  const remove = useMutation(api.inventory.removeAsset);
  const id = asset._id as Id<"assets">;

  const [qtyInput, setQtyInput] = useState<string | null>(null);
  const qtyValue = qtyInput !== null ? qtyInput : String(asset.quantity);

  async function saveQty() {
    const n = Number(qtyValue.trim());
    if (!Number.isInteger(n) || n < 0) {
      await run(
        () => Promise.reject(new Error("Enter a whole number (zero or more).")),
        { errorTitle: "Couldn't save quantity" },
      );
      setQtyInput(null);
      return;
    }
    if (n !== asset.quantity) {
      await run(() => update({ assetId: id, quantity: n }), {
        errorTitle: "Couldn't save quantity",
      });
    }
    setQtyInput(null);
  }

  function cycleCondition() {
    const cur = asset.condition ?? null;
    const idx = CONDITION_CYCLE.indexOf(cur);
    const next = CONDITION_CYCLE[(idx + 1) % CONDITION_CYCLE.length];
    void run(() => update({ assetId: id, condition: next }), {
      errorTitle: "Couldn't set condition",
    });
  }

  function toggleAcquired() {
    void run(() => update({ assetId: id, acquired: !asset.acquired }), {
      errorTitle: "Couldn't update asset",
    });
  }

  function handleRemove() {
    confirmAction({
      title: "Remove asset?",
      message: `"${asset.name}" and any event reservations of it will be deleted.`,
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(() => remove({ assetId: id }), {
          errorTitle: "Couldn't remove asset",
        }),
      destructive: true,
    });
  }

  return (
    <View className="flex-row items-start gap-3 border-t border-border py-3">
      <AssetPhotoButton assetId={id} photoUrl={asset.photoUrl} run={run} />

      <View className="flex-1">
        {/* Name (inline) */}
        <InlineText
          value={asset.name}
          placeholder="Asset name"
          weight="medium"
          onCommit={(t) => {
            const name = t.trim();
            if (name && name !== asset.name) {
              void run(() => update({ assetId: id, name }), {
                errorTitle: "Couldn't rename asset",
              });
            }
          }}
        />

        {/* Category + availability + warnings */}
        <View className="mt-1 flex-row flex-wrap items-center gap-2">
          <CategoryPicker
            value={asset.category}
            onChange={(category) =>
              void run(() => update({ assetId: id, category }), {
                errorTitle: "Couldn't set category",
              })
            }
          />
          <Text className="text-sm font-semibold text-ink">
            {asset.available} / {asset.quantity}
          </Text>
          {asset.overbooked ? (
            <Badge label="Overbooked" tone="danger" icon="alert-triangle" />
          ) : null}
          {!asset.acquired ? (
            <Pressable onPress={toggleAcquired} className="active:opacity-70">
              <Badge label="Not yet acquired" tone="warn" />
            </Pressable>
          ) : null}
          {/* Condition dot — tap to cycle */}
          <Pressable
            onPress={cycleCondition}
            hitSlop={8}
            accessibilityLabel={
              asset.condition
                ? `Condition: ${ASSET_CONDITION_LABELS[asset.condition]}`
                : "Set condition"
            }
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: asset.condition
                  ? CONDITION_COLOR[asset.condition]
                  : "transparent",
                borderWidth: asset.condition ? 0 : 1,
                borderColor: colors.faint,
              }}
            />
            {asset.condition ? (
              <Text className="text-2xs text-muted">
                {ASSET_CONDITION_LABELS[asset.condition]}
              </Text>
            ) : null}
          </Pressable>
        </View>

        {/* Acquired toggle when already acquired (compact) */}
        {asset.acquired ? (
          <Pressable
            onPress={toggleAcquired}
            className="mt-1 self-start active:opacity-70"
          >
            <Text className="text-2xs text-faint">Mark not yet acquired</Text>
          </Pressable>
        ) : null}

        {/* Prep state note (inline) */}
        <View className="mt-1">
          <InlineText
            value={asset.stateNote ?? ""}
            placeholder="Prep note (e.g. charge the battery)…"
            onCommit={(t) =>
              void run(() => update({ assetId: id, stateNote: t.trim() || null }), {
                errorTitle: "Couldn't save prep note",
              })
            }
          />
        </View>
      </View>

      {/* Quantity edit */}
      <View className="w-14">
        <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">
          Qty
        </Text>
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
          <TextInput
            value={qtyValue}
            onChangeText={setQtyInput}
            onBlur={() => void saveQty()}
            onSubmitEditing={() => void saveQty()}
            placeholder="0"
            placeholderTextColor={colors.faint}
            keyboardType="number-pad"
            className="flex-1 py-2 text-base text-ink"
          />
        </View>
      </View>

      <Pressable
        onPress={handleRemove}
        hitSlop={6}
        accessibilityLabel={`Remove ${asset.name}`}
        className="active:opacity-70"
      >
        <Icon name="trash-2" size={15} color={colors.danger} />
      </Pressable>
    </View>
  );
}

/** Category as a tappable badge that cycles a Select popover. */
function CategoryPicker({
  value,
  onChange,
}: {
  value: InventoryCategory;
  onChange: (v: InventoryCategory) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <View className="w-40">
        <Select
          value={value}
          options={INVENTORY_CATEGORY_OPTIONS}
          onChange={(v) => {
            onChange(v as InventoryCategory);
            setEditing(false);
          }}
        />
      </View>
    );
  }
  return (
    <Pressable onPress={() => setEditing(true)} className="active:opacity-70">
      <Badge label={INVENTORY_CATEGORY_LABELS[value]} tone="neutral" />
    </Pressable>
  );
}

/**
 * Per-asset photo attachment — mirrors the ReceiptButton / CoverPhotoPicker
 * generate-url → POST → store-storageId flow (web file input / native picker).
 */
function AssetPhotoButton({
  assetId,
  photoUrl,
  run,
}: {
  assetId: Id<"assets">;
  photoUrl: string | null;
  run: ActionRunner["run"];
}) {
  const setAssetPhoto = useMutation(api.inventory.setAssetPhoto);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const [uploading, setUploading] = useState(false);

  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      await run(
        async () => {
          const uploadUrl = await generateUploadUrl();
          const res = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          const { storageId } = await res.json();
          await setAssetPhoto({ assetId, photoStorageId: storageId });
        },
        { errorTitle: "Couldn't attach photo" },
      );
    } finally {
      setUploading(false);
    }
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "image/jpeg");
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  function pick() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  function clear() {
    confirmAction({
      title: "Remove photo?",
      message: "The attached photo will be detached from this asset.",
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(() => setAssetPhoto({ assetId, photoStorageId: null }), {
          errorTitle: "Couldn't remove photo",
        }),
      destructive: true,
    });
  }

  if (uploading) {
    return (
      <View
        className="h-11 w-11 items-center justify-center rounded-md border border-border bg-sunken"
        accessibilityLabel="Uploading photo"
      >
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }

  if (photoUrl) {
    return (
      <Pressable
        onPress={clear}
        accessibilityLabel="Remove photo"
        className="h-11 w-11 overflow-hidden rounded-md border border-border bg-sunken active:opacity-80"
      >
        <Image
          source={{ uri: photoUrl }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="cover"
        />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={pick}
      accessibilityLabel="Attach photo"
      className="h-11 w-11 items-center justify-center rounded-md border border-dashed border-border-strong bg-raised active:opacity-70"
    >
      <Icon name="camera" size={16} color={colors.muted} />
    </Pressable>
  );
}

/** The "Add asset" form: name + category + quantity + not-yet-acquired toggle. */
function AddAssetForm({ run }: { run: ActionRunner["run"] }) {
  const addAsset = useMutation(api.inventory.addAsset);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<InventoryCategory>("other");
  const [quantity, setQuantity] = useState("1");
  const [acquired, setAcquired] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setCategory("other");
    setQuantity("1");
    setAcquired(true);
  }

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      await run(() => Promise.reject(new Error("Enter an asset name.")), {
        errorTitle: "Couldn't add asset",
      });
      return;
    }
    const n = Number(quantity.trim());
    if (!Number.isInteger(n) || n < 0) {
      await run(
        () => Promise.reject(new Error("Enter a whole number (zero or more).")),
        { errorTitle: "Couldn't add asset" },
      );
      return;
    }
    setSubmitting(true);
    const ok = await run(
      () =>
        addAsset({
          name: trimmed,
          category,
          quantity: n,
          acquired,
        }),
      { errorTitle: "Couldn't add asset" },
    ).finally(() => setSubmitting(false));
    if (ok !== undefined) reset();
  }

  return (
    <Card>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="SM58 mic, 200W battery, A-frame sign…"
      />
      <Select
        label="Category"
        value={category}
        options={INVENTORY_CATEGORY_OPTIONS}
        onChange={(v) => setCategory(v as InventoryCategory)}
      />
      <Field label="Quantity owned">
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-3">
          <TextInput
            value={quantity}
            onChangeText={setQuantity}
            placeholder="1"
            placeholderTextColor={colors.faint}
            keyboardType="number-pad"
            className="flex-1 py-2.5 text-base text-ink"
          />
        </View>
      </Field>
      <Pressable
        onPress={() => setAcquired((a) => !a)}
        className="mb-1 flex-row items-center gap-2 self-start active:opacity-70"
      >
        <Icon
          name={acquired ? "check-square" : "square"}
          size={18}
          color={acquired ? colors.accent : colors.muted}
        />
        <Text className="text-sm text-ink">Already acquired</Text>
      </Pressable>
      <View className="mt-1 flex-row justify-end">
        <Button
          title="Add asset"
          icon="plus"
          size="sm"
          loading={submitting}
          onPress={() => void handleSubmit()}
        />
      </View>
    </Card>
  );
}
