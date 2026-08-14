/**
 * PUBLIC PAY-BACK PAGE — `/pay/<token>`, no login.
 *
 * Founder, 2026-08-14: "these might be past team members even. So it should
 * literally just be a rendered page where I could just copy a link, where they
 * can see the charge they're being charged for and go to the Stripe checkout.
 * Similar to our giving page, except it has the details for how much they need
 * to pay back."
 *
 * Lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups, so it is NOT
 * behind the auth guard — the same placement `/d/[shareId]` uses for the
 * public doc share. The token in the URL is the whole authority; see
 * `convex/repaymentLinks.ts` for what it does and doesn't authorize.
 *
 * ── IT GREETS NOBODY BY NAME ────────────────────────────────────────────────
 * "We don't need to put, like, 'hey Michael, you have these charges'." So the
 * page says these are the personal charges on this account and asks for them
 * back. No payer name, no merchant, no sender — just amounts and dates, which
 * is all somebody needs to recognise their own charge. A link that ends up
 * somewhere it shouldn't discloses a few numbers, not a person.
 *
 * That constraint is the reason this screen doesn't reuse the in-app
 * repayments page: same job, deliberately less to say.
 */
import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Icon } from "../../components/ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";

export default function PublicRepaymentScreen() {
  const { token, paid } = useLocalSearchParams<{ token: string; paid?: string }>();
  const link = useQuery(api.repaymentLinks.publicByToken, {
    token: (token as string) ?? "",
  });

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={{ backgroundColor: colors.surface }}
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          paddingVertical: 40,
          paddingHorizontal: 16,
        }}
      >
        <View style={{ width: "100%", maxWidth: 520 }}>
          {link === undefined ? (
            <Text className="text-center text-base text-muted">Loading…</Text>
          ) : link === null ? (
            <Inactive />
          ) : link.settled ? (
            <AllSettled chapterName={link.chapterName} justPaid={paid === "1"} />
          ) : (
            <PayBody token={token as string} link={link} justPaid={paid === "1"} />
          )}
        </View>
      </ScrollView>
    </>
  );
}

/** Unknown OR revoked — deliberately the same screen for both. Telling them
 *  apart only helps somebody trying tokens, and the person holding a dead link
 *  needs the same next step either way. */
function Inactive() {
  return (
    <View className="items-center gap-3 rounded-lg border border-border bg-raised p-8">
      <Icon name="link" size={28} color={colors.muted} />
      <Text className="text-center text-lg font-semibold text-ink">
        This payment link isn&apos;t active
      </Text>
      <Text className="text-center text-sm text-muted">
        It may have been replaced with a newer one. Ask whoever sent it for an
        up-to-date link.
      </Text>
    </View>
  );
}

function AllSettled({
  chapterName,
  justPaid,
}: {
  chapterName: string;
  justPaid: boolean;
}) {
  return (
    <View className="items-center gap-3 rounded-lg border border-border bg-raised p-8">
      <Icon name="check-circle" size={28} color={colors.success} />
      <Text className="text-center text-lg font-semibold text-ink">
        {justPaid ? "Thank you — that's settled" : "Nothing outstanding"}
      </Text>
      <Text className="text-center text-sm text-muted">
        {justPaid
          ? `Your payment to ${chapterName} went through. If you paid by bank transfer it may take a few business days to finish clearing.`
          : `There are no personal charges left to pay back on this account.`}
      </Text>
    </View>
  );
}

type Link = NonNullable<
  ReturnType<typeof useQuery<typeof api.repaymentLinks.publicByToken>>
>;

function PayBody({
  token,
  link,
  justPaid,
}: {
  token: string;
  link: Link;
  justPaid: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState<"card" | "ach">("card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkout = useAction(api.stripe.createPublicRepaymentCheckout);

  const payable = useMemo(
    () => link.charges.filter((c) => !c.clearing),
    [link.charges],
  );
  const clearing = useMemo(
    () => link.charges.filter((c) => c.clearing),
    [link.charges],
  );
  const selectedIds = useMemo(
    () => payable.filter((c) => selected[c.id]).map((c) => c.id),
    [payable, selected],
  );

  const quote = useQuery(
    api.repaymentLinks.publicQuote,
    selectedIds.length > 0 ? { token, repaymentIds: selectedIds } : "skip",
  );
  const chosen = quote ? (rail === "ach" ? quote.ach : quote.card) : null;
  const allSelected = payable.length > 0 && selectedIds.length === payable.length;

  async function pay() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await checkout({
        token,
        repaymentIds: selectedIds as Id<"personalRepayments">[],
        method: rail,
      });
      void Linking.openURL(result.url);
    } catch {
      // No toast machinery on a public page, and nothing useful to say about
      // the internals — one honest line and the button stays live to retry.
      setError("Couldn't start the payment. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-4">
      {justPaid ? (
        <View className="flex-row items-start gap-2 rounded-lg border border-border bg-accent-soft p-3">
          <Icon name="clock" size={14} color={colors.accent} />
          <Text className="flex-1 text-xs text-ink">
            Thanks — your payment is going through. Anything still listed below
            hasn&apos;t been paid yet.
          </Text>
        </View>
      ) : null}

      <View className="gap-2">
        <Text className="font-display text-2xl text-ink">
          Pay {link.chapterName} back
        </Text>
        <Text className="text-sm text-muted">
          These charges on a {link.chapterName} card were marked personal, so
          they&apos;re yours to pay back rather than the ministry&apos;s to
          cover. Pick what you&apos;re ready to settle — no account needed.
        </Text>
      </View>

      <View className="rounded-lg border border-border bg-raised p-4">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          Outstanding
        </Text>
        <Text
          className="text-2xl font-semibold text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(link.totalCents)}
        </Text>
        {payable.length > 1 ? (
          <Pressable
            onPress={() =>
              setSelected(
                allSelected
                  ? {}
                  : Object.fromEntries(payable.map((c) => [c.id, true])),
              )
            }
            accessibilityRole="button"
            className="mt-2 self-start active:opacity-70"
          >
            <Text className="text-sm font-medium text-accent">
              {allSelected ? "Clear selection" : "Select all"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* The charges. Amount and date only — see the file header. */}
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        {payable.map((c, i) => {
          const checked = !!selected[c.id];
          return (
            <Pressable
              key={c.id}
              onPress={() =>
                setSelected((m) => ({ ...m, [c.id]: !m[c.id] }))
              }
              accessibilityRole="checkbox"
              aria-checked={checked}
              accessibilityLabel={`Charge of ${formatCents(c.amountCents)} from ${formatDate(c.postedAt)}`}
              className={`flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${i === 0 ? "" : "border-t border-border"}`}
            >
              <View
                className={`h-4 w-4 items-center justify-center rounded border ${
                  checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
                }`}
              >
                {checked ? (
                  <Icon name="check" size={12} color={colors.accentText} />
                ) : null}
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-ink">Charge {i + 1}</Text>
                <Text className="text-xs text-muted">
                  {formatDate(c.postedAt)}
                </Text>
              </View>
              <Text
                className="text-sm font-semibold text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatCents(c.amountCents)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {clearing.length > 0 ? (
        <Text className="text-xs text-muted">
          {clearing.length} more{" "}
          {clearing.length === 1 ? "charge is" : "charges are"} already being
          paid by bank transfer and will clear on their own — nothing to do.
        </Text>
      ) : null}

      {/* What it costs, on both rails. Same arithmetic as the in-app page:
          the payer covers the processor's fee so the ministry nets the debt
          whole, and the bank rail is much cheaper on anything sizeable. */}
      <View className="gap-3 rounded-lg border border-border bg-raised p-4">
        {selectedIds.length === 0 ? (
          <Text className="text-sm text-muted">
            Select the charges you&apos;re ready to pay.
          </Text>
        ) : quote === undefined || quote === null || chosen === null ? (
          <Text className="text-sm text-muted">Working out the total…</Text>
        ) : (
          <>
            <View className="flex-row flex-wrap gap-2">
              <RailOption
                selected={rail === "card"}
                onPress={() => setRail("card")}
                title="Card"
                detail="Instant"
                cost={formatCents(quote.card.chargeCents)}
              />
              <RailOption
                selected={rail === "ach"}
                onPress={() => setRail("ach")}
                title="Bank transfer"
                detail="About 4 business days"
                cost={formatCents(quote.ach.chargeCents)}
              />
            </View>
            <View className="gap-1.5">
              <Line
                label={`${quote.count} charge${quote.count === 1 ? "" : "s"}`}
                value={formatCents(quote.totalCents)}
              />
              {chosen.feeCents > 0 ? (
                <Line
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
                  The fee is added so {link.chapterName} gets the full{" "}
                  {formatCents(quote.totalCents)} back rather than losing part
                  of it to the payment processor.
                </Text>
              ) : null}
            </View>
          </>
        )}

        {error ? <Text className="text-xs text-danger">{error}</Text> : null}

        <Pressable
          onPress={() => void pay()}
          disabled={selectedIds.length === 0 || busy || quote === undefined}
          accessibilityRole="button"
          className={`flex-row items-center justify-center gap-2 rounded-pill px-4 py-3 ${
            selectedIds.length === 0 || busy ? "bg-sunken" : "bg-accent"
          }`}
        >
          <Icon
            name={rail === "ach" ? "home" : "credit-card"}
            size={14}
            color={
              selectedIds.length === 0 || busy ? colors.muted : colors.accentText
            }
          />
          <Text
            className={`text-sm font-semibold ${
              selectedIds.length === 0 || busy ? "text-muted" : "text-accent-text"
            }`}
          >
            {busy ? "Starting…" : "Pay securely with Stripe"}
          </Text>
        </Pressable>
        <Text className="text-center text-2xs text-muted">
          Payment is handled by Stripe. Card details never touch{" "}
          {link.chapterName}&apos;s systems.
        </Text>
      </View>
    </View>
  );
}

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
      accessibilityLabel={`${title}, ${detail}, ${cost}`}
      className={`min-w-[150px] flex-1 rounded-lg border px-3 py-2.5 active:opacity-70 ${
        selected ? "border-accent bg-accent-soft" : "border-border bg-sunken"
      }`}
    >
      <Text className="text-sm font-semibold text-ink">{title}</Text>
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

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-2">
      <Text className="flex-1 text-sm text-muted" numberOfLines={2}>
        {label}
      </Text>
      <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}
