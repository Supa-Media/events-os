/**
 * GIVING · Dashboard — the development desk's home. Reads the caller's giving
 * lens (`myGivingAccess`: central or their chapter) and renders the scope's
 * totals from `givingDashboard` (denormalized rollups): lifetime, last-30-days,
 * donor count, lapsed (reactivation) count, plus the top donors by lifetime.
 *
 * Sub-nav tabs + app chrome come from the giving `_layout`; this screen renders
 * only the Dashboard body. The real gate is the backend `requireGivingView`;
 * this screen degrades to a friendly "access needed" state if the caller lacks
 * the desk.
 *
 * Territories P7 (bank-credit gift matching): a manager also sees "Possible
 * gifts" — recent bank credits (`candidateExternalGifts`) that look like
 * external giving, each confirmable into a real gift or dismissable. Least
 * intrusive placement: below the existing dashboard cards, and it renders
 * nothing at all when there's nothing to review or the caller can't manage.
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
import { useRouter } from "expo-router";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  Select,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

type GivingScope = "central" | Id<"chapters">;

export default function GivingDashboardScreen() {
  const access = useQuery(api.givingPlatform.myGivingAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView || access.scope === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Development desk access needed"
            message="Ask a development director to grant you access to the giving desk."
          />
        </Narrow>
      </Screen>
    );
  }
  return (
    <DashboardBody
      scope={access.scope}
      lensLabel={access.scope === "central" ? "Central" : access.chapterName ?? "Chapter"}
      canManage={access.canManage}
    />
  );
}

function DashboardBody({
  scope,
  lensLabel,
  canManage,
}: {
  scope: GivingScope;
  lensLabel: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const data = useQuery(api.givingPlatform.givingDashboard, { scope });

  if (data === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        <Text className="mb-3 text-sm font-semibold text-muted">
          {lensLabel} · Development
        </Text>

        <View className="mb-4 flex-row flex-wrap gap-3">
          <Stat label="Lifetime giving" value={formatCents(data.lifetimeCents)} />
          <Stat label="Last 30 days" value={formatCents(data.last30Cents)} />
          <Stat label="Donors" value={String(data.donorCount)} />
          <Stat
            label="Lapsed"
            value={String(data.lapsedCount)}
            tone={data.lapsedCount > 0 ? "warn" : "neutral"}
          />
        </View>

        <SectionHeader title="Top donors" />
        {data.topDonors.length === 0 ? (
          <EmptyState
            title="No donors yet"
            message="Record a gift or bring in history from the Import tab to get started."
          />
        ) : (
          <View className="gap-2">
            {data.topDonors.map((d) => (
              <Pressable
                key={d._id}
                onPress={() => router.navigate(`/giving/donor/${d._id}` as never)}
              >
                <Card>
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text className="text-xs text-muted">
                        {d.giftCount} {d.giftCount === 1 ? "gift" : "gifts"} · {d.status}
                      </Text>
                    </View>
                    <Text className="text-base font-semibold text-ink">
                      {formatCents(d.lifetimeCents)}
                    </Text>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        {canManage ? <PossibleGiftsSection scope={scope} /> : null}
      </Narrow>
    </Screen>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <View className="min-w-[140px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text
        className={`mt-1 text-xl font-bold ${tone === "warn" ? "text-warn" : "text-ink"}`}
      >
        {value}
      </Text>
    </View>
  );
}

// ── Possible gifts (Territories P7: bank-credit ↔ gift matching) ────────────

/** A candidate row as returned by `candidateExternalGifts`. */
type CandidateRow = {
  transactionId: Id<"transactions">;
  postedAt: number;
  amountCents: number;
  description: string | null;
  merchantName: string | null;
  source: string;
  accountLabel: string | null;
};

/** The confirm form's source picker — zelle/wire lead (the two rails a direct
 *  bank credit actually arrives on), the rest match the donor-detail "Source"
 *  picker's external options. */
const EXTERNAL_GIFT_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "zelle", label: "Zelle" },
  { value: "wire", label: "Wire" },
  { value: "venmo", label: "Venmo" },
  { value: "givebutter", label: "Givebutter" },
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "other", label: "Other" },
];
const DEFAULT_EXTERNAL_GIFT_SOURCE = "zelle";

/**
 * "Possible gifts" — recent bank credits that look like external giving
 * (`candidateExternalGifts`). Renders nothing while loading or once the list
 * is empty, so a scope with nothing to review never shows an empty card.
 * Confirm opens a small sheet (pick an existing donor or create one, source,
 * note, optional receipt); Dismiss removes the row from future lists.
 */
function PossibleGiftsSection({ scope }: { scope: GivingScope }) {
  const candidates = useQuery(api.givingCandidates.candidateExternalGifts, {
    scope,
  });
  const dismissCandidate = useMutation(api.givingCandidates.dismissGiftCandidate);
  const [confirming, setConfirming] = useState<CandidateRow | null>(null);
  const [dismissingId, setDismissingId] = useState<Id<"transactions"> | null>(
    null,
  );

  if (candidates === undefined || candidates.length === 0) return null;

  async function handleDismiss(transactionId: Id<"transactions">) {
    setDismissingId(transactionId);
    try {
      await dismissCandidate({ transactionId });
    } finally {
      setDismissingId(null);
    }
  }

  return (
    <View className="mb-4">
      <SectionHeader title="Possible gifts" count={candidates.length} />
      <Text className="mb-2 -mt-2 text-xs text-muted">
        Bank credits that look like giving — confirm each into a gift, or
        dismiss it.
      </Text>
      <View className="gap-2">
        {candidates.map((c) => (
          <Card key={c.transactionId}>
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="text-base font-semibold text-ink">
                  {formatCents(c.amountCents)}
                </Text>
                <Text className="text-xs text-muted">
                  {new Date(c.postedAt).toLocaleDateString()}
                  {c.accountLabel ? ` · ${c.accountLabel}` : ""}
                </Text>
                {c.merchantName || c.description ? (
                  <Text className="mt-1 text-xs text-faint" numberOfLines={2}>
                    {c.merchantName ?? c.description}
                  </Text>
                ) : null}
              </View>
              <View className="items-end gap-2">
                <Button title="Confirm" size="sm" onPress={() => setConfirming(c)} />
                <Button
                  title="Dismiss"
                  size="sm"
                  variant="secondary"
                  loading={dismissingId === c.transactionId}
                  onPress={() => void handleDismiss(c.transactionId)}
                />
              </View>
            </View>
          </Card>
        ))}
      </View>

      {confirming ? (
        <ConfirmGiftSheet
          scope={scope}
          candidate={confirming}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </View>
  );
}

/** A picked receipt in progress — mirrors the donor-detail record-gift form's
 *  upload flow (`generateGiftReceiptUploadUrl` is donor-scoped, so the confirm
 *  sheet requests it once a donor is chosen). */
type DraftReceipt = { storageId: Id<"_storage">; uri: string };

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

/**
 * The Confirm sheet: pick an existing donor (search-filtered from the scope's
 * donor list) or create a new one by name (+ optional email), then a source /
 * note / receipt, mirroring the donor-detail record-gift form. Posts
 * `confirmExternalGift` with the transaction id — amount/date always come from
 * the transaction server-side, never this form.
 */
function ConfirmGiftSheet({
  scope,
  candidate,
  onClose,
}: {
  scope: GivingScope;
  candidate: CandidateRow;
  onClose: () => void;
}) {
  const donors = useQuery(api.givingPlatform.listDonors, { scope });
  const confirmExternalGift = useMutation(api.givingCandidates.confirmExternalGift);
  const generateUploadUrl = useMutation(
    api.givingPlatform.generateGiftReceiptUploadUrl,
  );

  const [search, setSearch] = useState("");
  const [selectedDonorId, setSelectedDonorId] = useState<Id<"donors"> | null>(
    null,
  );
  const [newDonorName, setNewDonorName] = useState("");
  const [newDonorEmail, setNewDonorEmail] = useState("");
  const [method, setMethod] = useState(DEFAULT_EXTERNAL_GIFT_SOURCE);
  const [note, setNote] = useState("");
  const [receipts, setReceipts] = useState<DraftReceipt[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const filteredDonors = (donors ?? []).filter(
    (d) => !q || d.name.toLowerCase().includes(q) || d.email?.toLowerCase().includes(q),
  );
  const selectedDonor = (donors ?? []).find((d) => d._id === selectedDonorId);
  const creatingNew = !selectedDonorId && search.trim().length > 0 &&
    !filteredDonors.some((d) => d.name.trim().toLowerCase() === q);

  async function addReceipt() {
    if (!selectedDonorId) return; // the upload url is donor-scoped
    setError(null);
    setUploading(true);
    try {
      const picked = await pickAndUploadReceipt(() =>
        generateUploadUrl({ donorId: selectedDonorId }),
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
    if (!selectedDonorId && !newDonorName.trim()) {
      setError("Pick an existing donor or enter a name for a new one.");
      return;
    }
    setSaving(true);
    try {
      await confirmExternalGift({
        transactionId: candidate.transactionId,
        donorId: selectedDonorId ?? undefined,
        newDonor: selectedDonorId
          ? undefined
          : { name: newDonorName.trim(), email: newDonorEmail.trim() || undefined },
        method: method as never,
        note: note.trim() || undefined,
        receiptStorageIds:
          receipts.length > 0 ? receipts.map((r) => r.storageId) : undefined,
      });
      onClose();
    } catch {
      setError("Couldn't confirm that gift — it may have already been handled.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[88%] rounded-t-2xl bg-surface p-4">
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-bold text-ink">Confirm gift</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            <View className="mb-3 rounded-md bg-sunken px-3 py-2.5">
              <Text className="text-sm font-semibold text-ink">
                {formatCents(candidate.amountCents)}
              </Text>
              <Text className="text-xs text-muted">
                {new Date(candidate.postedAt).toLocaleDateString()}
                {candidate.merchantName ? ` · ${candidate.merchantName}` : ""}
              </Text>
            </View>

            <TextField
              label="Donor"
              value={selectedDonor ? selectedDonor.name : search}
              onChangeText={(v) => {
                setSelectedDonorId(null);
                setSearch(v);
              }}
              placeholder="Search donors, or type a new name…"
              editable={!selectedDonorId}
            />
            {selectedDonor ? (
              <Pressable
                onPress={() => {
                  setSelectedDonorId(null);
                  setSearch("");
                }}
                className="mb-3 -mt-2 self-start"
              >
                <Text className="text-xs text-accent">Change donor</Text>
              </Pressable>
            ) : q.length > 0 ? (
              <View className="mb-3 max-h-40 overflow-hidden rounded-md border border-border">
                <ScrollView>
                  {filteredDonors.map((d) => (
                    <Pressable
                      key={d._id}
                      onPress={() => {
                        setSelectedDonorId(d._id);
                        setSearch("");
                      }}
                      className="border-b border-border bg-raised px-3 py-2.5 active:bg-sunken"
                    >
                      <Text className="text-sm text-ink">{d.name}</Text>
                      {d.email ? (
                        <Text className="text-xs text-muted">{d.email}</Text>
                      ) : null}
                    </Pressable>
                  ))}
                  {creatingNew ? (
                    <View className="px-3 py-2.5">
                      <Text className="text-xs text-muted">
                        No match — will create “{search.trim()}” as a new donor.
                      </Text>
                    </View>
                  ) : null}
                </ScrollView>
              </View>
            ) : null}

            {creatingNew ? (
              <TextField
                label="New donor's email (optional)"
                value={newDonorEmail}
                onChangeText={setNewDonorEmail}
                placeholder="donor@example.com"
                autoCapitalize="none"
                keyboardType="email-address"
              />
            ) : null}

            <Select
              label="Source"
              value={method}
              options={EXTERNAL_GIFT_SOURCE_OPTIONS}
              onChange={setMethod}
            />
            <TextField
              label="Note (optional)"
              value={note}
              onChangeText={setNote}
              placeholder="Anything worth remembering about this gift…"
            />

            {selectedDonorId ? (
              <>
                {receipts.length > 0 ? (
                  <View className="mb-2 flex-row flex-wrap gap-2">
                    {receipts.map((r) => (
                      <View key={r.storageId} className="relative">
                        <Image
                          source={{ uri: r.uri }}
                          className="h-14 w-14 rounded-md border border-border bg-sunken"
                          resizeMode="cover"
                        />
                        <Pressable
                          onPress={() =>
                            setReceipts((rs) =>
                              rs.filter((x) => x.storageId !== r.storageId),
                            )
                          }
                          hitSlop={6}
                          accessibilityLabel="Remove receipt"
                          className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-danger"
                        >
                          <Icon name="x" size={11} color="#fff" />
                        </Pressable>
                      </View>
                    ))}
                  </View>
                ) : null}
                <Button
                  title={uploading ? "Uploading…" : "Attach receipt"}
                  variant="secondary"
                  size="sm"
                  icon="upload"
                  disabled={uploading}
                  onPress={() => void addReceipt()}
                  className="mb-2 self-start"
                />
              </>
            ) : null}

            {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button title="Cancel" variant="secondary" onPress={onClose} />
              </View>
              <View className="flex-1">
                <Button title="Confirm gift" onPress={submit} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
