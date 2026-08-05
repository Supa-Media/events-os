/**
 * RECONCILE GRID — the inline-editable spreadsheet the bookkeeper codes charges
 * in, built on the shared EditableTable primitives (the `people.tsx` pattern):
 * `DEFAULT_COLS` widths (user-adjustable + locally remembered on web via
 * `useResizableColumns`), a `GridHeaderCell` header row, and per-row
 * `Cell`-wrapped cells that each commit ONE field via its own mutation.
 *
 * Columns: [☐] Merchant · Date · Amount · Cardholder · Category▾ · For▾ ·
 * Suggested · Receipt · Status▾ · Actions. Category / For / Status edit
 * inline (dropdowns, commit per row); Suggested shows the AI auto-coding
 * proposal (when present + unreviewed) with an Accept action; Receipt shows
 * ✓ or an inline upload; Amount is read-only (signed). The fund is hidden —
 * the backend defaults it to the General Fund on categorize.
 *
 * Suggested / on-demand "Suggest": most unreviewed charges already carry a
 * proposal by the time the bookkeeper opens this grid — new transactions get
 * one within seconds of arriving (the on-ingest sweep, see
 * `aiCodingData.scheduleSuggestionOnIngest`), not just on the old hourly
 * cron. A still-`isSuggestible` row (`helpers.ts#isSuggestible` — unreviewed,
 * OR categorized but still needing a budget; PR fix-suggest-broaden) that
 * STILL has none (the on-ingest/hourly sweep's batch cap was exceeded,
 * OPENROUTER_API_KEY was unset when it landed, or a prior attempt failed and
 * is still cooling down) shows a "Suggest" button instead of the AI badge —
 * tapping it runs the exact same model-call core (`aiCoding.suggestCoding`)
 * for just that one transaction, on demand (`SuggestCell` below). Either path
 * lands in the same Accept/reject UI. A "Categorized" row whose "For" cell
 * still reads "Needs budget" is the majority of the backlog this covers — the
 * button used to only ever render on an unreviewed row, leaving that whole
 * bucket stuck at a bare "—" with no way to trigger a suggestion.
 *
 * The "For" column (WP-U: one home per dollar) replaces the old separate
 * Budget + Link columns/pickers with ONE picker, grouped Events / Projects /
 * Recurring — see `forPicker.ts`. WP-wave4 (item 5, owner addendum
 * 2026-07-17): only a ref with an APPROVED budget is ever offered
 * (`isAttributableBudget`, filtered server-side by both `forPickerOptions`
 * and `reconcileSuggest.rankForPicker`), so a picked value is always a real
 * `budgetId` already — `categorizeTransaction` accepts a `budgetId` only,
 * never a separate event/project link, and the old "summon a $0 budget on
 * pick" flow is retired.
 *
 * Actions (R1): a note icon (filled when set, tap → `TransactionNoteModal`)
 * and, for a finance MANAGER or the charge's own PAYER, a "Mark personal"
 * flag — `cards.flagPersonalCharge` (#147), confirmed first
 * (`MarkPersonalModal`, mirrors `ExcludeReasonModal`'s confirm-before-commit
 * pattern) since marking schedules a real repayment email. A flagged-but-
 * unpaid charge also offers "Un-mark" (`cards.unflagPersonalCharge`, same
 * confirm step) for a mis-flag — gone once the repayment settles (the server
 * refuses to un-flag a paid one). The flag's state is REAL (R1b follow-up):
 * `listReconcile` rows carry `isPersonal` + the linked repayment's live
 * `repaymentStatus`, so the badge reads "Personal" (awaiting repayment) or
 * "Repaid" straight from the payload — no session-local "what did I just
 * flag" state, so a reload or a flag made elsewhere always shows correctly.
 *
 * PAYEE (generalized past card-only): the flag button shows whenever
 * `row.cardholder` resolves — a card's cardholder OR a transaction with its
 * own `personId` directly attributed — mirroring `flagPersonalCharge`'s own
 * server-side payee resolution (`personId`, else the card's cardholder)
 * exactly, so this button's visibility never promises an action the backend
 * would then reject with `PAYEE_REQUIRED`.
 *
 * NO-PAYEE ROWS (founder feedback: "in reconcile I can't mark everything as
 * personal, some things it won't let me, the flag just doesn't exist"): a
 * bank/ACH entry, a Relay CSV row whose last-4 was never linked to a person,
 * or a hand-entered transaction resolves NOBODY — so the button used to be
 * absent with no explanation, and the row simply couldn't be flagged. A
 * MANAGER now gets the flag on those rows too; tapping it asks who owes it
 * (`PersonPicker`) before the usual confirm, and `flagPersonalCharge`'s
 * `payerPersonId` arg records that person as the charge's payer. Non-managers
 * still don't see it — naming someone else's debt is a manager's call, and
 * the server enforces the same split.
 *
 * OWN-CHARGE FLAG (founder feedback review): `cards.flagPersonalCharge`
 * already allows the PAYER, not just a manager, to flag their own charge
 * server-side — but this grid used to only ever offer the button to
 * `isManager`, so a bookkeeper-only payer (full Reconcile access, no manager
 * rank) reconciling their OWN charge had no way to flag it here (their only
 * path was the separate "My transactions" screen). The button also shows
 * when `row.cardholder?.personId === viewerPersonId` — the caller's OWN
 * roster person, resolved once by `listReconcile` — so "manager flags
 * anyone" and "payer flags themselves" are both covered, exactly mirroring
 * the server's own OR-gate. Server authz stays the source of truth either way.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Platform, ScrollView, TextInput } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import {
  Avatar,
  Badge,
  Button,
  Icon,
  OptionTag,
  PersonPicker,
  Popover,
  SelectCell,
  GridHeaderCell,
  useAnchor,
  useResizableColumns,
} from "../../ui";
import { CENTRAL, PAYOUT_PROCESSOR_LABELS } from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { TransactionNoteModal } from "../modals/TransactionNoteModal";
import { ExcludeReasonModal } from "../modals/ExcludeReasonModal";
import { MarkPersonalModal } from "../modals/MarkPersonalModal";
import { ReceiptViewerModal } from "../receipts/ReceiptViewerModal";
import { ReceiptAttachPicker } from "../receipts/ReceiptAttachPicker";
import {
  STATUS_OPTIONS,
  isSuggestible,
  signedMoney,
  shortDate,
  type TxnRow,
} from "./helpers";
import { buildRankedForPickerItems, type RankForPickerResult } from "./forPicker";

const NUM = { fontVariant: ["tabular-nums" as const] };
// Server-side search debounce (owner addendum) — a round trip per keystroke
// is wasteful; this mirrors `LocationAutocomplete`'s own debounce window.
const SEARCH_DEBOUNCE_MS = 200;

/** An option in the Category / For pickers; `header` rows are non-selectable.
 *  A "For" value is either a real `budgetId`, or a `summon:<refKind>:<id>`
 *  summon-candidate — see `forPicker.ts`. `reason` (ranked "For" rows only)
 *  renders as a small sublabel — "2 transactions nearby in June", etc. */
export type PickerItem = { value: string; label: string; header?: boolean; reason?: string };

// Default column widths (px) — the grid scrolls horizontally on narrow web
// while columns stay put, mirroring the People roster grid. These are only
// the DEFAULTS: `useResizableColumns` (web only) lets a bookkeeper drag any
// column but `check` wider/narrower, and remembers the result per-browser.
const DEFAULT_COLS = {
  check: 40,
  // Which BOOK the charge belongs to (Central / a chapter). Rendered when the
  // page chrome alone can't answer it: the merged all-books queue, and a view
  // into a chapter that isn't the caller's own desk. In an ordinary
  // single-book view the books selector and the header's `ScopeBadge` already
  // say so, and a column repeating it on every row would be noise. See
  // `finances.ts#reconcileBook`.
  book: 108,
  merchant: 210,
  date: 118, // fits "Mar 15, 2026" — year added for multi-year history

  amount: 104,
  cardholder: 168,
  category: 168,
  forCol: 200,
  suggested: 220,
  // Founder feedback (2026-07-24): 96px clipped BOTH the "Upload" label+icon
  // AND the "attach existing" search-icon affordance next to it — too tight
  // to comfortably click either. The table already scrolls horizontally, so
  // there's no shared budget to steal from another column for this.
  receipt: 140,
  status: 148,
  // Wide enough for the note icon PLUS the "Personal" badge (its widest
  // combination — the note icon + the manager-only flag icon is narrower).
  // 76px clipped/overlapped the badge's text.
  actions: 112,
} as const;
type ColKey = keyof typeof DEFAULT_COLS;
type ColWidths = Record<ColKey, number>;
const RECONCILE_COLUMNS_STORAGE_KEY = "reconcile-grid-columns";

export function ReconcileList({
  rows,
  categoryItems,
  forItems,
  selected,
  onToggle,
  onToggleAll,
  centralScope = false,
  showBook = false,
  ownChapterId = null,
  centralForItems,
  isManager = false,
  viewerPersonId = null,
}: {
  rows: TxnRow[];
  categoryItems: PickerItem[];
  forItems: PickerItem[];
  /** The "For" options valid for a CENTRAL-book row (central budgets only).
   *  Only meaningful in the merged all-books queue, where central and chapter
   *  rows share one grid: a central charge can't attribute to an event,
   *  project, or chapter budget — the backend rejects it — so its picker has
   *  to offer a different list than the chapter row directly above it. In a
   *  single-book scope every row is the same kind and `forItems` already is
   *  that list. */
  centralForItems?: PickerItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  /** The caller's OWN chapter, or null. Decides whether a CROSS-BOOK row's
   *  Category cell is editable: the categories this grid loads are the
   *  caller's chapter's, so a charge absorbed by a different chapter can't be
   *  categorized from here (the server enforces the same rule against the
   *  BUDGET's chapter — see `requireCategoryForCentralTxn`). */
  ownChapterId?: Id<"chapters"> | null;
  /** Render the Book column — true when "whose money is this?" stops being
   *  answerable from the page chrome alone: the merged all-books queue (rows
   *  from different books sit next to each other), or a view into a chapter
   *  that isn't the caller's own desk (the chrome names their desk, not the
   *  book on screen). */
  showBook?: boolean;
  // WP-2.1: reconciling CENTRAL-owned txns. Central money carries no
  // chapter-scoped links (funds/categories/projects/events are chapter-only), so
  // the Category column is hidden — central coding is For + Status.
  centralScope?: boolean;
  // R1b: the caller's finance-MANAGER rank (not just any finance seat) — gates
  // the "Mark personal" row action, which mirrors `cards.flagPersonalCharge`'s
  // own server-side manager-or-cardholder authz.
  isManager?: boolean;
  // Founder feedback review: the caller's OWN roster person id
  // (`listReconcile`'s `viewerPersonId`) — widens "Mark personal" to a
  // cardholder's OWN row, mirroring the server's cardholder-or-manager gate.
  viewerPersonId?: Id<"people"> | null;
}) {
  // "Select all" only ever means the rows this caller can actually act on —
  // an uneditable row (a foreign chapter's, in the merged queue) has no
  // checkbox at all, so including it here would leave the header box unable to
  // ever read as checked.
  const selectableRows = rows.filter((r) => r.book.canEdit);
  const allSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));
  // Founder feedback (2026-07-24): column widths are user-adjustable (drag
  // the header edge, web only) and remembered per-browser — `widths` starts
  // from `DEFAULT_COLS` and is overridden by whatever was last saved.
  const { widths, startResize } = useResizableColumns<ColKey>(
    RECONCILE_COLUMNS_STORAGE_KEY,
    DEFAULT_COLS,
  );
  // The Category column is chapter-only, so single-central scope normally drops
  // it — but a CROSS-BOOK row in that scope is absorbed by a chapter's budget
  // and DOES take that chapter's category, so hiding the column there would put
  // the one control that spend needs on a screen it isn't on. Data-driven: the
  // column appears in central scope exactly when there's something in it.
  const anyCrossBook = rows.some(
    (r) => r.chargedTo != null && r.chargedTo.id !== r.book.id,
  );
  const showCategory = !centralScope || anyCrossBook;
  const tableWidth = (Object.values(widths) as number[]).reduce((sum, w) => sum + w, 0);
  // Drop the width of any column this scope doesn't render so the grid doesn't
  // leave dead space: Category when it isn't shown, and the Book column outside
  // the merged all-books queue.
  const width =
    tableWidth -
    (showCategory ? 0 : widths.category) -
    (showBook ? 0 : widths.book);

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(width, 320) }}>
          {/* Column header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            <View
              style={{ width: widths.check }}
              className="items-center justify-center py-2.5"
            >
              <CheckBox checked={allSelected} onPress={onToggleAll} />
            </View>
            {showBook ? (
              <GridHeaderCell
                label="Book"
                width={widths.book}
                onResizeStart={startResize("book")}
              />
            ) : null}
            <GridHeaderCell
              label="Merchant"
              width={widths.merchant}
              onResizeStart={startResize("merchant")}
            />
            <GridHeaderCell label="Date" width={widths.date} onResizeStart={startResize("date")} />
            <GridHeaderCell
              label="Amount"
              width={widths.amount}
              onResizeStart={startResize("amount")}
            />
            <GridHeaderCell
              label="Cardholder"
              width={widths.cardholder}
              onResizeStart={startResize("cardholder")}
            />
            {showCategory ? (
              <GridHeaderCell
                label="Category"
                width={widths.category}
                onResizeStart={startResize("category")}
              />
            ) : null}
            <GridHeaderCell label="For" width={widths.forCol} onResizeStart={startResize("forCol")} />
            <GridHeaderCell
              label="Suggested"
              width={widths.suggested}
              onResizeStart={startResize("suggested")}
            />
            <GridHeaderCell
              label="Receipt"
              width={widths.receipt}
              onResizeStart={startResize("receipt")}
            />
            <GridHeaderCell
              label="Status"
              width={widths.status}
              onResizeStart={startResize("status")}
            />
            <View style={{ width: widths.actions }} />
          </View>

          {/* Body */}
          {rows.map((row, i) => (
            <ReconcileRow
              key={row.id}
              row={row}
              categoryItems={categoryItems}
              forItems={forItems}
              selected={selected.has(row.id)}
              onToggle={() => onToggle(row.id)}
              isLast={i === rows.length - 1}
              centralScope={centralScope}
              showBook={showBook}
              showCategory={showCategory}
              ownChapterId={ownChapterId}
              centralForItems={centralForItems}
              isManager={isManager}
              viewerPersonId={viewerPersonId}
              widths={widths}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function ReconcileRow({
  row,
  categoryItems,
  forItems,
  selected,
  onToggle,
  isLast,
  centralScope,
  showBook,
  showCategory,
  ownChapterId,
  centralForItems,
  isManager,
  viewerPersonId,
  widths,
}: {
  row: TxnRow;
  categoryItems: PickerItem[];
  forItems: PickerItem[];
  selected: boolean;
  onToggle: () => void;
  isLast: boolean;
  centralScope: boolean;
  showBook: boolean;
  showCategory: boolean;
  ownChapterId: Id<"chapters"> | null;
  centralForItems?: PickerItem[];
  isManager: boolean;
  viewerPersonId: Id<"people"> | null;
  widths: ColWidths;
}) {
  const categorize = useMutation(api.finances.categorizeTransaction);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const acceptSuggestion = useMutation(api.aiCodingData.acceptSuggestion);
  const recordCodingOverride = useMutation(api.aiCodingData.recordCodingOverride);
  const flagPersonalCharge = useMutation(api.cards.flagPersonalCharge);
  const unflagPersonalCharge = useMutation(api.cards.unflagPersonalCharge);
  // Un-marking only. MARKING a transfer needs two rows, so it lives in the
  // bulk bar (`BulkBar`) where a two-row selection exists; a row action there
  // would have no way to name the other leg. Un-marking is per-row because a
  // bookkeeper undoes it from whichever leg they're looking at — the mutation
  // finds the pair through `transferGroupId` and restores both.
  const unmarkTransfer = useMutation(api.finances.unmarkTransfer);
  const unmarkPayout = useMutation(api.finances.unmarkPayout);
  const id = row.id as Id<"transactions">;
  // Server-resolved writability for THIS row's book (mirrors
  // `requireReconcileTxn` — see `finances.ts#reconcileBook`). Drives the
  // read-only rendering below rather than being re-derived client-side, so
  // the grid and the mutations can't drift apart on who may edit what.
  const readOnly = !row.book.canEdit;
  // Is THIS row central-owned? In a single-book scope the answer is uniform
  // (`centralScope` covers it), but the merged all-books queue interleaves
  // central and chapter rows — and they don't accept the same coding. So the
  // "For" picker offers that row's own valid options rather than offering
  // options the backend would reject, which is the same "affordance that can't
  // work" this whole change set is about removing.
  const isCentralRow = row.book.id === CENTRAL;
  // One book paid, a different book's budget absorbed it — see the For cell's
  // CROSS-BOOK FLAG comment. `chargedTo` is null while the row is unattributed,
  // which is most of the review queue, so this is false for those by
  // construction rather than by a separate check.
  const isCrossBook = row.chargedTo != null && row.chargedTo.id !== row.book.id;
  // CATEGORY on a central-book row: normally none (categories are
  // chapter-scoped), EXCEPT on a cross-book charge absorbed by the caller's own
  // chapter — that spend lands on their budget card, and if it isn't
  // categorized here it can never be, since the row lives in central's book and
  // the chapter's treasurer can't write it (`requireCategoryForCentralTxn`).
  // Scoped to the caller's OWN chapter because `categoryItems` is their
  // chapter's list; a charge absorbed by some OTHER chapter would need that
  // chapter's categories, which this screen doesn't load.
  const canCategorizeCrossBook =
    isCentralRow &&
    isCrossBook &&
    ownChapterId != null &&
    row.chargedTo?.id === ownChapterId;
  // Only CENTRAL rows are ever inert here, exactly as before — a chapter row
  // (including a read-only peeked one, whose whole body is already
  // non-interactive) still renders its real category rather than a bare dash.
  const hideCategory = centralScope || (isCentralRow && !canCategorizeCrossBook);
  const rowForItems = isCentralRow && centralForItems ? centralForItems : forItems;

  // Fire-and-surface: run a cell mutation, alerting the server's reason on error.
  const guard = (p: Promise<unknown>) => p.catch((err) => alertError(err));

  // Founder feedback review: "is this MY charge" — the cardholder's OWN half
  // of `cards.flagPersonalCharge`'s server-side OR-gate (cardholder OR
  // manager). `viewerPersonId` is `null` for a superuser with no roster row,
  // which correctly never matches a real cardholder here.
  const isOwnCharge =
    viewerPersonId != null && row.cardholder?.personId === viewerPersonId;

  const [noteModalOpen, setNoteModalOpen] = useState(false);
  // Reason prompt (server-enforced, `finances.setTransactionStatus`) — set
  // ONLY while the picker is asking for a reason; `guard(setStatus(...))`
  // never fires until the bookkeeper confirms one.
  const [excludePromptOpen, setExcludePromptOpen] = useState(false);
  // "Mark personal" / "Un-mark" prompt — marking schedules a real email to
  // the payer, so it never fires straight off a tap (mirrors
  // `excludePromptOpen` above / `ExcludeReasonModal`'s own doc comment).
  const [personalPromptMode, setPersonalPromptMode] = useState<
    "mark" | "unmark" | null
  >(null);
  const [personalPromptBusy, setPersonalPromptBusy] = useState(false);
  // No-payee rows only (see the file header): who the manager said owes this
  // charge. The picker runs BEFORE the confirm prompt — two sequential modals
  // rather than a picker nested inside the confirm — and `namedPayee` is what
  // the confirm then names back to them and what `flagPersonalCharge`
  // attributes the charge to. Cleared whenever either step is dismissed.
  const [payeePickerOpen, setPayeePickerOpen] = useState(false);
  const [namedPayee, setNamedPayee] = useState<{
    id: Id<"people">;
    name: string;
  } | null>(null);
  // Accept feels TERMINAL: the moment a suggestion is accepted we show a brief
  // "Accepted" state in the Suggested cell instead of letting an
  // still-`isSuggestible` row (accepted the category but still needs a budget)
  // immediately re-render a fresh "Suggest" button — testers misread that
  // re-appearing button as "the suggestion didn't clear". Session-local (per
  // row); a reload starts fresh.
  const [justAccepted, setJustAccepted] = useState(false);

  async function handleAccept() {
    try {
      await acceptSuggestion({ transactionId: id });
      setJustAccepted(true);
    } catch (err) {
      alertError(err);
    }
  }

  // Measurement (precision): when a human hand-codes a Category / For value that
  // DIFFERS from a live suggestion's proposal for that dimension, log it as an
  // override BEFORE `categorize` clears the suggestion server-side. Best-effort
  // — a measurement write must never block or fail the actual coding edit.
  async function recordOverrideIfConflicting(
    dimension: "category" | "budget",
    chosen: string | null,
  ) {
    const ai = row.aiSuggestion;
    if (!ai) return;
    const suggested = dimension === "category" ? ai.categoryId : ai.budgetId;
    if (suggested == null) return; // the model didn't propose this dimension
    if (chosen === suggested) return; // agreement, not an override
    try {
      await recordCodingOverride({
        transactionId: id,
        dimension,
        ...(dimension === "category"
          ? { chosenCategoryId: chosen as Id<"budgetCategories"> | null }
          : { chosenBudgetId: chosen as Id<"budgets"> | null }),
      });
    } catch {
      // swallow — never let measurement interfere with the coding edit
    }
  }

  async function confirmPersonalPrompt() {
    setPersonalPromptBusy(true);
    try {
      // No local flagged state needed: `listReconcile`'s live subscription
      // re-renders this row with `isPersonal`/`repaymentStatus` set the
      // moment either mutation commits.
      if (personalPromptMode === "mark") {
        // `payerPersonId` only travels for a row that resolves no payee of its
        // own — the server ignores it otherwise (it will never re-attribute a
        // real cardholder's charge to someone else).
        await flagPersonalCharge({
          transactionId: id,
          ...(namedPayee ? { payerPersonId: namedPayee.id } : {}),
        });
      } else if (personalPromptMode === "unmark") {
        await unflagPersonalCharge({ transactionId: id });
      }
      setPersonalPromptMode(null);
      setNamedPayee(null);
    } catch (err) {
      alertError(err);
    } finally {
      setPersonalPromptBusy(false);
    }
  }

  /** Tapping the flag: a row with a resolvable payee goes straight to the
   *  confirm; one without asks a manager who owes it first. */
  function startMarkPersonal() {
    if (row.cardholder == null) {
      setPayeePickerOpen(true);
      return;
    }
    setPersonalPromptMode("mark");
  }

  // The "For" picker's value is just `budgetId` (WP-U: one home per dollar) —
  // always a real, APPROVED budget already (item 5) — no summon/resolution
  // step needed.
  async function onForChange(value: string | null) {
    await recordOverrideIfConflicting("budget", value);
    guard(
      categorize({
        transactionId: id,
        budgetId: value ? (value as Id<"budgets">) : null,
      }),
    );
  }

  return (
    <View
      className={`flex-row items-stretch border-b border-border ${
        selected ? "bg-accent-soft" : "bg-raised"
      } ${isLast ? "border-b-0" : ""}`}
    >
      {/* Select checkbox — replaced by a lock for a row this caller can't
          write. `book.canEdit` is server-resolved and mirrors
          `requireReconcileTxn` exactly (see `finances.ts#reconcileBook`), so
          this is the same boundary the mutations enforce, not a guess. A
          foreign chapter's rows in the merged queue (and a peeked chapter's)
          land here: previously the grid offered every inline edit on them and
          let the write fail with a toast. */}
      <View
        style={{ width: widths.check }}
        className="items-center justify-center border-r border-border/60"
      >
        {readOnly ? (
          <Icon name="lock" size={12} color={colors.faint} />
        ) : (
          <CheckBox checked={selected} onPress={onToggle} />
        )}
      </View>

      {/* Book — merged all-books queue only. */}
      {showBook ? (
        <Cell width={widths.book}>
          <View className="flex-1 px-2 py-1.5">
            <Badge
              label={row.book.name}
              tone={row.book.id === CENTRAL ? "info" : "success"}
            />
          </View>
        </Cell>
      ) : null}

      {/* Everything from here on is the editable body. Wrapping it in one
          non-interactive container is deliberate: a read-only row must not
          expose a SINGLE working affordance, and per-cell `disabled` props
          would be six independent chances to miss one as this grid grows. */}
      <View
        className="flex-1 flex-row items-stretch"
        pointerEvents={readOnly ? "none" : "auto"}
        style={readOnly ? { opacity: 0.55 } : undefined}
      >

      {/* Merchant (read-only) */}
      <Cell width={widths.merchant}>
        <Text
          className="flex-1 px-2 py-1.5 text-sm font-medium text-ink"
          numberOfLines={1}
        >
          {row.merchantName ?? row.description ?? "Unlabeled charge"}
        </Text>
      </Cell>

      {/* Date (read-only) */}
      <Cell width={widths.date}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
          {shortDate(row.postedAt)}
        </Text>
      </Cell>

      {/* Amount (read-only, signed) */}
      <Cell width={widths.amount}>
        <Text
          className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink"
          style={NUM}
        >
          {signedMoney(row.amountCents, row.flow)}
        </Text>
      </Cell>

      {/* Cardholder (read-only) */}
      <Cell width={widths.cardholder}>
        {row.cardholder ? (
          <View className="flex-1 flex-row items-center gap-2 px-2 py-1.5">
            <Avatar
              name={row.cardholder.name || "?"}
              size={22}
              uri={row.cardholder.imageUrl}
            />
            <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
              {row.cardholder.name}
            </Text>
          </View>
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
        )}
      </Cell>

      {/* Category (inline dropdown) — chapter-only; central txns have none.
          The COLUMN is present whenever any chapter row could be in view; an
          individual central row renders an inert dash in it (see
          `hideCategory`) so the grid stays aligned without offering a picker
          that can't commit. */}
      {showCategory ? (
        hideCategory ? (
          <Cell width={widths.category}>
            <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
          </Cell>
        ) : (
        <Cell width={widths.category}>
          <PickerCell
            value={row.categoryId}
            items={categoryItems}
            placeholder="Uncategorized"
            onChange={async (value) => {
              await recordOverrideIfConflicting("category", value);
              guard(
                categorize({
                  transactionId: id,
                  categoryId: value as Id<"budgetCategories"> | null,
                }),
              );
            }}
          />
        </Cell>
        )
      ) : null}

      {/* For (inline dropdown; grouped Events / Projects / Recurring — WP-U:
          one picker, one home per dollar. A CENTRAL row is offered central's
          own budgets PLUS the chapter's, under a "central is fronting this"
          heading — a central card really does buy things for a chapter's
          programme, and the backend admits it (`requireBudgetForCentralTxn`).
          RANKED per-row (nearby spend → similar merchant → upcoming date →
          everything else, budget-less demoted) via `reconcileSuggest.
          rankForPicker` — see `ForPickerCell`.

          CROSS-BOOK FLAG: when the budget picked belongs to a DIFFERENT book
          than the one that paid, the row says so right here. That gap is a
          receivable — `transfers.interScopeBalances` nets it into a settlement
          — and it used to be visible only on the central dashboard's balances
          panel, i.e. nowhere near the moment a treasurer creates it. */}
      <Cell width={widths.forCol}>
        <View className="flex-1 gap-0.5">
          <ForPickerCell
            value={row.budgetId}
            transactionId={id}
            baseItems={rowForItems}
            placeholder={row.needsBudget ? "Needs budget" : "None"}
            warn={row.needsBudget}
            onChange={onForChange}
          />
          {isCrossBook ? (
            <View className="flex-row items-center gap-1 px-2 pb-1">
              <Icon name="corner-down-right" size={11} color={colors.warn} />
              <Text className="text-2xs text-warn" numberOfLines={1}>
                {row.book.name} paid · {row.chargedTo?.name} owes
              </Text>
            </View>
          ) : null}
        </View>
      </Cell>

      {/* Suggested — AI auto-coding proposal + Accept when the model has
          already proposed something for this (still-unreviewed) row; a
          still-unreviewed row with NO suggestion yet offers an on-demand
          "Suggest" button instead (`SuggestCell`) rather than a bare dash —
          most new charges are suggested within seconds on arrival, but the
          batch cap / a cooling-down failed attempt / a stale charge that
          predates the feature can still leave one without one. */}
      <Cell width={widths.suggested}>
        {row.aiSuggestion ? (
          <View className="flex-1 gap-1 px-2 py-1.5">
            <Badge
              label={`AI: ${[row.aiSuggestion.categoryName, row.aiSuggestion.budgetName]
                .filter(Boolean)
                .join(" · ")}`}
              tone="lavender"
              icon="sparkles"
            />
            <Button
              title="Accept"
              size="sm"
              variant="secondary"
              onPress={handleAccept}
            />
          </View>
        ) : justAccepted ? (
          // Terminal state: the suggestion was just accepted this session. Show
          // it as done rather than immediately re-offering "Suggest" on a row
          // that still `isSuggestible` (accepted the category, still needs a
          // budget) — which testers read as the suggestion not clearing.
          <View className="flex-1 flex-row items-center gap-1 px-2 py-1.5">
            <Icon name="check-circle" size={15} color={colors.success} />
            <Text className="text-sm font-medium text-success">Accepted</Text>
          </View>
        ) : isSuggestible(row) ? (
          <View className="flex-1 px-2 py-1.5">
            <SuggestCell transactionId={id} />
          </View>
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
        )}
      </Cell>

      {/* Receipt (✓ or inline upload, escalating with the reminder timeline) */}
      <Cell width={widths.receipt}>
        <ReceiptCell
          hasReceipt={row.hasReceipt}
          reminderStage={row.reminderStage}
          transactionId={id}
          onUpload={async (storageId) => {
            await guard(attachReceipt({ transactionId: id, storageId }));
          }}
          generateUploadUrl={generateUploadUrl}
        />
      </Cell>

      {/* Status (inline dropdown). Picking "Excluded" opens the required
          reason prompt instead of committing right away — the mutation
          itself throws `REASON_REQUIRED` without one (see
          `ExcludeReasonModal`'s own doc comment); every other transition
          commits immediately, unchanged. */}
      <Cell width={widths.status}>
        <SelectCell
          value={row.status}
          options={STATUS_OPTIONS}
          onChange={(v) => {
            if (v === "excluded") {
              setExcludePromptOpen(true);
              return;
            }
            guard(setStatus({ transactionId: id, status: v }));
          }}
        />
      </Cell>
      {excludePromptOpen ? (
        <ExcludeReasonModal
          onCancel={() => setExcludePromptOpen(false)}
          onConfirm={(reason) => {
            setExcludePromptOpen(false);
            guard(setStatus({ transactionId: id, status: "excluded", reason }));
          }}
        />
      ) : null}

      {/* Actions (R1): note (icon fills in when set) + "Mark personal" on a
          charge with a resolvable payee (`row.cardholder` — a card's
          cardholder OR a directly-attributed person, mirrors
          `cards.flagPersonalCharge`'s own payee resolution) that isn't
          already personal, shown for a MANAGER (any charge) OR the PAYER on
          their OWN charge (`isOwnCharge` — founder feedback review, mirrors
          `cards.flagPersonalCharge`'s server-side payer-or-manager gate). A
          flagged charge shows its REAL repayment state ("Personal" until
          repaid, then "Repaid") from the row payload, plus an "Un-mark"
          affordance while it's still unpaid (mis-flag correction —
          `cards.unflagPersonalCharge` refuses once it's settled). Both
          transitions confirm first (`MarkPersonalModal`, mirrors
          `ExcludeReasonModal`) — marking schedules a real email, so neither
          fires off a stray tap. */}
      <Cell width={widths.actions}>
        <View className="flex-1 flex-row items-center justify-center gap-2 px-1">
          <Pressable
            onPress={() => setNoteModalOpen(true)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={row.note ? "Edit note" : "Add note"}
            className="rounded p-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon
              name="message-square"
              size={15}
              color={row.note ? colors.accent : colors.faint}
            />
          </Pressable>
          {/* Marking badges. Both carry an un-mark affordance for a mis-pick,
              bookkeeper+ only (`isManager` here is the grid's existing
              write-rank flag) — the server gates it again regardless. A
              transfer un-marks BOTH legs; a payout has none to pair with. */}
          {row.isMarkedTransfer ? (
            <View className="flex-row items-center gap-1.5">
              <Badge label="Transfer" tone="neutral" />
              {isManager ? (
                <Pressable
                  onPress={() => guard(unmarkTransfer({ transactionId: id }))}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Un-mark internal transfer (both legs)"
                  className="rounded p-1 active:opacity-70 web:hover:opacity-90"
                >
                  <Icon name="x-circle" size={14} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
          ) : row.payoutProcessor ? (
            <View className="flex-row items-center gap-1.5">
              <Badge
                label={PAYOUT_PROCESSOR_LABELS[row.payoutProcessor]}
                tone="success"
              />
              {isManager ? (
                <Pressable
                  onPress={() => guard(unmarkPayout({ transactionId: id }))}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Un-mark processor payout"
                  className="rounded p-1 active:opacity-70 web:hover:opacity-90"
                >
                  <Icon name="x-circle" size={14} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {row.isPersonal ? (
            <View className="flex-row items-center gap-1.5">
              {row.repaymentStatus === "paid" ? (
                <Badge label="Repaid" tone="success" />
              ) : (
                <>
                  <Badge label="Personal" tone="accent" />
                  {isManager || isOwnCharge ? (
                    <Pressable
                      onPress={() => setPersonalPromptMode("unmark")}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Un-mark personal"
                      className="rounded p-1 active:opacity-70 web:hover:opacity-90"
                    >
                      <Icon name="x-circle" size={14} color={colors.muted} />
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : /* A resolvable payee → manager or the payer themselves. No payee
                at all → a manager only, who names who owes it (see the file
                header's NO-PAYEE ROWS note). */
          row.cardholder != null ? (
            (isManager || isOwnCharge) && (
              <Pressable
                onPress={startMarkPersonal}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Mark personal"
                className="rounded p-1 active:opacity-70 web:hover:opacity-90"
              >
                <Icon name="flag" size={15} color={colors.muted} />
              </Pressable>
            )
          ) : isManager ? (
            <Pressable
              onPress={startMarkPersonal}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Mark personal — pick who owes it"
              className="rounded p-1 active:opacity-70 web:hover:opacity-90"
            >
              <Icon name="flag" size={15} color={colors.faint} />
            </Pressable>
          ) : null}
        </View>
      </Cell>
      </View>

      {/* Step 1 for a no-payee row: who owes this? Mounted only while asking,
          so the roster query it runs costs nothing on an ordinary grid. */}
      {payeePickerOpen ? (
        <PersonPicker
          visible
          title="Who owes this charge?"
          subtitle="This transaction isn't on anyone's card, so pick the person who made it — they'll be recorded as the payer and asked to pay it back."
          onPick={(personId, person) => {
            setNamedPayee({ id: personId as Id<"people">, name: person.name });
            setPayeePickerOpen(false);
            setPersonalPromptMode("mark");
          }}
          onClose={() => setPayeePickerOpen(false)}
        />
      ) : null}

      {personalPromptMode ? (
        <MarkPersonalModal
          mode={personalPromptMode}
          namedPayeeName={namedPayee?.name ?? null}
          submitting={personalPromptBusy}
          onCancel={() => {
            setPersonalPromptMode(null);
            setNamedPayee(null);
          }}
          onConfirm={() => void confirmPersonalPrompt()}
        />
      ) : null}

      {noteModalOpen ? (
        <TransactionNoteModal
          transactionId={id}
          currentNote={row.note}
          onClose={() => setNoteModalOpen(false)}
        />
      ) : null}
    </View>
  );
}

// ── On-demand "Suggest" (Suggested column, unreviewed row with no proposal
// yet) — runs the same model-call core as the on-ingest/hourly sweep
// (`api.aiCoding.suggestCoding`) for just this one transaction. Bookkeeper+
// gated server-side (`loadForSuggestion`'s finance-role check, same rank the
// rest of this grid's writes require) — a caller without the role sees the
// button fail with a readable error via `alertError`, same as every other
// cell's `guard()`. Loading state is local (`busy`): the button shows a
// spinner while the OpenRouter call is in flight and disables itself so a
// double-tap can't fire two calls; on error it re-enables — tapping again is
// the retry, no separate affordance needed. Success needs no local handling
// at all: `listReconcile`'s live subscription re-renders this row with
// `aiSuggestion` set the moment `writeSuggestion` commits, swapping this
// button out for the normal Accept UI above. ──────────────────────────────
function SuggestCell({ transactionId }: { transactionId: Id<"transactions"> }) {
  const suggestCoding = useAction(api.aiCoding.suggestCoding);
  const [busy, setBusy] = useState(false);

  async function handleSuggest() {
    setBusy(true);
    try {
      await suggestCoding({ transactionId });
    } catch (err) {
      alertError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      title="Suggest"
      size="sm"
      variant="secondary"
      icon="sparkles"
      loading={busy}
      onPress={handleSuggest}
    />
  );
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View
      style={{ width }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
  );
}

// ── Checkbox ──────────────────────────────────────────────────────────────────
function CheckBox({
  checked,
  onPress,
}: {
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className="rounded p-1 active:opacity-70"
    >
      <View
        className={`h-4 w-4 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
        }`}
      >
        {checked ? <Icon name="check" size={12} color={colors.accentText} /> : null}
      </View>
    </Pressable>
  );
}

// ── Category / Budget picker cell (a Popover of options + a "None" clear) ──────
function PickerCell({
  value,
  items,
  placeholder,
  warn,
  onChange,
}: {
  value: string | null;
  items: PickerItem[];
  placeholder: string;
  warn?: boolean;
  /** `""` clears the field (mapped to `null`). */
  onChange: (value: string | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const current = items.find((i) => !i.header && i.value === value);

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
      >
        {current ? (
          <OptionTag label={current.label} />
        ) : (
          <Text className={`text-sm ${warn ? "text-warn" : "text-faint"}`}>
            {placeholder}
          </Text>
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {items.map((it) =>
            it.header ? (
              <Text
                key={it.value}
                className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-muted"
              >
                {it.label}
              </Text>
            ) : (
              <Pressable
                key={it.value}
                onPress={() => {
                  onChange(it.value === "" ? null : it.value);
                  close();
                }}
                className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                {it.value === "" ? (
                  <Text className="text-sm text-muted">{it.label}</Text>
                ) : (
                  <OptionTag label={it.label} />
                )}
                {it.value === (value ?? "") ? (
                  <Icon name="check" size={15} color={colors.accent} />
                ) : null}
              </Pressable>
            ),
          )}
        </View>
      </Popover>
    </>
  );
}

// ── "For" picker cell — RANKED, per-transaction (`reconcileSuggest.
// rankForPicker` via `forPicker.ts#buildRankedForPickerItems`). A mini search
// box (owner addendum) sits at the top of the popover, auto-focusing the
// moment it opens, and drives the ranking query's `search` arg server-side
// (debounced — every keystroke would otherwise be a round trip). Only fires
// the ranking query while the popover is actually open (`useAnchor`'s
// `visible`, Convex's "skip" pattern) — a grid full of unopened "For" cells
// costs nothing beyond the base `forItems` this cell falls back to while the
// ranked list is in flight, so the popover is never blank. ──────────────────
function ForPickerCell({
  value,
  transactionId,
  baseItems,
  placeholder,
  warn,
  onChange,
}: {
  value: string | null;
  transactionId: Id<"transactions">;
  baseItems: PickerItem[];
  placeholder: string;
  warn?: boolean;
  /** `""` clears the field (mapped to `null`). */
  onChange: (value: string | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, visible]);

  const ranked = useQuery(
    api.reconcileSuggest.rankForPicker,
    visible ? { transactionId, search: debouncedSearch.trim() || undefined } : "skip",
  );
  // Keep the LAST resolved ranked payload rendered while a new args-tuple
  // (a debounce settle changing `search`) is in flight — `useQuery` returns
  // `undefined` for the whole round trip of a genuinely new subscription, so
  // without this every keystroke settle would flash the popover from the
  // current (possibly search-filtered) results all the way back to the
  // unranked `baseItems` fallback and then back again once the new result
  // lands. Reset on close so a FRESH open never shows a stale previous
  // search's results before its own default-view query resolves.
  const lastRankedRef = useRef<RankForPickerResult | undefined>(undefined);
  useEffect(() => {
    if (!visible) lastRankedRef.current = undefined;
  }, [visible]);
  if (ranked !== undefined) lastRankedRef.current = ranked;
  const effectiveRanked = ranked ?? lastRankedRef.current;

  const items = effectiveRanked ? buildRankedForPickerItems(effectiveRanked) : baseItems;
  const current = baseItems.find((i) => !i.header && i.value === value);
  const noMatches = effectiveRanked?.searching === true && items.length === 0;

  function handleClose() {
    close();
    setSearch("");
    setDebouncedSearch("");
  }

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
      >
        {current ? (
          <OptionTag label={current.label} />
        ) : (
          <Text className={`text-sm ${warn ? "text-warn" : "text-faint"}`}>
            {placeholder}
          </Text>
        )}
      </Pressable>
      <Popover visible={visible} onClose={handleClose} anchor={anchor}>
        <View className="border-b border-border/60 px-2 py-1.5">
          <View className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-sunken px-2 py-1">
            <Icon name="search" size={12} color={colors.faint} />
            <TextInput
              autoFocus
              value={search}
              onChangeText={setSearch}
              placeholder="Search…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 py-0.5 text-xs text-ink"
            />
          </View>
        </View>
        <View className="py-1">
          {noMatches ? (
            <Text className="px-3 py-2 text-sm text-faint">No matches</Text>
          ) : (
            items.map((it) =>
              it.header ? (
                <Text
                  key={it.value}
                  className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-muted"
                >
                  {it.label}
                </Text>
              ) : (
                <Pressable
                  key={it.value}
                  onPress={() => {
                    onChange(it.value === "" ? null : it.value);
                    handleClose();
                  }}
                  className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                >
                  <View className="flex-1">
                    {it.value === "" ? (
                      <Text className="text-sm text-muted">{it.label}</Text>
                    ) : (
                      <OptionTag label={it.label} />
                    )}
                    {it.reason ? (
                      <Text className="mt-0.5 text-2xs text-faint" numberOfLines={1}>
                        {it.reason}
                      </Text>
                    ) : null}
                  </View>
                  {it.value === (value ?? "") ? (
                    <Icon name="check" size={15} color={colors.accent} />
                  ) : null}
                </Pressable>
              ),
            )
          )}
        </View>
        {effectiveRanked?.truncated ? (
          <Text className="border-t border-border/60 px-3 py-1.5 text-2xs text-faint">
            Ranked from recent history
          </Text>
        ) : null}
      </Popover>
    </>
  );
}

// ── Receipt cell: a green ✓ when attached, else a web file-upload affordance
// that escalates in color/copy with the receipt-reminder timeline (day-1
// flag → day-3 escalate; day-7 auto-lock is shown at the card level).
// Exported so the member "My transactions" mini-reconcile (finances/
// my-transactions.tsx) can reuse the exact same upload affordance instead of
// re-implementing the web file-input → R2 upload → attach dance. ────────────
export function ReceiptCell({
  hasReceipt,
  reminderStage,
  transactionId,
  onUpload,
  generateUploadUrl,
}: {
  hasReceipt: boolean;
  reminderStage: "none" | "flagged" | "escalated";
  /** Which transaction this cell's receipt(s) belong to — powers the
   *  "Attached" chip's tap-to-view (`ReceiptViewerModal`, below). Optional so
   *  an existing call site outside this PR's file boundary (`money/MoneyView.tsx`)
   *  keeps compiling unchanged; omitting it just falls back to the old inert
   *  chip rather than opening a viewer. */
  transactionId?: Id<"transactions">;
  onUpload: (storageId: Id<"_storage">) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);

  async function uploadBlob(blob: Blob, contentType: string) {
    setBusy(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = await res.json();
      await onUpload(storageId as Id<"_storage">);
    } finally {
      setBusy(false);
    }
  }

  // Web file input → R2 upload → attach (mirrors the People avatar upload flow).
  function pickWeb() {
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "application/octet-stream");
    };
    input.click();
  }

  // Native picker (`expo-image-picker`) — mirrors `CoverPhotoPicker`/
  // `RequestForm`'s own pick → blob → upload dance. Images only on native (no
  // PDF picker available there — the same limitation those two call sites
  // already accept); the web `pickWeb()` above still takes PDFs too.
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

  if (hasReceipt) {
    if (!transactionId) {
      // No transaction to view receipts for (see the prop's own doc comment)
      // — the old inert chip, unchanged.
      return (
        <View className="flex-1 flex-row items-center gap-1 px-2 py-1.5">
          <Icon name="check-circle" size={15} color={colors.success} />
          <Text className="text-sm font-medium text-success">Attached</Text>
        </View>
      );
    }
    return (
      <>
        <Pressable
          onPress={() => setViewerOpen(true)}
          className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
        >
          <Icon name="check-circle" size={15} color={colors.success} />
          <Text className="text-sm font-medium text-success">Attached</Text>
        </Pressable>
        {viewerOpen ? (
          <ReceiptViewerModal
            transactionId={transactionId}
            onClose={() => setViewerOpen(false)}
          />
        ) : null}
      </>
    );
  }
  const escalated = reminderStage === "escalated";
  const flagged = reminderStage === "flagged";
  const tint = escalated ? colors.danger : flagged ? colors.warn : colors.muted;
  const label = busy
    ? "Uploading…"
    : escalated
      ? "Day 3 overdue"
      : flagged
        ? "Reminder sent"
        : "Upload";

  return (
    <>
      <View className="flex-1 flex-row items-center gap-1 px-2 py-1.5">
        <Pressable
          onPress={pick}
          disabled={busy}
          className="flex-row items-center gap-1 active:opacity-70 web:hover:opacity-90"
        >
          <Icon name={escalated ? "alert-triangle" : "upload"} size={14} color={tint} />
          <Text
            className={`text-sm ${escalated ? "text-danger" : flagged ? "text-warn" : "text-muted"}`}
          >
            {label}
          </Text>
        </Pressable>
        {/* Attach an EXISTING receipt instead of uploading a new one — opens
            the searchable library picker. Only when we know which transaction
            (see the prop doc); hidden while an upload is in flight. */}
        {transactionId && !busy ? (
          <Pressable
            onPress={() => setAttachOpen(true)}
            hitSlop={6}
            accessibilityLabel="Attach an existing receipt"
            className="ml-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon name="search" size={13} color={colors.faint} />
          </Pressable>
        ) : null}
      </View>
      {attachOpen && transactionId ? (
        <ReceiptAttachPicker
          transactionId={transactionId}
          onClose={() => setAttachOpen(false)}
        />
      ) : null}
    </>
  );
}
