/**
 * RECONCILE — the bookkeeper's inline-editable grid for coding & clearing charges.
 *
 * A single spreadsheet-style table (the `people.tsx` grid pattern): every charge
 * is a row whose Category / For / Status edit inline (dropdowns, commit per
 * row) and whose receipt uploads inline. Coding = Category + For only — the
 * fund is hidden and defaulted to the General Fund server-side.
 *
 * The "For" picker (WP-U: one home per dollar) replaces the old separate
 * Budget + Link pickers with ONE picker, grouped Events / Projects / Recurring
 * — built from `finances.forPickerOptions` (see `forPicker.ts`). WP-wave4
 * (item 5, owner addendum 2026-07-17): only a ref with an APPROVED budget is
 * ever offered — `forPickerOptions` filters server-side
 * (`isAttributableBudget`), so a picked value is always a real `budgetId`
 * already; the old "summon a $0 budget on pick" flow is retired.
 *
 * Filtering is SERVER-SIDE via `listReconcile({ filter })`, so each pill is
 * truthful across ALL of the chapter's charges (not just one page) and carries a
 * live count. Multi-select drives a bulk bar (set Category / set For / mark
 * Reconciled).
 *
 * Reconciliation is finance-manager/bookkeeper territory. Gated on the caller's
 * REAL finance seats (`financeRoles.mySeats`, WP-0.2) — same fix as the Cards
 * and Reimbursements tabs, and for the same reason: the queries this grid reads
 * (`listReconcile` / `listCategories` / `forPickerOptions`) require at least the
 * viewer finance role and THROW for anyone without one, and Convex queries fire
 * as soon as a component mounts regardless of any later conditional return in
 * its render. The former admin-or-lead org-tier gate didn't stop that — a
 * tier=admin/lead caller with no `financeRoles` grant (or any no-seat member
 * who deep-links straight to `/finances/reconcile`) still mounted this screen's
 * hooks and crashed on the throw (the [hotfix] crash class). `ReconcileGrid` is
 * the FinanceBoundary-wrapped inner component so a role throw degrades to a
 * friendly empty state instead of the root error boundary.
 *
 * ── THE SIDE PANEL (wide screens) ────────────────────────────────────────────
 * Founder, verbatim: "if I'm seeing a database view when I'm coding, I'm gonna
 * have to be able to see the receipts really well, like maybe in a side panel";
 * "information that helps me quickly click in and click out, rather than a
 * modal that's in the middle of the screen that blocks your ability to see
 * other things." THIS is the database view she meant, and it was the one
 * surface still answering with a modal: a row opened
 * `TransactionDocumentationModal`, and its receipt opened `ReceiptViewerModal`
 * on top — except two `<Modal>`s can't both be open, so looking at a receipt
 * while typing its explanation was not merely awkward here, it was impossible.
 *
 * At ≥`WIDE_MIN_WIDTH` a selected row now opens `CodingWorkbenchPanel` to the
 * RIGHT of the grid, list still visible and scrollable to its left, clicking
 * another row swapping the panel's content in place. Same component, same
 * layout idiom, same threshold as `explain.tsx` and `coding.tsx` — a third
 * home for the panel, not a second kind of panel. Narrow screens keep the
 * modal, untouched; `showPanel` below is the only branch point between them.
 *
 * WHAT THE PANEL IS GIVEN, and what it deliberately isn't:
 *  - `txn` — a `listReconcile` row IS a `txnSummary` (`reconcileRow` spreads
 *    `txnSummaryFields`), so no re-shaping is needed; two OPTIONAL summary
 *    fields that only `monthCodingWorklist` normally fills get filled from
 *    this row's own richer data instead (see `panelTxn`).
 *  - `ownCharge: false` — these rows are the whole book, not the caller's own
 *    charges (the same reading `explain.tsx` takes, and what makes the panel's
 *    category write use the bookkeeper-gated mutation).
 *  - `canViewReceiptList` — probed ONCE PER SCREEN, never per row (see
 *    `coding.tsx`'s module doc for why per-row is the wrong shape). This grid
 *    admits a finance VIEWER, and `receipts.listForTransaction` is
 *    bookkeeper+, so the answer here genuinely can be `false`.
 *  - NOT `todo` — `chargeTodo`'s chase semantics call a `reconciled` row
 *    settled, and most of this grid is reconciled. Correct for chasing a
 *    cardholder, wrong for a book. `explain.tsx` omits it for the same reason.
 *  - NOT `canRename` — the rename affordance stays in the Merchant column,
 *    which remains on screen beside the panel. Two live rename fields on one
 *    screen would be two, not one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  useWindowDimensions,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Button,
  EmptyState,
  FilterSelect,
  FULL_WIDTH,
  Icon,
  InfoTooltip,
  Narrow,
  Pill,
  Screen,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { useChapterContext } from "../../../lib/ChapterContext";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import {
  ReconcileList,
  type PickerItem,
} from "../../../components/finance/reconcile/ReconcileList";
import { BulkBar } from "../../../components/finance/reconcile/BulkBar";
import { CodingWorkbenchPanel } from "../../../components/finance/coding/CodingWorkbenchPanel";
import {
  indexOfSelected,
  panelPosition,
  selectionAfterRowsShrink,
  stepSelection,
} from "../../../components/finance/coding/panelNav";
import {
  ViewMenu,
  activeView,
  type BookView,
} from "../../../components/finance/reconcile/ViewMenu";
import { BulkNoDocumentationModal } from "../../../components/finance/modals/BulkNoDocumentationModal";
import type { ReceiptExceptionReason } from "@events-os/shared";
import type { ActionToast } from "../../../lib/useActionToast";
import { buildForPickerItems } from "../../../components/finance/reconcile/forPicker";
import {
  MarkTransferModal,
  type TransferLegPreview,
} from "../../../components/finance/modals/MarkTransferModal";
import {
  MarkPayoutModal,
  type PayoutAllocationChoice,
} from "../../../components/finance/modals/MarkPayoutModal";
import { MoveBookModal } from "../../../components/finance/modals/MoveBookModal";
import {
  CENTRAL,
  RECONCILE_DROPDOWN_GROUPS,
  RECONCILE_HEADER_CHIPS,
  RECONCILE_FILTER_LABELS,
  displayMerchantName,
  formatCents,
  parseReconcileFilters,
  serializeReconcileFilters,
  type PayoutProcessor,
  type ReconcileFilterKey,
} from "@events-os/shared";

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Reconcile is restricted"
      message="Only finance managers and bookkeepers can reconcile transactions."
    />
  );
}

/** Real gate: the caller's actual finance seats. No seat → an empty state,
 *  never `ReconcileGrid` (whose queries throw for a no-role caller). */
export default function ReconcileScreen() {
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (seats === undefined) return <Screen loading />;

  if (seats.length === 0) {
    return (
      <Screen>
        <Narrow>
          <NoFinanceAccess />
        </Narrow>
      </Screen>
    );
  }

  return (
    <FinanceBoundary fallback={<NoFinanceAccess />}>
      <ReconcileGrid />
    </FinanceBoundary>
  );
}

/**
 * Which BOOKS this grid is reading. Central and each chapter keep separate
 * books (separate operating entities under one legal entity — see
 * `finances.ts#reconcileBook`), and until now this screen could only ever show
 * one at a time while the header's `ScopeBadge` said something else: a caller
 * sitting at the Central desk got a badge reading "Central — all chapters" over
 * a grid silently pinned to "My chapter". Two scope controls, neither aware of
 * the other.
 *
 * Now: `"all"` is the merged queue (every book at once — the dual-hat default),
 * `"central"` and `"chapter"` narrow to one. The initial value FOLLOWS THE DESK
 * (`ChapterContext`) instead of always starting at "chapter", so the badge and
 * the grid can't disagree on arrival.
 */
type BookScope = "all" | "central" | "chapter";

/** Selector order: broadest first, so "All books" reads as the default it is. */
const BOOK_SCOPES: BookScope[] = ["all", "central", "chapter"];

/** The chapter pill says the chapter's real name ("New York"), never a generic
 *  "My chapter" — see the selector's own comment for why. Falls back to the
 *  generic wording only if the chapter's name hasn't resolved yet. */
function bookScopeLabel(scope: BookScope, ownChapterName: string | null): string {
  if (scope === "all") return "All books";
  if (scope === "central") return "Central";
  return ownChapterName ?? "My chapter";
}

/** `Jul 2026` / `YTD through Jul 2026` — the period-scope pill's label. */
function periodLabel(year: number, month: number, mode: "month" | "ytd"): string {
  const name = new Date(2000, month - 1, 1).toLocaleDateString("en-US", { month: "long" });
  return mode === "ytd" ? `YTD through ${name} ${year}` : `${name} ${year}`;
}

/**
 * How many rows the grid asks for, and how much further "Load more" reaches.
 * Matches `listReconcile`'s own default so the first request is the cheap one
 * the server is tuned for.
 */
const PAGE_STEP = 100;

/** Below this window width the side panel doesn't fit next to a readable
 *  grid — the SAME threshold `explain.tsx` and `coding.tsx` use for the same
 *  panel (and `CentralView`/`ChapterView`'s `STACK_WIDTH`), so "wide" means
 *  one window width everywhere in finance. */
const WIDE_MIN_WIDTH = 900;

/**
 * `value`, but only after it has stopped changing for `ms`.
 *
 * Search moved SERVER-SIDE (it has to — it was searching only the rows the
 * active filter had already left behind), so every keystroke is now a new query
 * subscription. Debouncing keeps a typed word to one round-trip instead of one
 * per character.
 */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function ReconcileGrid() {
  // WP-dashboard-drill: optional deep-link params (e.g. from the central
  // dashboard's "Reconcile centrally →" affordance) — override the initial
  // state only; the pills/toggle remain fully interactive afterward. Unknown
  // or malformed values fall back to the existing defaults, never throw.
  //
  // no-dead-numbers: `year`/`month`/`period` — set by a dashboard "Spent"
  // tile's drill-through (`?filter=spend&year=…&month=…&period=…`) — scope
  // the grid to the SAME window that tile summed (see `listReconcile`'s own
  // doc comment). Absent (the pre-existing deep links, and a plain visit to
  // this tab) → the original all-time bounded-recent behavior, unchanged.
  const params = useLocalSearchParams<{
    filter?: string;
    filters?: string;
    scope?: string;
    // A SPECIFIC chapter's book, by id — how the central dashboard's per-book
    // "to review" chips open one chapter's queue without first switching the
    // whole app's desk into peek. Previously the only way to read another
    // chapter's queue here was to already be peeking (`ChapterContext`), so a
    // deep link couldn't express it at all. Server-gated identically either
    // way (`listReconcile`'s `chapterId` re-checks central reach).
    chapterId?: string;
    year?: string;
    month?: string;
    period?: string;
  }>();
  const router = useRouter();
  // The filter SELECTION — a set, not a bucket. `?filters=a,b` is the current
  // form; `?filter=a` (singular) is still honoured for dashboard drill-throughs
  // and older shared links, including the pre-rename `uncategorized`/`ready`
  // spellings.
  //
  // NOTHING IS SELECTED ON ARRIVAL. This used to seed `["needs_budget"]`, which
  // opened the money app on 14 of 346 rows — and of those 14, two were work: 8
  // were machine-generated processor-fee rows blocked on one budget approval, 4
  // were already `reconciled`, and the largest dollar figure in the view was a
  // transfer that shouldn't have counted as spend at all. Meanwhile the header
  // announced 127, and the relationship between the two numbers was stated
  // nowhere.
  //
  // Those 8 fee rows are gone from the facet altogether now — `needsBudget`
  // exempts non-discretionary fees, because a budget is a control on CHOICE and
  // a fee is charged rather than chosen. The remaining two faults are what this
  // change fixes.
  //
  // The person opening this page is doing one of two things: "what happened
  // since I last looked" (newest-first, no filter) or "where is that
  // transaction" (search). A default filter serves neither, and it actively
  // broke the second — search only ever saw the rows the filter had left. The
  // daily worklist is a real third job, and it now gets a ONE-TAP affordance in
  // the header (the chips) rather than a silent pre-selection.
  const initialFilters: ReconcileFilterKey[] = (() => {
    const fromSet = parseReconcileFilters(params.filters);
    if (fromSet.length > 0) return fromSet;
    return parseReconcileFilters(params.filter);
  })();

  const [filters, setFilters] = useState<ReconcileFilterKey[]>(initialFilters);
  // Every change writes `?filters=` back, the same "URL = state" rule the books
  // selector follows — a filtered view is shareable and survives a refresh, and
  // a screenshot of one can be reproduced. `null` clears the param rather than
  // leaving `?filters=` empty in the bar.
  function applyFilters(next: ReconcileFilterKey[]) {
    setFilters(next);
    router.setParams({ filters: serializeReconcileFilters(next) ?? "" });
    clearSelectionRef.current?.();
  }
  function toggleFilter(key: ReconcileFilterKey) {
    applyFilters(
      filters.includes(key) ? filters.filter((k) => k !== key) : [...filters, key],
    );
  }
  function clearGroup(keys: readonly ReconcileFilterKey[]) {
    applyFilters(filters.filter((k) => !keys.includes(k)));
  }
  // `clearSelection` is defined further down (it needs `setSelected`); a ref
  // keeps these handlers above it without a forward-reference.
  const clearSelectionRef = useRef<(() => void) | null>(null);
  const [query, setQuery] = useState("");
  // What the SERVER searches. See `listReconcile`'s `search` arg: the query
  // runs over the whole book and stands the State filter down for that request,
  // which is the only way the box can find a row the current filter excludes.
  const debouncedQuery = useDebouncedValue(query, 200);
  // How many rows the server is currently shipping. Grows on "Load more"
  // instead of accumulating pages on the client: the query is reactive, so a
  // growing limit stays ONE live, consistent list, where stitched-together
  // snapshots would let a concurrent edit make two pages disagree.
  const [pageSize, setPageSize] = useState(PAGE_STEP);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The row the wide-screen side panel is showing (see the module doc). Stays
  // `null` on a narrow screen — nothing there can ever set it, which is what
  // keeps the narrow behavior exactly what it was.
  const [openId, setOpenId] = useState<string | null>(null);
  // Same threshold `explain.tsx`/`coding.tsx` use for this same panel.
  const isWide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
  const [noDocOpen, setNoDocOpen] = useState(false);
  const [noDocBusy, setNoDocBusy] = useState(false);
  // Result summary for the bulk acknowledge. `useActionRunner`'s own toast is
  // error-only, and this one has to report a SUCCESS with counts — how many
  // were filed, how many still need a second approver, how many were skipped.
  // Silence would be the wrong answer here: the caller just wrote a record
  // against every row they had selected.
  const [noDocSummary, setNoDocSummary] = useState<ActionToast | null>(null);

  const parsedYear = params.year ? Number(params.year) : undefined;
  const periodYear = parsedYear != null && !Number.isNaN(parsedYear) ? parsedYear : undefined;
  const parsedMonth = params.month ? Number(params.month) : undefined;
  const periodMonth =
    parsedMonth != null && !Number.isNaN(parsedMonth) ? parsedMonth : undefined;
  const periodMode: "month" | "ytd" = params.period === "ytd" ? "ytd" : "month";
  const hasPeriodScope = periodYear != null;
  // Fixed for the life of this deep-linked visit — there's no picker for it
  // here (unlike the dashboards' own `MonthStepper`/`PeriodSwitch`); "Clear"
  // drops back to the ordinary, unscoped Reconcile view.
  const clearPeriodScope = () => router.replace("/finances/reconcile" as never);

  // WP-2.1: central-seat holders can switch which BOOKS this grid reads.
  // `mySeats` resolves their real seats; a central seat unlocks the selector
  // (and, with it, the merged all-books queue).
  const seats = useQuery(api.financeRoles.mySeats, {}) ?? [];
  const hasCentralSeat = seats.some((s) => s.scope === "central");
  const { context, chapterSeats, peekChapters } = useChapterContext();
  // Every chapter this caller can name: their own desks, plus (central-seat
  // holders only) every peekable chapter — the same two lists the shell's
  // context pill is built from, so this can't name a chapter the shell won't.
  const chapterNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of chapterSeats) m.set(s.chapterId, s.chapterName);
    for (const p of peekChapters) m.set(p.chapterId, p.name);
    return m;
  }, [chapterSeats, peekChapters]);
  // The desk the shell says the caller is at, mapped to the book this grid
  // should open on. A central-desk caller lands on the MERGED queue: that desk's
  // badge promises "Central — all chapters", and a merged queue is the only
  // reading of it that's true. A chapter desk (or a peek) opens on that
  // chapter's book alone. `?scope=` in the URL still wins when present — a
  // shared link is explicit about which books it meant.
  const deskScope: BookScope =
    context?.kind === "seat" && context.scope === "central" ? "all" : "chapter";
  const paramScope: BookScope | null =
    params.scope === "central"
      ? "central"
      : params.scope === "all"
        ? "all"
        : params.scope === "chapter"
          ? "chapter"
          : null;
  const [scope, setScope] = useState<BookScope>(paramScope ?? deskScope);
  // `context` is `null` on the first render (ChapterContext resolves its
  // queries async), so the initial state above can only ever see the
  // "chapter" fallback — applying the desk default has to happen in an effect,
  // once the desk is actually known. This ALSO keeps the grid following later
  // desk switches: flipping the shell's context pill from Central to a chapter
  // while sitting on this screen moves the books with it, which is the whole
  // point of the fix (the header badge and the grid used to be able to say
  // different things indefinitely). A `?scope=` in the URL wins on arrival —
  // a shared link is explicit — but only for that first resolve; after it,
  // the desk drives, exactly like `finances/index.tsx`'s own scope sync.
  const lastDeskRef = useRef<BookScope | null>(null);
  useEffect(() => {
    if (!context) return; // desk not resolved yet
    if (lastDeskRef.current === deskScope) return;
    const isFirstResolve = lastDeskRef.current === null;
    lastDeskRef.current = deskScope;
    if (isFirstResolve && paramScope) return;
    setScope(deskScope);
    setSelected(new Set());
  }, [context, deskScope, paramScope]);
  // A non-central caller passing `?scope=central`/`?scope=all` harmlessly falls
  // back to their own chapter's book here, same as the selector already does —
  // no new authz surface (the server still gates both on central reach, via
  // `requireFinanceCentral` and `requireAllBooksReconcile` respectively).
  const centralScope = scope === "central" && hasCentralSeat;
  const allBooksScope = scope === "all" && hasCentralSeat;

  // WP-dashboard-drill Phase 2: a central caller PEEKING into a chapter that
  // isn't their own home chapter — `listReconcile`'s `chapterId` arg (added
  // by #228) reads THAT chapter's queue, server-side re-verified against
  // central reach exactly like `dashboardChapter`'s own drill-down. Peek is
  // READ-ONLY everywhere else in the app (see `ChapterContext`'s module doc),
  // and the reconcile WRITE mutations `ReconcileList` calls
  // (`categorizeTransaction`/`setStatus`/etc.) are NOT peek-aware —
  // `requireReconcileTxn` still scopes every write to the caller's own home
  // chapter, so it safely rejects (`NOT_FOUND`, never silently misattributes)
  // an attempt to edit a peeked chapter's row.
  //
  // That rejection is no longer how the user finds out. Every row now carries
  // `book.canEdit`, resolved SERVER-side from the same rule
  // (`finances.ts#reconcileBook`), and `ReconcileList` renders a non-editable
  // row read-only — a lock in place of its checkbox, no reachable inline
  // control. This replaces both of the old half-measures: the bulk bar's
  // blanket hide while peeking (it can stay up now, acting only on rows that
  // are genuinely writable) and the single-row edits that were simply left to
  // fail with a toast. Applies identically to a peeked chapter's rows and to a
  // foreign chapter's rows inside the merged all-books queue.
  const peekedChapterId = context?.kind === "peek" ? context.chapterId : undefined;
  // Which chapter's book to read when the scope isn't central/all: an explicit
  // `?chapterId=` (a dashboard chip's deep link) wins over the ambient peek
  // desk, and both fall through to the caller's own chapter server-side.
  //
  // `?chapterId=` is honored ONLY when it names a chapter this caller can
  // actually reach. A typo, a stale bookmark, or an id they've lost access to
  // falls back to the ambient desk instead of reaching the server as a
  // malformed `v.id("chapters")` argument — that's an argument-validation
  // throw, which `FinanceBoundary` (a ConvexError boundary) wouldn't catch.
  // Keeps this screen's standing promise that unknown params degrade to the
  // defaults and never throw.
  const paramChapterId =
    params.chapterId && chapterNameById.has(params.chapterId)
      ? (params.chapterId as Id<"chapters">)
      : undefined;
  const targetChapterId = paramChapterId ?? peekedChapterId;
  // Viewing a chapter that ISN'T the caller's own desk — via a deep-linked
  // chip or an active peek. The page chrome (the `ScopeBadge`, the books
  // selector) is built around the caller's OWN desk, so without naming the
  // viewed chapter explicitly this is the one state where the grid could
  // still show one book while the chrome named another — the exact confusion
  // this change set exists to remove, just relocated. So: the Book column
  // turns on, and the chapter pill takes the viewed chapter's name.
  const ownChapterId = chapterSeats[0]?.chapterId ?? null;
  const viewingForeignChapter =
    targetChapterId != null && targetChapterId !== ownChapterId;
  const viewedChapterName =
    (targetChapterId ? chapterNameById.get(targetChapterId) : null) ??
    chapterSeats[0]?.chapterName ??
    null;

  // no-dead-numbers: the optional period narrowing (see the module doc
  // above) — spread in on top of the scope args below, never overriding
  // them.
  const periodArgs = hasPeriodScope
    ? { year: periodYear as number, month: periodMonth, period: periodMode }
    : {};
  // Filters, search and paging all go to the SERVER. Built once and spread into
  // every scope branch so no branch can drift back to shipping the whole book.
  const listArgs = {
    filters,
    search: debouncedQuery.trim() || undefined,
    limit: pageSize,
    ...periodArgs,
  };
  const reconcile = useQuery(
    api.finances.listReconcile,
    allBooksScope
      ? { ...listArgs, scope: "all" as const }
      : centralScope
        ? { ...listArgs, scope: "central" as const }
        : targetChapterId
          ? { ...listArgs, chapterId: targetChapterId }
          : listArgs,
  );
  // A new selection, a new search or a new book starts at page one — otherwise
  // narrowing to 3 rows would keep asking the server for 400.
  useEffect(() => {
    setPageSize(PAGE_STEP);
  }, [filters, debouncedQuery, scope, targetChapterId]);
  // R1b: "Mark personal" (cards.flagPersonalCharge's manager path) is a
  // manager-only action — a bookkeeper has full Reconcile access but not this.
  // `ReconcileList` ALSO widens the same button to a cardholder's OWN row
  // (founder feedback review) via `reconcile.viewerPersonId` below — that's the
  // other half of `flagPersonalCharge`'s server-side OR-gate.
  //
  // Comes from the SERVER (`listReconcile.viewerIsManager` — the very
  // `getFinanceRole(...).isManager` the mutations gate on), not re-derived here
  // from `mySeats`. The old local test required a `scope:"chapter"` manager
  // seat, which a CENTRAL-scope manager (Executive Director / Financial
  // Manager / superuser) doesn't have: they're manager-everywhere server-side
  // but hold no chapter seat, so this grid hid "Mark personal" and both
  // un-mark affordances from them on every row except their own charges —
  // exactly the "some things it won't let me, the flag just doesn't exist"
  // report. One authority, no drift.
  const isManager = reconcile?.viewerIsManager ?? false;

  // The Chase-receipts destination, carrying this grid's CURRENT scope as
  // route params — mirrors the args object above (minus `filter`, which
  // `receipt-chase.tsx` has no use for) so `receiptChase` resolves the exact
  // same bucket `listReconcile` just counted for the missing_receipt pill.
  const chaseHref = allBooksScope
    ? "/finances/receipt-chase?scope=all"
    : centralScope
      ? "/finances/receipt-chase?scope=central"
      : targetChapterId
        ? `/finances/receipt-chase?chapterId=${targetChapterId}`
        : "/finances/receipt-chase";

  // All chapter categories (no fund filter — coding is category + For only).
  const categories = useQuery(api.finances.listCategories, {}) ?? [];
  // ── THE PANEL'S OWN CATEGORY OPTIONS ──────────────────────────────────────
  // NOT built from `categories` above, even though that list is already here:
  // `listCategories` returns no `expenseTypeHint`, and the hint is what
  // decides which §274(d) proof questions the coding form asks. Handing the
  // panel a hint-less option list would be a silently half-populated input —
  // the form would still render, just asking the generic question set on
  // every category. So the panel reads the SAME member-gated list
  // `explain.tsx` and `coding.tsx` give it. Skipped entirely on a narrow
  // screen, where no panel ever mounts.
  const chargeCategories = useQuery(
    api.finances.myChargeCategories,
    isWide ? {} : "skip",
  );
  const categoryOptions = useMemo(
    () => [
      { value: "", label: "No category" },
      ...(chargeCategories ?? []).map((c) => ({
        value: c.id,
        label: c.name,
        expenseTypeHint: c.expenseTypeHint,
      })),
    ],
    [chargeCategories],
  );
  // ── THE CAPABILITY PROBE, ONCE PER SCREEN ─────────────────────────────────
  // Never per row (see `coding.tsx`'s module doc: a per-row probe 403s the
  // wrong audience over and over). This grid's own floor is a finance VIEWER
  // while `receipts.listForTransaction` is bookkeeper+, so `false` is a real
  // answer here, not a theoretical one — and `undefined` (still resolving)
  // reads as `false` so the panel never fires the gated query speculatively.
  const canViewReceiptList =
    useQuery(api.receipts.canViewList, isWide ? {} : "skip") === true;
  // The "For" picker's option groups (WP-U) — events/projects + recurring
  // budgets by level, every row carrying a real, APPROVED budget (item 5).
  const forOptions = useQuery(api.finances.forPickerOptions, {});

  const bulkCategorize = useMutation(api.finances.bulkCategorize);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const attestBulk = useMutation(api.receiptExceptions.attestBulk);
  const reassignTransactions = useMutation(api.finances.reassignTransactions);
  const markAsTransfer = useMutation(api.finances.markAsTransfer);
  const markAsRefund = useMutation(api.finances.markAsRefund);
  const markAsPayout = useMutation(api.finances.markAsPayout);
  const { run, toast, dismiss } = useActionRunner();

  // WP-2.2: the chapters a central caller may reassign money to/from. Only
  // mounted for central-seat holders (the query is central-gated and throws
  // otherwise) — chapter-only reconcilers skip it.
  const reassignChapters = useQuery(
    api.finances.reassignTargets,
    hasCentralSeat ? {} : "skip",
  );

  const rows = reconcile?.rows ?? [];
  const counts = reconcile?.counts;

  // The scope suffix every cross-screen destination in the view menu carries,
  // built from the SAME resolution `chaseHref` above uses. Threaded, never
  // re-derived at the target: a page that resolves its own scope is how two
  // finance surfaces end up showing different books under the same heading.
  //
  // "ALL BOOKS" IS NOT A BOOK, and these destinations only take one.
  // `monthCodingWorklist` and `publicLedger`'s `scopeValidator` both accept
  // `v.id("chapters") | "central"` and nothing else, so forwarding
  // `?scope=all` failed ARGUMENT VALIDATION before the handler ran and the
  // screen died with a bare "Server Error" — on By month and Publish alike,
  // for every dual-hat holder, because "All books" is their default landing
  // scope. (`chaseHref` below is unaffected: `receiptChase` mirrors
  // `listReconcile`'s scope args, which DO include "all".)
  //
  // Omitted rather than guessed: with no `scope`, each target falls back to
  // the caller's own desk — exactly what it did before these menu entries
  // existed. Picking `central` on their behalf would silently point a
  // chapter treasurer at the wrong book, which is the failure this whole
  // area threads scope to prevent.
  const singleBookScopeQuery = centralScope
    ? "?scope=central"
    : targetChapterId
      ? `?scope=${targetChapterId}`
      : "";

  /**
   * THE VIEWS — saved questions about this one book.
   *
   * The first four re-filter the grid in place. The last three are separate
   * screens because they GROUP or paginate differently (a month biggest-first
   * with a progress meter; the chase list grouped by cardholder; a period's
   * publish console) — not because they're a different subject. Both kinds
   * read as "where do I want to be looking", which is the only question the
   * person opening this menu is asking.
   *
   * Counts come from `counts`, which is server-side and truthful across the
   * whole scope rather than the loaded page — so every number here is one you
   * can actually get to. The routed entries carry no count on purpose: this
   * screen has no honest figure for them, and a guessed one is the exact
   * defect this area keeps repairing.
   */
  const views: BookView[] = [
    {
      key: "attention",
      label: "Needs attention",
      detail:
        "Still unreviewed, or missing a budget, documentation, or money owed back. The pile that needs a decision.",
      filters: ["needs_attention"],
      count: counts?.needs_attention,
    },
    {
      key: "review",
      label: "Waiting on me",
      detail:
        "Explanations somebody submitted and you haven't decided yet — approve, or send back with a note.",
      // Routed, not filtered, even though `coding_review` IS a filter on this
      // grid. The review queue is a purpose-built surface — oldest first
      // (the 60-day clock runs against the ones that have waited longest) and
      // a send-back note field per row — and half-replacing it with a
      // filtered grid would quietly drop both. The filter stays available in
      // the State dropdown for anyone who wants these rows in the grid.
      href: "/finances/coding",
    },
    {
      key: "close",
      label: "Ready to close",
      detail:
        "Categorised, budgeted, documented — and simply never closed. Needs a keystroke, not a decision.",
      filters: ["ready_to_close"],
      count: counts?.ready_to_close,
    },
    {
      key: "everything",
      label: "Everything",
      detail: "The whole book for this desk, newest first, no filter applied.",
      filters: [],
      count: counts?.all,
    },
    {
      key: "month",
      label: "By month",
      detail:
        "Work one month biggest-first, with a progress meter — the backfill view, and where a month gets published from.",
      href: `/finances/explain${singleBookScopeQuery}`,
    },
    {
      key: "chase",
      label: "Chase receipts",
      detail:
        "Everything still owed a receipt, grouped by who spent it, with a nudge button per person.",
      href: chaseHref,
    },
    {
      key: "publish",
      label: "Publish a month",
      detail:
        "Close a month, hand it to a second person, and put it on publicworship.life.",
      href: `/finances/publish${singleBookScopeQuery}`,
    },
  ];
  const currentView = activeView(views, filters);

  // The server has already applied the filter set AND the search, so the grid
  // renders exactly what it was sent. This used to be
  // `filterReconcileRows(rows, query)` — a client-side pass over the rows the
  // filter had already narrowed, which is precisely what made the box unable to
  // find anything the active State filter excluded.
  const displayed = rows;

  // ── SIDE-PANEL SELECTION: stepping, position, and integrity ───────────────
  // `panelRows` is just the ids, in exactly the order the grid renders them,
  // so Prev/Next, the "3 of 42" label and the keyboard shortcut all step
  // through what's ON SCREEN (`panelNav.ts` — one implementation for all
  // three, rather than three hand-rolled `findIndex` calls disagreeing about
  // the ends of the list).
  const panelRows = useMemo(() => displayed.map((r) => ({ id: r.id })), [displayed]);
  const stepRow = (delta: 1 | -1) =>
    setOpenId((current) => stepSelection(panelRows, current, delta) ?? current);
  const openRow = displayed.find((r) => r.id === openId) ?? null;

  // A ROW CAN LEAVE THIS LIST UNDER AN OPEN PANEL, and unlike `explain.tsx`
  // it happens constantly: reconcile it, exclude it, code it while a State
  // filter is on, and the very next query result no longer contains it.
  // `lastKnownIndexRef` tracks the selected row's position while it IS in the
  // list; the moment it isn't, `selectionAfterRowsShrink` lands on whichever
  // row now occupies that same position — the natural next item for someone
  // clearing a queue top to bottom — or closes the panel if the list emptied.
  const lastKnownIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (openId == null) return;
    // NOT while the query is in flight. `useQuery` returns `undefined` on
    // every argument change — "Load more" included — and reading that empty
    // moment as "the row is gone" would close the panel every time the
    // treasurer asked for another page. Absence of an answer isn't an answer.
    if (reconcile === undefined) return;
    const idx = indexOfSelected(panelRows, openId);
    if (idx !== -1) {
      lastKnownIndexRef.current = idx;
      return;
    }
    const next = selectionAfterRowsShrink(panelRows, lastKnownIndexRef.current);
    lastKnownIndexRef.current = next == null ? null : indexOfSelected(panelRows, next);
    setOpenId(next);
  }, [panelRows, openId, reconcile]);

  // A NEW QUESTION CLOSES THE PANEL — a new filter set, a new search, a
  // different book. That's the ONE case the rule above must not apply to:
  // "the row at the old index" is a sensible answer when a row was cleared
  // out from under you, and a nonsense one when you just asked to look at a
  // different set of rows entirely, where index 7 means nothing it used to.
  // Declared AFTER the integrity effect deliberately: both can run in the
  // same commit, and the last write to `openId` has to be this one.
  useEffect(() => {
    setOpenId(null);
  }, [filters, debouncedQuery, scope, targetChapterId]);

  // ── QUICK FLOW: ArrowUp/ArrowDown (and j/k) step the selection through the
  // SAME order the panel's own Prev/Next buttons use — only while the panel
  // is actually open, and only when no text field has focus, so typing "j"
  // into the panel's purpose field, a note, or this screen's own search box
  // never gets eaten by row-stepping. Mirrors `explain.tsx`/`coding.tsx`'s
  // identical effect verbatim. ──
  useEffect(() => {
    if (Platform.OS !== "web" || !isWide || openId == null) return;
    if (typeof document === "undefined") return;
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        stepRow(-1);
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        stepRow(1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWide, openId, panelRows]);

  // WHAT THE PANEL IS HANDED. A `listReconcile` row already IS a `txnSummary`
  // — `reconcileRow` spreads `txnSummaryFields` verbatim — so there is no
  // re-shaping to get wrong here, only two OPTIONAL summary fields that this
  // query doesn't fill and this grid's own richer payload can:
  //   `cardholderName` → the panel's "who do I even ask" line, taken from the
  //     resolved `cardholder` the Cardholder column renders (`null` when the
  //     row resolves nobody — a bank/imported line — which the panel says out
  //     loud rather than leaving blank).
  //   `reconstructed`  → the "Imported record" badge, the same fact this
  //     grid's rows carry as `isReconstructed`.
  // Everything else on a reconcile row (documentation, book, chargedTo, …) is
  // simply extra the panel doesn't read.
  const panelTxn = useMemo(() => {
    if (openRow == null) return null;
    return {
      ...openRow,
      cardholderName: openRow.cardholder?.name ?? null,
      reconstructed: openRow.isReconstructed,
    };
  }, [openRow]);
  // The panel only on a wide screen WITH a row selected — the one branch
  // point between the two frames (mirrors `explain.tsx`'s own `showPanel`).
  const showPanel = isWide && panelTxn != null;

  const searching = debouncedQuery.trim().length > 0;
  // How many rows matched across the WHOLE scope, before paging — so "showing
  // 100 of 346" is a statement about the book, not about the page.
  const matchedCount = reconcile?.matchedCount ?? 0;
  const hasMore = reconcile?.hasMore ?? false;
  const selectionTotals = reconcile?.selectionTotals ?? {
    inCents: 0,
    outCents: 0,
    netCents: 0,
    neutralCount: 0,
  };
  // The server stood the State/roll-up filters down to run this search. Said
  // out loud below: a filter that silently stops applying is the whole defect.
  const searchIgnoredState = reconcile?.searchIgnoredState ?? false;
  // Whether the coding policy has started — gates the two coding filter
  // options, which can't return a row before it does. See the option build.
  const codingArmed = reconcile?.codingArmed ?? false;

  // One option list per GROUP (see `RECONCILE_FILTER_GROUPS` in shared) — the
  // grouping is the whole point: OR within a control widens, AND across the two
  // controls narrows, so "Kind: Spend" + "State: Needs documentation" reads as
  // "the spend that's missing receipts". Counts come straight from the server's
  // facet counts, so every number shown is one the current selection could
  // actually produce.
  //
  // `RECONCILE_DROPDOWN_GROUPS`, not every group: the roll-up keys behind the
  // header chips are a group for set-semantics purposes but must not appear in
  // this menu, where a 51 sitting next to a 7 and a 42 that are subsets of it
  // would recreate the "which number is the real one" problem the chips exist
  // to end.
  const filterOptionsByGroup = useMemo(
    () =>
      RECONCILE_DROPDOWN_GROUPS.map((group) => ({
        group,
        options: group.keys
          // HIDE AN OPTION THAT CANNOT RETURN A ROW. "Needs coding" and
          // "Coding review" both read 0 because the coding policy hasn't
          // started — zero by calendar, not by adoption
          // (`DEFAULT_CODING_REQUIRED_SINCE_MS` is 2026-09-01, and nothing has
          // been coded voluntarily). A menu that offers an option which cannot
          // produce a row teaches people the list is broken, and there were two
          // of them sitting in the middle of it. They come back on their own —
          // either the policy date passes, or a row shows up under one of them.
          .filter(
            (key) =>
              (key !== "uncoded" && key !== "coding_review") ||
              codingArmed ||
              (counts?.[key] ?? 0) > 0,
          )
          .map((key) => ({
            value: key,
            label: RECONCILE_FILTER_LABELS[key],
            count: counts ? counts[key] : undefined,
          })),
      })),
    [counts, codingArmed],
  );

  // Category picker items — "None" (clears) + every chapter category.
  const categoryItems = useMemo<PickerItem[]>(
    () => [
      { value: "", label: "None" },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories],
  );

  // The "For" options a CENTRAL-book row accepts. Central's OWN budgets lead,
  // then — CROSS-BOOK — the chapter's own events/projects/budgets, because a
  // central card genuinely does buy things for a chapter's programme (the
  // founder's case: a Public Worship card paying for something local). The
  // backend admits exactly this via `requireBudgetForCentralTxn`; custody stays
  // central while the budget decides whose programme it counts against, and
  // `transfers.interScopeBalances` books the difference as a receivable.
  //
  // Computed unconditionally (not just in central scope) because the merged
  // all-books queue needs BOTH lists at once: a central row and a chapter row
  // can sit adjacent, each needing its own options.
  const centralForItems = useMemo<PickerItem[]>(() => {
    if (!forOptions) return [{ value: "", label: "None" }];
    const central = forOptions.recurring.filter((r) => r.level === "central");
    const chapterItems = buildForPickerItems({
      ...forOptions,
      // Central's own recurring budgets are listed above under their own
      // heading; don't repeat them inside the chapter grouping.
      recurring: forOptions.recurring.filter((r) => r.level === "chapter"),
    }).filter((i) => i.value !== "");
    return [
      { value: "", label: "None" },
      { value: "__central__", label: "Central", header: true },
      ...central.map((r) => ({ value: r.budgetId, label: r.label })),
      ...(chapterItems.length > 0
        ? [
            {
              value: "__crossbook__",
              label: `${viewedChapterName ?? "Chapter"} · central is fronting this`,
              header: true,
            },
            ...chapterItems,
          ]
        : []),
    ];
  }, [forOptions, viewedChapterName]);

  // "For" picker items (WP-U) — grouped Events / Projects / Recurring. In
  // central scope (WP-2.1) only Recurring · Central budgets are offered — a
  // central-owned txn can't attribute to an event/project or a chapter budget
  // (the backend rejects it; those are chapter-only).
  const forItems = useMemo<PickerItem[]>(() => {
    if (!forOptions) return [{ value: "", label: "None" }];
    if (centralScope) return centralForItems;
    return buildForPickerItems(forOptions);
  }, [forOptions, centralScope, centralForItems]);

  // Reassign targets — "Central" + every active chapter (WP-2.2). Only built for
  // central-seat holders; `undefined` hides the "Reassign to" action entirely.
  const reassignItems = useMemo<PickerItem[] | undefined>(() => {
    if (!hasCentralSeat) return undefined;
    return [
      { value: "central", label: "Central" },
      ...(reassignChapters ?? []).map((c) => ({ value: c.id, label: c.name })),
    ];
  }, [hasCentralSeat, reassignChapters]);

  // Selection lives in a Set keyed by txn id; "in view" = the searched set, so
  // bulk actions only ever touch the rows actually on screen.
  const visibleIds = useMemo(
    () => new Set<string>(displayed.map((r) => r.id)),
    [displayed],
  );
  // In view AND writable. `book.canEdit` is server-resolved (it mirrors
  // `requireReconcileTxn` — see `finances.ts#reconcileBook`), and
  // `ReconcileList` gives a non-writable row a lock instead of a checkbox, so
  // this filter is belt-and-braces: it guarantees no bulk mutation is ever
  // fired at a row the server would reject, however the selection got there
  // (a scope switch mid-selection, a stale id). This replaces the old
  // `viewingPeekedChapter` blanket hide of the bulk bar — the bar can now stay
  // available for the rows a peeking caller CAN write, instead of vanishing.
  const selectedInView = useMemo(
    () =>
      [...selected].filter((id) => {
        if (!visibleIds.has(id)) return false;
        return displayed.find((r) => r.id === id)?.book.canEdit === true;
      }),
    [selected, visibleIds, displayed],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      // Only rows this caller can actually write (`book.canEdit`, server-
      // resolved) — selecting a foreign chapter's row in the merged queue
      // would only ever produce a rejected bulk write. Mirrors `ReconcileList`,
      // which gives those rows a lock instead of a checkbox.
      const selectable = displayed.filter((r) => r.book.canEdit);
      const allSelected =
        selectable.length > 0 && selectable.every((r) => prev.has(r.id));
      const next = new Set(prev);
      if (allSelected) selectable.forEach((r) => next.delete(r.id));
      else selectable.forEach((r) => next.add(r.id));
      return next;
    });
  }
  const clearSelection = () => setSelected(new Set());
  // Changing the filter set changes which rows are on screen, so a selection
  // made under the old set would silently act on rows the treasurer can no
  // longer see. Cleared via a ref because the filter handlers are declared
  // above this (they run on tap, long after both exist).
  clearSelectionRef.current = clearSelection;

  const loading = reconcile === undefined;
  // The old "N to clear" headline was `toClearCount`. It is still computed
  // server-side — it is the honest open-items figure and the thing the two
  // roll-up chips must sum to — but it is no longer rendered on its own,
  // because on its own it conflated 51 rows that needed a decision with 76 that
  // needed a keystroke. The header shows both halves instead
  // (`RECONCILE_HEADER_CHIPS`), which is a strictly more informative way to
  // spend the same pixels.
  // Whether the chase page has anything on it — server-computed over EVERY row
  // in scope, selection included and transfer legs included. This used to read
  // `counts.missing_receipt`, which is a facet count: it narrows with the
  // active filters, and it no longer sees a marked transfer now that the queue
  // hides transfer legs. Either would take the button away while
  // `receiptChase` still had rows to show — and this button is the only route
  // to that page.
  const chaseCount = reconcile?.chaseCount ?? 0;

  const bulkIds = selectedInView as Id<"transactions">[];

  // Which books the current selection spans. Coding (Set category / Set for)
  // is book-specific — a central charge takes neither a category nor a chapter
  // budget — so a selection mixing books has no single valid option list, and
  // offering one would guarantee a partial failure. Book-agnostic actions
  // (Mark reconciled, Reassign, the transfer/payout markings) are unaffected
  // and stay available.
  const selectedRows = useMemo(
    () =>
      selectedInView
        .map((id) => displayed.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => r != null),
    [selectedInView, displayed],
  );
  const selectionHasCentral = selectedRows.some((r) => r.book.id === CENTRAL);
  const selectionHasChapter = selectedRows.some((r) => r.book.id !== CENTRAL);
  const selectionSpansBooks = selectionHasCentral && selectionHasChapter;
  // Category never applies to a central row; "For" needs the matching list.
  const bulkHideCategory = centralScope || selectionHasCentral;
  const bulkForItems = selectionHasCentral ? centralForItems : forItems;

  async function bulkSetCategory(categoryId: string | null) {
    await run(
      () =>
        bulkCategorize({
          transactionIds: bulkIds,
          categoryId: categoryId as Id<"budgetCategories"> | null,
        }),
      { errorTitle: "Couldn't set category" },
    );
  }
  async function bulkSetFor(value: string | null) {
    await run(
      () =>
        bulkCategorize({
          transactionIds: bulkIds,
          budgetId: value ? (value as Id<"budgets">) : null,
        }),
      { errorTitle: "Couldn't set budget" },
    );
  }
  // "Fix who paid" — a CUSTODY rewrite, confirmed before it commits. Picking a
  // target no longer fires the mutation; it stages the target and opens
  // `MoveBookModal`, which names what's being rewritten and points at the "For"
  // column for the case this gets reached for by mistake (see that modal's own
  // doc comment for why the two controls need telling apart).
  const [moveBookTarget, setMoveBookTarget] = useState<string | null>(null);
  const [moveBookBusy, setMoveBookBusy] = useState(false);
  const moveBookTargetName =
    moveBookTarget == null
      ? ""
      : (reassignItems?.find((i) => i.value === moveBookTarget)?.label ?? "another book");

  async function confirmMoveBook() {
    if (!moveBookTarget) return;
    setMoveBookBusy(true);
    try {
      await run(
        () =>
          reassignTransactions({
            transactionIds: bulkIds,
            target:
              moveBookTarget === "central"
                ? ("central" as const)
                : (moveBookTarget as Id<"chapters">),
          }),
        {
          errorTitle: "Couldn't move these charges",
          // Success-only, matching the transfer/payout confirms above: a
          // server refusal leaves the selection intact so it can be corrected
          // rather than silently dropped.
          onSuccess: () => {
            setMoveBookTarget(null);
            clearSelection();
          },
        },
      );
    } finally {
      setMoveBookBusy(false);
    }
  }
  // ── Marking (founder ask) ──────────────────────────────────────────────────
  // Both open a confirm modal rather than committing on the tap: marking moves
  // a row in or out of spend totals, the same weight class as Exclude. The
  // server re-validates everything (pairing, amounts, scope, flow) — these
  // previews only help a bookkeeper catch a mis-pick first.
  const [transferPromptOpen, setTransferPromptOpen] = useState(false);
  const [refundPromptOpen, setRefundPromptOpen] = useState(false);
  const [payoutPromptOpen, setPayoutPromptOpen] = useState(false);
  const [markBusy, setMarkBusy] = useState(false);

  // The two selected rows, resolved back to their display data for the confirm
  // modal. `null` unless exactly two are selected — which is also the only
  // state the bulk bar enables the button in.
  const transferLegs = useMemo<[TransferLegPreview, TransferLegPreview] | null>(
    () => {
      if (selectedInView.length !== 2) return null;
      const picked = selectedInView
        .map((id) => displayed.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => r != null);
      if (picked.length !== 2) return null;
      const [a, b] = picked.map((r) => ({
        id: r.id,
        postedAt: r.postedAt,
        amountCents: r.amountCents,
        flow: r.flow,
        // The name the bookkeeper is LOOKING at in the grid — a confirm
        // prompt that named the row differently from the row it came from
        // would be asking them to verify a pairing they can't recognize.
        label: displayMerchantName(r, "Transaction"),
      }));
      return [a, b];
    },
    [selectedInView, displayed],
  );

  async function confirmMarkTransfer(note: string | null) {
    if (!transferLegs) return;
    setMarkBusy(true);
    try {
      // Close + clear ONLY on success (`run` swallows the rejection and would
      // otherwise close the modal on a server refusal). The refusals here are
      // all "you picked the wrong counterpart" — mismatched amounts, two rows
      // moving the same way, different books — so the selection has to survive
      // for the bookkeeper to correct it.
      await run(
        () =>
          markAsTransfer({
            transactionId: transferLegs[0].id as Id<"transactions">,
            counterpartTransactionId: transferLegs[1].id as Id<"transactions">,
            ...(note ? { note } : {}),
          }),
        {
          errorTitle: "Couldn't mark as transfer",
          onSuccess: () => {
            setTransferPromptOpen(false);
            clearSelection();
          },
        },
      );
    } finally {
      setMarkBusy(false);
    }
  }

  async function confirmMarkRefund(note: string | null) {
    if (!transferLegs) return;
    setMarkBusy(true);
    try {
      // The server wants the charge and the credit named, not just "these two".
      // Ordering them here rather than asking means the bookkeeper selects two
      // rows and is done; a wrong pick still refuses loudly on the server.
      const charge = transferLegs.find((l) => l.flow === "outflow");
      const credit = transferLegs.find((l) => l.flow === "inflow");
      if (!charge || !credit) {
        // The modal already warns on this shape, so reaching here means the
        // preview was bypassed; refuse rather than guess which row is which.
        await run(
          () =>
            Promise.reject(
              new Error(
                "A refund is one charge going out and one credit coming back — pick one of each.",
              ),
            ),
          { errorTitle: "Couldn't mark as refund" },
        );
        return;
      }
      await run(
        () =>
          markAsRefund({
            chargeTransactionId: charge.id as Id<"transactions">,
            refundTransactionId: credit.id as Id<"transactions">,
            ...(note ? { note } : {}),
          }),
        {
          errorTitle: "Couldn't mark as refund",
          onSuccess: () => {
            setRefundPromptOpen(false);
            clearSelection();
          },
        },
      );
    } finally {
      setMarkBusy(false);
    }
  }

  async function confirmMarkPayout(
    processor: PayoutProcessor,
    allocation: PayoutAllocationChoice,
  ) {
    setMarkBusy(true);
    try {
      // A loop over the per-row mutation, same shape as `bulkMarkReconciled`
      // — a month of payouts from one processor is a single action. The
      // "whose money is this?" choice applies to every selected deposit
      // (server-side no-op for rows already sitting on the stated book).
      await run(
        () =>
          Promise.all(
            bulkIds.map((id) =>
              markAsPayout({
                transactionId: id,
                processor,
                ...(allocation.kind === "scope"
                  ? { allocateToScope: allocation.scope }
                  : {}),
              }),
            ),
          ),
        {
          errorTitle: "Couldn't mark as payout",
          // Success-only, same reasoning as the transfer path above — a
          // selection containing an outflow is refused, and the bookkeeper
          // needs it intact to drop that row.
          onSuccess: () => {
            setPayoutPromptOpen(false);
            clearSelection();
          },
        },
      );
    } finally {
      setMarkBusy(false);
    }
  }

  // Acknowledge a whole selection as having no receipts. One attestation per
  // row server-side (`receiptExceptions.attestBulk`), auto-approved for the
  // rows under the org threshold when the caller is a Finance manager — so the
  // realistic case (a pile of transit fares) doesn't just move the work into
  // an approval queue. Rows that can't take one (already receipted, already
  // pending) are skipped and reported rather than failing the batch.
  async function confirmNoDocumentation(args: {
    reason: ReceiptExceptionReason;
    note: string;
  }) {
    setNoDocBusy(true);
    try {
      const res = await run(
        () =>
          attestBulk({
            transactionIds: bulkIds,
            reason: args.reason,
            note: args.note,
          }),
        { errorTitle: "Couldn't acknowledge" },
      );
      if (res) {
        const parts: string[] = [];
        if (res.approved > 0) parts.push(`${res.approved} acknowledged`);
        if (res.pendingApproval > 0) {
          parts.push(`${res.pendingApproval} awaiting a second approver`);
        }
        if (res.skipped > 0) {
          parts.push(`${res.skipped} skipped (already documented)`);
        }
        setNoDocSummary({
          title: "No documentation recorded",
          message: parts.join(" · ") || "Nothing to record.",
        });
      }
      setNoDocOpen(false);
      clearSelection();
    } finally {
      setNoDocBusy(false);
    }
  }

  async function bulkMarkReconciled() {
    await run(
      // No bulk-status mutation: a loop over the idempotent per-row setter is fine.
      () =>
        Promise.all(
          bulkIds.map((id) =>
            setStatus({ transactionId: id, status: "reconciled" }),
          ),
        ),
      { errorTitle: "Couldn't reconcile" },
    );
    clearSelection();
  }

  return (
    // Two columns when the panel is up, one when it isn't — the same wrapper
    // `explain.tsx` and `coding.tsx` use for the same panel. On a narrow
    // screen `showPanel` is always false and this is a plain column around
    // the screen it has always been.
    <View style={{ flex: 1, flexDirection: showPanel ? "row" : "column" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
      <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
          {/* Header — title + "N to clear" (or the searched result count), with
              "Chase receipts" as the page-level action on the right. That
              button used to sit at the end of the filter row, where it wrapped
              onto a line of its own on a phone; a page action belongs in the
              page header, and moving it there costs nothing and buys a row. */}
          <View className="mb-1 flex-row items-center justify-between gap-2">
            {/* THE TITLE IS THE VIEW PICKER (founder: "I don't love all these
                chips and stuff — maybe a drop down"). A rail of pills under a
                bar of pills was two rows of the same thing, which is the
                complaint this whole change exists to answer. The heading the
                page needs anyway carries the menu instead, so nothing is
                added to the screen and the current view is stated in the
                largest type on it. See `ViewMenu`. */}
            <ViewMenu
              views={views}
              active={currentView}
              subtitle={searching ? `${matchedCount} found` : undefined}
              onPickFilters={(next) => applyFilters([...next])}
              onNavigate={(href) => router.navigate(href as never)}
            />
            {chaseCount > 0 ? (
              <Button
                title="Chase receipts"
                variant="ghost"
                size="sm"
                icon="bell"
                onPress={() => router.navigate(chaseHref as never)}
              />
            ) : null}
          </View>

          {/* THE HEADER CHIPS — what replaced "127 to clear".

              That number was one figure doing two jobs. Of 127 open rows in
              production, 51 had something genuinely outstanding and 76 were
              categorised, budgeted, documented and simply never closed: 60% of
              the backlog headline was a keystroke, not a backlog, and there was
              no filter that found them — you could only reach them by scrolling
              346 rows and eyeballing each one. Now each pile is named, counted,
              and one tap away, which is the rule the rest of this area already
              follows: the number you announce has to be a number you can get
              to. `needs_attention + ready_to_close` equals the old total by
              construction (see `flagsFor`), so the header can't drift from the
              grid.

              Hidden while searching — the chips are filters, and a search
              deliberately stands the filters down. */}
          {!searching ? (
            <View className="mb-3 flex-row flex-wrap items-center gap-2">
              {RECONCILE_HEADER_CHIPS.map((key) => (
                <Pill
                  key={key}
                  label={`${counts?.[key] ?? 0} ${RECONCILE_FILTER_LABELS[key].toLowerCase()}`}
                  selected={filters.includes(key)}
                  onPress={() => toggleFilter(key)}
                />
              ))}
            </View>
          ) : null}

          {/* no-dead-numbers: the period-scope banner — only present when a
              dashboard tile's drill-through set `year`/`month`/`period` (see
              the module doc above). "Clear" drops back to the ordinary,
              unscoped view; the rest of the grid (search, other pills, bulk
              actions) stays fully interactive either way. */}
          {hasPeriodScope ? (
            <View className="mb-3 flex-row items-center gap-2">
              <Pill
                label={`Scoped to ${periodLabel(periodYear as number, periodMonth ?? 1, periodMode)} · Clear`}
                selected
                onPress={clearPeriodScope}
              />
            </View>
          ) : null}

          {/* Books selector — central-seat holders choose which books they're
              clearing: all of them at once (the default at the Central desk),
              central's own, or their chapter's. The chapter option is labelled
              with the chapter's REAL NAME, not "My chapter": the header badge
              names it ("New York — chapter finances"), the org chart names it,
              and a generic "My chapter" here was the one place the split went
              anonymous — precisely where a dual-hatted treasurer needs to know
              whose money she's about to edit. */}
          {hasCentralSeat ? (
            <View className="mb-3 flex-row flex-wrap items-center gap-2">
              {BOOK_SCOPES.map((s) => (
                <Pill
                  key={s}
                  label={bookScopeLabel(s, viewedChapterName)}
                  selected={scope === s}
                  onPress={() => {
                    setScope(s);
                    clearSelection();
                    // Keep the URL in sync with the selector (scope must be
                    // unmistakable + deep-linkable/shareable/refresh-safe —
                    // previously only the INITIAL `?scope=` was read; flipping
                    // it left the URL stale, so a screenshot or refresh could
                    // silently land back on a different book).
                    router.setParams({ scope: s });
                  }}
                />
              ))}
            </View>
          ) : null}
          <Text className="mb-4 text-sm text-muted">
            {allBooksScope
              ? "Every book at once — the Book column says which. Code each charge, confirm the receipt, mark it reconciled."
              : "Code each charge, confirm the receipt, mark it reconciled. Edit any cell inline."}
          </Text>

          {/* Search + filter on ONE row — the standard pairing, and the shape a
              filter bar takes in every other CRM-ish screen in this app (the
              giving Donors screen's `FilterSelect` row is the direct
              precedent).

              This replaced a row of nine counted chips, which had been through
              two bad shapes: wrapped, they cost three rows and pushed the first
              transaction below the fold; scrolling horizontally, they fit one
              row but put most of the counts offscreen behind a gesture with no
              affordance — a worse failure, since the counts ARE the worklist.

              A dropdown fixes the thing chips fundamentally couldn't: open it
              and ALL NINE counts are visible at once, grouped by the question
              they answer (see `FILTER_GROUPS`). Closed, it still names the
              active filter and its count, so the current view is never
              ambiguous. One row, nothing hidden, and it scales — a tenth filter
              costs nothing here where it used to cost another wrapped line. */}
          <View className="mb-4 flex-row items-center gap-2">
            <View
              className={`h-9 flex-1 flex-row items-center rounded-md border bg-raised px-3 ${
                searchFocused ? "border-accent" : "border-border-strong"
              }`}
            >
              <Icon name="search" size={16} color={colors.faint} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search merchant, cardholder, amount…"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                className="flex-1 px-2 py-1.5 text-sm text-ink"
              />
              {query.length > 0 ? (
                <Pressable
                  onPress={() => setQuery("")}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                  className="rounded p-1 active:opacity-70"
                >
                  <Icon name="x" size={16} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
            {filterOptionsByGroup.map(({ group, options }) => (
              <FilterSelect
                key={group.id}
                label={group.title}
                values={filters.filter((k) => group.keys.includes(k))}
                options={options}
                onToggle={(v) => toggleFilter(v as ReconcileFilterKey)}
                onClear={() => clearGroup(group.keys)}
                anyLabel={group.anyLabel}
                minWidth={240}
              />
            ))}
            <InfoTooltip
              text="Spend: every dollar that counts as actual spend. Transfers: money moving between your own books — hidden from this queue by default, since a transfer owes no coding, no receipt and no close; pick it to see them. Needs budget: categorized but no budget linked — processor and bank fees are excluded, since a fee is charged rather than chosen. Needs documentation: no receipt and no acknowledged reason there isn't one. Undocumented: the same, but counting rows already marked Reconciled too — the backlog to clear before publishing. To review: still Unreviewed — nobody has touched it. Reconciled: already cleared. Personal (unpaid): flagged personal, not yet repaid."
              size={14}
            />
          </View>
          {/* SAY IT OUT LOUD. A search covers the whole book, which means the
              State dropdown the user can still see is not what produced these
              rows. Leaving that unsaid is the original defect wearing different
              clothes: the old build silently intersected the two and returned
              nothing, and nothing on screen explained why. */}
          {searchIgnoredState ? (
            <View className="mb-2 flex-row items-center gap-2">
              <Icon name="info" size={14} color={colors.muted} />
              <Text className="text-xs text-muted">
                Searching the whole book — state filters don’t apply while you
                search.
              </Text>
            </View>
          ) : null}

          {/* WHAT THIS SELECTION ADDS UP TO (founder ask 2026-08-12: "I want
              to see the total figure on the reconcile," not only on the
              dashboard). Server-computed over the WHOLE match set — the same
              population `matchedCount` reports — so it keeps telling the truth
              while the grid pages 100 rows of 346. A client-side sum of loaded
              rows would say something different after every "Load more", which
              is exactly the kind of number that teaches people not to trust
              the screen.

              Money in / money out / net rather than one figure, because the
              queue routinely holds both directions at once and a lone net of
              "$40" over a filtered month answers nothing. */}
          {matchedCount > 0 ? (
            <View className="mb-3 flex-row flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-sunken px-3 py-2">
              <View className="flex-row items-baseline gap-1.5">
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                  In
                </Text>
                <Text className="text-sm text-ink">
                  {formatCents(selectionTotals.inCents)}
                </Text>
              </View>
              <View className="flex-row items-baseline gap-1.5">
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                  Out
                </Text>
                <Text className="text-sm text-ink">
                  {formatCents(selectionTotals.outCents)}
                </Text>
              </View>
              <View className="flex-row items-baseline gap-1.5">
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                  Net
                </Text>
                <Text
                  className={`text-sm font-semibold ${
                    selectionTotals.netCents < 0 ? "text-warn" : "text-ink"
                  }`}
                >
                  {formatCents(selectionTotals.netCents)}
                </Text>
              </View>
              <Text className="text-2xs text-faint">
                {`across ${matchedCount} ${matchedCount === 1 ? "row" : "rows"}`}
              </Text>
              {/* Say why a non-empty selection can still total nothing, rather
                  than letting it read as a broken number. */}
              {selectionTotals.neutralCount > 0 ? (
                <View className="flex-row items-center gap-1">
                  <Text className="text-2xs text-faint">
                    {`${selectionTotals.neutralCount} not counted`}
                  </Text>
                  <InfoTooltip
                    text="Some rows contribute nothing to a book's value by design, so they're left out of these totals: excluded duplicates and bank errors, transfers you've marked as money moving between your own accounts, and processor payout deposits (that revenue is already counted when the gift, ticket or sale was recorded — counting the deposit too would double it)."
                    size={12}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
        </Narrow>

        {/* Bulk action bar (multi-select). `selectedInView` is already
            restricted to rows the caller can WRITE (see its doc comment), so
            the bar appearing at all now means every row under it is
            actionable — no more blanket hide while peeking, and no more
            failed-write toasts from a foreign chapter's rows. */}
        {selectedInView.length > 0 ? (
          <BulkBar
            count={selectedInView.length}
            categoryItems={categoryItems}
            forItems={bulkForItems}
            onSetCategory={bulkSetCategory}
            onSetFor={bulkSetFor}
            onMarkReconciled={bulkMarkReconciled}
            onClear={clearSelection}
            hideCategory={bulkHideCategory}
            spansBooks={selectionSpansBooks}
            reassignItems={reassignItems}
            onReassign={hasCentralSeat ? setMoveBookTarget : undefined}
            onMarkTransfer={() => setTransferPromptOpen(true)}
            onMarkRefund={() => setRefundPromptOpen(true)}
            onMarkPayout={() => setPayoutPromptOpen(true)}
            onNoDocumentation={() => setNoDocOpen(true)}
          />
        ) : null}

        {noDocOpen ? (
          <BulkNoDocumentationModal
            count={selectedInView.length}
            submitting={noDocBusy}
            onCancel={() => setNoDocOpen(false)}
            onConfirm={(args) => void confirmNoDocumentation(args)}
          />
        ) : null}

        {refundPromptOpen && transferLegs ? (
          <MarkTransferModal
            legs={transferLegs}
            submitting={markBusy}
            kind="refund"
            onCancel={() => setRefundPromptOpen(false)}
            onConfirm={(note) => void confirmMarkRefund(note)}
          />
        ) : null}

        {transferPromptOpen && transferLegs ? (
          <MarkTransferModal
            legs={transferLegs}
            submitting={markBusy}
            onCancel={() => setTransferPromptOpen(false)}
            onConfirm={(note) => void confirmMarkTransfer(note)}
          />
        ) : null}
        {moveBookTarget ? (
          <MoveBookModal
            count={selectedInView.length}
            targetName={moveBookTargetName}
            submitting={moveBookBusy}
            onCancel={() => setMoveBookTarget(null)}
            onConfirm={() => void confirmMoveBook()}
          />
        ) : null}

        {payoutPromptOpen ? (
          <MarkPayoutModal
            count={selectedInView.length}
            submitting={markBusy}
            onCancel={() => setPayoutPromptOpen(false)}
            onConfirm={(processor, allocation) =>
              void confirmMarkPayout(processor, allocation)
            }
          />
        ) : null}

        {loading ? (
          <View className="py-14">
            <EmptyState title="Loading transactions…" />
          </View>
        ) : displayed.length === 0 ? (
          searching ? (
            <EmptyState
              icon="search"
              title="No matches"
              // "in this book", not "in this view": the search ran over the
              // whole scope with the State filter stood down, so an empty
              // result really does mean the book doesn't have it. The old copy
              // said "this view" while the view was silently 14 of 346 rows.
              message={`Nothing in this book matches “${query.trim()}”.`}
            />
          ) : (
            <EmptyState
              icon="check-circle"
              title="Nothing in this view"
              message="Try another filter — new charges land here to code and reconcile."
            />
          )
        ) : (
          <>
            <ReconcileList
              rows={displayed}
              categoryItems={categoryItems}
              forItems={forItems}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
              centralScope={centralScope}
              showBook={allBooksScope || viewingForeignChapter}
              ownChapterId={ownChapterId}
              centralForItems={centralForItems}
              isManager={isManager}
              viewerPersonId={reconcile?.viewerPersonId ?? null}
              // The panel seam. `onOpenRow` present ⇔ wide, which is what
              // makes a row's open affordances select instead of opening the
              // modal; `panelOpen` (wide AND something selected) is what
              // makes the grid give up the three columns the panel renders.
              onOpenRow={isWide ? (id) => setOpenId(id) : undefined}
              openRowId={openId}
              panelOpen={showPanel}
            />
            {/* PAGING. The server ships `limit` rows and reports how many
                matched across the whole scope, so this footer states both —
                "Showing 100 of 346" is a fact about the book, not about the
                page, and the count next to the button is what pressing it
                reaches. Absent entirely when everything already fits. */}
            {hasMore ? (
              <View className="items-center gap-2 py-6">
                <Text className="text-xs text-muted">
                  {`Showing ${displayed.length} of ${matchedCount}`}
                </Text>
                <Button
                  title={`Load ${Math.min(PAGE_STEP, matchedCount - displayed.length)} more`}
                  variant="secondary"
                  size="sm"
                  onPress={() => setPageSize((n) => n + PAGE_STEP)}
                />
              </View>
            ) : matchedCount > PAGE_STEP ? (
              <View className="items-center py-6">
                <Text className="text-xs text-muted">
                  {`All ${matchedCount} shown`}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
      <ToastView
        toast={noDocSummary}
        onDismiss={() => setNoDocSummary(null)}
      />
      </View>

      {showPanel && panelTxn ? (
        // Same geometry as the panel's other two hosts, deliberately — this
        // is a third home for one panel, not a second kind of panel.
        <View style={{ width: "44%", maxWidth: 640, minWidth: 380, padding: 16 }}>
          <CodingWorkbenchPanel
            txn={panelTxn}
            categoryOptions={categoryOptions}
            // `listReconcile` rows are the whole book, never the caller's own
            // charges by construction — same reading `explain.tsx` takes, and
            // what routes the panel's category write through the
            // bookkeeper-gated mutation instead of the cardholder's own.
            ownCharge={false}
            onDeselect={() => setOpenId(null)}
            onPrev={() => stepRow(-1)}
            onNext={() => stepRow(1)}
            hasPrev={stepSelection(panelRows, openId, -1) != null}
            hasNext={stepSelection(panelRows, openId, 1) != null}
            position={panelPosition(panelRows, openId)}
            canViewReceiptList={canViewReceiptList}
          />
        </View>
      ) : null}
    </View>
  );
}
