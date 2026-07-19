/**
 * GIVING · Gifts ledger (owner request #1) — the chronological feed of every
 * gift in the book, NEWEST-FIRST: "no view where I can just see the donations
 * as they come in." This is where the giving desk lives during data cleanup.
 *
 *  - A CENTRAL holder gets a scope dropdown (All chapters / Central / each
 *    chapter). "All chapters" tags each row with its book (`listGifts` all-scopes
 *    merge). A chapter-only viewer stays locked to their own book.
 *  - A client-side search box filters the loaded rows by donor / note / book /
 *    source (server search comes later).
 *  - "Add gift" (manage) records a manual / external gift — the wires, Zelle,
 *    Cash App, on-behalf-of purchases — with a past date, a source, receipts,
 *    and (central) a book choice (owner request #3).
 *  - Tapping a row opens the detail sheet: edit (amount / date / source / note /
 *    receipts), MOVE BOOK (central-manage, owner #4a), REASSIGN DONOR (owner #2),
 *    and the AUDIT TRAIL — the "breadcrumb trail of me showing I updated this"
 *    (owner #4b). Reads are `requireGivingView`; every write is manage-gated
 *    server-side too.
 *
 * A fuller visual revamp is a follow-up PR — components here are kept clean and
 * separable on purpose.
 */
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  DateTimeField,
  EmptyState,
  FilterSelect,
  type FilterSelectOption,
  FULL_WIDTH,
  GridCell,
  GridContainer,
  GridCountLabel,
  GridHeaderRow,
  GridRow,
  Icon,
  Narrow,
  Screen,
  Select,
  SortableHeaderCell,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { useGivingScope } from "../../../lib/useGivingScope";
import { ALL_SCOPES_VALUE } from "../../../components/giving/dashboard/donorFilters";

type GivingScope = "central" | Id<"chapters">;

// ── Source vocabulary (kept in step with schema `GIFT_METHODS` by hand) ───────
const SOURCE_OPTIONS: FilterSelectOption[] = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "wire", label: "Wire" },
  { value: "zelle", label: "Zelle" },
  { value: "cash_app", label: "Cash App" },
  { value: "venmo", label: "Venmo" },
  { value: "givebutter", label: "Givebutter" },
  { value: "in_kind", label: "In-kind (on behalf of the org)" },
  { value: "stripe", label: "Chapter OS" },
  { value: "other", label: "Other" },
];
const SOURCE_LABELS: Record<string, string> = {
  stripe: "Chapter OS",
  cash: "Cash",
  check: "Check",
  wire: "Wire",
  in_kind: "In-kind",
  zelle: "Zelle",
  cash_app: "Cash App",
  venmo: "Venmo",
  givebutter: "Givebutter",
  other: "Other",
};
function sourceLabel(method: string): string {
  return SOURCE_LABELS[method] ?? method;
}
/** External sources whose gifts warrant proof (a non-blocking hint). */
const EXTERNAL_SOURCES = new Set([
  "cash",
  "zelle",
  "cash_app",
  "venmo",
  "wire",
  "in_kind",
  "other",
]);
const DEFAULT_SOURCE = "cash";
const MAX_RECEIPTS = 10;

const NUM = { fontVariant: ["tabular-nums" as const] };

// Fixed column widths (px) — the grid scrolls horizontally on narrow web
// while columns stay put, mirroring the Reconcile / Donors / Backers grids.
const COLS = {
  date: 100,
  donor: 220,
  amount: 120,
  source: 230,
  book: 140,
} as const;

type LedgerGift = {
  _id: Id<"gifts">;
  donorId: Id<"donors">;
  donorName: string;
  amountCents: number;
  receivedAt: number;
  method: string;
  note: string | null;
  scope: GivingScope;
  bookLabel: string;
  hasReceipts: boolean;
  edited: boolean;
  systemWritten: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════
export default function GiftsScreen() {
  const chapterId = useGivingScope();
  const access = useQuery(api.givingPlatform.myGivingAccess, { chapterId });

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
    <GiftsBody
      lensScope={access.scope}
      isCentral={access.isCentral}
      canManage={access.canManage}
    />
  );
}

function GiftsBody({
  lensScope,
  isCentral,
  canManage,
}: {
  lensScope: GivingScope;
  isCentral: boolean;
  canManage: boolean;
}) {
  const scopeOpts = useQuery(api.givingPlatform.givingScopeOptions, {});
  const [scopeSel, setScopeSel] = useState<string>(lensScope);
  const [search, setSearch] = useState("");
  const [openGiftId, setOpenGiftId] = useState<Id<"gifts"> | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const isAllScopes = isCentral && scopeSel === ALL_SCOPES_VALUE;
  const queryScope: GivingScope = isAllScopes
    ? "central"
    : (scopeSel as GivingScope);
  const data = useQuery(api.givingPlatform.listGifts, {
    scope: queryScope,
    allScopes: isAllScopes,
  });

  // Central holders pick a book; chapter viewers stay on their lens.
  const scopeDropdown: FilterSelectOption[] = [
    { value: ALL_SCOPES_VALUE, label: "All chapters" },
    ...(scopeOpts?.options ?? []).map((o) => ({
      value: o.scope,
      label: o.label,
    })),
  ];

  const filtered = useMemo(() => {
    const gifts = (data?.gifts ?? []) as LedgerGift[];
    const q = search.trim().toLowerCase();
    if (!q) return gifts;
    return gifts.filter((g) =>
      [g.donorName, g.note ?? "", g.bookLabel, sourceLabel(g.method)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [data, search]);

  const searching = search.trim().length > 0;
  const width = isAllScopes
    ? COLS.date + COLS.donor + COLS.amount + COLS.source + COLS.book
    : COLS.date + COLS.donor + COLS.amount + COLS.source;

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        <View className="mb-3 flex-row items-center justify-between">
          {data === undefined ? (
            <View />
          ) : searching ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {filtered.length} of {data.gifts.length}
            </Text>
          ) : (
            <GridCountLabel label="Gifts" count={data.gifts.length} />
          )}
        </View>
        <View className="mb-3 flex-row flex-wrap items-center gap-2">
          {isCentral ? (
            <FilterSelect
              label="Book"
              value={scopeSel}
              options={scopeDropdown}
              onChange={setScopeSel}
              minWidth={200}
            />
          ) : null}
          <View className="min-w-[160px] flex-1">
            <TextField
              value={search}
              onChangeText={setSearch}
              placeholder="Search donor, note, source…"
              autoCapitalize="none"
            />
          </View>
          {canManage ? (
            <Button
              title="Add gift"
              icon="plus"
              size="sm"
              onPress={() => setAddOpen(true)}
            />
          ) : null}
        </View>

        {data === undefined ? (
          <View className="items-center justify-center py-16">
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="gift"
            title={search ? "No gifts match that search" : "No gifts yet"}
            message={
              search
                ? "Try a different search term."
                : "Add a gift, or bring in history from the Import tab."
            }
          />
        ) : null}
      </Narrow>

      {data !== undefined && filtered.length > 0 ? (
        <GridContainer width={width}>
          <GridHeaderRow>
            <SortableHeaderCell label="Date" width={COLS.date} />
            <SortableHeaderCell label="Donor" width={COLS.donor} />
            <SortableHeaderCell label="Amount" width={COLS.amount} align="right" />
            <SortableHeaderCell label="Method / Source" width={COLS.source} />
            {isAllScopes ? (
              <SortableHeaderCell label="Book" width={COLS.book} />
            ) : null}
          </GridHeaderRow>
          {filtered.map((g, i) => (
            <GiftLedgerRow
              key={g._id}
              gift={g}
              showBook={isAllScopes}
              isLast={i === filtered.length - 1}
              onPress={() => setOpenGiftId(g._id)}
            />
          ))}
        </GridContainer>
      ) : null}

      {openGiftId ? (
        <GiftDetailSheet
          giftId={openGiftId}
          canManage={canManage}
          canManageCentral={scopeOpts?.canManageCentral === true}
          scopeOptions={scopeOpts?.options ?? []}
          onClose={() => setOpenGiftId(null)}
        />
      ) : null}

      {addOpen ? (
        <AddGiftSheet
          defaultScope={isAllScopes ? undefined : (scopeSel as GivingScope)}
          scopeOptions={(scopeOpts?.options ?? []).filter((o) => o.canManage)}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** One ledger row: Date · Donor · Amount · Method/Source (+ note/receipt/
 *  edited flags folded in as a subtitle line) · Book tag (all-scopes only). */
function GiftLedgerRow({
  gift,
  showBook,
  isLast,
  onPress,
}: {
  gift: LedgerGift;
  showBook: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  const flags = [
    gift.hasReceipts ? "📎" : null,
    gift.edited ? "edited" : null,
    gift.note,
  ].filter(Boolean) as string[];

  return (
    <GridRow onPress={onPress} isLast={isLast} accessibilityLabel={`Open gift from ${gift.donorName}`}>
      <GridCell width={COLS.date}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
          {new Date(gift.receivedAt).toLocaleDateString()}
        </Text>
      </GridCell>
      <GridCell width={COLS.donor}>
        <Text className="flex-1 px-2 py-1.5 text-sm font-medium text-ink" numberOfLines={1}>
          {gift.donorName}
        </Text>
      </GridCell>
      <GridCell width={COLS.amount}>
        <Text
          className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink"
          style={NUM}
        >
          {formatCents(gift.amountCents)}
        </Text>
      </GridCell>
      <GridCell width={COLS.source}>
        <View className="flex-1 px-2 py-1.5">
          <Text className="text-sm text-ink" numberOfLines={1}>
            {sourceLabel(gift.method)}
          </Text>
          {flags.length > 0 ? (
            <Text className="text-2xs text-muted" numberOfLines={1}>
              {flags.join(" · ")}
            </Text>
          ) : null}
        </View>
      </GridCell>
      {showBook ? (
        <GridCell width={COLS.book}>
          <Text className="flex-1 px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
            {gift.bookLabel}
          </Text>
        </GridCell>
      ) : null}
    </GridRow>
  );
}

// ── Receipt upload (compact; mirrors the donor-detail flow) ───────────────────
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
        const { storageId } = (await res.json()) as {
          storageId: Id<"_storage">;
        };
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
      ) : null}
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

// ── Gift detail sheet: edit · move book · reassign donor · audit trail ────────
type AuditRow = {
  _id: string;
  at: number;
  action: string;
  changes: { field: string; from?: string; to?: string }[];
  note: string | null;
  actorName: string;
};
const ACTION_LABEL: Record<string, string> = {
  created: "Created",
  edited: "Edited",
  reassignedDonor: "Reassigned donor",
  movedScope: "Moved book",
  deleted: "Removed",
  split: "Split",
  createdBySplit: "Created by split",
};

function GiftDetailSheet({
  giftId,
  canManage,
  canManageCentral,
  scopeOptions,
  onClose,
}: {
  giftId: Id<"gifts">;
  canManage: boolean;
  canManageCentral: boolean;
  scopeOptions: { scope: GivingScope; label: string; canManage: boolean }[];
  onClose: () => void;
}) {
  const data = useQuery(api.givingPlatform.getGift, { giftId });
  const [mode, setMode] = useState<
    "view" | "edit" | "move" | "reassign" | "remove" | "split"
  >("view");

  const gift = data?.gift;
  const locked = data?.systemWritten === true;
  const sheetTitle =
    mode === "view"
      ? "Gift"
      : mode === "edit"
        ? "Edit gift"
        : mode === "move"
          ? "Move book"
          : mode === "reassign"
            ? "Reassign donor"
            : mode === "split"
              ? "Split gift"
              : "Remove gift";

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[90%] rounded-t-2xl bg-surface p-4">
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-bold text-ink">{sheetTitle}</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>

          {data === undefined || !gift ? (
            <View className="items-center py-10">
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              {mode === "view" ? (
                <GiftDetailView
                  data={data}
                  canManage={canManage}
                  canManageCentral={canManageCentral}
                  onEdit={() => setMode("edit")}
                  onMove={() => setMode("move")}
                  onReassign={() => setMode("reassign")}
                  onRemove={() => setMode("remove")}
                  onSplit={() => setMode("split")}
                />
              ) : mode === "remove" ? (
                <RemoveGiftForm
                  giftId={giftId}
                  onDone={() => setMode("view")}
                  onRemoved={onClose}
                />
              ) : mode === "split" ? (
                <SplitGiftForm
                  giftId={giftId}
                  amountCents={gift.amountCents}
                  currentScope={gift.scope}
                  scopeOptions={scopeOptions}
                  onDone={() => setMode("view")}
                  onSplit={onClose}
                />
              ) : mode === "edit" ? (
                <EditGiftForm
                  giftId={giftId}
                  donorId={gift.donorId}
                  locked={locked}
                  initial={{
                    amountCents: gift.amountCents,
                    receivedAt: gift.receivedAt,
                    method: gift.method,
                    note: gift.note ?? "",
                    receiptStorageIds: gift.receiptStorageIds ?? [],
                    receiptUrls: gift.receiptUrls ?? [],
                  }}
                  onDone={() => setMode("view")}
                />
              ) : mode === "move" ? (
                <MoveBookForm
                  giftId={giftId}
                  currentScope={gift.scope}
                  scopeOptions={scopeOptions}
                  onDone={() => setMode("view")}
                />
              ) : (
                <ReassignDonorForm
                  giftId={giftId}
                  scope={gift.scope}
                  currentDonorId={gift.donorId}
                  onDone={() => setMode("view")}
                />
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function GiftDetailView({
  data,
  canManage,
  canManageCentral,
  onEdit,
  onMove,
  onReassign,
  onRemove,
  onSplit,
}: {
  data: {
    gift: {
      _id: Id<"gifts">;
      amountCents: number;
      receivedAt: number;
      method: string;
      note?: string;
      receiptUrls: string[];
    };
    donorName: string;
    bookLabel: string;
    systemWritten: boolean;
    audit: AuditRow[];
  };
  canManage: boolean;
  canManageCentral: boolean;
  onEdit: () => void;
  onMove: () => void;
  onReassign: () => void;
  onRemove: () => void;
  onSplit: () => void;
}) {
  const { gift } = data;

  return (
    <View>
      <View className="mb-3">
        <Text className="text-3xl font-bold text-ink">
          {formatCents(gift.amountCents)}
        </Text>
        <Text className="mt-1 text-sm text-muted">
          {data.donorName} · {new Date(gift.receivedAt).toLocaleDateString()} ·{" "}
          {sourceLabel(gift.method)}
        </Text>
        <View className="mt-1 flex-row items-center gap-2">
          <Badge label={data.bookLabel} tone="neutral" />
          {data.systemWritten ? (
            <Badge label="Source-managed" tone="warn" />
          ) : null}
        </View>
        {gift.note ? (
          <Text className="mt-2 text-sm text-ink">{gift.note}</Text>
        ) : null}
      </View>

      {gift.receiptUrls.length > 0 ? (
        <View className="mb-3 flex-row flex-wrap gap-2">
          {gift.receiptUrls.map((url) => (
            <Image
              key={url}
              source={{ uri: url }}
              className="h-16 w-16 rounded-md border border-border"
              resizeMode="cover"
            />
          ))}
        </View>
      ) : null}

      {canManage ? (
        <View className="mb-4 flex-row flex-wrap gap-2">
          <Button title="Edit" icon="edit-2" size="sm" variant="secondary" onPress={onEdit} />
          <Button title="Reassign donor" icon="user" size="sm" variant="secondary" onPress={onReassign} />
          {canManageCentral && !data.systemWritten ? (
            <>
              <Button title="Move book" icon="repeat" size="sm" variant="secondary" onPress={onMove} />
              <Button title="Split" icon="scissors" size="sm" variant="secondary" onPress={onSplit} />
            </>
          ) : null}
          {!data.systemWritten ? (
            <Button title="Remove" icon="trash-2" size="sm" variant="danger" onPress={onRemove} />
          ) : null}
        </View>
      ) : null}

      {/* Audit trail — the breadcrumb trail of who changed what (owner #4b). */}
      <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-faint">
        History
      </Text>
      {data.audit.length === 0 ? (
        <Text className="text-sm text-muted">No changes recorded yet.</Text>
      ) : (
        <View className="gap-2">
          {data.audit.map((a) => (
            <View
              key={a._id}
              className="rounded-lg border border-border bg-raised p-2.5"
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-semibold text-ink">
                  {ACTION_LABEL[a.action] ?? a.action}
                </Text>
                <Text className="text-2xs text-muted">
                  {new Date(a.at).toLocaleString()}
                </Text>
              </View>
              <Text className="text-xs text-muted">by {a.actorName}</Text>
              {a.changes.map((c, i) => (
                <Text key={i} className="mt-0.5 text-xs text-ink">
                  {c.field}:{" "}
                  {c.from !== undefined ? `${c.from} → ` : ""}
                  {c.to ?? "—"}
                </Text>
              ))}
              {a.note ? (
                <Text className="mt-0.5 text-xs italic text-muted">
                  “{a.note}”
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function EditGiftForm({
  giftId,
  donorId,
  locked,
  initial,
  onDone,
}: {
  giftId: Id<"gifts">;
  donorId: Id<"donors">;
  locked: boolean;
  initial: {
    amountCents: number;
    receivedAt: number;
    method: string;
    note: string;
    receiptStorageIds: Id<"_storage">[];
    receiptUrls: string[];
  };
  onDone: () => void;
}) {
  const editGift = useMutation(api.givingPlatform.editGift);
  const genUrl = useMutation(api.givingPlatform.generateGiftReceiptUploadUrl);
  const [amount, setAmount] = useState(String(initial.amountCents / 100));
  const [receivedAt, setReceivedAt] = useState(initial.receivedAt);
  const [method, setMethod] = useState(initial.method);
  const [note, setNote] = useState(initial.note);
  const [reason, setReason] = useState("");
  const [receipts, setReceipts] = useState<DraftReceipt[]>(
    initial.receiptStorageIds.map((sid, i) => ({
      storageId: sid,
      uri: initial.receiptUrls[i] ?? "",
    })),
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addReceipt() {
    setUploading(true);
    try {
      const picked = await pickAndUploadReceipt(() => genUrl({ donorId }));
      if (picked) setReceipts((rs) => [...rs, picked]);
    } catch {
      setError("Couldn't attach that receipt — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setError(null);
    const patch: Record<string, unknown> = {
      giftId,
      note: note.trim() || undefined,
      receiptStorageIds: receipts.map((r) => r.storageId),
      reason: reason.trim() || undefined,
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
      onDone();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  const isExternal = EXTERNAL_SOURCES.has(method);
  return (
    <View>
      {locked ? (
        <View className="mb-3 flex-row items-start gap-2 rounded-md bg-sunken px-3 py-2.5">
          <Icon name="lock" size={13} color={colors.muted} />
          <Text className="flex-1 text-xs text-muted">
            This gift's amount, date, and source are managed by its source. You
            can still edit the note and receipts here.
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
        <Select label="Source" value={method} options={SOURCE_OPTIONS} onChange={setMethod} />
      ) : null}
      <TextField label="Note / designation" value={note} onChangeText={setNote} placeholder="What this gift is for…" />
      {!locked && isExternal ? (
        <View className="mb-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2">
          <Icon name="paperclip" size={13} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            External gift — attach proof so it counts cleanly toward their statement.
          </Text>
        </View>
      ) : null}
      <ReceiptField
        receipts={receipts}
        uploading={uploading}
        onAdd={() => void addReceipt()}
        onRemove={(sid) => setReceipts((rs) => rs.filter((r) => r.storageId !== sid))}
      />
      <TextField label="Why (optional)" value={reason} onChangeText={setReason} placeholder="A note for the history…" />
      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        <View className="flex-1">
          <Button title="Save" onPress={save} loading={saving} />
        </View>
      </View>
    </View>
  );
}

function MoveBookForm({
  giftId,
  currentScope,
  scopeOptions,
  onDone,
}: {
  giftId: Id<"gifts">;
  currentScope: GivingScope;
  scopeOptions: { scope: GivingScope; label: string; canManage: boolean }[];
  onDone: () => void;
}) {
  const moveGift = useMutation(api.givingPlatform.moveGiftScope);
  const targets = scopeOptions.filter((o) => o.scope !== currentScope);
  const [toScope, setToScope] = useState<string>(targets[0]?.scope ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!toScope) {
      setError("Pick a destination book.");
      return;
    }
    setSaving(true);
    try {
      await moveGift({
        giftId,
        toScope: toScope as GivingScope,
        reason: reason.trim() || undefined,
      });
      onDone();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View>
      <Text className="mb-3 text-sm text-muted">
        Moving a gift to another book match-or-creates its donor there and nets
        both books' totals exactly. Recorded in this gift's history.
      </Text>
      <Select
        label="Move to"
        value={toScope}
        options={targets.map((o) => ({ value: o.scope, label: o.label }))}
        onChange={setToScope}
      />
      <TextField label="Why (optional)" value={reason} onChangeText={setReason} placeholder="A note for the history…" />
      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        <View className="flex-1">
          <Button title="Move gift" onPress={save} loading={saving} />
        </View>
      </View>
    </View>
  );
}

/**
 * Remove a gift — owner feedback #1: removing has EFFECTS (rollups reverse), so
 * the desk MAKES you say why before it's gone. The reason + a snapshot land on
 * the book's audit trail.
 */
function RemoveGiftForm({
  giftId,
  onDone,
  onRemoved,
}: {
  giftId: Id<"gifts">;
  onDone: () => void;
  onRemoved: () => void;
}) {
  const removeGift = useMutation(api.givingPlatform.removeGift);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!why.trim()) return;
    setSaving(true);
    try {
      await removeGift({ giftId, why: why.trim() });
      onRemoved();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View>
      <Text className="mb-3 text-sm text-muted">
        Removing this gift reverses the donor's and the book's totals and takes
        it off the ledger. Say why — a snapshot of the gift is kept on the record.
      </Text>
      <TextField
        label="Why are you removing it?"
        value={why}
        onChangeText={setWhy}
        placeholder="e.g. Actually a ticket-sale payout, not a gift"
        multiline
      />
      <View className="mt-2 flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        <View className="flex-1">
          <Button
            title="Remove gift"
            variant="danger"
            onPress={save}
            loading={saving}
            disabled={!why.trim()}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Split a gift into two parts across books — owner feedback #2. Keeps it simple:
 * pick each part's book and the FIRST part's amount; the second part takes the
 * remainder, so the two always sum to exactly the original. A reason is required.
 */
function SplitGiftForm({
  giftId,
  amountCents,
  currentScope,
  scopeOptions,
  onDone,
  onSplit,
}: {
  giftId: Id<"gifts">;
  amountCents: number;
  currentScope: GivingScope;
  scopeOptions: { scope: GivingScope; label: string; canManage: boolean }[];
  onDone: () => void;
  onSplit: () => void;
}) {
  const splitGift = useMutation(api.givingPlatform.splitGift);
  const books = scopeOptions.length > 0 ? scopeOptions : [];
  const [scopeA, setScopeA] = useState<string>(currentScope);
  const [scopeB, setScopeB] = useState<string>(
    books.find((o) => o.scope !== currentScope)?.scope ?? currentScope,
  );
  const [amountA, setAmountA] = useState(String(amountCents / 100 / 2));
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const centsA = Math.round((Number.parseFloat(amountA) || 0) * 100);
  const centsB = amountCents - centsA;

  async function save() {
    setError(null);
    if (!why.trim()) {
      setError("Say why you're splitting this gift.");
      return;
    }
    if (centsA <= 0 || centsB <= 0) {
      setError(
        `Each part must be more than $0 and less than ${formatCents(amountCents)}.`,
      );
      return;
    }
    setSaving(true);
    try {
      await splitGift({
        giftId,
        parts: [
          { scope: scopeA as GivingScope, amountCents: centsA },
          { scope: scopeB as GivingScope, amountCents: centsB },
        ],
        why: why.trim(),
      });
      onSplit();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  const bookOptions = books.map((o) => ({ value: o.scope, label: o.label }));

  return (
    <View>
      <Text className="mb-3 text-sm text-muted">
        Split {formatCents(amountCents)} into two parts across books. The parts
        always sum to the original — the second takes the remainder. Kept on both
        gifts' history.
      </Text>
      <Select label="Part 1 book" value={scopeA} options={bookOptions} onChange={setScopeA} />
      <TextField
        label="Part 1 amount (USD)"
        value={amountA}
        onChangeText={setAmountA}
        keyboardType="decimal-pad"
        placeholder="0.00"
      />
      <Select label="Part 2 book" value={scopeB} options={bookOptions} onChange={setScopeB} />
      <Text className="mb-2 text-sm text-muted">
        Part 2 gets the remainder: {formatCents(Math.max(0, centsB))}
      </Text>
      <TextField
        label="Why"
        value={why}
        onChangeText={setWhy}
        placeholder="e.g. Split this wire between Central and New York"
        multiline
      />
      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        <View className="flex-1">
          <Button title="Split gift" onPress={save} loading={saving} disabled={!why.trim()} />
        </View>
      </View>
    </View>
  );
}

function ReassignDonorForm({
  giftId,
  scope,
  currentDonorId,
  onDone,
}: {
  giftId: Id<"gifts">;
  scope: GivingScope;
  currentDonorId: Id<"donors">;
  onDone: () => void;
}) {
  const reassign = useMutation(api.givingPlatform.reassignGift);
  const donors = useQuery(api.givingPlatform.listDonors, { scope });
  const [search, setSearch] = useState("");
  const [toDonorId, setToDonorId] = useState<Id<"donors"> | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const list = (donors ?? []).filter((d) => d._id !== currentDonorId);
    const q = search.trim().toLowerCase();
    if (!q) return list.slice(0, 30);
    return list
      .filter((d) =>
        [d.name, d.email ?? ""].join(" ").toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [donors, search, currentDonorId]);

  async function save() {
    if (!toDonorId) {
      setError("Pick a donor to move this gift to.");
      return;
    }
    setSaving(true);
    try {
      await reassign({
        giftId,
        toDonorId,
        reason: reason.trim() || undefined,
      });
      onDone();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View>
      <Text className="mb-2 text-sm text-muted">
        Move this gift onto another donor in the same book (both donors' totals
        re-derive exactly). Recorded in the gift's history.
      </Text>
      <TextField
        value={search}
        onChangeText={setSearch}
        placeholder="Search donors…"
        autoCapitalize="none"
      />
      {donors === undefined ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <View className="mb-2 gap-1">
          {candidates.map((d) => {
            const selected = toDonorId === d._id;
            return (
              <Pressable
                key={d._id}
                onPress={() => setToDonorId(d._id)}
                className={`flex-row items-center justify-between rounded-lg border p-2.5 ${
                  selected ? "border-accent bg-brand-100" : "border-border bg-raised"
                }`}
              >
                <View className="flex-1 pr-2">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                    {d.name}
                  </Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {d.email ?? "No email"} · {formatCents(d.lifetimeCents)}
                  </Text>
                </View>
                <Icon
                  name={selected ? "check-circle" : "circle"}
                  size={16}
                  color={selected ? colors.accent : colors.faint}
                />
              </Pressable>
            );
          })}
        </View>
      )}
      <TextField label="Why (optional)" value={reason} onChangeText={setReason} placeholder="A note for the history…" />
      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        <View className="flex-1">
          <Button title="Reassign" onPress={save} loading={saving} disabled={!toDonorId} />
        </View>
      </View>
    </View>
  );
}

// ── Add gift (manual / external) ──────────────────────────────────────────────
function AddGiftSheet({
  defaultScope,
  scopeOptions,
  onClose,
}: {
  defaultScope?: GivingScope;
  scopeOptions: { scope: GivingScope; label: string; canManage: boolean }[];
  onClose: () => void;
}) {
  const addGift = useMutation(api.givingPlatform.addGift);
  const genUrlForScope = useMutation(
    api.givingPlatform.generateGiftReceiptUploadUrlForScope,
  );
  const [scope, setScope] = useState<string>(
    defaultScope ?? scopeOptions[0]?.scope ?? "",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState(DEFAULT_SOURCE);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [note, setNote] = useState("");
  const [receipts, setReceipts] = useState<DraftReceipt[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsScopePicker = scopeOptions.length > 1;

  async function addReceipt() {
    if (!scope) return;
    setUploading(true);
    try {
      const picked = await pickAndUploadReceipt(() =>
        genUrlForScope({ scope: scope as GivingScope }),
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
    if (!name.trim()) {
      setError("Enter the donor's name.");
      return;
    }
    const dollars = Number.parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setSaving(true);
    try {
      await addGift({
        scope: scope as GivingScope,
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        amountCents: Math.round(dollars * 100),
        method: method as never,
        receivedAt,
        note: note.trim() || undefined,
        receiptStorageIds:
          receipts.length > 0 ? receipts.map((r) => r.storageId) : undefined,
      });
      onClose();
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  }

  const isExternal = EXTERNAL_SOURCES.has(method);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[90%] rounded-t-2xl bg-surface p-4">
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-bold text-ink">Add gift</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            {needsScopePicker ? (
              <Select
                label="Book"
                value={scope}
                options={scopeOptions.map((o) => ({
                  value: o.scope,
                  label: o.label,
                }))}
                onChange={setScope}
              />
            ) : null}
            <TextField label="Donor name" value={name} onChangeText={setName} placeholder="Who gave" />
            <TextField label="Email (optional)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="For matching + receipts" />
            <TextField label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <TextField label="Amount (USD)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="1000.00" />
            <Select label="Source" value={method} options={SOURCE_OPTIONS} onChange={setMethod} />
            <View className="mb-3">
              <Text className="mb-1 text-xs font-medium text-muted">Date</Text>
              <DateTimeField value={receivedAt} onChange={setReceivedAt} />
            </View>
            <TextField label="Note / designation (optional)" value={note} onChangeText={setNote} placeholder="e.g. wire to the Relay account" />
            {isExternal ? (
              <View className="mb-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2">
                <Icon name="paperclip" size={13} color={colors.warn} />
                <Text className="flex-1 text-xs text-warn">
                  External gift — attach proof (a transfer screenshot or receipt).
                </Text>
              </View>
            ) : null}
            <ReceiptField
              receipts={receipts}
              uploading={uploading}
              onAdd={() => void addReceipt()}
              onRemove={(sid) => setReceipts((rs) => rs.filter((r) => r.storageId !== sid))}
            />
            {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
            <Button title="Add gift" onPress={submit} loading={saving} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
