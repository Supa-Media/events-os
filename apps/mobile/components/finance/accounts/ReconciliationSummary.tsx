/**
 * DOES IT ADD UP? — the panel that answers the only question this page exists
 * for, in the order a person asks it.
 *
 * The founder, 2026-08-08:
 *
 *   "the whole point of this section is to see whether our books match what's
 *    in the bank account. So I just want things put in a format that shows me —
 *    hey, if we take all the pending, all the stuff in payout, and all the
 *    stuff in Stripe, and all the stuff in the account, we're still missing
 *    $50. Or we don't have this amount of money, so I know I need to go
 *    reconcile it and find out, oh, was there a payment that wasn't attributed
 *    to the right book. But right now it's just very abstract to get that
 *    information."
 *
 * Every number he needed was already on the page. What was missing was the
 * SUBTRACTION — the page laid out four columns and left the arithmetic, and
 * therefore the conclusion, as an exercise. So this panel states one figure
 * prominently and the two totals it came from underneath, rather than adding a
 * fifth column to a table nobody could total by eye.
 *
 * ── THREE THINGS IT REFUSES TO DO ────────────────────────────────────────────
 *
 * 1. IT NEVER SHOWS THE GAP AS AN ABSOLUTE VALUE. Which way it leans IS the
 *    diagnosis: more cash than the books explain means income nobody recorded;
 *    more books than cash means something is counted twice or was never really
 *    spent. Those send a treasurer to opposite ends of the app, and "$5,871.68
 *    difference" sends them nowhere.
 *
 * 2. IT NEVER CALLS A GAP AN ERROR. A difference can be entirely legitimate —
 *    which is why the known-legitimate components are netted out first (pending
 *    is added back to the bank side, money at Stripe is counted as money) and
 *    in-kind revenue is named rather than silently adjusted. What is left is
 *    "unaccounted for", which is a statement about our knowledge, not an
 *    accusation.
 *
 * 3. IT NEVER STOPS AT THE NUMBER. A gap the reader can't act on is just a
 *    worse version of the four columns. "Where to look" points at the tools
 *    that already exist for exactly these findings — the per-book duplicate
 *    scan and counted-as-zero list behind a tap on any row above.
 *
 * ── WHY IT REFRESHES ON MOUNT ────────────────────────────────────────────────
 * The founder again: "I need it to sync every time I open the page." Balances
 * used to move only when the morning cron ran, so this panel would confidently
 * reconcile the books against a bank figure from 5am. The mount effect calls
 * `refreshBalancesNow`, which re-reads Increase and Stripe and NOTHING else —
 * it is not the engine, it books nothing and moves no cash. The throttle that
 * stops a remount storm from hammering two vendors lives on the server, where
 * it survives remounts and knows about other viewers; see
 * `reconciliation.ts#claimBalanceSnapshot`.
 */
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import { Badge, Button, Card, SectionHeader } from "../../ui";

/** `Aug 8, 2:14 PM` in the org's timezone. */
function stamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Row({
  label,
  hint,
  value,
  strong,
  faint,
}: {
  label: string;
  hint?: string;
  value: string;
  strong?: boolean;
  faint?: boolean;
}) {
  return (
    <View className="flex-row items-baseline gap-3 py-1">
      <View className="min-w-0 flex-1">
        <Text
          className={`text-sm ${
            strong ? "font-semibold text-ink" : faint ? "text-faint" : "text-muted"
          }`}
        >
          {label}
        </Text>
        {hint ? <Text className="text-2xs text-faint">{hint}</Text> : null}
      </View>
      <Text
        className={`text-sm ${strong ? "font-semibold text-ink" : "text-ink"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

export function ReconciliationSummary() {
  const summary = useQuery(api.reconciliation.reconciliationSummary, {});
  const refresh = useAction(api.reconciliation.refreshBalancesNow);
  const [refreshing, setRefreshing] = useState(false);

  // ONE automatic refresh per mount. A ref rather than state because the effect
  // must not re-fire when the refresh's own writes push a new query result down
  // — that is a loop, and a loop here is a loop against Increase and Stripe.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (askedOnOpen.current) return;
    askedOnOpen.current = true;
    // Fire and forget, deliberately. A balance refresh failing is not worth a
    // toast over a page that already renders the (visibly stamped) last-known
    // figures — the server logs it, and the "as of" tells the truth either way.
    void refresh({}).catch(() => {});
  }, [refresh]);

  const onRefresh = () => {
    setRefreshing(true);
    // `force` skips the freshness window: the reader can see the "as of" and
    // has decided it isn't good enough. It does not skip the in-flight lock.
    void refresh({ force: true })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  if (summary === undefined) {
    return (
      <>
        <SectionHeader title="Does it add up?" />
        <Card>
          <Text className="text-sm text-muted">Loading…</Text>
        </Card>
      </>
    );
  }

  const gap = summary.differenceCents;
  const cashHigh = summary.verdict === "cash_exceeds_books";
  // "It adds up to the cent" is a claim, and a claim needs every term. If
  // Stripe has never been read, the cash side is short by however much is
  // sitting there — which could be thousands — so a zero difference is a
  // coincidence, not a reconciliation, and must not be reported as one.
  const balanced = summary.verdict === "balanced" && !summary.incomplete;
  const unknowable = summary.verdict === "balanced" && summary.incomplete;

  return (
    <>
      <SectionHeader title="Does it add up?" />
      <Text className="mb-3 text-sm text-muted">
        Everything the books say the org is worth, against every pile of money we
        can actually point at. Compared across the whole org on purpose: every
        payout lands in central&apos;s account, so central always holds cash the
        chapters earned and a single book&apos;s value never matches its own bank.
        Summed, that cancels out.
      </Text>
      <Card>
        <Row
          label="The books say we have"
          hint="Every book's value added up"
          value={formatCents(summary.bookValueCents)}
          strong
        />

        <View className="mt-3 border-t border-border-strong pt-2">
          <Text className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
            Where that money actually is
          </Text>
          <Row
            label="In the bank"
            hint="Available across every Increase account"
            value={formatCents(summary.bankAvailableCents)}
          />
          <Row
            label="Set aside, not yet posted"
            hint="Card spend, outbound transfers and holds the bank has taken off the available balance but hasn't posted — the ledger hasn't seen them either, so it still counts as ours"
            value={formatCents(summary.bankPendingCents)}
          />
          <Row
            label="Still at Stripe"
            hint={
              summary.incomplete
                ? "Never fetched — this total is short by whatever Stripe is holding"
                : "Earned and counted, but not yet paid into any account"
            }
            value={
              summary.incomplete
                ? "—"
                : formatCents(
                    (summary.stripeAvailableCents ?? 0) +
                      (summary.stripePendingCents ?? 0),
                  )
            }
          />
          <View className="mt-1 border-t border-border pt-1">
            <Row
              label="Total we can point at"
              value={formatCents(summary.locatedCents)}
              strong
            />
          </View>
        </View>

        {/* THE ANSWER. Deliberately the loudest thing in the card — it is the
            sentence the reader came for, and every figure above it is
            supporting evidence. */}
        <View
          className={`mt-3 rounded-lg border px-3 py-3 ${
            balanced
              ? "border-success/40 bg-success/10"
              : "border-warn/40 bg-warn/10"
          }`}
        >
          {balanced ? (
            <>
              <Text className="font-display text-base text-ink">
                It adds up. The books match the money to the cent.
              </Text>
              <Text className="mt-0.5 text-2xs text-muted">
                Nothing to reconcile right now.
              </Text>
            </>
          ) : unknowable ? (
            <>
              <Text className="font-display text-base text-ink">
                Can&apos;t say yet — we&apos;ve never read the Stripe balance.
              </Text>
              <Text className="mt-0.5 text-sm text-muted">
                The two sides happen to match, but whatever Stripe is holding is
                missing from the money side, so that isn&apos;t a
                reconciliation. Press Refresh, or wait for the morning run.
              </Text>
            </>
          ) : (
            <>
              <Text
                className="font-display text-xl text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatCents(Math.abs(gap))} unaccounted for
              </Text>
              <Text className="mt-0.5 text-sm text-muted">
                {cashHigh
                  ? "There is more money in the accounts than the books explain — something came in that was never recorded, or an expense was recorded that never actually left."
                  : "The books claim more money than we can find — something is counted twice, or was recorded as spent when it wasn't."}
              </Text>
            </>
          )}
        </View>

        {!balanced ? (
          <View className="mt-3 gap-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              Where to look
            </Text>
            {/* Ordered most-likely-first for the DIRECTION of this gap, so the
                first line is the one worth reading. Suppressed when there is no
                direction to reason from — with Stripe unread, "the books claim
                more than we can find" would be pointing at the wrong culprit. */}
            {unknowable ? null : cashHigh ? (
              <Text className="text-2xs text-muted">
                • Income that never made it onto a book — a deposit sitting in
                Reconcile uncoded, or money collected somewhere the app
                doesn&apos;t sync. Start with the largest recent bank credit.
              </Text>
            ) : (
              <Text className="text-2xs text-muted">
                • The same money counted twice — a gift recorded AND the bank
                credit that delivered it. Tap a book above; its breakdown scans
                for exactly this pair and offers to link them.
              </Text>
            )}
            {summary.unmatchedPayoutCount > 0 ? (
              <Text className="text-2xs text-muted">
                • {summary.unmatchedPayoutCount} payout
                {summary.unmatchedPayoutCount === 1 ? "" : "s"} worth{" "}
                {formatCents(summary.unmatchedPayoutCents)} whose bank deposit we
                never found. Until it&apos;s matched, that deposit counts as
                ordinary income on top of the revenue it was already paying for.
              </Text>
            ) : null}
            {summary.inKindRevenueCents > 0 ? (
              <Text className="text-2xs text-muted">
                • {formatCents(summary.inKindRevenueCents)} of book value is
                in-kind gifts — goods and services, never cash. They&apos;re
                meant to be cancelled out by the expense they paid for, so they
                should not move this number. One entered without its expense
                will.
              </Text>
            ) : null}
            {summary.booksWithoutBankBalance.length > 0 ? (
              <Text className="text-2xs text-warn">
                • No bank balance has ever synced for{" "}
                {summary.booksWithoutBankBalance.join(", ")} — that account is
                missing from the money side entirely, which is not the same as it
                holding nothing.
              </Text>
            ) : null}
            {summary.unattributedBankCents !== 0 ? (
              <Text className="text-2xs text-warn">
                • {formatCents(summary.unattributedBankCents)} sits in an
                Increase account no active book claims. It&apos;s counted above
                as real money, but nothing on the books is holding it.
              </Text>
            ) : null}
            {unknowable ? null : (
              <Text className="mt-1 text-2xs text-faint">
                Tap any book in Account balances below to open its breakdown —
                the duplicate scan and the &ldquo;counted as zero&rdquo; list are
                where a wrong number usually hides. &ldquo;See every line&rdquo;
                from there gives you the individual rows.
              </Text>
            )}
          </View>
        ) : null}

        <View className="mt-3 flex-row flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
            <Text className="text-2xs text-faint">
              {summary.balancesAsOf
                ? `Balances as of ${stamp(summary.balancesAsOf)}`
                : "Balances have never been fetched"}
            </Text>
            {summary.refreshing ? (
              <Badge label="Syncing…" tone="neutral" icon="refresh-cw" />
            ) : null}
            {summary.truncated ? (
              <Badge
                label="Scan truncated — approximate"
                tone="warn"
                icon="alert-triangle"
              />
            ) : null}
          </View>
          <Button
            title={refreshing ? "Refreshing…" : "Refresh"}
            variant="secondary"
            size="sm"
            icon="refresh-cw"
            disabled={refreshing}
            onPress={onRefresh}
          />
        </View>
      </Card>
    </>
  );
}
