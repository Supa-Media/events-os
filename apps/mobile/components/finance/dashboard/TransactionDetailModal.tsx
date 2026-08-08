/**
 * DASH-2.1 UI — the transaction detail/edit modal opened from a dashboard's
 * category→transactions drill-down (`TransactionList`) AND from
 * `ChapterView`'s "Recent transactions" digest. Two entry shapes, one modal:
 *
 *  - `{kind:"detail", txn, budgetName}` — the drill-down already has the full
 *    row from `api.dashboardCharts.budgetTransactions` (DASH-2.1 backend,
 *    #242): merchant/description, category (name resolved), cardholder,
 *    receipt presence, status, the REAL `isPersonal`, note. `budgetName`
 *    comes from the row the caller drilled through (that query is scoped to
 *    one budget already, so it doesn't repeat the name).
 *  - `{kind:"lookup", transactionId, fallback}` — the digest row
 *    (`ChapterDash["recentTransactions"]`) doesn't carry category id,
 *    receipt presence, or a note (see its own `recentTxnCard` validator in
 *    `finances.ts`), so this modal lazily reads `api.finances.listReconcile`
 *    (an EXISTING query, no new Convex code) and finds the matching row —
 *    same `reconcileRow` shape the Reconcile grid itself edits, so nothing
 *    here can drift from what Reconcile shows. `isPersonal` isn't in that
 *    shape either (mirrors `ReconcileList`'s own documented limitation — see
 *    its `flaggedPersonal` comment) — the Personal toggle is simply omitted
 *    for this entry path rather than guess (see "no dead disabled buttons").
 *    `fallback` (the digest row's own `codedTo` strings) fills the budget/
 *    category display the instant the modal opens, before the lookup
 *    resolves — always accurate (server-resolved for whichever chapter the
 *    digest itself belongs to, peek included), unlike anything this modal
 *    could re-derive client-side.
 *
 * EDITING reuses the EXISTING reconcile mutations — no new write path:
 *  - Category → `finances.setTransactionCategory` (the CATEGORY-ONLY editor,
 *    deliberately narrower than `categorizeTransaction` — this modal never
 *    touches fund/team/budget/amount/status through it).
 *  - Note → `finances.setTransactionNote`.
 *  - Status → `finances.setTransactionStatus`.
 *  - Receipt → `finances.attachReceipt` via the SAME `ReceiptCell` affordance
 *    `ReconcileList` uses (re-exported from there, unmodified).
 *  - Personal flag → READ-ONLY here (was `finances.flagPersonal`, a plain
 *    boolean setter that created no repayment record and emailed nobody —
 *    DELETED; see `finances.ts`'s removal note). Marking/un-marking personal
 *    now always goes through `cards.flagPersonalCharge`/`unflagPersonalCharge`
 *    (creates the repayment, resolves a real payee, schedules the email,
 *    confirms first) — a workflow this compact modal has no room to
 *    represent faithfully (no confirm step, no payee resolution UI). Rather
 *    than half-implement that here, this modal just SHOWS the live state
 *    and points the caller at the Reconcile grid — the founder's own chosen
 *    home for this action — to change it.
 *

 * PEEK (owner rule, 2026-07-17): a central caller PEEKING a chapter that
 * isn't their own home desk has reconcile writes that would fail
 * server-side (every mutation above scopes to the caller's OWN chapter via
 * `requireReconcileTxn`/`requireTxnNoteReceiptCategoryAccess`) — this modal
 * detects peek via `useChapterContext()` (the SAME source of truth
 * `ChapterView`'s own `isDrilldown` prop and `reconcile.tsx`'s
 * `viewingPeekedChapter` use) and renders every field READ-ONLY with one
 * explanatory line, rather than dead buttons that would toast a failed
 * write.
 *
 * ROLE (review fix, finding #3): peek alone doesn't cover every failing
 * write — a chapter finance VIEWER (below bookkeeper) reaches their OWN
 * chapter's dashboard (`dashboardChapter` only requires `viewer`) and can
 * drill into this modal without peeking at all, at which point every
 * mutation above would still throw (they all require `bookkeeper`+). The
 * caller passes `canRecordTransactions` (resolved server-side by
 * `dashboardCharts.spendByMonth`, which `ChapterView` already fetches for
 * its own chapter) and `readOnly` below is `peeking || !canRecordTransactions`
 * — the SAME read-only treatment either way, so a viewer sees the identical
 * "no dead disabled buttons" experience a peeking central caller does, just
 * with a role-appropriate explanatory line.
 */
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  MAX_NOTE_LENGTH,
  FINANCE_AUDIT_ACTION_LABELS,
  type BudgetRefKind,
  type TransactionFlow,
  type TransactionStatus,
} from "@events-os/shared";
import { Badge, Button, Icon, OptionTag, Popover, SelectCell, TextField, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { useChapterContext } from "../../../lib/ChapterContext";
import { SignedMoney, txnStatusTone } from "./parts";
import { STATUS_OPTIONS, shortDate } from "../reconcile/helpers";
import { ReceiptCell } from "../reconcile/ReconcileList";
import { ReceiptExceptionSection } from "../reconcile/ReceiptExceptionSection";
import { TransactionCodingSection } from "../reconcile/TransactionCodingSection";
import { ReceiptViewerModal } from "../receipts/ReceiptViewerModal";
import { ExcludeReasonModal } from "../modals/ExcludeReasonModal";
import type { DrilldownTxn } from "./TransactionList";

const TABULAR = { fontVariant: ["tabular-nums" as const] };

export type TransactionDetailSource =
  | {
      kind: "detail";
      txn: DrilldownTxn;
      budgetName: string | null;
      /** WP-wave4 (item 4 — deep links) restore: the OWNING budget row's own
       *  ref (mirrors `BudgetTableRow.refKind`/`scopeRefId`) — `null` for a
       *  recurring bucket or an unlinked one-time budget. */
      refKind: BudgetRefKind | null;
      scopeRefId: string | null;
    }
  | {
      kind: "lookup";
      transactionId: Id<"transactions">;
      /** The digest row's own already-resolved display strings — always
       *  correct for whichever chapter is being viewed (peek included),
       *  unlike anything resolvable client-side from a lookup alone. */
      fallback: {
        budgetName: string | null;
        categoryName: string | null;
        refKind: BudgetRefKind | null;
        scopeRefId: string | null;
      };
    };

// Normalized shape both entry paths reduce to — everything the body renders
// reads from this, so the two paths never fork past this point.
type Normalized = {
  id: Id<"transactions">;
  dateMs: number | null; // null only if a "lookup" row can't be found at all
  description: string | null;
  merchantName: string | null;
  amountCents: number;
  flow: TransactionFlow;
  status: TransactionStatus;
  categoryId: Id<"budgetCategories"> | null;
  categoryName: string | null;
  budgetName: string | null;
  refKind: BudgetRefKind | null;
  scopeRefId: string | null;
  personName: string | null;
  hasReceipt: boolean;
  reminderStage: "none" | "flagged" | "escalated";
  /** `null` = unknown (the "lookup" path's source query doesn't carry this
   *  field) — the Personal toggle is omitted in that case, not guessed. */
  isPersonal: boolean | null;
  note: string | null;
};

export function TransactionDetailModal({
  source,
  onClose,
  canRecordTransactions,
}: {
  source: TransactionDetailSource;
  onClose: () => void;
  /** Review fix (finding #3): the caller's OWN resolved write capability for
   *  this chapter (bookkeeper+) — see this file's own module doc's "ROLE"
   *  section. Combined with `peeking` below to gate every edit control. */
  canRecordTransactions: boolean;
}) {
  const { context } = useChapterContext();
  const peeking = context?.kind === "peek";
  // Mirrors `reconcile.tsx`'s own `peekedChapterId` derivation — a SEPARATE
  // `context?.kind === "peek"` check (not `peeking` above) so TS narrows
  // `context` to the peek variant right here.
  const peekedChapterId = context?.kind === "peek" ? context.chapterId : undefined;
  // Review fix (finding #3): read-only for EITHER reason — peeking a chapter
  // that isn't the caller's own, OR a below-bookkeeper role on their own
  // chapter. Same treatment either way (see module doc).
  const readOnly = peeking || !canRecordTransactions;

  // Only fires for the "lookup" entry (the digest row) — an EXISTING query
  // (the Reconcile grid's own data source), peek-aware via `chapterId` the
  // same way `reconcile.tsx` itself reads it while peeking.
  const reconcile = useQuery(
    api.finances.listReconcile,
    source.kind === "lookup" ? { filter: "all", chapterId: peekedChapterId } : "skip",
  );

  // Category picker options — only fetched when editing is actually possible
  // (never while read-only — peeking, or a below-bookkeeper role — so this is
  // always the correct chapter's categories AND never wasted on a viewer who
  // can't use them).
  const categories = useQuery(api.finances.listCategories, readOnly ? "skip" : {}) ?? [];

  const normalized: Normalized | "loading" | "not_found" =
    source.kind === "detail"
      ? {
          id: source.txn.id,
          dateMs: source.txn.date,
          description: source.txn.description,
          merchantName: source.txn.merchantName,
          amountCents: source.txn.amountCents,
          flow: source.txn.flow,
          status: source.txn.status,
          categoryId: source.txn.categoryId,
          categoryName: source.txn.categoryName,
          budgetName: source.budgetName,
          refKind: source.refKind,
          scopeRefId: source.scopeRefId,
          personName: source.txn.personName,
          hasReceipt: source.txn.hasReceipt,
          reminderStage: "none", // not carried by `budgetTransactions` — see module doc
          isPersonal: source.txn.isPersonal,
          note: source.txn.note,
        }
      : reconcile === undefined
        ? "loading"
        : (() => {
            const row = reconcile.rows.find((r) => r.id === source.transactionId);
            if (!row) return "not_found";
            return {
              id: row.id,
              dateMs: row.postedAt,
              description: row.description,
              merchantName: row.merchantName,
              amountCents: row.amountCents,
              flow: row.flow,
              status: row.status,
              categoryId: row.categoryId,
              categoryName: source.fallback.categoryName,
              budgetName: source.fallback.budgetName,
              refKind: source.fallback.refKind,
              scopeRefId: source.fallback.scopeRefId,
              personName: row.cardholder?.name ?? null,
              hasReceipt: row.hasReceipt,
              reminderStage: row.reminderStage,
              isPersonal: null, // not in `reconcileRow` — see module doc
              note: row.note,
            } satisfies Normalized;
          })();

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-start justify-between border-b border-border px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="font-display text-lg text-ink" numberOfLines={1}>
                {normalized === "loading" || normalized === "not_found"
                  ? "Transaction"
                  : (normalized.merchantName ?? normalized.description ?? "Transaction")}
              </Text>
              {normalized !== "loading" && normalized !== "not_found" ? (
                <Text className="mt-0.5 text-xs text-muted">
                  {normalized.dateMs != null ? shortDate(normalized.dateMs) : null}
                </Text>
              ) : null}
            </View>
            {normalized !== "loading" && normalized !== "not_found" ? (
              <SignedMoney
                cents={normalized.amountCents}
                flow={normalized.flow}
                className="mr-2 text-base font-semibold"
              />
            ) : null}
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px] px-5 py-4">
            {normalized === "loading" ? (
              <Text className="py-6 text-center text-sm text-muted">Loading…</Text>
            ) : normalized === "not_found" ? (
              <Text className="py-6 text-center text-sm text-muted">
                Couldn't load this transaction's details.
              </Text>
            ) : (
              <TransactionDetailBody
                txn={normalized}
                categories={categories}
                readOnly={readOnly}
                readOnlyReason={peeking ? "peek" : "role"}
                peeking={peeking}
              />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function TransactionDetailBody({
  txn,
  categories,
  readOnly,
  readOnlyReason,
  peeking,
}: {
  txn: Normalized;
  categories: { id: Id<"budgetCategories">; name: string }[];
  readOnly: boolean;
  /** Which read-only banner to show — see `TransactionDetailModal`'s module
   *  doc's "ROLE" section (review fix, finding #3). Ignored when `readOnly`
   *  is false. */
  readOnlyReason: "peek" | "role";
  /** WP-wave4 (item 4 — deep links) restore: whether the caller is peeking a
   *  chapter that isn't their own — same rule `ChapterView.onOpenRef` uses to
   *  hide the row-level link, applied here to the "Part of" link too (the
   *  linked event/project belongs to the PEEKED chapter, not the caller's
   *  own, and `/event/[id]`/`/project/[id]` are hard-scoped server-side to
   *  the caller's own chapter). */
  peeking: boolean;
}) {
  const router = useRouter();
  const setCategory = useMutation(api.finances.setTransactionCategory);
  const setNote = useMutation(api.finances.setTransactionNote);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);

  // LOCAL OPTIMISTIC OVERRIDES: `txn` (the "detail" path) is a plain snapshot
  // passed in once when the modal opened, NOT a live query result — a
  // reactive dashboard update elsewhere doesn't re-flow into it. Without
  // this, editing a field here would correctly write through (the dashboard
  // behind the modal updates live) but this MODAL would keep showing the
  // pre-edit value until closed and reopened. Seeded from `txn`, reset only
  // when a DIFFERENT transaction is opened (`txn.id` changes), and updated
  // locally the instant each mutation is fired (matching `ReconcileRow`'s own
  // `flaggedPersonal` local-tracking precedent for the same class of gap).
  const [categoryId, setCategoryIdState] = useState(txn.categoryId);
  const [categoryName, setCategoryNameState] = useState(txn.categoryName);
  const [status, setStatusState] = useState(txn.status);
  const [hasReceipt, setHasReceiptState] = useState(txn.hasReceipt);
  const [isPersonal, setIsPersonalState] = useState(txn.isPersonal);
  const [noteValue, setNoteValue] = useState(txn.note ?? "");
  const [savedNote, setSavedNote] = useState(txn.note ?? "");
  // Read-only (peek / below-bookkeeper role) still allows VIEWING receipts —
  // only the mutating actions inside the viewer are hidden (`readOnly` below).
  const [readOnlyViewerOpen, setReadOnlyViewerOpen] = useState(false);
  // Reason prompt (server-enforced, `finances.setTransactionStatus`) — see
  // `ExcludeReasonModal`'s own doc comment; mirrors the Reconcile grid's own
  // `excludePromptOpen` gate exactly.
  const [excludePromptOpen, setExcludePromptOpen] = useState(false);
  useEffect(() => {
    setCategoryIdState(txn.categoryId);
    setCategoryNameState(txn.categoryName);
    setStatusState(txn.status);
    setHasReceiptState(txn.hasReceipt);
    setIsPersonalState(txn.isPersonal);
    setNoteValue(txn.note ?? "");
    setSavedNote(txn.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn.id]);

  const [savingNote, setSavingNote] = useState(false);
  const noteDirty = noteValue !== savedNote;

  // Review fix (finding #4): EVERY optimistic setter below mirrors this same
  // shape — set the optimistic value immediately (instant feedback), fire the
  // mutation, and on rejection REVERT to the pre-edit value + toast. Before
  // this fix only Note followed this discipline (it never applied its
  // optimistic value until the write actually succeeded); the other four
  // fields (`guard`'s old fire-and-forget shape) left the modal showing the
  // value the server just refused — including `attachReceipt`, whose old
  // `await guard(...); setHasReceiptState(true)` shape set "Attached" even
  // when the upload/attach mutation FAILED (`guard` swallows the rejection,
  // so the unconditional `setHasReceiptState(true)` after it always ran).
  async function editCategory(newCategoryId: Id<"budgetCategories"> | null) {
    const prevId = categoryId;
    const prevName = categoryName;
    setCategoryIdState(newCategoryId);
    setCategoryNameState(
      newCategoryId ? (categories.find((c) => c.id === newCategoryId)?.name ?? null) : null,
    );
    try {
      await setCategory({ transactionId: txn.id, categoryId: newCategoryId });
    } catch (err) {
      setCategoryIdState(prevId);
      setCategoryNameState(prevName);
      alertError(err);
    }
  }

  async function editStatus(next: TransactionStatus, reason?: string) {
    const prev = status;
    setStatusState(next);
    try {
      await setStatus({ transactionId: txn.id, status: next, reason });
    } catch (err) {
      setStatusState(prev);
      alertError(err);
    }
  }

  async function editReceipt(storageId: Id<"_storage">) {
    const prev = hasReceipt;
    setHasReceiptState(true);
    try {
      await attachReceipt({ transactionId: txn.id, storageId });
    } catch (err) {
      setHasReceiptState(prev);
      alertError(err);
    }
  }

  async function saveNote() {
    setSavingNote(true);
    try {
      const trimmed = noteValue.trim() ? noteValue : null;
      await setNote({ transactionId: txn.id, note: trimmed });
      setSavedNote(trimmed ?? "");
    } catch (err) {
      alertError(err);
    } finally {
      setSavingNote(false);
    }
  }

  const tone = txnStatusTone(status);

  return (
    <View className="gap-4">
      {readOnly ? (
        <View className="flex-row items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2">
          <Icon name="lock" size={13} color={colors.muted} />
          <Text className="flex-1 text-2xs text-muted">
            {readOnlyReason === "peek"
              ? "Editing happens in this chapter's own Reconcile."
              : "Viewing only — recording requires the Treasurer/bookkeeper role."}
          </Text>
        </View>
      ) : null}

      <Row label="Cardholder" value={txn.personName ?? "—"} />
      {/* WP-wave4 (item 4 — deep links) restore: a "Part of: <name> ›" link
          when the txn's budget is event/project-linked — hidden while
          peeking (see this component's own `peeking` prop doc). Falls back
          to the plain, non-interactive row otherwise (unlinked, or a
          recurring-budget-coded txn). */}
      {txn.refKind && txn.scopeRefId && !peeking ? (
        <View>
          <FieldLabel label="Budget" />
          <Pressable
            onPress={() => router.push(`/${txn.refKind}/${txn.scopeRefId}` as never)}
            accessibilityRole="button"
            className="flex-row items-center gap-1 self-start active:opacity-70 web:hover:opacity-90"
          >
            <Text className="text-sm font-medium text-accent" numberOfLines={1}>
              Part of: {txn.budgetName ?? "—"}
            </Text>
            <Icon name="chevron-right" size={13} color={colors.accent} />
          </Pressable>
        </View>
      ) : (
        <Row label="Budget" value={txn.budgetName ?? "—"} />
      )}

      {/* Category */}
      <View>
        <FieldLabel label="Category" />
        {readOnly ? (
          <Text className="text-sm text-ink">{categoryName ?? "Uncategorized"}</Text>
        ) : (
          <CategoryPicker
            value={categoryId}
            label={categoryName}
            categories={categories}
            onChange={(newCategoryId) => {
              void editCategory(newCategoryId);
            }}
          />
        )}
      </View>

      {/* Status. Picking "Excluded" opens the required reason prompt instead
          of committing right away — see `ExcludeReasonModal`'s own doc
          comment (mirrors the Reconcile grid's identical gate). */}
      <View>
        <FieldLabel label="Status" />
        {readOnly ? (
          <Badge label={tone.label} tone={tone.tone} />
        ) : (
          <View style={{ alignSelf: "flex-start" }}>
            <SelectCell
              value={status}
              options={STATUS_OPTIONS}
              onChange={(v) => {
                if (v === "excluded") {
                  setExcludePromptOpen(true);
                  return;
                }
                void editStatus(v);
              }}
            />
          </View>
        )}
      </View>
      {excludePromptOpen ? (
        <ExcludeReasonModal
          onCancel={() => setExcludePromptOpen(false)}
          onConfirm={(reason) => {
            setExcludePromptOpen(false);
            void editStatus("excluded", reason);
          }}
        />
      ) : null}

      {/* Receipt — read-only (peek / below-bookkeeper) still lets a caller
          VIEW the receipt(s); only the viewer's mutating actions are hidden
          (`readOnly` passed through), so this is never a dead disabled
          button, just a narrower one. */}
      <View>
        <FieldLabel label="Receipt" />
        {readOnly ? (
          hasReceipt ? (
            <>
              <Pressable
                onPress={() => setReadOnlyViewerOpen(true)}
                accessibilityRole="button"
                className="self-start active:opacity-70 web:hover:opacity-90"
              >
                <Text className="text-sm font-medium text-ink underline">Attached</Text>
              </Pressable>
              {readOnlyViewerOpen ? (
                <ReceiptViewerModal
                  transactionId={txn.id}
                  onClose={() => setReadOnlyViewerOpen(false)}
                  readOnly
                />
              ) : null}
            </>
          ) : (
            <Text className="text-sm text-ink">Not attached</Text>
          )
        ) : (
          <ReceiptCell
            hasReceipt={hasReceipt}
            reminderStage={txn.reminderStage}
            transactionId={txn.id}
            onUpload={async (storageId) => {
              await editReceipt(storageId);
            }}
            generateUploadUrl={generateUploadUrl}
          />
        )}
      </View>

      {/* Receipt exception — the documentation of record when no receipt can
          be produced. Renders nothing once a receipt is attached (a receipt
          outranks an exception) or for a caller who may not even file one.
          See `docs/plans/receipt-exceptions.md`. */}
      <ReceiptExceptionSection
        transactionId={txn.id}
        amountCents={txn.amountCents}
        hasReceipt={hasReceipt}
        readOnly={readOnly}
        onError={alertError}
      />

      {/* Coding — the structured what/why/who substantiation record, with
          its own review loop. Spend posted at/after the policy date
          (2026-09-01) can't be reconciled without an approved one. See
          `docs/plans/transaction-coding.md`. */}
      <TransactionCodingSection
        transactionId={txn.id}
        merchantLine={[
          txn.merchantName ?? txn.description ?? "Charge",
          txn.dateMs != null ? shortDate(txn.dateMs) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        amountCents={txn.amountCents}
        readOnly={readOnly}
        onError={alertError}
      />

      {/* Personal charge — READ-ONLY (see the module doc comment for why
          editing it doesn't live here): only shown when the source query
          actually carries the real value, omitted rather than shown in a
          possibly-wrong default state. Mark/un-mark from the Reconcile
          grid. */}
      {isPersonal != null ? (
        <View>
          <FieldLabel label="Personal charge" />
          <Text className="text-sm text-ink">{isPersonal ? "Yes" : "No"}</Text>
          {!readOnly && isPersonal != null ? (
            <Text className="mt-1 text-xs text-muted">
              Mark or un-mark from the Reconcile grid.
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Note */}
      <View>
        <FieldLabel label="Note" />
        {readOnly ? (
          <Text className="text-sm text-ink">{savedNote || "—"}</Text>
        ) : (
          <View className="gap-2">
            <TextField
              value={noteValue}
              onChangeText={setNoteValue}
              placeholder="Who was this for, and why?"
              multiline
              numberOfLines={3}
              maxLength={MAX_NOTE_LENGTH}
            />
            {noteDirty ? (
              <View className="flex-row justify-end gap-2">
                <Button
                  title="Cancel"
                  size="sm"
                  variant="secondary"
                  onPress={() => setNoteValue(savedNote)}
                />
                <Button title="Save note" size="sm" onPress={saveNote} loading={savingNote} />
              </View>
            ) : null}
          </View>
        )}
      </View>

      {/* History — the `financeAuditLog` trail (actor · when · what changed),
          collapsed by default so it never competes with the fields above.
          Read-only for everyone who can view this modal (peek included) —
          the query itself is bookkeeper+ gated server-side, so a below-
          bookkeeper viewer simply sees an empty/loading list rather than a
          FORBIDDEN error surfacing here. */}
      <TransactionHistorySection transactionId={txn.id} />
    </View>
  );
}

/**
 * Compact, collapsed-by-default "History" section reading
 * `finances.financeAuditTrail` for this one transaction — actor, when, and
 * what changed (before → after, plus a reason when one was given). Query is
 * `"skip"`ped until expanded so a caller who never opens it never pays for
 * the read. Bookkeeper+ / scope gated server-side (see that query's own doc
 * comment) — a caller below that bar just sees an empty list, never an error,
 * matching this modal's existing "no dead disabled buttons" philosophy.
 */
function TransactionHistorySection({ transactionId }: { transactionId: Id<"transactions"> }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useQuery(
    api.finances.financeAuditTrail,
    expanded ? { subjectType: "transaction", subjectId: transactionId } : "skip",
  );

  return (
    <View className="border-t border-border pt-3">
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        className="flex-row items-center gap-1 self-start active:opacity-70 web:hover:opacity-90"
      >
        <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">History</Text>
      </Pressable>
      {expanded ? (
        rows === undefined ? (
          <Text className="mt-2 text-xs text-muted">Loading…</Text>
        ) : rows.length === 0 ? (
          <Text className="mt-2 text-xs text-muted">No changes recorded yet.</Text>
        ) : (
          <View className="mt-2 gap-2.5">
            {rows.map((r) => (
              <View key={r.id} className="border-l-2 border-border pl-2">
                <Text className="text-xs font-medium text-ink">
                  {FINANCE_AUDIT_ACTION_LABELS[r.action]}
                  {r.field ? ` — ${r.field}` : ""}
                </Text>
                {r.before != null || r.after != null ? (
                  <Text className="text-xs text-muted" numberOfLines={2}>
                    {r.before ?? "—"} → {r.after ?? "—"}
                  </Text>
                ) : null}
                {r.reason ? (
                  <Text className="text-xs text-muted" numberOfLines={3}>
                    Reason: {r.reason}
                  </Text>
                ) : null}
                <Text className="text-2xs text-faint">
                  {r.actorName ?? "Unknown"} · {shortDate(r.createdAt)}
                </Text>
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <FieldLabel label={label} />
      <Text className="text-sm text-ink" style={TABULAR} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function FieldLabel({ label }: { label: string }) {
  return (
    <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">{label}</Text>
  );
}

// ── Category picker — a compact Popover, mirrors `ReconcileList`'s
// (un-exported) `PickerCell` but sized for a modal field rather than a grid
// cell. ───────────────────────────────────────────────────────────────────
function CategoryPicker({
  value,
  label,
  categories,
  onChange,
}: {
  value: Id<"budgetCategories"> | null;
  label: string | null;
  categories: { id: Id<"budgetCategories">; name: string }[];
  onChange: (categoryId: Id<"budgetCategories"> | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        className="self-start active:opacity-70 web:hover:opacity-90"
      >
        {value ? (
          <OptionTag label={label ?? "Categorized"} />
        ) : (
          <Text className="text-sm text-faint">Uncategorized</Text>
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          <Pressable
            onPress={() => {
              onChange(null);
              close();
            }}
            className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
          >
            <Text className="text-sm text-muted">None</Text>
            {value == null ? <Icon name="check" size={15} color={colors.accent} /> : null}
          </Pressable>
          {categories.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => {
                onChange(c.id);
                close();
              }}
              className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <OptionTag label={c.name} />
              {c.id === value ? <Icon name="check" size={15} color={colors.accent} /> : null}
            </Pressable>
          ))}
        </View>
      </Popover>
    </>
  );
}
