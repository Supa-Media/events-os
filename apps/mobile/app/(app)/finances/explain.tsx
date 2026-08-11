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
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
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
import { useChapterContext } from "../../../lib/ChapterContext";

type WorklistRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.finances.monthCodingWorklist>>
>["rows"][number];

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
      ...(categories ?? []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories],
  );

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
  const pct =
    data.totalCount > 0 ? Math.round((done / data.totalCount) * 100) : 100;

  return (
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

        <Card>
          <Text className="text-sm text-muted">
            {done} of {data.totalCount} lines explained ({pct}%) —{" "}
            {formatCents(data.explainedCents)} of {formatCents(data.totalCents)}.
          </Text>
          {/* Dollars beside counts, deliberately. A month can be 20% of the
              lines and 80% of the money, and on a page strangers read, the
              money is the part that gets asked about. */}
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
            This month is larger than one read returns; the list below is a
            prefix. Explain these, then reopen for the rest.
          </Text>
        ) : null}

        {data.rows.length === 0 ? (
          <View className="mt-4">
            <EmptyState
              icon="check-circle"
              title={`${data.label} is fully explained`}
              message={
                data.totalCount === 0
                  ? "There's nothing in this month that needs an explanation."
                  : "Every line that will publish carries a written purpose. Move to another month, or go publish this one."
              }
            />
          </View>
        ) : (
          data.rows.map((row) => (
            <ExplainRow key={row.id} row={row} onOpen={() => setOpenId(row.id)} />
          ))
        )}
      </Narrow>

      {openRow ? (
        <FinishChargeSheet
          txn={openRow as never}
          categoryOptions={categoryOptions}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </Screen>
  );
}

/** One line still owing an explanation. Amount leads, because the list is
 *  ordered by it and a reader scanning down is scanning amounts. */
function ExplainRow({ row, onOpen }: { row: WorklistRow; onOpen: () => void }) {
  const when = new Date(row.postedAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
  return (
    <Card>
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
