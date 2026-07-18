/**
 * GIVING · Donor detail — identity, denormalized rollups, full gift history,
 * a manual record-gift form (the "backfill people's giving history" workflow,
 * PRD §1), per-gift editing, and notes. Reads `getDonor` (gated by
 * `requireGivingView`); the record-gift + edit surfaces are shown only to a
 * caller with `giving.manage` and post to `recordGift` / `editGift` (gated
 * server-side too).
 *
 * Territories P4 (gift sources/editing/receipts):
 *  - "Source" (the merged, widened method field): full picker, `stripe` shown
 *    as "Chapter OS", default `cash`.
 *  - Receipt proof — image/file upload to Convex storage (mirrors the
 *    reimbursement `RequestForm` flow) with thumbnails on each gift row.
 *  - Per-gift edit sheet (amount/date/source/note + receipts). A system-written
 *    gift (Stripe billing cycle or event donation) is note/receipt-only — the
 *    sheet locks its money fields and says so.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  Text,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  DateTimeField,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  Select,
  TextField,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { donorStatusTone } from "../donors";

/** The merged "Source" picker — the widened `GIFT_METHODS` union minus the
 *  deprecated-legacy `imported` (never written for new gifts). `stripe` is our
 *  own rails, shown as "Chapter OS". Default is `cash` (the most common manual
 *  backfill). */
const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "wire", label: "Wire" },
  { value: "zelle", label: "Zelle" },
  { value: "venmo", label: "Venmo" },
  { value: "givebutter", label: "Givebutter" },
  { value: "in_kind", label: "In-kind" },
  { value: "stripe", label: "Chapter OS" },
  { value: "other", label: "Other" },
];
const DEFAULT_SOURCE = "cash";

/** Every source's display label (covers legacy `imported` for old rows too). */
const SOURCE_LABELS: Record<string, string> = {
  stripe: "Chapter OS",
  cash: "Cash",
  check: "Check",
  wire: "Wire",
  in_kind: "In-kind",
  imported: "Imported",
  zelle: "Zelle",
  venmo: "Venmo",
  givebutter: "Givebutter",
  other: "Other",
};
function sourceLabel(method: string): string {
  return SOURCE_LABELS[method] ?? method;
}

/** External sources whose gifts warrant proof — a direct transfer or an
 *  expensive purchase made on behalf of the org that counts toward the giver's
 *  statement. Drives a non-blocking hint, not a requirement. */
const EXTERNAL_SOURCES = new Set([
  "cash",
  "zelle",
  "venmo",
  "wire",
  "in_kind",
  "other",
]);

const MAX_RECEIPTS = 10;

/** A gift row as returned by `getDonor` (with resolved `receiptUrls`). */
type GiftRow = {
  _id: Id<"gifts">;
  amountCents: number;
  receivedAt: number;
  method: string;
  note?: string;
  donationId?: Id<"donations">;
  stripeInvoiceId?: string;
  receiptStorageIds?: Id<"_storage">[];
  receiptUrls: string[];
  editedAt?: number;
};

export default function DonorDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const donorId = id as Id<"donors">;
  const access = useQuery(api.givingPlatform.myGivingAccess, {});
  const data = useQuery(api.givingPlatform.getDonor, { donorId });

  const [editing, setEditing] = useState<GiftRow | null>(null);

  if (access === undefined || data === undefined) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const { donor, gifts } = data as { donor: typeof data.donor; gifts: GiftRow[] };
  const canManage = access.canManage;
  return (
    <Screen>
      <Narrow>
        <View className="mb-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-2xl font-bold text-ink">{donor.name}</Text>
            <Badge label={donor.status} tone={donorStatusTone(donor.status)} />
          </View>
          {donor.email ? (
            <Text className="mt-1 text-sm text-muted">{donor.email}</Text>
          ) : null}
          {donor.phone ? (
            <Text className="text-sm text-muted">{donor.phone}</Text>
          ) : null}
          <Text className="mt-1 text-xs text-faint">
            {donor.kind}
            {donor.source ? ` · ${donor.source}` : ""}
          </Text>
        </View>

        <View className="mb-4 flex-row flex-wrap gap-3">
          <Stat label="Lifetime" value={formatCents(donor.lifetimeCents)} />
          <Stat label="Gifts" value={String(donor.giftCount)} />
          <Stat
            label="Last gift"
            value={
              donor.lastGiftAt
                ? new Date(donor.lastGiftAt).toLocaleDateString()
                : "—"
            }
          />
        </View>

        {donor.notes ? (
          <View className="mb-4">
            <SectionHeader title="Notes" />
            <Card>
              <Text className="text-sm text-ink">{donor.notes}</Text>
            </Card>
          </View>
        ) : null}

        <BackingSection donorId={donorId} />

        {canManage ? <RecordGiftForm donorId={donorId} /> : null}

        <SectionHeader title="Gift history" />
        {gifts.length === 0 ? (
          <EmptyState
            title="No gifts recorded"
            message="Record this donor's first gift above."
          />
        ) : (
          <View className="gap-2">
            {gifts.map((g) => (
              <GiftHistoryRow
                key={g._id}
                gift={g}
                canManage={canManage}
                onEdit={() => setEditing(g)}
              />
            ))}
          </View>
        )}
      </Narrow>

      {editing ? (
        <EditGiftSheet
          donorId={donorId}
          gift={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Screen>
  );
}

/** One gift-history row: amount, date · source, note, optional receipt
 *  thumbnails, and (for a manager) an edit affordance. */
function GiftHistoryRow({
  gift,
  canManage,
  onEdit,
}: {
  gift: GiftRow;
  canManage: boolean;
  onEdit: () => void;
}) {
  return (
    <Pressable
      onPress={canManage ? onEdit : undefined}
      disabled={!canManage}
      className={`rounded-lg border border-border bg-raised p-3 ${
        canManage ? "active:opacity-70" : ""
      }`}
    >
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-base font-semibold text-ink">
            {formatCents(gift.amountCents)}
          </Text>
          <Text className="text-xs text-muted">
            {new Date(gift.receivedAt).toLocaleDateString()} ·{" "}
            {sourceLabel(gift.method)}
            {gift.editedAt ? " · edited" : ""}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          {gift.note ? (
            <Text
              className="ml-3 max-w-[150px] text-right text-xs text-faint"
              numberOfLines={2}
            >
              {gift.note}
            </Text>
          ) : null}
          {canManage ? (
            <Icon name="edit-2" size={14} color={colors.muted} />
          ) : null}
        </View>
      </View>
      {gift.receiptUrls.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap gap-2">
          {gift.receiptUrls.map((url) => (
            <Image
              key={url}
              source={{ uri: url }}
              className="h-12 w-12 rounded-md border border-border"
              resizeMode="cover"
            />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** The donor's recurring pledges (F-6 P2), if any — the "active pledge" the
 *  donor-detail screen is meant to surface. Renders nothing when the donor has
 *  never pledged, so it stays out of the way for one-time givers. */
function BackingSection({ donorId }: { donorId: Id<"donors"> }) {
  const pledges = useQuery(api.givingPledges.getDonorPledges, { donorId });
  if (pledges === undefined || pledges.length === 0) return null;
  return (
    <View className="mb-4">
      <SectionHeader title="Backing" />
      <View className="gap-2">
        {pledges.map((p) => (
          <View
            key={p._id}
            className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3"
          >
            <View>
              <Text className="text-base font-semibold text-ink">
                {formatCents(p.amountCents)}
                <Text className="text-xs text-muted"> /mo</Text>
              </Text>
              <Text className="text-xs text-muted">
                {p.origin === "imported" ? "Givebutter (awaiting re-signup)" : "Monthly pledge"}
              </Text>
            </View>
            <Badge
              label={p.status}
              tone={
                p.status === "active"
                  ? "success"
                  : p.status === "past_due"
                    ? "warn"
                    : p.status === "canceled"
                      ? "danger"
                      : "neutral"
              }
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/** A picked receipt in progress: its uploaded storage id + a preview uri. */
type DraftReceipt = { storageId: Id<"_storage">; uri: string };

/**
 * Pick an image/file, upload it straight to Convex storage (mirrors the
 * reimbursement `RequestForm` generate-url → POST → storageId flow), and hand
 * back the storage id + a preview uri. Web uses a file input; native uses the
 * image library.
 */
async function pickAndUploadReceipt(
  getUploadUrl: () => Promise<string>,
): Promise<DraftReceipt | null> {
  if (Platform.OS === "web") {
    return await new Promise<DraftReceipt | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,application/pdf";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const url = await getUploadUrl();
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        resolve({ storageId, uri: URL.createObjectURL(file) });
      };
      input.click();
    });
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  const resp = await fetch(asset.uri);
  const blob = await resp.blob();
  const url = await getUploadUrl();
  const uploadRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": asset.mimeType || blob.type || "image/jpeg" },
    body: blob,
  });
  const { storageId } = (await uploadRes.json()) as { storageId: Id<"_storage"> };
  return { storageId, uri: asset.uri };
}

/** A thumbnail strip of picked receipts, each removable. */
function ReceiptStrip({
  receipts,
  onRemove,
}: {
  receipts: DraftReceipt[];
  onRemove: (storageId: Id<"_storage">) => void;
}) {
  if (receipts.length === 0) return null;
  return (
    <View className="mb-2 flex-row flex-wrap gap-2">
      {receipts.map((r) => (
        <View key={r.storageId} className="relative">
          <Image
            source={{ uri: r.uri }}
            className="h-14 w-14 rounded-md border border-border bg-sunken"
            resizeMode="cover"
          />
          <Pressable
            onPress={() => onRemove(r.storageId)}
            hitSlop={6}
            accessibilityLabel="Remove receipt"
            className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-danger"
          >
            <Icon name="x" size={11} color="#fff" />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** A record/attach receipt control shared by the record + edit surfaces. */
function ReceiptField({
  receipts,
  uploading,
  onAdd,
  onRemove,
}: {
  receipts: DraftReceipt[];
  uploading: boolean;
  onAdd: () => void;
  onRemove: (storageId: Id<"_storage">) => void;
}) {
  return (
    <>
      <ReceiptStrip receipts={receipts} onRemove={onRemove} />
      <Button
        title={uploading ? "Uploading…" : "Attach receipt"}
        variant="secondary"
        size="sm"
        icon="upload"
        disabled={uploading || receipts.length >= MAX_RECEIPTS}
        onPress={onAdd}
        className="mb-2 self-start"
      />
    </>
  );
}

function RecordGiftForm({ donorId }: { donorId: Id<"donors"> }) {
  const recordGift = useMutation(api.givingPlatform.recordGift);
  const generateUploadUrl = useMutation(
    api.givingPlatform.generateGiftReceiptUploadUrl,
  );
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState(DEFAULT_SOURCE);
  const [note, setNote] = useState("");
  const [receipts, setReceipts] = useState<DraftReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function addReceipt() {
    if (receipts.length >= MAX_RECEIPTS) {
      setError(`Up to ${MAX_RECEIPTS} receipts per gift.`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const picked = await pickAndUploadReceipt(() =>
        generateUploadUrl({ donorId }),
      );
      if (picked) setReceipts((rs) => [...rs, picked]);
    } catch {
      setError("Couldn't attach that receipt — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setError(null);
    const dollars = Number.parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    const amountCents = Math.round(dollars * 100);
    setSaving(true);
    try {
      await recordGift({
        donorId,
        amountCents,
        method: method as never,
        note: note.trim() || undefined,
        receiptStorageIds:
          receipts.length > 0 ? receipts.map((r) => r.storageId) : undefined,
      });
      setAmount("");
      setNote("");
      setReceipts([]);
      setMethod(DEFAULT_SOURCE);
    } catch {
      setError("Couldn't record that gift — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  const isExternal = EXTERNAL_SOURCES.has(method);
  return (
    <View className="mb-4">
      <SectionHeader title="Record a gift" />
      <Card>
        <TextField
          label="Amount (USD)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="500.00"
        />
        <Select
          label="Source"
          value={method}
          options={SOURCE_OPTIONS}
          onChange={setMethod}
        />
        <TextField
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          placeholder="Anything worth remembering about this gift…"
        />

        {isExternal ? (
          <View className="mb-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2">
            <Icon name="paperclip" size={13} color={colors.warn} />
            <Text className="flex-1 text-xs text-warn">
              This is an external gift — attach proof (a transfer screenshot or a
              receipt) so it counts cleanly toward their statement.
            </Text>
          </View>
        ) : null}

        <ReceiptField
          receipts={receipts}
          uploading={uploading}
          onAdd={() => void addReceipt()}
          onRemove={(sid) =>
            setReceipts((rs) => rs.filter((r) => r.storageId !== sid))
          }
        />

        {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
        <Button title="Record gift" onPress={submit} loading={saving} />
      </Card>
    </View>
  );
}

/**
 * The per-gift edit sheet. Amount / date / source / note are editable for a
 * manual gift; a SYSTEM-WRITTEN gift (Stripe billing cycle or event donation)
 * is note/receipt-only — its money fields are locked and the sheet says why.
 */
function EditGiftSheet({
  donorId,
  gift,
  onClose,
}: {
  donorId: Id<"donors">;
  gift: GiftRow;
  onClose: () => void;
}) {
  const editGift = useMutation(api.givingPlatform.editGift);
  const generateUploadUrl = useMutation(
    api.givingPlatform.generateGiftReceiptUploadUrl,
  );
  const locked =
    gift.donationId !== undefined || gift.stripeInvoiceId !== undefined;

  const [amount, setAmount] = useState(String(gift.amountCents / 100));
  const [receivedAt, setReceivedAt] = useState(gift.receivedAt);
  const [method, setMethod] = useState(gift.method);
  const [note, setNote] = useState(gift.note ?? "");
  // Existing receipts start as previews: their resolved display url (from
  // `getDonor`) keyed by storage id.
  const [receipts, setReceipts] = useState<DraftReceipt[]>(
    (gift.receiptStorageIds ?? []).map((sid, i) => ({
      storageId: sid,
      uri: gift.receiptUrls[i] ?? "",
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function addReceipt() {
    if (receipts.length >= MAX_RECEIPTS) {
      setError(`Up to ${MAX_RECEIPTS} receipts per gift.`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const picked = await pickAndUploadReceipt(() =>
        generateUploadUrl({ donorId }),
      );
      if (picked) setReceipts((rs) => [...rs, picked]);
    } catch {
      setError("Couldn't attach that receipt — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setError(null);
    const receiptStorageIds = receipts.map((r) => r.storageId);
    const patch: {
      giftId: Id<"gifts">;
      note?: string;
      receiptStorageIds?: Id<"_storage">[];
      amountCents?: number;
      receivedAt?: number;
      method?: string;
    } = {
      giftId: gift._id,
      note: note.trim() || undefined,
      receiptStorageIds,
    };
    if (!locked) {
      const dollars = Number.parseFloat(amount);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setError("Enter an amount greater than zero.");
        return;
      }
      patch.amountCents = Math.round(dollars * 100);
      patch.receivedAt = receivedAt;
      patch.method = method;
    }
    setSaving(true);
    try {
      await editGift(patch as never);
      onClose();
    } catch {
      setError("Couldn't save those changes — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  const isExternal = EXTERNAL_SOURCES.has(method);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[88%] rounded-t-2xl bg-surface p-4">
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-bold text-ink">Edit gift</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            {locked ? (
              <View className="mb-3 flex-row items-start gap-2 rounded-md bg-sunken px-3 py-2.5">
                <Icon name="lock" size={13} color={colors.muted} />
                <Text className="flex-1 text-xs text-muted">
                  Recorded by {gift.stripeInvoiceId ? "Stripe" : "an event"} — its
                  amount, date, and source are managed there. You can still edit
                  the note and receipts here.
                </Text>
              </View>
            ) : null}

            <TextField
              label="Amount (USD)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              editable={!locked}
            />
            {!locked ? (
              <View className="mb-3">
                <Text className="mb-1 text-xs font-medium text-muted">Date</Text>
                <DateTimeField value={receivedAt} onChange={setReceivedAt} />
              </View>
            ) : null}
            {!locked ? (
              <Select
                label="Source"
                value={method}
                options={SOURCE_OPTIONS}
                onChange={setMethod}
              />
            ) : null}
            <TextField
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="Anything worth remembering about this gift…"
            />

            {!locked && isExternal ? (
              <View className="mb-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2">
                <Icon name="paperclip" size={13} color={colors.warn} />
                <Text className="flex-1 text-xs text-warn">
                  External gift — attach proof so it counts cleanly toward their
                  statement.
                </Text>
              </View>
            ) : null}

            <ReceiptField
              receipts={receipts}
              uploading={uploading}
              onAdd={() => void addReceipt()}
              onRemove={(sid) =>
                setReceipts((rs) => rs.filter((r) => r.storageId !== sid))
              }
            />

            {error ? (
              <Text className="mb-2 text-sm text-danger">{error}</Text>
            ) : null}
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button title="Cancel" variant="secondary" onPress={onClose} />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[110px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text className="mt-1 text-lg font-bold text-ink">{value}</Text>
    </View>
  );
}
