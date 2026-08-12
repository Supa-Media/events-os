/**
 * FINANCES · CODING — one screen, two audiences, both first-class.
 *
 * The owner had never seen the cardholder half, and the reason was structural:
 * it lived at `/finances/my-transactions`, which appeared in the tab bar only
 * for members with NO finance seat. Anyone holding a seat — which is everyone
 * who would ever look at this — could reach it by URL and no other way. So the
 * two halves are one tab now, and `/finances/my-transactions` redirects here
 * rather than the two both existing (CLAUDE.md: remove, don't deprecate).
 *
 * The two audiences, in the order they matter to whoever is looking:
 *
 *  1. YOURS TO CODE — the charges you spent and haven't explained yet. Served
 *     by `finances.personTransactions`, which is caller-scoped and needs no
 *     finance grant at all, so a cardholder with no seat gets this tab and the
 *     full `FinishChargeSheet` behind it. This half is first on the page for
 *     everyone, including the FM: your own unexplained spending outranks your
 *     review queue, and putting it second would let it hide behind other
 *     people's work.
 *
 *  2. AWAITING REVIEW — the codings you may decide. Scoped exactly like
 *     Reconcile (`scope: "central" | "all"` + a `chapterId` drill-down,
 *     rendered as All books / Central / <chapter> pills), because it's the
 *     same books, the same people, and the same question. A central reviewer
 *     also gets the per-chapter roll-up above the pills.
 *
 * Somebody with neither half — nothing to code, no review authority — gets no
 * tab at all rather than an empty one (`_layout.tsx` reads the same
 * `workload` query this screen does).
 *
 * No screen title: the tab pill says "Coding" and the ScopeBadge above says
 * which desk you're at. See `cards.tsx` for the same posture.
 *
 * ── THE SIDE PANEL (wide screens) ────────────────────────────────────────────
 * Founder, opening a charge from here on a wide desktop screen: "quickly
 * click in and click out, rather than a modal in the middle of the screen."
 * `CodingWorkbenchPanel` shipped for `explain.tsx` and is REUSED here
 * verbatim — list left, panel right, ≥`WIDE_MIN_WIDTH`, narrow screens
 * unchanged (the modal, `FinishChargeSheet`, byte-identical to before this
 * PR). `todo` is passed through exactly as the modal already passes it — the
 * chase state machine is the correct lens on THIS list (unlike `explain.tsx`,
 * whose rows are the publishing population — see that screen's own doc).
 *
 * THE REASON THIS SCREEN WAS SKIPPED THE FIRST TIME: "Yours to code" is
 * `finances.personTransactions` — reachable by a cardholder with NO finance
 * seat at all, and `receipts.listForTransaction` (what the panel's
 * `ReceiptPane` fetches) needs bookkeeper rank. Auto-fetching on every
 * receipted row would 403 that audience every time the panel opened. So this
 * screen probes ONCE PER SCREEN, not per row (`receipts.canViewList` — the
 * non-throwing `has` form of the exact same `requireFinanceRole(bookkeeper)`
 * gate `listForTransaction` itself runs) and threads the answer down as
 * `canViewReceiptList`. A denied caller's panel still shows the row's own
 * receipt state and its existing upload affordance (`ReceiptPane`'s own
 * module doc) — nothing new is exposed, the fetched preview just isn't
 * attempted.
 */
import { useEffect, useMemo, useState } from "react";
import { Platform, Text, useWindowDimensions, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { DEFAULT_CODING_REQUIRED_SINCE_MS } from "@events-os/shared";
import {
  Button,
  EmptyState,
  HeaderCell,
  Icon,
  InfoTooltip,
  Narrow,
  Pill,
  RadioGroup,
  Screen,
  SectionHeader,
  Table,
  TableHeader,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  ChargeRow,
  FilterChip,
} from "../../../components/finance/myTransactions/ChargeRow";
import { FinishChargeSheet } from "../../../components/finance/myTransactions/FinishChargeSheet";
import {
  chargeTodo,
  parseChargeFilter,
  sortByTodo,
  type ChargeFilter,
  type MyTxnRow,
} from "../../../components/finance/myTransactions/chargeTodo";
import { ChapterWorkload } from "../../../components/finance/coding/ChapterWorkload";
import { CodingWorkbenchPanel } from "../../../components/finance/coding/CodingWorkbenchPanel";
import {
  panelPosition,
  stepSelection,
} from "../../../components/finance/coding/panelNav";
import {
  ReviewQueue,
  type ReviewQueueRow,
} from "../../../components/finance/coding/ReviewQueue";

/** Selector order: broadest first, so "All books" reads as the default it is.
 *  Copied deliberately from `reconcile.tsx` — same pills, same order, same
 *  words, because it is the same choice about the same books. */
type BookScope = "all" | "central" | "chapter";
const BOOK_SCOPES: BookScope[] = ["all", "central", "chapter"];

/** Below this window width the side panel doesn't fit next to a readable
 *  list — same threshold `explain.tsx`'s own wide-panel split uses
 *  (`CentralView`/`ChapterView`'s `STACK_WIDTH`), so "wide" means the same
 *  window width everywhere in finance. */
const WIDE_MIN_WIDTH = 900;

/** Jargon relief for a screen that leans on two terms it never defines
 *  inline. Same vocabulary the Academy teaches
 *  (`finance-coding-your-charges`): coding is the spender's own testimony,
 *  Reconcile is the finance team's book. Kept to two sentences on purpose —
 *  this is an affordance, not a lesson. */
const CODING_VS_RECONCILE_TEXT =
  "Coding is your own words on what a charge bought and who it served, plus the receipt that proves it — together, the record that publishes. Reconcile is the finance team's whole-book view, where categories, budgets, and status live.";

export default function CodingScreen() {
  const router = useRouter();
  // `?filter=uncoded` is the reminder email's deep link, inherited from
  // `/finances/my-transactions` and still honoured — emails already in
  // people's inboxes carry it.
  const params = useLocalSearchParams<{
    filter?: string;
    scope?: string;
    chapterId?: string;
  }>();

  const workload = useQuery(api.transactionCodings.workload, {});
  const transactions = useQuery(api.finances.personTransactions, {});
  const categories = useQuery(api.finances.myChargeCategories, {});
  const policy = useQuery(api.transactionCodings.policy, {});
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();

  const [filter, setFilter] = useState<ChargeFilter>(() =>
    parseChargeFilter(params.filter),
  );
  useEffect(() => {
    setFilter(parseChargeFilter(params.filter));
  }, [params.filter]);

  const [openId, setOpenId] = useState<string | null>(null);

  // Same threshold as `explain.tsx`'s own two-column split (`WIDE_MIN_WIDTH`,
  // above) — "wide" means the same window width everywhere in finance.
  const isWide = useWindowDimensions().width >= WIDE_MIN_WIDTH;

  // ── THE CAPABILITY PROBE, ONCE PER SCREEN ────────────────────────────────
  // Not per row: see the module doc. `undefined` (still loading) reads as
  // `false` here — deliberately conservative, so the panel never fires the
  // gated `listForTransaction` query before this probe has actually
  // resolved to `true`.
  const canViewReceiptList = useQuery(api.receipts.canViewList, {}) === true;

  const orgWide = workload?.orgWide === true;
  // Scope is URL-backed so a drill-down is shareable and survives a refresh —
  // the lesson `reconcile.tsx` learned the hard way (its own comment).
  const scope: BookScope =
    orgWide && (params.scope === "central" || params.scope === "chapter")
      ? params.scope
      : "all";
  const drillChapterId = params.chapterId ?? null;

  const queueArgs = useMemo(() => {
    if (!orgWide) return {};
    if (scope === "central") return { scope: "central" as const };
    if (scope === "chapter" && drillChapterId) {
      return { chapterId: drillChapterId as Id<"chapters"> };
    }
    return { scope: "all" as const };
  }, [orgWide, scope, drillChapterId]);

  const queue = useQuery(api.transactionCodings.reviewQueue, queueArgs);

  const sinceMs = policy?.sinceMs ?? DEFAULT_CODING_REQUIRED_SINCE_MS;

  const rows = useMemo(
    () =>
      (transactions ?? []).map((t: MyTxnRow) => ({
        txn: t,
        todo: chargeTodo(
          {
            postedAt: t.postedAt,
            flow: t.flow,
            status: t.status,
            isPersonal: t.isPersonal,
            hasReceipt: t.hasReceipt,
            hasApprovedException: t.hasApprovedException,
            codingStatus: t.codingState,
          },
          sinceMs,
        ),
      })),
    [transactions, sinceMs],
  );

  const actionableCount = rows.filter((r) => r.todo.actionable).length;
  const visible = useMemo(() => {
    const subset =
      filter === "uncoded" ? rows.filter((r) => r.todo.actionable) : rows;
    return sortByTodo(subset, (r) => ({
      rank: r.todo.rank,
      postedAt: r.txn.postedAt,
    }));
  }, [rows, filter]);

  const categoryOptions = [
    { value: "", label: "No category" },
    ...(categories ?? []).map((c) => ({ value: c.id, label: c.name })),
  ];
  // `openRow` is looked up in `rows` — the caller's WHOLE ledger — not
  // `visible`, which a filter chip can narrow at any moment. A submit inside
  // the panel flips `todo.actionable` to `false` the instant it lands, which
  // would drop the row out of `visible` under the "Needs you" filter right
  // after the one action someone opened the panel to take; looking it up in
  // `rows` instead means the panel just stays open on the same row and shows
  // its new state (the same "no auto-advance on submit" contract
  // `CodingWorkbenchPanel`'s own module doc describes for `explain.tsx`).
  const openRow = rows.find((r) => r.txn.id === openId) ?? null;

  // Prev/Next + the "N of M" position step through exactly what's ON SCREEN
  // (`visible` — the same biggest-first, possibly-filtered list the table
  // below renders), not the whole ledger `openRow` reads from. If the open
  // row falls out of `visible` (the filter case above), `panelNav.ts`
  // degrades it gracefully on its own: `stepSelection` returns no next id and
  // `panelPosition` returns `null` — Prev/Next just disable and the header
  // omits the count, exactly as documented there for a selection that isn't
  // in the list. The panel itself never closes or jumps to a different row
  // because of that; only these two controls notice.
  const panelRows = useMemo(() => visible.map((r) => ({ id: r.txn.id })), [visible]);
  const stepRow = (delta: 1 | -1) =>
    setOpenId((current) => stepSelection(panelRows, current, delta) ?? current);

  const ownChapterName =
    workload?.byChapter.find((b) => b.id === drillChapterId)?.name ?? null;

  function setScope(next: BookScope, chapterId?: string | null) {
    router.setParams({
      scope: next,
      ...(next === "chapter" && chapterId ? { chapterId } : { chapterId: "" }),
    });
  }

  // ── QUICK FLOW: ArrowUp/ArrowDown (and j/k) step through the SAME
  // biggest-first order the panel's own Prev/Next buttons use — only while
  // the panel is actually open (wide screen, a row selected) and only when no
  // text field has focus, so typing into a note, a business purpose, OR the
  // "Awaiting review" section's own send-back note (`ReviewQueue`, rendered
  // below on this same screen) never gets eaten by row-stepping. Mirrors
  // `explain.tsx`'s identical effect verbatim. ──
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

  if (workload === undefined || transactions === undefined) {
    return <Screen loading />;
  }

  const hasReviewQueue = queue != null && queue.rows.length > 0;
  const showReviewSection =
    (workload.awaitingMyReview ?? 0) > 0 || hasReviewQueue || orgWide;

  // The persistent side panel only on a wide screen WITH a row selected —
  // founder: "quickly click in and click out, rather than a modal in the
  // middle of the screen." Narrow screens keep the pre-panel Modal sheet,
  // byte-identical, regardless of width — this is the only branch point
  // between the two (mirrors `explain.tsx`'s own `showPanel`).
  const showPanel = isWide && openRow != null;

  return (
    <View style={{ flex: 1, flexDirection: showPanel ? "row" : "column" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Screen maxWidth={1080}>
          <Narrow>
        {/* ── 1. YOURS TO CODE ─────────────────────────────────────────── */}
        <SectionHeader
          title="Yours to code"
          count={actionableCount > 0 ? actionableCount : undefined}
          titleAccessory={<InfoTooltip text={CODING_VS_RECONCILE_TEXT} />}
        />
        <Text className="mb-3 text-sm text-muted">
          Charges attributed to you, and what each still needs. Coding one means
          saying — in your own words — what it bought, which org work it served,
          and who was there,{" "}
          <Text className="text-ink">
            and attaching the receipt in the same breath
          </Text>
          : the words and the proof are one record. If there is genuinely no
          receipt, say so right there and that counts. It&apos;s what keeps
          money you spent from becoming taxable income to you.
        </Text>

        {rows.length > 0 ? (
          <View className="mb-4 flex-row items-center gap-2">
            <RadioGroup
              accessibilityLabel="Which of your charges to show"
              horizontal
              className="flex-row items-center gap-2"
            >
              <FilterChip
                label={`Needs you${actionableCount > 0 ? ` (${actionableCount})` : ""}`}
                active={filter === "uncoded"}
                onPress={() => setFilter("uncoded")}
              />
              <FilterChip
                label={`All (${rows.length})`}
                active={filter === "all"}
                onPress={() => setFilter("all")}
              />
            </RadioGroup>
            {actionableCount === 0 ? (
              // Has to read true under "All" too, where every finished row is
              // sitting right below it — "Nothing outstanding" used to claim
              // an empty list that wasn't empty. This says what's actually
              // true regardless of which chip is selected: nothing below
              // needs YOU, whatever state it's actually in.
              <View className="flex-row items-center gap-1.5">
                <Icon name="check-circle" size={13} color={colors.success} />
                <Text className="text-xs text-muted">
                  Nothing needs you — what&apos;s below is done, or someone
                  else&apos;s turn.
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            title="No charges of yours"
            message="Charges and entries attributed to you show up here."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="Nothing needs you right now"
            message="Every charge of yours is coded, documented, or with a reviewer."
            action={
              <Button
                title="Show all"
                variant="secondary"
                size="sm"
                onPress={() => setFilter("all")}
              />
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <HeaderCell flex={2}>Transaction</HeaderCell>
              <HeaderCell width={110} align="right">
                Amount
              </HeaderCell>
              <HeaderCell width={185}>Still needs</HeaderCell>
              <HeaderCell width={130}>Receipt</HeaderCell>
              <HeaderCell width={110} align="right">
                {" "}
              </HeaderCell>
            </TableHeader>
            {visible.map((r, i) => (
              <ChargeRow
                key={r.txn.id}
                txn={r.txn}
                todo={r.todo}
                last={i === visible.length - 1}
                selected={showPanel && r.txn.id === openId}
                onOpen={() => setOpenId(r.txn.id)}
                onUpload={async (storageId, filename) => {
                  await run(
                    () =>
                      attachReceipt({
                        transactionId: r.txn.id as Id<"transactions">,
                        storageId,
                        // The filename is what `receiptFileKind` falls back to
                        // when a content type is missing (#614) — dropping it
                        // here would leave PDFs uploaded from this tab
                        // classifying as "unknown" in the viewer.
                        ...(filename ? { filename } : {}),
                      }),
                    { errorTitle: "Couldn't attach receipt" },
                  );
                }}
                generateUploadUrl={generateUploadUrl}
              />
            ))}
          </Table>
        )}

        {/* ── 2. AWAITING REVIEW ───────────────────────────────────────── */}
        {showReviewSection ? (
          <View className="mt-8">
            <SectionHeader
              title="Awaiting review"
              count={
                workload.awaitingMyReview > 0
                  ? workload.awaitingMyReview
                  : undefined
              }
            />
            <Text className="mb-3 text-sm text-muted">
              Codings people have submitted, oldest first — the ones that have
              waited longest are the ones the 60-day clock is running against.
              Approve one only when it would satisfy a stranger reading the
              public ledger; otherwise send it back with a note saying exactly
              what would make it approvable.
            </Text>

            {orgWide && workload.byChapter.length > 0 ? (
              <ChapterWorkload
                rows={workload.byChapter}
                selectedBookId={
                  scope === "central"
                    ? "central"
                    : scope === "chapter"
                      ? drillChapterId
                      : null
                }
                onSelectBook={(bookId) => {
                  if (bookId == null) setScope("all");
                  else if (bookId === "central") setScope("central");
                  else setScope("chapter", bookId);
                }}
              />
            ) : null}

            {orgWide ? (
              <View className="mb-3 flex-row flex-wrap items-center gap-2">
                {BOOK_SCOPES.map((s) => (
                  <Pill
                    key={s}
                    label={
                      s === "all"
                        ? "All books"
                        : s === "central"
                          ? "Central"
                          : (ownChapterName ?? "One chapter")
                    }
                    selected={scope === s}
                    onPress={() => {
                      if (s === "chapter") {
                        // Nothing to drill into until a book is chosen above —
                        // the roll-up is the picker, so the pill only reflects.
                        if (drillChapterId) setScope("chapter", drillChapterId);
                        return;
                      }
                      setScope(s);
                    }}
                  />
                ))}
              </View>
            ) : null}

            {queue === undefined ? (
              <EmptyState title="Loading the review queue…" />
            ) : (
              <ReviewQueue
                rows={queue.rows as ReviewQueueRow[]}
                showBook={orgWide && scope === "all"}
                bookFilterName={
                  scope === "central"
                    ? "Central"
                    : scope === "chapter"
                      ? ownChapterName
                      : null
                }
                runAction={run}
              />
            )}
            {queue?.hasMore ? (
              <Text className="mt-2 text-2xs text-muted">
                Showing the oldest 100. Clear some and the rest appear.
              </Text>
            ) : null}
          </View>
        ) : null}
      </Narrow>

          {/* NARROW screens only — the pre-panel Modal sheet, unchanged. On a
              wide screen with a row selected, the panel to the right is the
              whole record instead; this never mounts alongside it. */}
          {openRow && !showPanel ? (
            <FinishChargeSheet
              txn={openRow.txn}
              todo={openRow.todo}
              categoryOptions={categoryOptions}
              onClose={() => setOpenId(null)}
            />
          ) : null}
          <ToastView toast={toast} onDismiss={dismiss} />
        </Screen>
      </View>

      {showPanel && openRow ? (
        <View style={{ width: "44%", maxWidth: 640, minWidth: 380, padding: 16 }}>
          <CodingWorkbenchPanel
            txn={openRow.txn}
            todo={openRow.todo}
            categoryOptions={categoryOptions}
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
