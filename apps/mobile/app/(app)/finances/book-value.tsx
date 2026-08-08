/**
 * EVERY LINE BEHIND A BOOK'S VALUE — the audit page.
 *
 * The Account Balances card gives two numbers. The breakdown modal groups them
 * by gift method and budget category. This is the third rung: every individual
 * row, on both sides, plus every row that contributed NOTHING and why.
 *
 * Built because grouping can't answer the question the founder actually asked —
 * "show me the line items, because there has to be a duplicate or an undercount
 * in here somewhere." A category subtotal will happily hide the same $500
 * counted twice. A list won't.
 *
 * ── THE THREE SECTIONS EARN THEIR ORDER ─────────────────────────────────────
 * SAME AMOUNT, SAME DAY leads when it has anything to show. Every real
 * double-count found in this deployment — the Truist gifts, the Pop The Balloon
 * payout, the Givebutter backfill — was exactly that shape.
 *
 * COUNTED AS ZERO comes before the line lists rather than after. A wrong book
 * value is far more often a row that should have counted nothing and didn't (or
 * the reverse) than a mis-added column, and those rows are invisible in every
 * total on every other screen.
 *
 * EARNED and OUT are last: the longest, least surprising, and the ones you only
 * scroll when the first two didn't explain it.
 *
 * ── ON "SAME AMOUNT, SAME DAY" BEING NOISY ──────────────────────────────────
 * It is, deliberately. A $20 ticket price generates dozens of innocent matches.
 * Narrowing it would be the wrong instinct: the two genuine double-counts found
 * here were only distinguishable from an innocent match by a person who knew
 * what the money was, and a filter tight enough to hide the noise would have
 * hidden them too. So it's framed as a place to look, never a verdict.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  BackLink,
  Card,
  EmptyState,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { useChapterContext } from "../../../lib/ChapterContext";

function shortDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function NoAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Restricted"
      message="Only the Executive Director or Financial Manager can audit book value."
    />
  );
}

type Section = "flags" | "zero" | "earned" | "out";

export default function BookValueScreen() {
  return (
    <FinanceBoundary fallback={<NoAccess />}>
      <Body />
    </FinanceBoundary>
  );
}

function Body() {
  const params = useLocalSearchParams<{ scope?: string }>();
  const { context } = useChapterContext();
  // `?scope=` wins so a shared link is explicit about which book it meant;
  // otherwise fall back to whichever desk the caller is standing at.
  const scope =
    params.scope ??
    (context?.kind === "peek"
      ? context.chapterId
      : context?.kind === "seat"
        ? context.scope
        : null);

  const data = useQuery(
    api.reconciliation.bookValueLines,
    scope ? ({ scope } as never) : "skip",
  );
  const [section, setSection] = useState<Section>("flags");

  const tabs: { key: Section; label: string }[] = useMemo(
    () => [
      { key: "flags", label: `Worth checking${data ? ` (${data.sameAmountSameDay.length})` : ""}` },
      { key: "zero", label: `Counted as zero${data ? ` (${data.ignored.length})` : ""}` },
      { key: "earned", label: `Earned${data ? ` (${data.earned.length})` : ""}` },
      { key: "out", label: `Ledger${data ? ` (${data.ledger.length})` : ""}` },
    ],
    [data],
  );

  if (!scope) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="book-open"
            title="No book selected"
            message="Open this from a row on the Accounts page."
          />
        </Narrow>
      </Screen>
    );
  }
  if (data === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <BackLink fallback="/finances/accounts" label="Accounts" />
        <SectionHeader title={`${data.scopeName} — every line`} />

        <Card>
          <View className="flex-row items-baseline gap-3 py-1">
            <Text className="flex-1 text-sm text-muted">Earned</Text>
            <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              {formatCents(data.revenueCents)}
            </Text>
          </View>
          <View className="flex-row items-baseline gap-3 py-1">
            <Text className="flex-1 text-sm text-muted">Ledger</Text>
            <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              {formatCents(data.ledgerNetCents)}
            </Text>
          </View>
          <View className="mt-1 flex-row items-baseline gap-3 border-t border-border-strong pt-1">
            <Text className="flex-1 text-sm font-semibold text-ink">Book value</Text>
            <Text
              className="text-base font-semibold text-ink"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {formatCents(data.bookBalanceCents)}
            </Text>
          </View>
        </Card>

        <View className="mt-3 flex-row flex-wrap gap-2">
          {tabs.map((t) => (
            <Pill
              key={t.key}
              label={t.label}
              selected={section === t.key}
              onPress={() => setSection(t.key)}
            />
          ))}
        </View>

        <View className="mt-3">
          {section === "flags" ? (
            data.sameAmountSameDay.length === 0 ? (
              <EmptyState
                icon="check"
                title="Nothing matching"
                message="No two lines share an amount and a date."
              />
            ) : (
              <>
                <Text className="mb-2 text-2xs text-muted">
                  Lines that share an amount and a day. Most of these are
                  innocent — a $20 ticket price produces dozens — so this is a
                  place to look, not a verdict. Every real double-count found in
                  these books was this shape, which is why the net is cast wide.
                </Text>
                <Card>
                  {data.sameAmountSameDay.map((g) => (
                    <View
                      key={`${g.amountCents}-${g.day}`}
                      className="border-t border-border py-2"
                    >
                      <View className="flex-row items-baseline gap-3">
                        <Text className="flex-1 text-sm font-semibold text-ink">
                          {formatCents(g.amountCents)}
                        </Text>
                        <Text className="text-2xs text-faint">{g.day}</Text>
                      </View>
                      {g.members.map((mem, i) => (
                        <Text key={i} className="text-2xs text-muted" numberOfLines={1}>
                          • {mem}
                        </Text>
                      ))}
                    </View>
                  ))}
                </Card>
              </>
            )
          ) : null}

          {section === "zero" ? (
            <>
              <Text className="mb-2 text-2xs text-muted">
                Rows the ledger holds that book value deliberately ignores —
                usually because the money is already counted somewhere else.
                This is where a wrong number most often hides.
              </Text>
              <Card>
                {data.ignored.map((r) => (
                  <View key={r.id} className="border-t border-border py-2">
                    <View className="flex-row items-baseline gap-3">
                      <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                        {r.description || "(no description)"}
                      </Text>
                      <Text
                        className="text-sm text-faint"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {formatCents(r.amountCents)}
                      </Text>
                    </View>
                    <Text className="text-2xs text-faint">
                      {shortDate(r.at)} · {r.reason}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {section === "earned" ? (
            <Card>
              {data.earned.map((e) => (
                <View key={`${e.kind}-${e.id}`} className="border-t border-border py-2">
                  <View className="flex-row items-baseline gap-3">
                    <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                      {e.label}
                    </Text>
                    <Text
                      className="text-sm text-ink"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(e.amountCents)}
                    </Text>
                  </View>
                  <Text className="text-2xs text-faint" numberOfLines={1}>
                    {shortDate(e.at)} · {e.kind}
                    {e.detail ? ` · ${e.detail}` : ""}
                    {e.linkedToBankRow ? " · matched to its bank row" : ""}
                  </Text>
                </View>
              ))}
            </Card>
          ) : null}

          {section === "out" ? (
            <Card>
              {data.ledger.map((l) => (
                <View key={l.id} className="border-t border-border py-2">
                  <View className="flex-row items-baseline gap-3">
                    <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                      {l.description || "(no description)"}
                    </Text>
                    <Text
                      className={`text-sm ${l.amountCents < 0 ? "text-ink" : "text-success"}`}
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(l.amountCents)}
                    </Text>
                  </View>
                  <Text className="text-2xs text-faint" numberOfLines={1}>
                    {shortDate(l.at)} · {l.category} · {l.source} · {l.status}
                  </Text>
                </View>
              ))}
            </Card>
          ) : null}
        </View>

        {data.truncated ? (
          <View className="mt-4">
            <Badge
              tone="warn"
              icon="alert-triangle"
              label="Scan truncated — this list is incomplete"
            />
          </View>
        ) : null}
        <View className="h-10" />
      </Narrow>
    </Screen>
  );
}
