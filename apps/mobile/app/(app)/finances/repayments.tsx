/**
 * FINANCES · REPAYMENTS — "you owe Public Worship", and the page where you
 * actually settle it.
 *
 * Founder, 2026-08-14, on why the old banner wasn't enough:
 *
 *   "There are a bunch of people with personal charges. I want to be able to
 *    send them to reimbursements, and then they see 'hey, you owe this
 *    amount', and then you're able to select which ones you want to pay back
 *    with your card… It shouldn't be all at once, because for some things it's
 *    like 'oh, I accidentally paid for a company expense with this' — let me
 *    use my company card for this. But then another one, 'oh, that's a
 *    personal charge'. I want people to be able to break up what card they use
 *    per transaction. So allow people to multi-select: okay, I'm ready to pay
 *    these off."
 *
 * What existed before was `OwedBanner` — a one-line "You owe $X" with a "Pay
 * by card" button that bundled EVERY outstanding charge into one checkout.
 * There was no way to see what the charges were, no way to pay one and not
 * another, and no fee recovery. Three things this page adds:
 *
 *  1. THE CHARGES, INDIVIDUALLY. Merchant, description, when it posted, when
 *     it was flagged, amount — enough to recognize a charge and decide whether
 *     it really was yours before paying for it.
 *  2. SELECTION. Nothing is checked by default (paying money is never the
 *     accidental outcome of landing on a page). Select all / none for the
 *     common case; per-row checkboxes for the split case above.
 *  3. AN HONEST TOTAL, ON BOTH RAILS. The payer is charged the debt PLUS
 *     Stripe's cut, quoted live from `api.cards.quoteRepayment` as the
 *     selection changes, because the org has to net the debt whole (founder:
 *     "we have to get back whatever Stripe fees we lose from that
 *     transaction"). Since the payer covers it, they get to choose how much it
 *     costs: card is instant at 2.9% + 30¢, bank transfer is 0.8% capped at
 *     $5.00 and takes about four business days. On a $248 charge that is $7.49
 *     against $1.98, and quietly routing everyone onto the expensive rail
 *     because it was the only one built would be the org saving its own
 *     inconvenience with a volunteer's money.
 *
 *     The fee is charged once per PAYMENT, so the page also says out loud that
 *     paying in one batch costs less than paying in several — the one thing a
 *     payer can't work out for themselves from the numbers on screen.
 *
 * Nothing here settles anything. The flag only clears when Stripe's webhook
 * confirms the money ARRIVED (`cards.applyRepaymentPaidFromStripe`); an
 * abandoned checkout leaves every charge exactly as outstanding as it was.
 * That is why this page has no optimistic "initiated" state of its own — the
 * balance it shows is always the true one.
 *
 * A bank transfer makes that gap days long rather than instant, so those
 * charges sit in `processing`: still owed, visibly in flight, and NOT
 * selectable, because the one thing worse than a payer wondering whether it
 * worked is a payer paying for it twice. See `REPAYMENT_STATUSES`.
 *
 * Settled charges stay visible under a collapsed "Paid back" section rather
 * than vanishing: a charge that disappears the moment it's paid reads as
 * "never flagged" and invites a re-flag, and it's also the only receipt the
 * payer has.
 */
import { useMemo, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { useActionRunner } from "../../../lib/useActionToast";

type Repayment = FunctionReturnType<
  typeof api.cards.myPersonalRepayments
>[number];

export default function RepaymentsScreen() {
  const repayments = useQuery(api.cards.myPersonalRepayments, {});
  // Stripe sends the payer back here with `?repay=success`. The webhook is what
  // actually settles, and it may not have landed yet, so this is deliberately
  // worded as "we'll update when it clears" rather than "paid" — the row list
  // below is the source of truth either way and updates itself live.
  const params = useLocalSearchParams<{ repay?: string }>();
  const justReturned = params.repay === "success";

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // Which rail. Card first because it is instant and most repayments are
  // small; the panel below shows what each costs so the choice is informed
  // rather than defaulted into.
  const [rail, setRail] = useState<"card" | "ach">("card");
  const createRepaymentCheckout = useAction(api.stripe.createRepaymentCheckout);
  const { run, toast, dismiss } = useActionRunner();
  const [busy, setBusy] = useState(false);

  // Owed AND payable. A `processing` charge is still owed — it counts in the
  // balance and it is not gone from the page — but it is deliberately not in
  // this list, because everything here is selectable and paying for a debit
  // that is already clearing collects the same money twice.
  const outstanding = useMemo(
    () =>
      (repayments ?? []).filter(
        (r) => r.status !== "paid" && r.status !== "processing",
      ),
    [repayments],
  );
  const clearing = useMemo(
    () => (repayments ?? []).filter((r) => r.status === "processing"),
    [repayments],
  );
  const settled = useMemo(
    () => (repayments ?? []).filter((r) => r.status === "paid"),
    [repayments],
  );

  // Selection is intersected with what's still outstanding on every render, so
  // a charge a manager marks repaid (or another checkout settles) while this
  // page is open can never stay silently checked and be paid for twice.
  const selectedIds = useMemo(
    () => outstanding.filter((r) => selected[r.id]).map((r) => r.id),
    [outstanding, selected],
  );

  const quote = useQuery(
    api.cards.quoteRepayment,
    selectedIds.length > 0 ? { repaymentIds: selectedIds } : "skip",
  );

  const owedCents = outstanding.reduce((sum, r) => sum + r.amountCents, 0);
  const allSelected =
    outstanding.length > 0 && selectedIds.length === outstanding.length;

  function toggle(id: string) {
    setSelected((m) => ({ ...m, [id]: !m[id] }));
  }

  function toggleAll() {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const r of outstanding) next[r.id] = true;
    setSelected(next);
  }

  /** Hand the selection to Stripe Checkout. Deliberately does NOT clear the
   *  selection or mark anything paid — see the file header on why this page
   *  keeps no optimistic state. */
  async function paySelected() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    const result = await run(
      () =>
        createRepaymentCheckout({
          repaymentIds: selectedIds as Id<"personalRepayments">[],
          method: rail,
        }),
      { errorTitle: "Couldn't start checkout" },
    );
    setBusy(false);
    if (!result) return;
    void Linking.openURL(result.url);
  }

  if (repayments === undefined) return <Screen loading />;

  return (
    <>
      <Screen maxWidth={1080}>
        <Narrow>
          <View className="mb-1">
            <Text className="font-display text-2xl text-ink">
              Pay Public Worship back
            </Text>
          </View>
          <Text className="mb-4 text-sm text-muted">
            Charges on your card that were flagged personal. Pick the ones
            you&apos;re ready to settle and pay them with your own card — a
            credit posts against each charge as soon as the payment clears.
          </Text>

          {justReturned ? (
            <View className="mb-4 flex-row items-start gap-2 rounded-lg border border-border bg-accent-soft p-3">
              <Icon name="clock" size={14} color={colors.accent} />
              <Text className="flex-1 text-xs text-ink">
                Thanks — your payment is going through. A card payment clears
                from this list within a minute; a bank transfer moves to
                &ldquo;Clearing&rdquo; and settles in about four business days.
              </Text>
            </View>
          ) : null}

          {/* ── Bank transfers on their way ────────────────────────────────
                Above the payable list, and deliberately not inside it: these
                are already paid for as far as the payer is concerned, and the
                only thing they need is reassurance plus the certainty that
                they can't be charged again. No checkboxes, no total. */}
          {clearing.length > 0 ? (
            <View className="mb-4">
              <SectionHeader title="Clearing" count={clearing.length} />
              <Card padding="none">
                {clearing.map((r, i) => (
                  <View
                    key={r.id}
                    className={`flex-row items-center gap-3 px-4 py-3 ${i === 0 ? "" : "border-t border-border"}`}
                  >
                    <Icon name="clock" size={14} color={colors.accent} />
                    <View className="min-w-0 flex-1">
                      <Text className="text-sm text-ink" numberOfLines={1}>
                        {r.merchantName ?? r.description ?? "Personal charge"}
                      </Text>
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        Bank transfer on its way — usually about 4 business days
                      </Text>
                    </View>
                    <Text
                      className="text-sm text-muted"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(r.amountCents)}
                    </Text>
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          {outstanding.length === 0 ? (
            clearing.length > 0 ? null : (
              <EmptyState
                icon="check-circle"
                title="Nothing outstanding"
                message="No personal charges are flagged against your card right now."
              />
            )
          ) : (
            <>
              {/* ── The balance + the selection controls ──────────────────── */}
              <Card className="mb-3">
                <View className="flex-row flex-wrap items-baseline justify-between gap-2">
                  <View>
                    <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                      You owe
                    </Text>
                    <Text
                      className="text-2xl font-semibold text-ink"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(owedCents)}
                    </Text>
                    <Text className="text-xs text-muted">
                      across {outstanding.length} charge
                      {outstanding.length === 1 ? "" : "s"}
                    </Text>
                  </View>
                  <Button
                    title={allSelected ? "Clear selection" : "Select all"}
                    variant="secondary"
                    size="sm"
                    onPress={toggleAll}
                  />
                </View>
              </Card>

              <SectionHeader
                title="Flagged personal"
                count={outstanding.length}
              />
              <Card padding="none">
                {outstanding.map((r, i) => (
                  <RepaymentRow
                    key={r.id}
                    row={r}
                    first={i === 0}
                    checked={!!selected[r.id]}
                    onToggle={() => toggle(r.id)}
                  />
                ))}
              </Card>

              {/* ── What this will cost, and the button ───────────────────── */}
              <PayPanel
                rail={rail}
                onRailChange={setRail}
                selectedCount={selectedIds.length}
                outstandingCount={outstanding.length}
                quote={quote}
                busy={busy}
                onPay={() => void paySelected()}
              />
            </>
          )}

          {settled.length > 0 ? (
            <SettledSection rows={settled} />
          ) : null}
        </Narrow>
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

/**
 * The check mark, drawn rather than composed from `<Checkbox>`.
 *
 * Not an oversight: the whole ROW is the press target here (a 16px box is not
 * a reasonable thing to ask someone to hit on a phone), and `<Checkbox>` is
 * itself a `Pressable` carrying the checkbox accessibility role. Nesting it
 * inside a row that carries the same role announces every charge twice to a
 * screen reader and gives a keyboard user two stops per line. One control per row,
 * so the visual is a plain `View` and the row owns the semantics. Styling
 * deliberately mirrors `ui/Checkbox` — if that changes, change this with it.
 */
function CheckMark({ checked }: { checked: boolean }) {
  return (
    <View
      className={`h-4 w-4 items-center justify-center rounded border ${
        checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
      }`}
    >
      {checked ? <Icon name="check" size={12} color={colors.accentText} /> : null}
    </View>
  );
}

/** One outstanding charge, with its check mark. */
function RepaymentRow({
  row,
  first,
  checked,
  onToggle,
}: {
  row: Repayment;
  first: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const title = row.merchantName ?? row.description ?? "Personal charge";
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      aria-checked={checked}
      accessibilityLabel={`${title}, ${formatCents(row.amountCents)}`}
      className={`flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${first ? "" : "border-t border-border"}`}
    >
      <CheckMark checked={checked} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-ink" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-xs text-muted" numberOfLines={1}>
          {formatDate(row.postedAt)}
          {row.flaggedAt > row.postedAt
            ? ` · flagged ${formatDate(row.flaggedAt)}`
            : ""}
        </Text>
      </View>
      {row.status === "failed" ? (
        <Badge label="Attempt failed" tone="danger" />
      ) : null}
      <Text
        className="text-sm font-semibold text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(row.amountCents)}
      </Text>
    </Pressable>
  );
}

/**
 * The commit step: which rail, what each costs, and the total the payer is
 * agreeing to.
 *
 * Both rails are priced on screen at once rather than behind a toggle that
 * re-quotes. The saving is the entire argument for the slower option, and an
 * argument you have to click to see is one most people never see — on a $248
 * charge it is $7.49 against $1.98, out of the pocket of a volunteer fixing
 * their own mistake.
 *
 * The one-batch nudge is not upsell either — it is the only part of the
 * arithmetic a payer cannot work out from the numbers in front of them.
 * Stripe's fixed fee is per PAYMENT, so three checkouts cost more than one,
 * and they are the one covering it. Shown only when it is actually true (a
 * partial selection of more than one remaining charge).
 */
function PayPanel({
  selectedCount,
  outstandingCount,
  quote,
  rail,
  onRailChange,
  busy,
  onPay,
}: {
  selectedCount: number;
  outstandingCount: number;
  quote: FunctionReturnType<typeof api.cards.quoteRepayment> | undefined;
  rail: "card" | "ach";
  onRailChange: (next: "card" | "ach") => void;
  busy: boolean;
  onPay: () => void;
}) {
  const partial = selectedCount > 0 && selectedCount < outstandingCount;
  const chosen = quote ? (rail === "ach" ? quote.ach : quote.card) : null;
  // What picking the bank saves, in the payer's own pocket. Only stated when
  // it is a real number — at small amounts the two rails are pennies apart and
  // "save $0.14, wait four days" is not a trade worth interrupting anyone for.
  const achSavesCents = quote ? quote.card.feeCents - quote.ach.feeCents : 0;
  return (
    <Card className="mt-3">
      {selectedCount === 0 ? (
        <Text className="text-sm text-muted">
          Select the charges you&apos;re ready to pay back.
        </Text>
      ) : quote === undefined || chosen === null ? (
        <Text className="text-sm text-muted">Working out the total…</Text>
      ) : (
        <View className="gap-3">
          {/* ── How do you want to pay? ─────────────────────────────────── */}
          <View className="flex-row flex-wrap gap-2">
            <RailOption
              selected={rail === "card"}
              onPress={() => onRailChange("card")}
              title="Card"
              detail="Instant"
              cost={formatCents(quote.card.chargeCents)}
            />
            <RailOption
              selected={rail === "ach"}
              onPress={() => onRailChange("ach")}
              title="Bank transfer"
              detail="About 4 business days"
              cost={formatCents(quote.ach.chargeCents)}
            />
          </View>
          {rail === "card" && achSavesCents >= 100 ? (
            <Text className="text-xs text-muted">
              Paying by bank instead would cost you{" "}
              {formatCents(achSavesCents)} less — it just takes a few days to
              clear.
            </Text>
          ) : null}

          <View className="gap-1.5">
            <QuoteRow
              label={`${quote.count} charge${quote.count === 1 ? "" : "s"}`}
              value={formatCents(quote.totalCents)}
            />
            {chosen.feeCents > 0 ? (
              <QuoteRow
                label={
                  chosen.rateLabel
                    ? `Processing fee (${chosen.rateLabel})`
                    : "Processing fee"
                }
                value={formatCents(chosen.feeCents)}
              />
            ) : null}
            <View className="mt-1 flex-row items-baseline justify-between gap-2 border-t border-border pt-2">
              <Text className="text-sm font-semibold text-ink">
                You&apos;ll be charged
              </Text>
              <Text
                className="text-lg font-semibold text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatCents(chosen.chargeCents)}
              </Text>
            </View>
            {chosen.feeCents > 0 ? (
              <Text className="text-xs text-muted">
                The fee is added so Public Worship gets the full{" "}
                {formatCents(quote.totalCents)} back rather than losing it to
                the payment processor.
              </Text>
            ) : null}
            {partial ? (
              <Text className="text-xs text-muted">
                The processing fee is charged once per payment — settling the
                rest in this same batch costs less than paying for them
                separately later.
              </Text>
            ) : null}
            {rail === "ach" ? (
              <Text className="text-xs text-muted">
                Bank transfers take about four business days. These charges
                will show as clearing until the money lands, and stay off your
                balance the moment it does.
              </Text>
            ) : null}
          </View>
        </View>
      )}
      <View className="mt-3 flex-row justify-end">
        <Button
          title={
            selectedCount === 0
              ? "Pay"
              : rail === "ach"
                ? `Pay ${selectedCount} by bank`
                : `Pay ${selectedCount} by card`
          }
          icon={rail === "ach" ? "home" : "credit-card"}
          loading={busy}
          disabled={selectedCount === 0 || quote === undefined}
          onPress={onPay}
        />
      </View>
    </Card>
  );
}

/** One rail's card in the chooser: what it's called, how long it takes, and
 *  what it will actually cost this selection. The price is on the option
 *  itself, not in a footnote — it is the thing being chosen between. */
function RailOption({
  selected,
  onPress,
  title,
  detail,
  cost,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  detail: string;
  cost: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      aria-checked={selected}
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}, ${detail}, ${cost}`}
      className={`min-w-[150px] flex-1 rounded-lg border px-3 py-2.5 active:opacity-70 ${
        selected ? "border-accent bg-accent-soft" : "border-border bg-sunken"
      }`}
    >
      <View className="flex-row items-center gap-1.5">
        <CheckMark checked={selected} />
        <Text className="text-sm font-semibold text-ink">{title}</Text>
      </View>
      <Text className="mt-0.5 text-2xs text-muted">{detail}</Text>
      <Text
        className="mt-1 text-sm font-semibold text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {cost}
      </Text>
    </Pressable>
  );
}

function QuoteRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-2">
      <Text className="flex-1 text-sm text-muted" numberOfLines={2}>
        {label}
      </Text>
      <Text
        className="text-sm text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

/** Settled charges, collapsed. See the file header for why they stay. */
function SettledSection({ rows }: { rows: Repayment[] }) {
  const [open, setOpen] = useState(false);
  const total = rows.reduce((sum, r) => sum + r.amountCents, 0);
  return (
    <View className="mt-6">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-2 py-2 active:opacity-70"
      >
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
        <Text className="flex-1 text-sm font-semibold text-ink">
          Paid back ({rows.length})
        </Text>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(total)}
        </Text>
      </Pressable>
      {open ? (
        <Card padding="none">
          {rows.map((r, i) => (
            <View
              key={r.id}
              className={`flex-row items-center gap-3 px-4 py-3 ${i === 0 ? "" : "border-t border-border"}`}
            >
              <Icon name="check-circle" size={14} color={colors.success} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-ink" numberOfLines={1}>
                  {r.merchantName ?? r.description ?? "Personal charge"}
                </Text>
                <Text className="text-xs text-muted" numberOfLines={1}>
                  {formatDate(r.postedAt)}
                </Text>
              </View>
              <Text
                className="text-sm text-muted"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatCents(r.amountCents)}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  );
}
