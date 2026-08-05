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
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Button,
  EmptyState,
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
import {
  FILTERS,
  filterReconcileRows,
  parseFilterParam,
  type FilterKey,
} from "../../../components/finance/reconcile/helpers";
import { BulkBar } from "../../../components/finance/reconcile/BulkBar";
import { buildForPickerItems } from "../../../components/finance/reconcile/forPicker";
import {
  MarkTransferModal,
  type TransferLegPreview,
} from "../../../components/finance/modals/MarkTransferModal";
import { MarkPayoutModal } from "../../../components/finance/modals/MarkPayoutModal";
import { MoveBookModal } from "../../../components/finance/modals/MoveBookModal";
import { CENTRAL, type PayoutProcessor } from "@events-os/shared";

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
  // `parseFilterParam` also maps the pre-rename spellings (`uncategorized` →
  // `to_review`, `ready` → `reconciled`) so an old link still lands on the
  // pill it meant. Unknown/absent → the long-standing `needs_budget` default.
  const initialFilter: FilterKey = parseFilterParam(params.filter) ?? "needs_budget";

  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
  const reconcile = useQuery(
    api.finances.listReconcile,
    allBooksScope
      ? { filter, scope: "all" as const, ...periodArgs }
      : centralScope
        ? { filter, scope: "central" as const, ...periodArgs }
        : targetChapterId
          ? { filter, chapterId: targetChapterId, ...periodArgs }
          : { filter, ...periodArgs },
  );
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
  // The "For" picker's option groups (WP-U) — events/projects + recurring
  // budgets by level, every row carrying a real, APPROVED budget (item 5).
  const forOptions = useQuery(api.finances.forPickerOptions, {});

  const bulkCategorize = useMutation(api.finances.bulkCategorize);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const reassignTransactions = useMutation(api.finances.reassignTransactions);
  const markAsTransfer = useMutation(api.finances.markAsTransfer);
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

  // Search narrows the active pill's already-loaded rows, client-side.
  const displayed = useMemo(
    () => filterReconcileRows(rows, query),
    [rows, query],
  );
  const searching = query.trim().length > 0;

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

  const loading = reconcile === undefined;
  // "N to clear" — everything not yet reconciled (the actionable backlog).
  // Reads as the exact complement of the "Reconciled" pill now that that pill
  // is named after what it counts (it was "Ready", which read as the backlog
  // itself — the same number under two opposite-sounding names).
  const toClear = counts ? counts.all - counts.reconciled : 0;

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
        label: r.merchantName ?? r.description ?? "Transaction",
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

  async function confirmMarkPayout(processor: PayoutProcessor) {
    setMarkBusy(true);
    try {
      // A loop over the per-row mutation, same shape as `bulkMarkReconciled`
      // — a month of payouts from one processor is a single action.
      await run(
        () =>
          Promise.all(
            bulkIds.map((id) => markAsPayout({ transactionId: id, processor })),
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
    <>
      <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
          {/* Header — title + "N to clear" (or the searched result count), with
              "Chase receipts" as the page-level action on the right. That
              button used to sit at the end of the filter row, where it wrapped
              onto a line of its own on a phone; a page action belongs in the
              page header, and moving it there costs nothing and buys a row. */}
          <View className="mb-1 flex-row items-center justify-between gap-2">
            <View className="flex-row items-baseline gap-2">
              <Text className="font-display text-2xl text-ink">Reconcile</Text>
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                {searching
                  ? `${displayed.length} of ${rows.length}`
                  : `${toClear} to clear`}
              </Text>
            </View>
            {counts && counts.missing_receipt > 0 ? (
              <Button
                title="Chase receipts"
                variant="ghost"
                size="sm"
                icon="bell"
                onPress={() => router.navigate(chaseHref as never)}
              />
            ) : null}
          </View>

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

          {/* Search — narrows the active pill's rows (merchant, cardholder,
              card last-4, amount) client-side. */}
          <View
            className={`mb-3 flex-row items-center rounded-md border bg-raised px-3 ${
              searchFocused ? "border-accent" : "border-border-strong"
            }`}
          >
            <Icon name="search" size={16} color={colors.faint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search merchant, cardholder, card, amount…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              className="flex-1 px-2 py-2.5 text-base text-ink"
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

          {/* Server-side filter pills, each with its live count.

              ONE HORIZONTALLY-SCROLLING ROW (founder: "redesign these chips to
              be more compact"). Nine filters with counts don't fit a phone's
              width: wrapped, they cost three rows, and with the description and
              search above them the first transaction started below the fold.
              Shrinking the chips alone only recovered one of those rows — the
              labels are the width, not the padding — so they scroll instead,
              the same pattern the finance sub-nav directly above already uses
              (`finances/_layout.tsx`). Every count stays truthful and reachable;
              none of them is hidden behind a "More" affordance, which is the
              usual alternative and the one that makes a number disappear.

              The compact `size="sm"` still applies: it fits ~4 chips per screen
              instead of ~3, so less scrolling to reach the ones on the right.

              "Chase receipts" moved up to the page header (see above) — it's an
              action, not a filter, and it was wrapping onto its own line here.
              `chaseHref` still carries the grid's CURRENT scope through as
              route params, so the list it opens reads the SAME bucket the
              missing_receipt count came from. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, alignItems: "center", paddingRight: 16 }}
            className="mb-4 grow-0"
          >
            {FILTERS.map((f) => (
              <Pill
                key={f.key}
                label={f.label}
                size="sm"
                count={counts ? counts[f.key] : undefined}
                selected={filter === f.key}
                onPress={() => setFilter(f.key)}
              />
            ))}
            <InfoTooltip
              text="Spend: every dollar that counts as actual spend. Needs budget: categorized but no budget linked. Missing receipt: no receipt uploaded. To review: still Unreviewed — nobody has touched it. Reconciled: already cleared. Personal (unpaid): flagged personal, not yet repaid."
              size={14}
            />
          </ScrollView>
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
            onMarkPayout={() => setPayoutPromptOpen(true)}
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
            onConfirm={(processor) => void confirmMarkPayout(processor)}
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
              message={`No charges in this view match “${query.trim()}”.`}
            />
          ) : (
            <EmptyState
              icon="check-circle"
              title="Nothing in this view"
              message="Try another filter — new charges land here to code and reconcile."
            />
          )
        ) : (
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
          />
        )}
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
