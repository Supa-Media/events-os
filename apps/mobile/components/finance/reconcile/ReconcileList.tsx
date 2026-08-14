/**
 * RECONCILE GRID — the inline-editable spreadsheet the bookkeeper codes charges
 * in, built on the shared EditableTable primitives (the `people.tsx` pattern):
 * `DEFAULT_COLS` widths (user-adjustable + locally remembered on web via
 * `useResizableColumns`), a `GridHeaderCell` header row, and per-row
 * `Cell`-wrapped cells that each commit ONE field via its own mutation.
 *
 * Columns: [☐] Merchant · Date · Amount · Cardholder · What it was for ·
 * Category▾ · For▾ · Receipt · Status▾ · Actions.
 * "What it was for" is the coding's own sentence, read-only and rendered
 * straight from the row payload (`explanation`, see `finances.ts#reconcileRow`)
 * — tapping it opens the same documentation modal the Actions speech-bubble
 * does. Merchant / Category / For / Status edit inline
 * (Merchant a text cell, the rest dropdowns, all committing per row); Receipt
 * shows ✓ or an inline upload; Amount is read-only (signed). The fund is
 * hidden — the backend defaults it to the General Fund on categorize.
 *
 * ── THE SIDE PANEL (wide screens) ────────────────────────────────────────────
 * Opening a charge from this grid used to mean a modal — and the receipt
 * inside it meant a SECOND modal, which cannot be open at the same time. So
 * the one thing the founder asked for ("see the receipts really well, like
 * maybe in a side panel… quickly click in and click out, rather than a modal
 * that's in the middle of the screen") was not merely awkward here, it was
 * unreachable. At ≥900px `reconcile.tsx` now renders `CodingWorkbenchPanel`
 * beside this grid and passes `onOpenRow`/`openRowId`/`panelOpen` in: a row's
 * open affordances select instead of opening the modal, the panel swaps to
 * that row in place, and three columns the panel itself renders step aside to
 * pay for the space (see `hidesForPanel`). Below 900px, and anywhere
 * `onOpenRow` is absent, this file behaves exactly as it did.
 *
 * MERCHANT is a RENAME, not an edit of the bank's record — it writes a
 * separate `merchantNameOverride` and leaves the provider's own string
 * untouched, with a history icon on renamed rows. The icon stays live on a
 * read-only row (a foreign book, a peek) even though the name itself goes
 * flat there — reading what a row used to be called is a read. See
 * `MerchantCell` below and `finances.renameMerchant`.
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
 * Actions (R1): a comment icon (tap → `TransactionDocumentationModal`, which
 * holds BOTH the freeform note and the structured coding — purpose, route,
 * attendees — plus a reviewer's Approve / Send back; the icon itself says
 * whether anything is behind it, see `docState`)
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, Pressable, Platform, ScrollView, TextInput } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import {
  Avatar,
  Badge,
  Button,
  Icon,
  Checkbox,
  InlineText,
  OptionTag,
  PersonPicker,
  Popover,
  SelectCell,
  GridHeaderCell,
  useAnchor,
  useResizableColumns,
} from "../../ui";
import {
  CENTRAL,
  MIN_PURPOSE_LENGTH,
  PAYOUT_PROCESSOR_LABELS,
  MAX_MERCHANT_NAME_LENGTH,
  displayMerchantName,
  providerMerchantName,
} from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { ReceiptExceptionModal } from "../modals/ReceiptExceptionModal";
import { ReceiptExceptionDecideModal } from "../modals/ReceiptExceptionDecideModal";
import { TransactionDocumentationModal } from "../modals/TransactionDocumentationModal";
import { CorrectTransactionModal } from "../modals/CorrectTransactionModal";
import { MerchantHistoryModal } from "../modals/MerchantHistoryModal";
import { ExcludeReasonModal } from "../modals/ExcludeReasonModal";
import { MarkPersonalModal } from "../modals/MarkPersonalModal";
import { ReceiptViewerModal } from "../receipts/ReceiptViewerModal";
import { ReceiptAttachPicker } from "../receipts/ReceiptAttachPicker";
import {
  STATUS_OPTIONS,
  signedMoney,
  shortDate,
  type TxnRow,
} from "./helpers";
import { ReconcileGroupHeader } from "./ReconcileGroupHeader";
import {
  groupSegments,
  type GroupSummary,
  type ReconcileGroupBy,
  type ReconcileSortDir,
  type ReconcileSortKey,
} from "./gridView";
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
  // THE ROW'S OWN SENTENCE. Wide because it holds prose, not a token, and
  // placed straight after Cardholder so a scan reads as one line of English —
  // "Guitar Center · $1,284.00 · Marcus Webb · Two condenser mics for the
  // album sessions" — inside the first screenful, before the editable cells.
  // Parking it out past Status would have put the thing people came to read
  // behind a horizontal scroll.
  //
  // Deliberately NOT adjacent to `forCol`: "For" is the BUDGET and this is
  // the EXPLANATION, and two columns reading "For" / "What it was for" side
  // by side is exactly the vocabulary collision this area keeps paying for.
  // Category sits between them.
  explanation: 300,
  category: 168,
  forCol: 200,
  // Founder feedback (2026-07-24): 96px clipped BOTH the "Upload" label+icon
  // AND the "attach existing" search-icon affordance next to it — too tight
  // to comfortably click either. The table already scrolls horizontally, so
  // there's no shared budget to steal from another column for this.
  //
  // 140 was still short once the cell grew its third affordance ("No receipt")
  // and its longest label ("Day 3 overdue"): measured in the browser, that
  // combination renders 197px wide, so it spilled 57px into the Status column.
  // It LOOKED fine only because nothing clipped — the overflow painted over
  // the neighbour instead of being cut off. Now that `Cell` clips (see its
  // comment), an under-wide column would silently swallow the "No receipt"
  // control rather than merely look untidy, so the default has to actually fit
  // the widest state the cell can render.
  receipt: 208,
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
  canRename = false,
  viewerPersonId = null,
  onOpenRow,
  openRowId = null,
  panelOpen = false,
  sortKey = "date",
  sortDir = "desc",
  onSort,
  groups,
  groupBy = null,
  renderGroupAction,
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
  // Whether the caller may RENAME a merchant at all (`listReconcile`'s
  // `viewerCanRename` — the bookkeeper+ rank `finances.renameMerchant` itself
  // enforces). Separate from the row's own `readOnly`, which answers a
  // different question: whether this row's BOOK is writable. A finance VIEWER
  // in their own chapter passes that test and still cannot rename anything, so
  // without this they were shown a live text box every keystroke of which the
  // server would refuse — the guarantee `monthCodingWorklist.canRename` gave
  // the Explain screen, carried onto the grid that replaces it.
  canRename?: boolean;
  // Founder feedback review: the caller's OWN roster person id
  // (`listReconcile`'s `viewerPersonId`) — widens "Mark personal" to a
  // cardholder's OWN row, mirroring the server's cardholder-or-manager gate.
  viewerPersonId?: Id<"people"> | null;
  // ── THE SIDE PANEL (wide screens only) ────────────────────────────────────
  // Founder, verbatim: "information that helps me quickly click in and click
  // out, rather than a modal that's in the middle of the screen that blocks
  // your ability to see other things." In THIS grid that failure was
  // structural, not merely annoying: the record opened in
  // `TransactionDocumentationModal` and the receipt opened in
  // `ReceiptViewerModal`, and two `<Modal>`s cannot be open at once — so
  // reading a receipt WHILE typing its explanation was impossible from here,
  // which is the one thing that was asked for. `reconcile.tsx` now hosts
  // `CodingWorkbenchPanel` beside this grid on a wide screen; these three
  // props are the whole seam, and all three are absent on narrow, where every
  // behavior below is exactly what it was.
  /** Present ⇔ the host is rendering the side panel (wide screen). A row's
   *  "open the record" affordances then SELECT the row for the panel instead
   *  of opening the modal. ABSENT (narrow) → the modal, unchanged. */
  onOpenRow?: (id: string) => void;
  /** The row the panel is showing — marked with an accent bar so it stays
   *  identifiable while the list scrolls past it. */
  openRowId?: string | null;
  /** The panel is actually on screen (wide AND a row selected). Hides the
   *  columns the panel itself renders in full — see `hidesForPanel`. */
  panelOpen?: boolean;
  // ── SORT ──────────────────────────────────────────────────────────────────
  // The ACTIVE sort, as the server applied it — this grid renders the order it
  // was sent and never re-sorts locally. It couldn't honestly: the server sorts
  // the WHOLE match set before paging, so a client re-sort of the loaded 100
  // would silently mean "biggest of the rows that happened to load".
  /** Which column carries the caret. */
  sortKey?: ReconcileSortKey;
  sortDir?: ReconcileSortDir;
  /** Present ⇔ the Date/Amount headers are pressable. Absent leaves every
   *  header exactly the plain label it has always been. */
  onSort?: (key: ReconcileSortKey) => void;
  // ── GROUPING ──────────────────────────────────────────────────────────────
  /** `listReconcile`'s `groups`, in render order — present only when the host
   *  asked for `groupBy`. Each group's rows are contiguous in `rows` and in
   *  this same order, so the grid slices the page by walking these counts
   *  (`groupSegments`) rather than re-deriving anyone's month or cardholder.
   *  ABSENT → one flat list, byte-for-byte the grid this file already
   *  rendered. */
  groups?: readonly GroupSummary[];
  /** WHICH grouping produced them — the bands render differently for people
   *  (an avatar, and a nudge button when the host supplies one) than for
   *  months. Derivable from the group keys in principle; passed explicitly
   *  because "does this key parse as YYYY-MM" is not a question a renderer
   *  should be answering. */
  groupBy?: ReconcileGroupBy | null;
  /** Per-band trailing control, built by the host. Returning `null` (or
   *  omitting this) leaves the band exactly what it was.
   *
   *  A slot rather than a `onNudge` prop: the nudge is seat-gated, rate-limited
   *  and in-flight-aware, and none of that belongs in a grid renderer. */
  renderGroupAction?: (group: GroupSummary) => ReactNode;
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
  // ── WHAT THE PANEL COSTS THIS GRID, AND WHAT IT PAYS BACK ─────────────────
  // The columns already total ~1776px in a single-book scope and the grid
  // scrolls horizontally to fit them; handing 44% of the window to the panel
  // would make that scroll much worse if nothing gave way. So while the panel
  // is open, this grid drops exactly the columns the panel RENDERS IN FULL —
  // and nothing else:
  //
  //   Cardholder (168)      → the panel's header line ("Marcus Webb · card
  //                           ••4417"), the founder's "who do I even ask".
  //   What it was for (300) → the panel's purpose field, where it is not just
  //                           shown but WRITTEN.
  //   Documentation (208)   → `ReceiptPane` — the receipt itself, big, plus
  //                           the very same `ReceiptCell` upload affordance
  //                           this column renders (that component is imported
  //                           FROM this file), so no capability is lost.
  //
  // 676px back: ~1776 → ~1100, which is what makes the two-pane layout usable
  // rather than two scrollbars fighting. Everything the panel does NOT do
  // stays: the checkbox (bulk actions), Book, Merchant (the rename lives
  // here), Date, Amount, Category, For, Status, and the row Actions.
  const hidesForPanel = panelOpen;
  const showCardholder = !hidesForPanel;
  const showExplanation = !hidesForPanel;
  const showReceipt = !hidesForPanel;
  const tableWidth = (Object.values(widths) as number[]).reduce((sum, w) => sum + w, 0);
  // Drop the width of any column this scope doesn't render so the grid doesn't
  // leave dead space: Category when it isn't shown, the Book column outside
  // the merged all-books queue, and the three the side panel supersedes.
  const width =
    tableWidth -
    (showCategory ? 0 : widths.category) -
    (showBook ? 0 : widths.book) -
    (showCardholder ? 0 : widths.cardholder) -
    (showExplanation ? 0 : widths.explanation) -
    (showReceipt ? 0 : widths.receipt);

  // One row, however it's being laid out — so the grouped and ungrouped
  // branches below can't drift into rendering different rows. `i` stays the
  // index into the WHOLE page, so `isLast` still means the last row on screen
  // rather than the last row of some group.
  const renderRow = (row: TxnRow, i: number) => (
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
      canRename={canRename}
      viewerPersonId={viewerPersonId}
      widths={widths}
      showCardholder={showCardholder}
      showExplanation={showExplanation}
      showReceipt={showReceipt}
      onOpenRow={onOpenRow}
      panelSelected={panelOpen && row.id === openRowId}
    />
  );

  // The page sliced into groups, or `null` for "render it flat". A `groups`
  // array that somehow describes none of the loaded rows also falls back to
  // flat rather than rendering an empty grid — the rows are the data, the
  // headers are decoration over them.
  const computedSegments =
    groups != null && groups.length > 0 ? groupSegments(rows.length, groups) : null;
  const segments =
    computedSegments != null && computedSegments.length > 0 ? computedSegments : null;
  const groupedRowCount =
    segments?.reduce((n, s) => n + s.shownCount, 0) ?? rows.length;
  // The band's content width — see the `onLayout` below. `null` until the
  // first layout (and forever in jsdom, where `onLayout` never fires), which
  // is the band's own "lay out full width" fallback, so nothing on this grid
  // waits on a measurement.
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  // Never wider than the table itself: on a wide monitor with the panel closed
  // the box can exceed ~1776px, and a band laid out at the box's width would
  // then push its action past the last column instead of level with it.
  const bandWidth =
    viewportWidth == null ? null : Math.min(viewportWidth, Math.max(width, 320));

  return (
    <View
      className="overflow-hidden rounded-lg border border-border bg-raised shadow-card"
      // ── HOW WIDE THE WINDOW ONTO THIS GRID ACTUALLY IS ────────────────────
      // The table is ~1776px and scrolls horizontally inside this box; this is
      // the box's own width, which is what the reader can see at rest.
      //
      // The group bands need it. Their trailing action ("Send reminder" on a
      // person band, Preview/Publish on a month band) used to be pushed to the
      // far end of the TABLE, i.e. ~500px past the right edge of a laptop
      // window — rendered, and unreachable without a scroll gesture nothing
      // pointed at. Founder: "why can't I see the header?" So the band lays its
      // content out at this width instead (see `ReconcileGroupHeader`), while
      // its background still spans every column.
      //
      // Measured rather than assumed: this box is inside `Screen`'s max-width
      // AND gives up 44% of the window when the side panel opens, so neither
      // the window width nor a constant would be right in both frames.
      onLayout={(e) => setViewportWidth(e.nativeEvent.layout.width)}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(width, 320) }}>
          {/* Column header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            <View
              style={{ width: widths.check }}
              className="items-center justify-center py-2.5"
            >
              <Checkbox
                checked={allSelected}
                onPress={onToggleAll}
                accessibilityLabel={
                  allSelected ? "Deselect all transactions" : "Select all transactions"
                }
              />
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
            {/* THE TWO SORTABLE COLUMNS. Same `GridHeaderCell` as every other
                header — extended, not forked — so a sorted Date column can
                still be dragged wider, and the seven columns that don't sort
                render exactly as they always have. */}
            <GridHeaderCell
              label="Date"
              width={widths.date}
              onResizeStart={startResize("date")}
              onSort={onSort ? () => onSort("date") : undefined}
              sortActive={sortKey === "date"}
              sortDirection={sortDir}
            />
            <GridHeaderCell
              label="Amount"
              width={widths.amount}
              onResizeStart={startResize("amount")}
              onSort={onSort ? () => onSort("amount") : undefined}
              sortActive={sortKey === "amount"}
              sortDirection={sortDir}
            />
            {showCardholder ? (
              <GridHeaderCell
                label="Cardholder"
                width={widths.cardholder}
                onResizeStart={startResize("cardholder")}
              />
            ) : null}
            {showExplanation ? (
              <GridHeaderCell
                label="What it was for"
                width={widths.explanation}
                onResizeStart={startResize("explanation")}
              />
            ) : null}
            {showCategory ? (
              <GridHeaderCell
                label="Category"
                width={widths.category}
                onResizeStart={startResize("category")}
              />
            ) : null}
            <GridHeaderCell label="For" width={widths.forCol} onResizeStart={startResize("forCol")} />
            {showReceipt ? (
              <GridHeaderCell
                label="Documentation"
                width={widths.receipt}
                onResizeStart={startResize("receipt")}
              />
            ) : null}
            <GridHeaderCell
              label="Status"
              width={widths.status}
              onResizeStart={startResize("status")}
            />
            <View style={{ width: widths.actions }} />
          </View>

          {/* Body — one flat list, or the same list with a band before each
              group. `segments` is null in the ungrouped case, which is the
              safety property: with no `groups` prop nothing below this line
              behaves differently from before grouping existed. */}
          {segments == null
            ? rows.map(renderRow)
            : segments.map((seg) => (
                <View key={seg.group.key}>
                  <ReconcileGroupHeader
                    label={seg.group.label}
                    count={seg.group.count}
                    totalCents={seg.group.totalCents}
                    shownCount={seg.shownCount}
                    // MONTH BANDS ONLY, and only when the grid is narrowed —
                    // the band then says "12 of 318 charges · -$4,102 of
                    // -$88,201", which is what makes the Publish button beside
                    // it about the month rather than about the selection.
                    unfilteredCount={seg.group.unfilteredCount}
                    unfilteredTotalCents={seg.group.unfilteredTotalCents}
                    // Keeps the band's trailing action inside the window
                    // rather than at the far end of a ~1776px table.
                    contentWidth={bandWidth}
                    // The whole tally, passed through rather than picked
                    // apart: the band needs the live/backlog split as well as
                    // the combined figure, and `GroupSummary` already IS an
                    // `ExplainProgress`.
                    progress={seg.group}
                    imageUrl={seg.group.imageUrl}
                    showAvatar={groupBy === "person"}
                    // The screen decides whether this band gets a nudge button
                    // — it owns the seat check, the 24h rate-limit status and
                    // the action itself. `null` for every month band and for
                    // any caller who may not nudge.
                    action={renderGroupAction?.(seg.group) ?? null}
                  />
                  {rows
                    .slice(seg.startIndex, seg.startIndex + seg.shownCount)
                    .map((row, j) => renderRow(row, seg.startIndex + j))}
                </View>
              ))}
          {/* NO ROW IS EVER SILENTLY DROPPED. `groups` covers the whole match
              set, so the segments above always account for the entire page —
              but if they ever didn't, the rows are the data and the headers
              are decoration over them, so the remainder still renders. */}
          {segments != null && groupedRowCount < rows.length
            ? rows
                .slice(groupedRowCount)
                .map((row, j) => renderRow(row, groupedRowCount + j))
            : null}
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
  canRename,
  viewerPersonId,
  widths,
  showCardholder,
  showExplanation,
  showReceipt,
  onOpenRow,
  panelSelected,
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
  canRename: boolean;
  viewerPersonId: Id<"people"> | null;
  widths: ColWidths;
  /** The side panel renders these three itself — see `hidesForPanel`. */
  showCardholder: boolean;
  showExplanation: boolean;
  showReceipt: boolean;
  /** Wide screen: select this row for the panel instead of opening the modal. */
  onOpenRow?: (id: string) => void;
  /** This is the row the panel is showing. */
  panelSelected: boolean;
}) {
  const categorize = useMutation(api.finances.categorizeTransaction);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const correctTransaction = useMutation(api.finances.correctTransaction);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
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
  // A transfer leg has no category and no budget BY DESIGN — it isn't spend,
  // it's the same money moving between two books, and `signedBookCents`
  // deliberately keeps it out of both. Rendering it as an empty "Uncategorized"
  // picker read as unfinished work (owner, 2026-08-07: these rows "need to be
  // filled out in a standard way"), so say what it is instead. The row's note
  // carries the arithmetic — see `reconciliation.ts`'s settlement/allocation
  // notes, which spell out every sum the net came from.
  const isTransferLeg = row.flow === "transfer";
  const rowForItems = isCentralRow && centralForItems ? centralForItems : forItems;

  // Fire-and-surface: run a cell mutation, alerting the server's reason on error.
  const guard = (p: Promise<unknown>) => p.catch((err) => alertError(err));

  // ── THE INLINE "WHAT IT WAS FOR" EDITOR ───────────────────────────────────
  // See the cell itself for why this is an input rather than a way into the
  // panel. `editable` is server-resolved per row (`reconcileRow.explanation`),
  // and `setPurpose` re-checks it — this state only decides what is drawn.
  const setPurpose = useMutation(api.transactionCodings.setPurpose);
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [draftPurpose, setDraftPurpose] = useState("");
  const [savingPurpose, setSavingPurpose] = useState(false);
  // An approved row can't be edited, so the only thing tapping it can usefully
  // do is finish the sentence the cell truncated at two lines.
  const [purposeExpanded, setPurposeExpanded] = useState(false);
  const purposeEditable = row.explanation?.editable === true && !readOnly;
  /**
   * WHAT A TAP MEANS, decided by what the row can take.
   *
   * The three branches are the three states in the cell's own comment: edit
   * it, read the rest of it, or go to the sheet that can create one. The
   * panel is reached from exactly one of them — the row that genuinely has no
   * coding to edit — which is the whole of the founder's complaint.
   */
  const beginEditPurpose = () => {
    if (purposeEditable) {
      setDraftPurpose(row.explanation?.purpose ?? "");
      setEditingPurpose(true);
      return;
    }
    if (row.explanation) {
      setPurposeExpanded((v) => !v);
      return;
    }
    openRecord();
  };
  /**
   * SAVE ON BLUR OR ENTER, and say nothing when nothing changed.
   *
   * Both events fire for one commit on web (Enter blurs), so `savingPurpose`
   * is the re-entry guard as well as the spinner — without it the second
   * event submits the same sentence again and the row picks up a second
   * `coding_submit` audit entry for one edit.
   *
   * An unchanged draft closes silently rather than resubmitting: reopening a
   * cell to re-read it must not put an approved-and-sent-back coding through
   * another review round, and it must not write an audit line saying somebody
   * revised something they didn't.
   */
  const commitPurpose = () => {
    if (savingPurpose) return;
    const next = draftPurpose.trim();
    if (next === (row.explanation?.purpose ?? "").trim()) {
      setEditingPurpose(false);
      return;
    }
    setSavingPurpose(true);
    void setPurpose({ transactionId: id, businessPurpose: next })
      .then(() => {
        setEditingPurpose(false);
      })
      .catch((err) => {
        // STAYS OPEN ON REFUSAL, with what they typed still in it. The server
        // rejects a purpose under the length floor, and closing the editor
        // would throw the sentence away along with the reason it was refused.
        alertError(err);
      })
      .finally(() => setSavingPurpose(false));
  };

  // Founder feedback review: "is this MY charge" — the cardholder's OWN half
  // of `cards.flagPersonalCharge`'s server-side OR-gate (cardholder OR
  // manager). `viewerPersonId` is `null` for a superuser with no roster row,
  // which correctly never matches a real cardholder here.
  const isOwnCharge =
    viewerPersonId != null && row.cardholder?.personId === viewerPersonId;

  /**
   * What the row's speech-bubble is standing on, in one word — so the icon can
   * say it before anyone clicks.
   *
   *  "written" — there is something to read: a comment, or a coding in any
   *              state. The whole point of the change; a filled record used to
   *              be indistinguishable from an empty one.
   *  "missing" — this charge OWES an account of itself (the policy requires a
   *              coding and none is submitted) and nobody has written one.
   *  "empty"   — nothing written and nothing owed. Ordinary; stays quiet.
   *
   * Read off `codingState` — already on every reconcile row as a denorm, and
   * until now rendered nowhere — so this costs no extra read. `requiresCoding`
   * is deliberately NOT recomputed here: the row payload doesn't carry the
   * policy date, and a client that guessed it would disagree with the server
   * the day central finance moves it. `needsBudget`-style precision isn't
   * needed — this is an icon, and "spend that nobody has written anything
   * about" is the honest, policy-independent version of the warning.
   */
  const docState: "written" | "missing" | "empty" =
    row.note || row.codingState != null
      ? "written"
      : row.flow === "outflow" && row.status !== "excluded" && !row.isPersonal
        ? "missing"
        : "empty";

  const [noteModalOpen, setNoteModalOpen] = useState(false);
  /**
   * ONE WAY IN to this charge's whole record, two frames for it. On a wide
   * screen (`onOpenRow` present) it selects the row and the host's side panel
   * swaps to it in place — the list stays visible and the receipt stays
   * readable while the explanation is typed. Everywhere else it is the modal
   * this grid has always opened, unchanged.
   *
   * Every affordance that used to call `setNoteModalOpen(true)` calls this
   * instead, so the two frames can never be reachable by different routes.
   */
  const openRecord = () => {
    if (onOpenRow) {
      onOpenRow(row.id);
      return;
    }
    setNoteModalOpen(true);
  };
  /**
   * Makes a READ-ONLY cell double as the row's way into the panel — but only
   * when there is a panel. Without one it returns its argument untouched, so
   * a narrow screen renders precisely the cells it rendered before.
   *
   * It exists because the panel HIDES "What it was for" (the cell that used
   * to be the way in), and the speech-bubble in Actions sits at the far right
   * of a grid that scrolls horizontally. Stepping from row to row is the
   * whole point of the panel, so the target for it has to be wide, on the
   * left, and on every row: Date and Amount, which have nothing to edit and
   * so cost nothing to give away.
   */
  const openable = (node: React.ReactNode) =>
    onOpenRow ? (
      <Pressable
        onPress={openRecord}
        accessibilityRole="button"
        accessibilityLabel={`Open ${displayMerchantName(row, "this transaction")}`}
        className="flex-1 active:opacity-70 web:hover:opacity-90"
      >
        {node}
      </Pressable>
    ) : (
      node
    );
  const [correctOpen, setCorrectOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
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
        selected || panelSelected ? "bg-accent-soft" : "bg-raised"
      } ${isLast ? "border-b-0" : ""}`}
    >
      {/* THE ROW THE PANEL IS SHOWING. An absolutely-positioned bar rather
          than a left border, deliberately: a border would push this row's
          cells 3px out of line with every other row's and with the header,
          which in a grid reads as a rendering fault. Distinct from the
          checkbox tint above (which this row may also carry) because the two
          mean different things — one is "in the bulk selection", this is
          "open in the panel to the right". */}
      {panelSelected ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: colors.accent,
          }}
        />
      ) : null}
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
          <Checkbox
            checked={selected}
            onPress={onToggle}
            accessibilityLabel={`Select ${
              row.merchantNameOverride ?? row.merchantName ?? "this transaction"
            }`}
          />
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

      {/* Merchant — MIXED, so it sits OUTSIDE the read-only wrapper below and
          owns its own `readOnly` handling. It holds one write affordance (the
          inline rename) and one READ affordance (the name-history icon), and
          the wrapper can only disable a subtree wholesale.

          This is the only cell that gets to sit out here, and the distinction
          that earns it is narrow: a read is not a write. The wrapper exists so
          a read-only row can never expose a working WRITE — see its own
          comment — and pushing a read-only affordance through it is not a
          precedent for pushing an editable one through. Anything that COMMITS
          belongs inside the wrapper; if a future cell wants out, the question
          is whether it can change data, not whether it's inconvenient. */}
      <Cell width={widths.merchant}>
        {/* TWO independent reasons the name goes flat, OR'd here rather than
            inside the cell: this row's book isn't writable, or this caller
            holds no rank to rename with anywhere. Both leave the history icon
            live — reading what a row used to be called is a read. */}
        <MerchantCell row={row} readOnly={readOnly || !canRename} />
      </Cell>

      {/* Everything from here on is the editable body. Wrapping it in one
          non-interactive container is deliberate: a read-only row must not
          expose a SINGLE working WRITE affordance, and per-cell `disabled`
          props would be six independent chances to miss one as this grid
          grows. `pointerEvents="none"` covers the whole subtree, which is the
          point — it can't be partially defeated by a cell forgetting. */}
      <View
        className="flex-1 flex-row items-stretch"
        pointerEvents={readOnly ? "none" : "auto"}
        style={readOnly ? { opacity: 0.55 } : undefined}
      >

      {/* Date (read-only) — and, on a wide screen, part of the row's way IN.
          `openable` is a no-op wrapper when there's no panel, so on narrow
          these two cells render exactly the plain Text they always have. */}
      <Cell width={widths.date}>
        {openable(
          <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
            {shortDate(row.postedAt)}
          </Text>,
        )}
      </Cell>

      {/* Amount (read-only, signed) */}
      <Cell width={widths.amount}>
        {openable(
          <Text
            className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink"
            style={NUM}
          >
            {signedMoney(row.amountCents, row.flow, row.preMarkFlow)}
          </Text>,
        )}
      </Cell>

      {/* Cardholder (read-only) — hidden while the panel is open, which says
          the same thing in words ("Marcus Webb · card ••4417"). */}
      {showCardholder ? (
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
      ) : null}

      {/* WHAT IT WAS FOR — the coding's own sentence, readable AND editable
          without opening anything.

          The column shipped read-only, and tapping a cell opened the
          documentation modal. Founder, on the deployed build: "There's a whole
          column for it. When you click on it, it opens the side panel. That
          kinda defeats the purpose." He is right — a column whose reason for
          existing is that you don't have to open anything, which opens
          something, has argued itself out of existence.

          It was read-only for a real reason: `submitCoding` refuses an
          APPROVED coding (`CODING_APPROVED`), so a cell that always accepted
          typing would work on some rows and throw on others. But that fixed a
          per-row problem by degrading every row to the safe case. The row now
          says which case it is (`explanation.editable`, server-resolved), so:

            editable → a real text input, saved by `setPurpose`, which carries
                       every other coding field forward untouched (a partial
                       write here would silently erase a meal's attendees —
                       see `codingWriteFieldsFrom`).
            approved → NOT an input, and still not the panel. The cell
                       truncates to two lines, so the only honest reason to tap
                       is to read the rest: it expands in place and says the
                       sentence is the record now.
            no coding → the panel, and only here. There is no type to preserve
                       and nothing to edit, and inventing "general" for a
                       restaurant charge would write a coding that fails
                       substantiation from a control with nowhere to say who
                       was there.

          THREE STATES for what to SHOW, matching the speech-bubble's
          `docState` exactly so the two can never contradict each other:
            written — show it, and let it be edited
            missing — this charge owes an account of itself and has none
            empty   — nothing written, nothing owed; stays quiet. */}
      {showExplanation ? (
      <Cell width={widths.explanation}>
        {editingPurpose ? (
          <View className="flex-1 px-1 py-1">
            <TextInput
              value={draftPurpose}
              onChangeText={setDraftPurpose}
              autoFocus
              multiline
              // ENTER SAVES, not newline: this is a cell in a grid, and the
              // sentence is one sentence. `multiline` is here only so a long
              // purpose wraps while it is being read back, which is the same
              // two lines the read view shows.
              blurOnSubmit
              onSubmitEditing={commitPurpose}
              onBlur={commitPurpose}
              editable={!savingPurpose}
              placeholder={`At least ${MIN_PURPOSE_LENGTH} characters`}
              placeholderTextColor={colors.faint}
              className="rounded border border-accent bg-raised px-1.5 py-1 text-sm text-ink"
            />
          </View>
        ) : (
        <Pressable
          onPress={beginEditPurpose}
          accessibilityRole="button"
          accessibilityLabel={
            row.explanation
              ? row.explanation.editable
                ? `Edit what it was for: ${row.explanation.purpose}`
                : `What it was for (approved): ${row.explanation.purpose}`
              : docState === "missing"
                ? "Needs an explanation — say what this was for"
                : "Say what this was for"
          }
          className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
        >
          {row.explanation ? (
            <View className="flex-row items-start gap-1">
              <Text
                className="flex-1 text-sm text-ink"
                // Expanded only where expanding is the whole point: an
                // approved row somebody tapped to read the rest of.
                numberOfLines={purposeExpanded ? undefined : 2}
              >
                {row.explanation.purpose}
              </Text>
              {/* A reviewer replaced the author's wording for publication.
                  Marked rather than silent: this is the sentence the public
                  page prints, and somebody reading the grid should be able to
                  tell it isn't the spender's own words. */}
              {row.explanation.redacted ? (
                <Icon name="edit-3" size={11} color={colors.faint} />
              ) : null}
            </View>
          ) : docState === "missing" ? (
            <Text className="text-sm text-muted">Not written</Text>
          ) : (
            <Text className="text-sm text-faint">—</Text>
          )}
          {/* SAY WHY THIS ONE DOESN'T TYPE. Without it, an approved row is a
              cell that looks exactly like every editable one and simply
              doesn't take a cursor, which reads as broken rather than as
              closed. Only once expanded, so a column of approved rows isn't a
              column of the same sentence. */}
          {purposeExpanded && row.explanation && !row.explanation.editable ? (
            <Text className="mt-0.5 text-2xs text-faint">
              Approved — a reviewer sends it back to change it
            </Text>
          ) : null}
        </Pressable>
        )}
      </Cell>
      ) : null}

      {/* Category (inline dropdown) — chapter-only; central txns have none.
          The COLUMN is present whenever any chapter row could be in view; an
          individual central row renders an inert dash in it (see
          `hideCategory`) so the grid stays aligned without offering a picker
          that can't commit. */}
      {showCategory ? (
        isTransferLeg ? (
          <Cell width={widths.category}>
            <Text className="flex-1 px-2 py-1.5 text-sm text-muted">
              Internal transfer
            </Text>
          </Cell>
        ) : hideCategory ? (
          <Cell width={widths.category}>
            <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
          </Cell>
        ) : (
        <Cell width={widths.category}>
          <PickerCell
            value={row.categoryId}
            items={categoryItems}
            placeholder="Uncategorized"
            onChange={(value) => {
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

      {/* Receipt (✓ or inline upload, escalating with the reminder timeline).
          Hidden while the panel is open — `ReceiptPane` there shows the
          receipt itself, big, and mounts this very component for the upload
          case, so nothing here is out of reach. */}
      {showReceipt ? (
      <Cell width={widths.receipt}>
        <ReceiptCell
          hasReceipt={row.hasReceipt}
          documentation={row.documentation}
          amountCents={row.amountCents}
          readOnly={readOnly}
          reminderStage={row.reminderStage}
          isPersonal={row.isPersonal === true}
          transactionId={id}
          // The one surface where it's safe: this grid throws for anyone
          // below bookkeeper before a row ever renders.
          libraryPicker
          onUpload={async (storageId, filename) => {
            await guard(
              attachReceipt({
                transactionId: id,
                storageId,
                ...(filename ? { filename } : {}),
              }),
            );
          }}
          generateUploadUrl={generateUploadUrl}
        />
      </Cell>
      ) : null}

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
          {/* THE WAY IN TO EVERYTHING WRITTEN DOWN about this charge — the
              comment AND the coding (purpose, route, who was there), plus a
              reviewer's Approve / Send back. Owner ask, 2026-08-09: the coding
              should surface where he is already looking, not in a second table.

              The icon says what is behind it before you click, because it used
              to look identical whether anything was there or not — which is how
              six properly written codings sat unread. Three states, and the
              order matters: an unanswered ASK outranks a filled record, because
              the only one of the three that needs somebody to do something is
              the empty one on a charge that owes an account of itself. */}
          <Pressable
            onPress={openRecord}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={
              docState === "missing"
                ? "Needs coding — say what this was for"
                : docState === "written"
                  ? "Read what this was for"
                  : "Say what this was for"
            }
            className="rounded p-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon
              name={docState === "written" ? "message-square" : "message-circle"}
              size={15}
              color={
                docState === "written"
                  ? colors.accent
                  : docState === "missing"
                    ? colors.warn
                    : colors.faint
              }
            />
          </Pressable>
          {/* Correct a manually-entered row's amount / date / merchant. Shown
              only when the SERVER says the row's source accepts it
              (`row.correctable` — `manual` only), so a synced row never offers
              a button that would throw. Manager-gated server-side too. */}
          {row.correctable && isManager ? (
            <Pressable
              onPress={() => setCorrectOpen(true)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Correct this transaction"
              className="rounded p-1 active:opacity-70 web:hover:opacity-90"
            >
              <Icon name="edit-2" size={14} color={colors.faint} />
            </Pressable>
          ) : null}
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
        <TransactionDocumentationModal
          transactionId={id}
          currentNote={row.note}
          merchantLine={`${displayMerchantName(row, "—")} · ${shortDate(row.postedAt)}`}
          rawDescription={row.description}
          amountCents={row.amountCents}
          readOnly={readOnly}
          onClose={() => setNoteModalOpen(false)}
        />
      ) : null}

      {correctOpen ? (
        <CorrectTransactionModal
          current={{
            amountCents: row.amountCents,
            postedAt: row.postedAt,
            merchantName: row.merchantName,
            description: row.description,
            isReconstructed: row.isReconstructed,
          }}
          submitting={correcting}
          onCancel={() => setCorrectOpen(false)}
          onConfirm={(args) => {
            void (async () => {
              setCorrecting(true);
              try {
                await correctTransaction({ transactionId: id, ...args });
                setCorrectOpen(false);
              } catch (err) {
                alertError(err);
              } finally {
                setCorrecting(false);
              }
            })();
          }}
        />
      ) : null}
    </View>
  );
}

// ── Merchant cell (inline rename + name history) ─────────────────────────────
/**
 * The MERCHANT column, editable in place.
 *
 * A bank feed's merchant string is a machine artifact — `IC* COSTCO BY IN
 * CAR`, `AMAZON MKTPL*56OXD2TB2`, `Purchase from AMAZON.COM*569A3 | Address:
 * SEATTLE, WA, US | **8728` — and a bookkeeper wants to call the row what it
 * actually was (owner ask, 2026-08-08). Typing here calls
 * `finances.renameMerchant`, which writes a SEPARATE `merchantNameOverride`
 * and never touches the provider's own value; see that mutation's doc comment
 * for why that separation is the whole design.
 *
 * WHAT COMMITS. `InlineText` fires `onCommit` on every blur, including a blur
 * with nothing typed — so this diffs against what's currently ON SCREEN before
 * calling anything. Without that, tabbing through the grid would silently
 * stamp the bank's own string into the override field on every row it passed,
 * which would look like nothing happened and be a lie in the audit trail.
 * Emptying the cell CLEARS a rename (the provider's name comes back); emptying
 * a row that was never renamed is a no-op, and the text snaps back.
 *
 * THE HISTORY ICON renders only on a row that has actually been renamed
 * (`hasMerchantRenameHistory`, server-resolved) — the owner asked for the
 * affordance on renamed rows, and an icon on all 200 rows of a reconcile queue
 * is noise. It survives a clear: a row renamed and then un-renamed still has a
 * story worth reading.
 *
 * ON A READ-ONLY ROW (a foreign book in the merged queue, or a peek) the NAME
 * goes flat — a `Text`, not an input, so there is nothing to focus and nothing
 * that could commit — but THE HISTORY ICON STAYS LIVE. Reading what a row used
 * to be called is exactly the question a reviewer looking at someone else's
 * ledger has, and `financeAuditTrail` is already gated and scoped server-side,
 * so nothing here is what decides whether they may see it. This is why this
 * cell renders outside the row's read-only wrapper; see the call site for why
 * that exception is about reads only.
 */
function MerchantCell({ row, readOnly }: { row: TxnRow; readOnly: boolean }) {
  const renameMerchant = useMutation(api.finances.renameMerchant);
  const clearMerchantRename = useMutation(api.finances.clearMerchantRename);
  const [historyOpen, setHistoryOpen] = useState(false);
  const shown = displayMerchantName(row);

  function onCommit(next: string) {
    const trimmed = next.trim();
    if (trimmed === shown) return; // untouched — never write, never log
    if (!trimmed) {
      // Emptying the cell means "go back to what the bank called it". With no
      // rename in place there is nothing to go back to, so this is a no-op —
      // `InlineText` re-syncs its text from `value` on the next render.
      if (row.merchantNameOverride == null) return;
      void clearMerchantRename({ transactionId: row.id }).catch(alertError);
      return;
    }
    void renameMerchant({ transactionId: row.id, merchantName: trimmed }).catch(
      alertError,
    );
  }

  return (
    <>
      {readOnly ? (
        // Dimmed to the same 0.55 the rest of the read-only row carries, so
        // hoisting this cell out of that wrapper doesn't make it the one cell
        // that looks editable on a row that isn't.
        <Text
          className="flex-1 px-2 py-1.5 text-sm font-medium text-ink"
          style={{ opacity: 0.55 }}
          numberOfLines={1}
        >
          {shown}
        </Text>
      ) : (
        <InlineText
          value={shown}
          onCommit={onCommit}
          weight="medium"
          maxLength={MAX_MERCHANT_NAME_LENGTH}
        />
      )}
      {row.hasMerchantRenameHistory ? (
        <Pressable
          onPress={() => setHistoryOpen(true)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Name history"
          className="rounded p-1 active:opacity-70 web:hover:opacity-90"
        >
          <Icon name="clock" size={13} color={colors.muted} />
        </Pressable>
      ) : null}
      {historyOpen ? (
        <MerchantHistoryModal
          transactionId={row.id}
          providerName={providerMerchantName(row)}
          currentOverride={row.merchantNameOverride}
          // The trail is readable on a read-only row; un-naming is a WRITE, and
          // a button the server would refuse is the same dead control this
          // change set is removing.
          canClear={!readOnly}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * One fixed-width grid cell.
 *
 * `overflow: "hidden"` is load-bearing, not tidiness. A `View` does not clip by
 * default, and RN-Web gives a sibling `View` `flexShrink: 0` — so a cell whose
 * content is naturally wider than its column (a long "For" chip, the
 * Documentation cell's icon + label + "No receipt") did not truncate, it
 * PAINTED PAST its right edge into the next column. Later siblings paint on
 * top, so the reader saw the Documentation column's text sitting on top of the
 * For column's budget name — reported by the owner as "Day 3 overdue" over
 * "Worship With Strangers · Feb 7, 2026" and "Attached" over "Love Thy
 * Neighbor 2025 · Sep 20, 2025". A column with a fixed width has to keep its
 * content inside that width; anything else is two cells claiming one box.
 *
 * Clipping is the floor, not the whole answer — a hard clip cuts a glyph in
 * half. Content that can outgrow its column truncates gracefully on its own
 * (`OptionTag` caps at `max-w-full` so its `numberOfLines={1}` can ellipsize;
 * `DEFAULT_COLS.receipt` is wide enough for the Documentation cell's longest
 * combination). This is what stops the damage from reaching a neighbour.
 */
function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View
      style={{ width, overflow: "hidden" }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
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
  isPersonal,
  transactionId,
  onUpload,
  generateUploadUrl,
  documentation,
  amountCents,
  readOnly,
  onExceptionFiled,
  libraryPicker,
}: {
  hasReceipt: boolean;
  /**
   * Show the "attach an existing receipt" library picker?
   *
   * REQUIRED, deliberately — no default. The picker reads
   * `receipts.listReceipts`, which is bookkeeper-gated, and a Convex query
   * throws the moment it mounts; on a member-facing surface that unwinds to
   * the root ErrorBoundary and replaces the entire page. When this defaulted
   * to `true`, `ChargeRow` — the row on `/code`, whose whole audience is
   * people with NO finance seat — silently inherited the picker and could
   * crash the page out from under a volunteer. Every other host was passing
   * `false` correctly; the default is what made the one miss invisible.
   *
   * `true` only where every caller is bookkeeper+ (the Reconcile grid).
   */
  libraryPicker: boolean;
  reminderStage: "none" | "flagged" | "escalated";
  /** BELT, not the primary fix: `convertChargeToPersonalRepayment` now clears
   *  `receiptReminderStage` the moment a charge is flagged personal, so a
   *  freshly-flagged row never carries a stale stage going forward. This prop
   *  guards the DISPLAY too, for rows that were already escalated before that
   *  fix shipped — nobody is ever going to attach a receipt to a charge that
   *  isn't the org's, so "Day N overdue" on a personal row is always wrong,
   *  no matter what the field says. No migration needed to backfill those
   *  rows; this suppresses the symptom at read time instead. Optional and
   *  defaults to `false` so any future call site whose row projection
   *  doesn't carry `isPersonal` keeps rendering the raw `reminderStage`
   *  rather than the guard silently no-op'ing — every current caller
   *  (Reconcile grid, ChargeRow, TransactionDetailModal, MoneyView) wires
   *  it through. */
  isPersonal?: boolean;
  /** Which transaction this cell's receipt(s) belong to — powers the
   *  "Attached" chip's tap-to-view (`ReceiptViewerModal`, below). Optional so
   *  an existing call site outside this PR's file boundary (`money/MoneyView.tsx`)
   *  keeps compiling unchanged; omitting it just falls back to the old inert
   *  chip rather than opening a viewer. */
  transactionId?: Id<"transactions">;
  /** `filename` is the name of the file the human picked, or `null` when there
   *  genuinely isn't one (a native camera-roll pick). Every caller forwards it
   *  to `finances.attachReceipt` so the receipt row records what it is — see
   *  that mutation's doc. */
  onUpload: (storageId: Id<"_storage">, filename: string | null) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
  /** What actually backs this row up (`listReconcile`'s `documentation`).
   *  Absent on the call sites that only know `hasReceipt` (MoneyView), which
   *  keeps the old receipt-only rendering — the cell never GUESSES a
   *  documentation state it wasn't given. */
  documentation?: {
    state: "receipt" | "exception" | "undocumented";
    reasonLabel: string | null;
    pendingReason: string | null;
  };
  /** Amount, for the exception modal's second-approver hint. */
  amountCents?: number;
  /** Called after an exception is filed from this cell, so the grid can
   *  refresh optimistically. */
  /** Peek / below-bookkeeper: a pending exception stays readable, not decidable. */
  readOnly?: boolean;
  onExceptionFiled?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [noDocOpen, setNoDocOpen] = useState(false);
  const [decideOpen, setDecideOpen] = useState(false);
  const attestException = useMutation(api.receiptExceptions.attest);

  async function uploadBlob(blob: Blob, contentType: string, filename: string | null) {
    setBusy(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = await res.json();
      await onUpload(storageId as Id<"_storage">, filename);
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
      if (file) {
        void uploadBlob(file, file.type || "application/octet-stream", file.name || null);
      }
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
    await uploadBlob(
      blob,
      asset.mimeType || blob.type || "image/jpeg",
      asset.fileName ?? null,
    );
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
  // ACKNOWLEDGED: an approved exception documents this row. Reads as a settled
  // state, not a warning — the whole point is that "we know, we wrote down
  // why, we moved on" is a legitimate resting place, not a permanent nag.
  if (documentation?.state === "exception") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-2 py-1.5">
        <Icon name="edit-3" size={14} color={colors.muted} />
        <Text className="flex-1 text-sm text-muted" numberOfLines={1}>
          {documentation.reasonLabel ?? "No receipt"}
        </Text>
      </View>
    );
  }

  // A personal charge never shows the overdue/flagged badge — see the prop
  // doc above. Treated as `reminderStage: "none"` regardless of what the row
  // actually carries.
  const escalated = !isPersonal && reminderStage === "escalated";
  const flagged = !isPersonal && reminderStage === "flagged";
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
            (see the prop doc); hidden while an upload is in flight.
            ALSO hidden for a cardholder (`libraryPicker={false}`): every query
            behind `ReceiptAttachPicker` is bookkeeper+ gated, so on the member
            coding sheet — where this cell now renders — it would open a search
            box that is permanently empty and read as "we lost your receipts".
            A cardholder reaches their own inbound receipts through the
            suggestions in the coding sheet instead, which is the member-safe
            read (`receipts.suggestedForTransaction`). */}
        {transactionId && !busy && libraryPicker !== false ? (
          <Pressable
            onPress={() => setAttachOpen(true)}
            hitSlop={6}
            accessibilityLabel="Attach an existing receipt"
            className="ml-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon name="search" size={13} color={colors.faint} />
          </Pressable>
        ) : null}
        {/* "There is no receipt for this" — the third option alongside upload
            and search, right where a bookkeeper already is. Before this it
            existed only in the dashboard drill-down's detail panel, which is
            not where anyone reconciles. */}
        {transactionId && !busy && documentation ? (
          documentation.pendingReason ? (
            // Was inert text. Filing an exception worked from the grid but deciding
            // one only existed in the dashboard drill-down's detail panel — the same
            // asymmetry noted above for filing, and it stranded exactly the person
            // working the receipt chase.
            <Pressable
              onPress={() => setDecideOpen(true)}
              hitSlop={6}
              accessibilityLabel={
                readOnly ? "View this receipt exception" : "Decide this receipt exception"
              }
              className="ml-1 active:opacity-70 web:hover:opacity-90"
            >
              <Text className="text-2xs text-warn underline" numberOfLines={1}>
                Awaiting approval
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => setNoDocOpen(true)}
              hitSlop={6}
              accessibilityLabel="There is no receipt for this"
              className="ml-1 active:opacity-70 web:hover:opacity-90"
            >
              <Text className="text-2xs text-faint">No receipt</Text>
            </Pressable>
          )
        ) : null}
      </View>
      {decideOpen && transactionId ? (
        <ReceiptExceptionDecideModal
          transactionId={transactionId}
          amountCents={amountCents ?? 0}
          readOnly={readOnly ?? false}
          onClose={() => setDecideOpen(false)}
          onError={() => setDecideOpen(false)}
        />
      ) : null}
      {noDocOpen && transactionId ? (
        <ReceiptExceptionModal
          amountCents={amountCents ?? 0}
          onCancel={() => setNoDocOpen(false)}
          onConfirm={({ reason, note, evidenceStorageIds }) => {
            void (async () => {
              try {
                await attestException({
                  transactionId,
                  reason,
                  note,
                  ...(evidenceStorageIds.length ? { evidenceStorageIds } : {}),
                });
                setNoDocOpen(false);
                onExceptionFiled?.();
              } catch (err) {
                alertError(err);
              }
            })();
          }}
        />
      ) : null}
      {attachOpen && transactionId ? (
        <ReceiptAttachPicker
          transactionId={transactionId}
          onClose={() => setAttachOpen(false)}
        />
      ) : null}
    </>
  );
}
