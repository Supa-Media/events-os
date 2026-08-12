/**
 * EXPLAIN A MONTH — the backfill workbench.
 *
 * Built for one job the owner described exactly: "if there was a nice UI for
 * me to look at a month's transactions and do all the coding myself I can
 * probably get most of it done." That job had no surface at all, and not by
 * oversight — by two independent design decisions that are each correct and
 * together made historical rows unreachable:
 *
 *  - The Coding tab's "yours to code" list is `personTransactions`, indexed
 *    `by_person`. A genesis-backfilled row has no `personId`, so it is in
 *    nobody's queue.
 *  - The reconcile grid's `uncoded` facet keys off `requiresCoding`, which
 *    grandfathers everything before the coding policy date. Every 2024/2025
 *    row is exempt, so that facet is empty.
 *
 * Both answer "what does policy demand of whom." This screen answers a
 * different question — "what will a stranger see a blank next to when this
 * month publishes" — and so it reads the PUBLISHING population
 * (`finances.monthCodingWorklist`), where policy dates do not enter into it.
 *
 * ── BIGGEST FIRST, AND THE PROGRESS BAR IS THE POINT ─────────────────────────
 * Eighteen months of history is a grind that will not always be finished in
 * one sitting. Ordering by amount means whatever gets done first is the work
 * that changes the published page most — ten explanations on a month's ten
 * largest charges beat fifty on its smallest. The progress line exists so
 * stopping halfway still feels like progress rather than abandonment, because
 * halfway up this list genuinely is most of the money.
 *
 * ── IT REUSES THE REAL CODING SHEET ──────────────────────────────────────────
 * Tapping a row opens `FinishChargeSheet` — the same component the cardholder
 * flow uses, which already does coding, receipt attach, exception filing,
 * category and note in one place. A second coding form built for this screen
 * would have been two forms drifting apart on the one surface where the org's
 * §274(d) substantiation is authored.
 *
 * `chargeTodo` is deliberately NOT used for the row state here: its chase
 * semantics call a `reconciled` row settled, and nearly every historical row
 * is reconciled. Correct for chasing a cardholder, wrong for this — the row
 * is closed and still publishes blank.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, useWindowDimensions, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  displayMerchantName,
  formatCents,
  parsePeriodKey,
  periodKey as makePeriodKey,
  previousPeriodKey,
} from "@events-os/shared";
import {
  Badge,
  BackLink,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { FinishChargeSheet } from "../../../components/finance/myTransactions/FinishChargeSheet";
import { CodingWorkbenchPanel } from "../../../components/finance/coding/CodingWorkbenchPanel";
import {
  indexOfSelected,
  panelPosition,
  selectionAfterRowsShrink,
  stepSelection,
} from "../../../components/finance/coding/panelNav";
import { useChapterContext } from "../../../lib/ChapterContext";
import { colors } from "../../../lib/theme";

type WorklistRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.finances.monthCodingWorklist>>
>["rows"][number];

/** Below this window width the side panel doesn't fit next to a readable
 *  list — same threshold the finance dashboard's own two-column layouts use
 *  (`CentralView.tsx`/`ChapterView.tsx`'s `STACK_WIDTH`), so "wide" means the
 *  same thing everywhere in this module. */
const WIDE_MIN_WIDTH = 900;

function NoAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Restricted"
      message="Only a finance seat can work a month's explanations."
    />
  );
}

/** The month this screen opens on: `?period=` if given, else last month —
 *  never the current one, which is still accruing and not the month anybody
 *  is preparing to publish. */
function defaultPeriod(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return makePeriodKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export default function ExplainScreen() {
  return (
    <FinanceBoundary fallback={<NoAccess />}>
      <Body />
    </FinanceBoundary>
  );
}

function Body() {
  const params = useLocalSearchParams<{ period?: string; scope?: string }>();
  const router = useRouter();
  const { context } = useChapterContext();
  // Same scope resolution as every other finance screen — and the same reason
  // it matters here as on the publish console: without it this would silently
  // work the caller's own chapter while they believed they were working
  // central's book.
  const scope =
    params.scope ??
    (context?.kind === "peek"
      ? context.chapterId
      : context?.kind === "seat"
        ? context.scope
        : null);

  const period =
    params.period && parsePeriodKey(params.period)
      ? params.period
      : defaultPeriod();

  const data = useQuery(api.finances.monthCodingWorklist, {
    periodKey: period,
    ...(scope ? { scope } : {}),
  } as never);
  const categories = useQuery(api.finances.myChargeCategories, {});
  const [openId, setOpenId] = useState<string | null>(null);

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "No category" },
      ...(categories ?? []).map((c) => ({
        value: c.id,
        label: c.name,
        expenseTypeHint: c.expenseTypeHint,
      })),
    ],
    [categories],
  );

  // Same threshold as `CentralView`/`ChapterView`'s own two-column split
  // (`WIDE_MIN_WIDTH`, above) — "wide" means the same window width everywhere
  // in finance.
  const isWide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
  // Memoized on `data?.rows` itself (Convex only produces a new array
  // reference there when the query result actually changes) rather than
  // recomputed inline — two effects below depend on `rows`, and a fresh `[]`
  // reference every render would re-run both on every unrelated re-render.
  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const stepRow = (delta: 1 | -1) =>
    setOpenId((current) => stepSelection(rows, current, delta) ?? current);

  // ── SELECTION INTEGRITY: `rows` is `monthCodingWorklist`'s PENDING
  // population, not a fixed list — approving a coding removes its row the
  // instant the query refetches, out from under whatever panel had it open.
  // (Submitting one does NOT: the row stays, just with a new state, which is
  // why nothing special is needed for that case — see `stepRow`'s own
  // callers and `CodingWorkbenchPanel`'s module doc.) `lastKnownIndexRef`
  // tracks the selected row's own position for as long as it's actually
  // still there; the moment it isn't, `selectionAfterRowsShrink` lands on
  // whichever row now occupies that same position — the natural next item
  // for someone clearing a biggest-first list — or closes the panel if the
  // list emptied out, letting the "fully explained" state take over. ──
  const lastKnownIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (openId == null) return;
    const idx = indexOfSelected(rows, openId);
    if (idx !== -1) {
      lastKnownIndexRef.current = idx;
      return;
    }
    const next = selectionAfterRowsShrink(rows, lastKnownIndexRef.current);
    lastKnownIndexRef.current = next == null ? null : indexOfSelected(rows, next);
    setOpenId(next);
  }, [rows, openId]);

  // ── QUICK FLOW: ArrowUp/ArrowDown (and j/k) step the selection through the
  // SAME biggest-first order the panel's own Prev/Next buttons use — only
  // while the panel is actually open (wide screens, a row selected), and only
  // when no text field has focus, so typing "j" into a note or a business
  // purpose never gets eaten by row-stepping. ──
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
  }, [isWide, openId, rows]);

  const step = (delta: number) => {
    const parsed = parsePeriodKey(period);
    if (!parsed) return;
    const next =
      delta < 0
        ? previousPeriodKey(period)
        : parsed.month === 12
          ? makePeriodKey(parsed.year + 1, 1)
          : makePeriodKey(parsed.year, parsed.month + 1);
    if (next) router.setParams({ period: next });
  };

  if (data === undefined) return <Screen loading />;
  if (data === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="book-open"
            title="No chapter yet"
            message="You'll be able to work a month once you belong to a chapter."
          />
        </Narrow>
      </Screen>
    );
  }

  const openRow = data.rows.find((r) => r.id === openId) ?? null;
  const done = data.explainedCount;
  // Only meaningful when the book actually has lines this month — a 0/0
  // month is EMPTY, not 100% done, so it gets its own branch below rather
  // than a percentage that implies a completion that never happened.
  const pct = data.totalCount > 0 ? Math.round((done / data.totalCount) * 100) : 0;

  // The persistent side panel only on a wide screen WITH a row selected —
  // founder: "if I'm seeing a database view when I'm coding... maybe in a
  // side panel." Narrow screens keep the pre-panel Modal sheet, untouched,
  // regardless of width — this is the only branch point between the two.
  const showPanel = isWide && openRow != null;

  return (
    <View style={{ flex: 1, flexDirection: showPanel ? "row" : "column" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Screen>
          <Narrow>
            <BackLink fallback="/finances/publish" label="Publish" />
            <SectionHeader title={`Explain — ${data.scopeName}`} />

            <View className="mb-3 flex-row items-center gap-2">
              <Button variant="secondary" size="sm" title="←" onPress={() => step(-1)} />
              <Text className="flex-1 text-center text-base font-semibold text-ink">
                {data.label}
              </Text>
              <Button variant="secondary" size="sm" title="→" onPress={() => step(1)} />
            </View>

            {data.totalCount === 0 ? (
              // A ZERO-ROW resolved book is never "fully explained" — that copy
              // is indistinguishable from a genuinely finished month. Name the
              // book that's empty, and — when the caller can see other books —
              // say where the actual rows are instead of celebrating nothing.
              <View className="mt-4">
                <EmptyState
                  icon="book-open"
                  title={`${data.scopeName} has nothing to explain in ${data.label}`}
                  message={
                    data.otherBooks && data.otherBooks.length > 0
                      ? `${data.scopeName}'s book is empty for this month — that's not the same as complete. Other books have unexplained lines for ${data.label}:`
                      : `${data.scopeName}'s book has no lines at all for ${data.label} — an empty book, not a finished one.`
                  }
                  action={
                    data.otherBooks && data.otherBooks.length > 0 ? (
                      <View className="gap-2">
                        {data.otherBooks.map((book) => (
                          <Button
                            key={String(book.scope)}
                            variant="secondary"
                            size="sm"
                            title={`Switch to ${book.scopeName} — ${book.totalCount} unexplained`}
                            onPress={() =>
                              router.setParams({ scope: String(book.scope) })
                            }
                          />
                        ))}
                      </View>
                    ) : undefined
                  }
                />
              </View>
            ) : (
              <>
                <Card>
                  <Text className="text-sm text-muted">
                    {done} of {data.totalCount} lines explained ({pct}%) —{" "}
                    {formatCents(data.explainedCents)} of {formatCents(data.totalCents)}.
                  </Text>
                  {/* Dollars beside counts, deliberately. A month can be 20% of
                      the lines and 80% of the money, and on a page strangers
                      read, the money is the part that gets asked about. */}
                  <View className="mt-2 h-2 overflow-hidden rounded-full bg-sunken">
                    <View
                      className="h-full rounded-full bg-success"
                      style={{ width: `${pct}%` }}
                    />
                  </View>
                  <Text className="mt-2 text-2xs text-muted">
                    Biggest first — the top of this list is most of the money.
                  </Text>
                </Card>

                {data.truncated ? (
                  <Text className="mt-2 text-sm text-danger">
                    This month is larger than one read returns; the list below is
                    a prefix. Explain these, then reopen for the rest.
                  </Text>
                ) : null}

                {data.rows.length === 0 ? (
                  <View className="mt-4">
                    <EmptyState
                      icon="check-circle"
                      title={`${data.label} is fully explained`}
                      message="Every line that will publish carries a written purpose. Move to another month, or go publish this one."
                    />
                  </View>
                ) : (
                  data.rows.map((row) => (
                    <ExplainRow
                      key={row.id}
                      row={row}
                      selected={showPanel && row.id === openId}
                      onOpen={() => setOpenId(row.id)}
                    />
                  ))
                )}
              </>
            )}
          </Narrow>

          {/* NARROW screens only — the pre-panel Modal sheet, unchanged. On a
              wide screen with a row selected, the panel below is the whole
              record instead; this never mounts alongside it. */}
          {openRow && !showPanel ? (
            <FinishChargeSheet
              txn={openRow as never}
              categoryOptions={categoryOptions}
              // Same as the panel below: `monthCodingWorklist` rows aren't
              // the caller's own.
              ownCharge={false}
              onClose={() => setOpenId(null)}
            />
          ) : null}
        </Screen>
      </View>

      {showPanel && openRow ? (
        <View style={{ width: "44%", maxWidth: 640, minWidth: 380, padding: 16 }}>
          <CodingWorkbenchPanel
            txn={openRow as never}
            categoryOptions={categoryOptions}
            // `monthCodingWorklist` rows are the whole chapter's publishing
            // population, not just the caller's own — the HIGH review
            // finding (`planCategoryEdit`) this flag exists to fix.
            ownCharge={false}
            onDeselect={() => setOpenId(null)}
            onPrev={() => stepRow(-1)}
            onNext={() => stepRow(1)}
            hasPrev={stepSelection(rows, openId, -1) != null}
            hasNext={stepSelection(rows, openId, 1) != null}
            position={panelPosition(rows, openId)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** One line still owing an explanation. Amount leads, because the list is
 *  ordered by it and a reader scanning down is scanning amounts.
 *  `selected` (wide screens, panel open on this row) draws an accent border
 *  so the row the panel is showing is never ambiguous while the list keeps
 *  scrolling past it. */
function ExplainRow({
  row,
  selected,
  onOpen,
}: {
  row: WorklistRow;
  selected: boolean;
  onOpen: () => void;
}) {
  const when = new Date(row.postedAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
  return (
    <Card
      style={
        selected
          ? { borderColor: colors.accent, borderWidth: 2, backgroundColor: colors.accentBg }
          : undefined
      }
    >
      <View className="flex-row items-center gap-3">
        <Text
          className="text-base font-semibold text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(row.amountCents)}
        </Text>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            {displayMerchantName(row)}
          </Text>
          <Text className="text-2xs text-muted">
            {when}
            {row.needsBudget ? " · not attached to a budget" : ""}
          </Text>
        </View>
        {/* A receipt already on file is worth showing here: it is the
            difference between writing an explanation from memory and writing
            it off the document. */}
        {row.hasReceipt ? (
          <Badge tone="success" label="Receipt" />
        ) : row.hasApprovedException ? (
          <Badge tone="warn" label="Exception" />
        ) : (
          <Badge tone="neutral" label="No receipt" />
        )}
        <Button size="sm" title="Explain" onPress={onOpen} />
      </View>
      {row.codingState === "changes_requested" ? (
        <Text className="mt-2 text-sm text-danger">
          Sent back — needs another pass before it can publish.
        </Text>
      ) : row.codingState === "submitted" ? (
        <Text className="mt-2 text-sm text-muted">
          Waiting on review. It publishes blank until it&apos;s approved.
        </Text>
      ) : null}
    </Card>
  );
}
