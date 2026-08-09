/**
 * SALES — merch, snacks and drinks sold in person.
 *
 * The third revenue stream. Gifts have the giving pages and tickets have the
 * event pages, but a $2 Izze sold from a table at Pop The Balloon reached Stripe
 * and stopped there — $1,588 of real money that book value could not see while
 * its cash sat in the bank.
 *
 * ── WHY THIS IS A GRID AND NOT A REPORT ─────────────────────────────────────
 * It used to be a stack of cards: totals, then a By Event roll-up, then a What
 * Sold roll-up, then a list of plain rows at the bottom. Everything on it was
 * true and none of it could be acted on (owner, looking at the tab: "needs to be
 * fixed to be more of a database view like reconcile"). The rows a bookkeeper
 * actually needs to touch — the unattributed payments, the ones whose items were
 * never recorded — sat below three screens of summary with no way to fix them
 * once found.
 *
 * So it takes Reconcile's shape, because Reconcile is what he was naming: a real
 * table with a header row, a search-and-filter bar whose counts are live facets,
 * cells that edit inline and commit per row, multi-select driving a bulk bar, and
 * a detail affordance at the end of each row. What it does NOT take is anything
 * that would make a sale pretend to be a bank charge — no status lifecycle, no
 * free-text cells, no editable money (see `SalesTable`'s own doc).
 *
 * ── WHAT SURVIVED FROM THE OLD PAGE, AND WHY ────────────────────────────────
 * THE SUMMARY, verbatim in substance: gross, Stripe's fee, and what was banked.
 * A treasurer's first question is that line and it deserves to be answerable
 * without reading a single row. It stays CHAPTER-WIDE while the grid filters
 * underneath it — a headline revenue figure that silently re-scoped itself on
 * every filter click would be a good way to misreport revenue — and the header
 * says "N of M" when a selection is narrowing the table, so the two numbers
 * never look like they disagree.
 *
 * THE UNRESOLVED EXPLANATION, also verbatim. A page where most rows say
 * "Unresolved" invites exactly one wrong conclusion — that revenue is missing —
 * and the sentence that prevents it is worth more than the space it costs.
 *
 * THE TWO ROLL-UPS DID NOT SURVIVE AS CARDS, and nothing they said was lost:
 * "By event" and "What sold" are now the Event and Item filters' facet counts.
 * A count you can click narrows the table; a count in a card just sits there.
 * (Item counts are UNITS SOLD, which is the number the old card reported and the
 * one a treasurer means by "what sold" — the filter bar's tooltip says so, since
 * a number that means something different from its neighbours has to admit it.)
 *
 * Chapter-scoped, seat-gated, and a central-desk caller still picks which
 * chapter — sales are chapter money and central sells nothing directly.
 */
import { useMemo, useState } from "react";
import { Text, View, TextInput, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Card,
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
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { useChapterContext } from "../../../lib/ChapterContext";
import { SalesTable } from "../../../components/finance/sales/SalesTable";
import { SalesBulkBar } from "../../../components/finance/sales/SalesBulkBar";
import { SaleDetailModal } from "../../../components/finance/sales/SaleDetailModal";
import {
  applySelection,
  facetCounts,
  hasAnyFilter,
  itemLabels,
  sharedBasketOptions,
  BREAKDOWN_KEYS,
  BREAKDOWN_LABELS,
  EMPTY_FILTERS,
  UNATTRIBUTED,
  type BreakdownKey,
  type SaleRow,
  type SalesFilters,
} from "../../../components/finance/sales/helpers";

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Sales is restricted"
      message="Only finance managers and bookkeepers can see sales detail."
    />
  );
}

export default function SalesScreen() {
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
      <SalesBody />
    </FinanceBoundary>
  );
}

function SalesBody() {
  const { context, chapterSeats, peekChapters } = useChapterContext();
  const { run, toast, dismiss } = useActionRunner();

  // Sales are chapter money — central sells nothing directly — so this screen
  // always resolves to ONE chapter. A chapter desk (or a peek) is that chapter;
  // a central-desk caller picks, defaulting to the first they can reach.
  const reachable = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of chapterSeats) m.set(s.chapterId, s.chapterName);
    for (const p of peekChapters) m.set(p.chapterId, p.name);
    return [...m.entries()].map(([chapterId, name]) => ({ chapterId, name }));
  }, [chapterSeats, peekChapters]);

  const deskChapterId =
    context?.kind === "peek"
      ? context.chapterId
      : context?.kind === "seat" && context.scope !== "central"
        ? context.scope
        : null;

  const [picked, setPicked] = useState<string | null>(null);
  const chapterId = (picked ?? deskChapterId ?? reachable[0]?.chapterId ?? null) as
    | Id<"chapters">
    | null;

  const data = useQuery(api.sales.listSales, chapterId ? { chapterId } : "skip");
  const setSaleItems = useMutation(api.sales.setSaleItems);
  const setSaleEvent = useMutation(api.sales.setSaleEvent);

  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [filters, setFilters] = useState<SalesFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<SaleRow | null>(null);

  const rows = useMemo(() => data?.sales ?? [], [data]);
  const displayed = useMemo(
    () => applySelection(rows, filters, query),
    [rows, filters, query],
  );
  const facets = useMemo(
    () => facetCounts(rows, filters, query),
    [rows, filters, query],
  );
  const products = useMemo(() => itemLabels(rows), [rows]);

  // The selection only ever means rows currently on screen. Filtering away a
  // checked row and then hitting a bulk action would otherwise write to
  // something the user can no longer see — the one bulk-edit failure that is
  // genuinely hard to notice afterwards.
  const selectedRows = useMemo(
    () => displayed.filter((r) => selected.has(r.saleId)),
    [displayed, selected],
  );
  const bulkBaskets = useMemo(() => sharedBasketOptions(selectedRows), [selectedRows]);

  function clearSelection() {
    setSelected(new Set());
  }
  function toggle(saleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(saleId)) next.delete(saleId);
      else next.add(saleId);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) =>
      displayed.every((r) => prev.has(r.saleId))
        ? new Set()
        : new Set(displayed.map((r) => r.saleId)),
    );
  }
  function toggleFilter<K extends keyof SalesFilters>(group: K, value: string) {
    setFilters((prev) => {
      const current = prev[group] as string[];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...prev, [group]: next };
    });
  }
  function clearGroup(group: keyof SalesFilters) {
    setFilters((prev) => ({ ...prev, [group]: [] }));
  }

  async function commitItems(saleId: string, basketKey: string | null) {
    await run(
      () => setSaleItems({ saleId: saleId as Id<"sales">, basketKey }),
      { errorTitle: "Couldn't set the items" },
    );
  }
  async function commitEvent(saleId: string, eventId: string | null) {
    await run(
      () =>
        setSaleEvent({
          saleId: saleId as Id<"sales">,
          eventId: (eventId as Id<"events"> | null) ?? null,
        }),
      { errorTitle: "Couldn't set the event" },
    );
  }
  async function bulkSetEvent(eventId: string | null) {
    const ids = selectedRows.map((r) => r.saleId);
    await run(
      () =>
        Promise.all(
          ids.map((saleId) =>
            setSaleEvent({
              saleId: saleId as Id<"sales">,
              eventId: (eventId as Id<"events"> | null) ?? null,
            }),
          ),
        ),
      { errorTitle: "Couldn't set the event" },
    );
    clearSelection();
  }
  async function bulkSetItems(basketKey: string | null) {
    const ids = selectedRows.map((r) => r.saleId);
    await run(
      () =>
        Promise.all(
          ids.map((saleId) =>
            setSaleItems({ saleId: saleId as Id<"sales">, basketKey }),
          ),
        ),
      { errorTitle: "Couldn't set the items" },
    );
    clearSelection();
  }

  if (!chapterId) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="shopping-bag"
            title="No chapter to show"
            message="Sales are recorded against a chapter. You don't have a chapter desk yet."
          />
        </Narrow>
      </Screen>
    );
  }

  const narrowing = hasAnyFilter(filters) || query.trim().length > 0;
  const summary = data?.summary;

  return (
    <>
      <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
          <View className="mb-1 flex-row items-baseline gap-2">
            <Text className="font-display text-2xl text-ink">Sales</Text>
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {summary
                ? narrowing
                  ? `${displayed.length} of ${summary.count}`
                  : `${summary.count} sales`
                : ""}
            </Text>
          </View>

          {/* Only a central caller sees the switcher — a chapter desk has exactly
              one answer and a one-option picker is noise. */}
          {deskChapterId === null && reachable.length > 1 ? (
            <View className="mb-3 flex-row flex-wrap gap-2">
              {reachable.map((c) => (
                <Pill
                  key={c.chapterId}
                  label={c.name}
                  selected={c.chapterId === chapterId}
                  onPress={() => {
                    setPicked(c.chapterId);
                    clearSelection();
                  }}
                />
              ))}
            </View>
          ) : null}

          <Text className="mb-3 text-sm text-muted">
            Merch, snacks and drinks sold in person. Counted gross — Stripe&apos;s
            fee is a separate expense, not a haircut on revenue.
          </Text>

          {data === undefined ? (
            <Text className="text-sm text-muted">Loading…</Text>
          ) : rows.length === 0 ? (
            <EmptyState
              icon="shopping-bag"
              title="No sales yet"
              message="In-person sales taken through Stripe appear here once they sync."
            />
          ) : (
            <>
              {/* The summary the old page led with, kept and compacted onto one
                  line. Chapter-wide on purpose — see this file's header. */}
              {summary ? (
                <Card>
                  <View className="flex-row flex-wrap items-baseline gap-x-6 gap-y-1">
                    <Stat label="Gross" cents={summary.grossCents} strong />
                    <Stat label="Stripe fees" cents={summary.feeCents} />
                    <Stat label="Banked" cents={summary.netCents} />
                  </View>
                  <Text className="mt-2 text-2xs text-faint">
                    {summary.count} sales · {summary.resolvedCount} itemised ·{" "}
                    {summary.unresolvedCount} banked without a breakdown
                    {summary.unresolvedCents > 0
                      ? ` (${formatCents(summary.unresolvedCents)})`
                      : ""}
                  </Text>
                </Card>
              ) : null}

              {summary && summary.unresolvedCount > 0 ? (
                <Text className="mt-2 text-2xs text-muted">
                  The older taps went through a card reader that sent Stripe an
                  amount and no line items, so where several combinations of that
                  event&apos;s prices make the same total, the item can&apos;t be
                  pinned down on its own. The revenue is exact either way — only
                  the breakdown is missing, and the Items column lets you settle
                  the ones you remember.
                </Text>
              ) : null}

              {/* Search + the three filter groups on one row — the shape every
                  CRM-ish screen in this app takes, and the shape Reconcile
                  settled on after counted chips failed twice. */}
              <View className="mb-4 mt-4 flex-row items-center gap-2">
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
                    placeholder="Search item, event, amount, payment…"
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

                <FilterSelect
                  label="Breakdown"
                  values={filters.breakdown}
                  options={BREAKDOWN_KEYS.map((k) => ({
                    value: k,
                    label: BREAKDOWN_LABELS[k],
                    count: facets.breakdown[k],
                  }))}
                  onToggle={(v) => toggleFilter("breakdown", v as BreakdownKey)}
                  onClear={() => clearGroup("breakdown")}
                  anyLabel="Any breakdown"
                  minWidth={260}
                />

                <FilterSelect
                  label="Event"
                  values={filters.events}
                  options={[
                    ...data.events
                      .filter((e) => (facets.events.get(e.eventId) ?? 0) > 0)
                      .map((e) => ({
                        value: e.eventId as string,
                        label: e.name,
                        count: facets.events.get(e.eventId) ?? 0,
                      })),
                    {
                      value: UNATTRIBUTED,
                      label: "Unattributed",
                      count: facets.events.get(UNATTRIBUTED) ?? 0,
                    },
                  ]}
                  onToggle={(v) => toggleFilter("events", v)}
                  onClear={() => clearGroup("events")}
                  anyLabel="Any event"
                  minWidth={240}
                />

                <FilterSelect
                  label="Item"
                  values={filters.items}
                  options={products.map((label) => ({
                    value: label,
                    label,
                    count: facets.items.get(label) ?? 0,
                  }))}
                  onToggle={(v) => toggleFilter("items", v)}
                  onClear={() => clearGroup("items")}
                  anyLabel="Any item"
                  minWidth={240}
                />

                <InfoTooltip
                  text="Needs a choice: the amount matches more than one basket from that day's price list — you can settle it if you remember the sale. No reading fits: no combination of that day's prices makes this amount, so there's nothing to choose. Itemised: a breakdown is recorded. Set by hand: somebody chose it rather than the amount deciding. Unattributed: the sale isn't tied to an event yet. Item counts are UNITS SOLD, not rows — one tap can buy two of something."
                  size={14}
                />
              </View>
            </>
          )}
        </Narrow>

        {selectedRows.length > 0 && data?.canEdit ? (
          <SalesBulkBar
            count={selectedRows.length}
            events={data.events}
            basketOptions={bulkBaskets}
            sharedGrossCents={selectedRows[0]?.grossCents ?? null}
            onSetEvent={(eventId) => void bulkSetEvent(eventId)}
            onSetItems={(basketKey) => void bulkSetItems(basketKey)}
            onClear={clearSelection}
          />
        ) : null}

        {data !== undefined && rows.length > 0 ? (
          displayed.length === 0 ? (
            <EmptyState
              icon="search"
              title="No matches"
              message="No sales in this view match what you're looking for. Try another filter."
            />
          ) : (
            <SalesTable
              rows={displayed}
              events={data.events}
              canEdit={data.canEdit}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
              onSetItems={(saleId, key) => void commitItems(saleId, key)}
              onSetEvent={(saleId, eventId) => void commitEvent(saleId, eventId)}
              onOpenDetail={setDetail}
            />
          )
        ) : null}

        {data?.truncated ? (
          <Narrow>
            <View className="mt-4">
              <Badge
                tone="warn"
                icon="alert-triangle"
                label="Scan truncated — treat these figures as approximate"
              />
            </View>
          </Narrow>
        ) : null}
        <View className="h-8" />
      </Screen>

      {detail ? (
        <SaleDetailModal
          // Re-read from the live rows so an edit made behind the modal is
          // reflected in it; fall back to the captured row if it filtered away.
          row={rows.find((r) => r.saleId === detail.saleId) ?? detail}
          onClose={() => setDetail(null)}
        />
      ) : null}
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

function Stat({
  label,
  cents,
  strong = false,
}: {
  label: string;
  cents: number;
  strong?: boolean;
}) {
  return (
    <View className="flex-row items-baseline gap-2">
      <Text className="text-sm text-muted">{label}</Text>
      <Text
        className={
          strong ? "text-base font-semibold text-ink" : "text-sm text-ink"
        }
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(cents)}
      </Text>
    </View>
  );
}
