/**
 * SALES — merch, snacks and drinks sold in person.
 *
 * The third revenue stream finally gets a surface. Gifts have the giving pages
 * and tickets have the event pages, but a $2 Izze sold from a table at Pop The
 * Balloon reached Stripe and stopped there — $1,588 of real money that book
 * value could not see while its cash sat in the bank.
 *
 * ── "UNRESOLVED" IS THE HONEST ANSWER, NOT A BUG ────────────────────────────
 * The in-person taps went through a third-party Tap-to-Pay app that sent Stripe
 * an AMOUNT and nothing else — 177 of 178 charges carry no line item, even
 * though the product catalogue existed. So the amount is the only surviving
 * evidence of what was sold, and the catalogue only asserts a breakdown when
 * exactly one combination of that event's prices makes the total. Eden sold
 * only $30 tees, so its charges read cleanly. Pop The Balloon's $1/$2/$3/$5
 * snack prices overlap so heavily that most of it can't be pinned down.
 *
 * The screen leads with that rather than hiding it: the summary says how much
 * money is itemised versus merely banked, so nobody reads a page full of
 * "Unresolved" as missing revenue. The money and the event are certain; the SKU
 * is not, and a fabricated SKU would be worse than a blank.
 *
 * Read-only by design — sales originate at Stripe and re-sync idempotently on
 * the charge id, so there is no hand-entry path to offer.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Card,
  EmptyState,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { useChapterContext } from "../../../lib/ChapterContext";

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Sales is restricted"
      message="Only finance managers and bookkeepers can see sales detail."
    />
  );
}

function shortDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

  const data = useQuery(
    api.sales.listSales,
    chapterId ? { chapterId } : "skip",
  );

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

  return (
    <Screen>
      <Narrow>
        {/* Only a central caller sees the switcher — a chapter desk has exactly
            one answer and a one-option picker is noise. */}
        {deskChapterId === null && reachable.length > 1 ? (
          <View className="mb-3 flex-row flex-wrap gap-2">
            {reachable.map((c) => (
              <Pill
                key={c.chapterId}
                label={c.name}
                selected={c.chapterId === chapterId}
                onPress={() => setPicked(c.chapterId)}
              />
            ))}
          </View>
        ) : null}

        {data === undefined ? (
          <Text className="text-sm text-muted">Loading…</Text>
        ) : data.sales.length === 0 ? (
          <EmptyState
            icon="shopping-bag"
            title="No sales yet"
            message="In-person sales taken through Stripe appear here once they sync."
          />
        ) : (
          <>
            <SectionHeader title="Sales" />
            <Text className="mb-3 text-sm text-muted">
              Merch, snacks and drinks sold in person. Counted gross — Stripe&apos;s
              fee is a separate expense, not a haircut on revenue.
            </Text>

            <Card>
              <View className="flex-row items-baseline gap-3 py-1">
                <Text className="flex-1 text-sm text-ink">Gross</Text>
                <Text
                  className="text-base font-semibold text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {formatCents(data.summary.grossCents)}
                </Text>
              </View>
              <View className="flex-row items-baseline gap-3 py-1">
                <Text className="flex-1 text-sm text-muted">Stripe fees</Text>
                <Text
                  className="text-sm text-muted"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {formatCents(data.summary.feeCents)}
                </Text>
              </View>
              <View className="mt-1 flex-row items-baseline gap-3 border-t border-border-strong pt-1">
                <Text className="flex-1 text-sm text-muted">Banked</Text>
                <Text
                  className="text-sm text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {formatCents(data.summary.netCents)}
                </Text>
              </View>
              <Text className="mt-2 text-2xs text-faint">
                {data.summary.count} sales ·{" "}
                {data.summary.resolvedCount} itemised ·{" "}
                {data.summary.unresolvedCount} banked without a breakdown
                {data.summary.unresolvedCents > 0
                  ? ` (${formatCents(data.summary.unresolvedCents)})`
                  : ""}
              </Text>
            </Card>

            {data.summary.unresolvedCount > 0 ? (
              <Text className="mt-2 text-2xs text-muted">
                The older taps went through a card reader that sent Stripe an
                amount and no line items, so where several combinations of that
                event&apos;s prices make the same total, the item can&apos;t be pinned
                down. The revenue is exact either way — only the breakdown is
                missing.
              </Text>
            ) : null}

            {data.byEvent.length > 0 ? (
              <View className="mt-5">
                <SectionHeader title="By event" />
                <Card>
                  {data.byEvent.map((e, i) => (
                    <View
                      key={e.eventId ?? "none"}
                      className={`flex-row items-baseline gap-3 py-2 ${
                        i > 0 ? "border-t border-border" : ""
                      }`}
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm text-ink" numberOfLines={1}>
                          {e.eventName}
                        </Text>
                        <Text className="text-2xs text-faint">
                          {e.count} sales · {formatCents(e.feeCents)} in fees
                        </Text>
                      </View>
                      <Text
                        className="text-sm font-semibold text-ink"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {formatCents(e.grossCents)}
                      </Text>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {data.byItem.length > 0 ? (
              <View className="mt-5">
                <SectionHeader title="What sold" />
                <Text className="mb-2 text-2xs text-muted">
                  Only the sales whose item Stripe named, or whose amount matches
                  exactly one basket.
                </Text>
                <Card>
                  {data.byItem.map((it, i) => (
                    <View
                      key={it.label}
                      className={`flex-row items-baseline gap-3 py-2 ${
                        i > 0 ? "border-t border-border" : ""
                      }`}
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm text-ink">{it.label}</Text>
                        {it.candidates.length > 1 ? (
                          <Text className="text-2xs text-faint">
                            could be {it.candidates.join(", ")}
                          </Text>
                        ) : null}
                      </View>
                      <Text className="w-12 text-right text-sm text-muted">
                        ×{it.quantity}
                      </Text>
                      <Text
                        className="w-20 text-right text-sm font-semibold text-ink"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {formatCents(it.grossCents)}
                      </Text>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            <View className="mt-5">
              <SectionHeader title="Every sale" />
              <Card>
                {data.sales.map((s, i) => (
                  <View
                    key={s.saleId}
                    className={`flex-row items-baseline gap-3 py-2 ${
                      i > 0 ? "border-t border-border" : ""
                    }`}
                  >
                    <View className="min-w-0 flex-1">
                      <Text className="text-sm text-ink" numberOfLines={1}>
                        {s.items.length > 0
                          ? s.items
                              .map((it) =>
                                it.quantity > 1
                                  ? `${it.quantity} × ${it.label}`
                                  : it.label,
                              )
                              .join(" + ")
                          : "Unresolved"}
                      </Text>
                      <Text className="text-2xs text-faint">
                        {shortDate(s.soldAt)}
                        {s.eventName ? ` · ${s.eventName}` : ""}
                      </Text>
                    </View>
                    <Text
                      className="text-sm text-ink"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(s.grossCents)}
                    </Text>
                  </View>
                ))}
              </Card>
            </View>

            {data.truncated ? (
              <View className="mt-4">
                <Badge
                  tone="warn"
                  icon="alert-triangle"
                  label="Scan truncated — treat these figures as approximate"
                />
              </View>
            ) : null}
            <View className="h-8" />
          </>
        )}
      </Narrow>
    </Screen>
  );
}
