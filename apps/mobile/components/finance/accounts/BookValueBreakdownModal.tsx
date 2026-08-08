/**
 * BOOK VALUE, ITEMISED — the drill-down behind an Account Balances row.
 *
 * Account Balances gives two numbers per book and no way to interrogate them.
 * When New York read $9,639.16 and the founder's reaction was "that doesn't
 * seem right", nothing in the app could answer it — the only route was
 * exporting the tables and re-deriving the arithmetic by hand. This is that
 * investigation, in the product.
 *
 * Ordered the way someone actually audits a total: what came IN (by source),
 * what went OUT (by category), then — the part a total can never show — what
 * contributed NOTHING and why. A wrong book value is far more often a row that
 * should have counted zero and didn't, than a mis-added column.
 *
 * SUSPECTED DOUBLE COUNTS LEAD, when there are any. Revenue is counted at the
 * gifts layer, so a gift whose money ALSO landed as a plain bank credit is
 * counted twice unless the gift is linked to that bank row. They are presented
 * as questions, never as findings: matching on amount and a few days' proximity
 * is a heuristic, and two genuinely separate deposits of the same size on one
 * day are an ordinary thing that happens. Acting on that pattern as if it were
 * proof deleted a real $500 deposit from this deployment; the UI asks a person
 * instead.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatCents, increasePendingCategoryLabel } from "@events-os/shared";
import { Badge, Button, Card, Icon, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

type Scope = string;

function shortDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Gift methods are stored as snake_case keys; show them as words. */
function methodLabel(method: string): string {
  const known: Record<string, string> = {
    in_kind: "In-kind",
    givebutter: "Givebutter",
    stripe: "Stripe",
    wire: "Wire",
    other: "Other",
    cash: "Cash",
    check: "Check",
  };
  return known[method] ?? method.replace(/_/g, " ");
}

function Line({
  label,
  value,
  hint,
  strong,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  tone?: "ink" | "muted" | "warn";
}) {
  const color =
    tone === "warn" ? "text-warn" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <View className="flex-row items-baseline gap-3 py-1">
      <View className="min-w-0 flex-1">
        <Text className={`text-sm ${strong ? "font-semibold text-ink" : color}`}>
          {label}
        </Text>
        {hint ? <Text className="text-2xs text-faint">{hint}</Text> : null}
      </View>
      <Text
        className={`text-sm ${strong ? "font-semibold text-ink" : color}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-4">
      <Text className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
        {title}
      </Text>
      <Card>{children}</Card>
    </View>
  );
}

export function BookValueBreakdownModal({
  scope,
  onClose,
}: {
  scope: Scope | null;
  onClose: () => void;
}) {
  const data = useQuery(
    api.reconciliation.bookValueBreakdown,
    scope ? ({ scope } as never) : "skip",
  );
  // Org-level and cheap (one settings row). Mounted with the modal rather than
  // hoisted into the page so the drill-down owns everything it displays.
  const stripe = useQuery(api.reconciliation.stripeBalance, scope ? {} : "skip");
  const router = useRouter();
  const linkGift = useMutation(api.givingCandidates.linkGiftToTransaction);
  const { run, toast, dismiss } = useActionRunner();
  // Which suspicion is mid-flight — so its button alone shows the pending state
  // rather than every row going busy at once.
  const [linking, setLinking] = useState<string | null>(null);

  return (
    <Modal
      visible={scope !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[90%] rounded-t-2xl bg-canvas px-4 pb-8 pt-4">
          <View className="mb-2 flex-row items-center gap-3">
            <Text className="flex-1 font-display text-lg text-ink">
              {data?.scopeName ?? "Book value"}
            </Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Icon name="x" size={20} color={colors.muted} />
            </Pressable>
          </View>

          {data === undefined ? (
            <Text className="py-8 text-sm text-muted">Loading…</Text>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              <Card>
                <Line
                  label="Earned"
                  value={formatCents(data.revenueCents)}
                  hint="Donations, ticket sales and in-person sales, gross of processor fees"
                />
                <Line
                  label="Ledger"
                  value={formatCents(data.ledgerNetCents)}
                  hint="Everything the transaction ledger says moved"
                />
                <View className="mt-1 border-t border-border-strong pt-1">
                  <Line
                    label="Book value"
                    value={formatCents(data.bookBalanceCents)}
                    strong
                  />
                </View>
              </Card>

              {/* THE CASH SIDE — the two figures the table shows next to book
                  value, which this drill-down used to omit entirely. The
                  founder: "Is the pending and held at Stripe even accurate? It
                  doesn't really show up in the breakdown when I click on it,
                  and it's a little confusing." You cannot check a number you
                  cannot see, and a bare "Pending $940.79" invites a reader to
                  go hunting for card spend that may not be what it's made of. */}
              <Group title="Cash in this book's bank account">
                <Text className="mb-2 text-2xs text-muted">
                  Book value above is what this book is WORTH. This is where its
                  cash physically is. They are not meant to match row by row —
                  payouts all land in central&apos;s account, so central holds
                  what the chapters earned until the morning engine moves it. The
                  org-wide check is on the accounts page.
                </Text>
                {data.cash.bankBalanceCents == null ? (
                  <Text className="text-sm text-muted">
                    No bank balance has ever synced for this book.
                  </Text>
                ) : (
                  <Line
                    label="Available in the account"
                    hint={
                      data.cash.bankBalanceAsOf
                        ? `As of ${shortDate(data.cash.bankBalanceAsOf)}`
                        : undefined
                    }
                    value={formatCents(data.cash.bankBalanceCents)}
                  />
                )}
                {data.cash.pendingCents == null ? null : (
                  <>
                    <Line
                      label="Set aside, not yet posted"
                      hint="The bank has already taken this off the available balance, but it hasn't posted — so the ledger hasn't seen it and book value hasn't either"
                      value={formatCents(data.cash.pendingCents)}
                      tone={data.cash.pendingCents > 0 ? "warn" : "muted"}
                    />
                    {data.cash.pendingCents > 0 &&
                    data.cash.pendingBreakdown.length === 0 ? (
                      <Text className="text-2xs text-faint">
                        What it&apos;s made of hasn&apos;t been read yet — it
                        arrives with the next balance sync.
                      </Text>
                    ) : null}
                    {/* Increase reports pending amounts SIGNED, and only the
                        negative ones move the available balance — a positive
                        one (an unsettled card refund) is money on its way back
                        that the bank hasn't credited yet. Adding its magnitude
                        to the total would overstate what's held, so the sign is
                        kept and said out loud. */}
                    {data.cash.pendingBreakdown.map((p) => (
                      <Line
                        key={p.category}
                        label={increasePendingCategoryLabel(p.category)}
                        hint={`${p.count} ${p.count === 1 ? "item" : "items"}${
                          p.amountCents > 0
                            ? " · coming back to us; doesn't change the available balance"
                            : ""
                        }`}
                        value={
                          p.amountCents > 0
                            ? `+${formatCents(p.amountCents)}`
                            : formatCents(Math.abs(p.amountCents))
                        }
                        tone="muted"
                      />
                    ))}
                  </>
                )}
                {/* Org-level, not this book's — there is one Stripe account and
                    its balance can't be attributed to a chapter until it pays
                    out. Shown here anyway because it's the other figure the
                    accounts page states without explaining, and a reader
                    checking "where is my money" needs to know some of it hasn't
                    reached a bank at all yet. */}
                {stripe &&
                (stripe.availableCents != null || stripe.pendingCents != null) ? (
                  <View className="mt-2 border-t border-border pt-2">
                    <Line
                      label="Still at Stripe (whole org)"
                      hint={`Earned and already counted in book value, but not yet paid into any bank account${
                        stripe.asOf ? ` · as of ${shortDate(stripe.asOf)}` : ""
                      }`}
                      value={formatCents(
                        (stripe.availableCents ?? 0) + (stripe.pendingCents ?? 0),
                      )}
                      tone="muted"
                    />
                  </View>
                ) : null}
              </Group>

              {data.suspectedDoubleCounts.length > 0 ? (
                <View className="mt-4">
                  <Text className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-warn">
                    Worth checking — possible double count
                  </Text>
                  <Card>
                    <Text className="mb-2 text-2xs text-muted">
                      Each of these is a bank credit that looks like money already
                      counted as a gift. If it is the same money, it is in this
                      book twice — link the gift to the bank row to settle it.
                      Same amount on a nearby date is a hint, not proof: two
                      separate deposits of the same size do happen.
                    </Text>
                    {data.suspectedDoubleCounts.map((s) => (
                      <View
                        key={s.transactionId}
                        className="border-t border-border py-2"
                      >
                        <View className="flex-row items-baseline gap-3">
                          <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                            {s.description || "(no description)"}
                          </Text>
                          <Text
                            className="text-sm font-semibold text-warn"
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {formatCents(s.amountCents)}
                          </Text>
                        </View>
                        <Text className="text-2xs text-faint">
                          {shortDate(s.postedAt)} · also recorded as a{" "}
                          {methodLabel(s.giftMethod)} gift
                          {s.giftExternalRef ? ` (${s.giftExternalRef})` : ""}
                        </Text>
                        {/* Confirming is a HUMAN act. The suspicion came from
                            amounts matching on nearby dates, which is a hint and
                            not proof — two separate deposits of the same size on
                            one day happen. So the app offers the button and
                            never presses it. */}
                        <View className="mt-2 flex-row items-center gap-3">
                          <Button
                            size="sm"
                            variant="secondary"
                            title="Same money — link them"
                            loading={linking === s.transactionId}
                            disabled={linking !== null}
                            onPress={() => {
                              setLinking(s.transactionId);
                              void run(
                                () =>
                                  linkGift({
                                    giftId: s.giftId,
                                    transactionId: s.transactionId,
                                  }),
                                { errorTitle: "Couldn't link them" },
                              ).finally(() => setLinking(null));
                            }}
                          />
                          <Text className="flex-1 text-2xs text-faint">
                            Counts it once, at the gift.
                          </Text>
                        </View>
                      </View>
                    ))}
                  </Card>
                </View>
              ) : null}

              <Group title="Earned">
                {data.revenue.gifts.map((g) => (
                  <Line
                    key={g.method}
                    label={`${methodLabel(g.method)} gifts`}
                    hint={`${g.count} ${g.count === 1 ? "gift" : "gifts"}`}
                    value={formatCents(g.amountCents)}
                  />
                ))}
                {data.revenue.ticketCount > 0 ? (
                  <Line
                    label="Ticket sales"
                    hint={`${data.revenue.ticketCount} paid orders`}
                    value={formatCents(data.revenue.ticketCents)}
                  />
                ) : null}
                {data.revenue.saleCount > 0 ? (
                  <Line
                    label="In-person sales"
                    hint={`${data.revenue.saleCount} sales`}
                    value={formatCents(data.revenue.saleCents)}
                  />
                ) : null}
                <View className="mt-1 border-t border-border-strong pt-1">
                  <Line label="Total earned" value={formatCents(data.revenueCents)} strong />
                </View>
              </Group>

              <Group title="Spent, by category">
                {data.outflowsByCategory.length === 0 ? (
                  <Text className="text-sm text-muted">Nothing went out.</Text>
                ) : (
                  data.outflowsByCategory.map((c) => (
                    <Line
                      key={c.category}
                      label={c.category}
                      hint={`${c.count} ${c.count === 1 ? "row" : "rows"}`}
                      value={formatCents(c.amountCents)}
                    />
                  ))
                )}
              </Group>

              <Group title="Money in, from the ledger">
                {data.inflows.length === 0 ? (
                  <Text className="text-sm text-muted">
                    No ledger inflows — everything earned came through gifts,
                    tickets or sales.
                  </Text>
                ) : (
                  <>
                    <Text className="mb-2 text-2xs text-muted">
                      Bank credits that are not a processor payout. Listed
                      individually because each is a judgement call — a refund
                      offsetting a purchase belongs here; a donation does not
                      (it should be a gift).
                    </Text>
                    {data.inflows.map((t) => (
                      <View key={t.transactionId} className="border-t border-border py-1.5">
                        <View className="flex-row items-baseline gap-3">
                          <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                            {t.description || "(no description)"}
                          </Text>
                          <Text
                            className="text-sm text-ink"
                            style={{ fontVariant: ["tabular-nums"] }}
                          >
                            {formatCents(t.amountCents)}
                          </Text>
                        </View>
                        <Text className="text-2xs text-faint">
                          {shortDate(t.postedAt)} · {t.source || "—"} · {t.status}
                        </Text>
                      </View>
                    ))}
                  </>
                )}
              </Group>

              <Group title="Counted as zero">
                <Text className="mb-2 text-2xs text-muted">
                  Rows the ledger holds but book value deliberately ignores —
                  usually because the money is already counted somewhere else.
                </Text>
                <Line
                  label="Processor payout deposits"
                  hint="Stripe and Givebutter deposits — the revenue is already counted at the gift, ticket or sale"
                  value={String(data.zeroContributors.payoutDeposits)}
                  tone="muted"
                />
                <Line
                  label="Payout allocation legs"
                  hint="Central↔chapter moves of money already counted"
                  value={String(data.zeroContributors.allocationLegs)}
                  tone="muted"
                />
                <Line
                  label="Bank credits linked to a gift"
                  hint="Counted once, at the gift"
                  value={String(data.zeroContributors.linkedGiftCredits)}
                  tone="muted"
                />
                <Line
                  label="Excluded rows"
                  hint="Marked not-our-money"
                  value={String(data.zeroContributors.excluded)}
                  tone="muted"
                />
                {data.zeroContributors.unknownTransferShape > 0 ? (
                  <Line
                    label="Transfers of unknown shape"
                    hint="No direction recorded, so they contribute nothing rather than guess — worth categorising"
                    value={String(data.zeroContributors.unknownTransferShape)}
                    tone="warn"
                  />
                ) : null}
              </Group>

              {/* The grouped view above answers "what shape is this number".
                  When the answer is "still doesn't look right", the next rung
                  is every individual line — see `finances/book-value`. */}
              <View className="mt-4">
                <Button
                  variant="secondary"
                  title="See every line"
                  onPress={() => {
                    onClose();
                    router.navigate(
                      `/finances/book-value?scope=${encodeURIComponent(data.scope)}` as never,
                    );
                  }}
                />
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
              <View className="h-6" />
            </ScrollView>
          )}
          <ToastView toast={toast} onDismiss={dismiss} />
        </View>
      </View>
    </Modal>
  );
}
