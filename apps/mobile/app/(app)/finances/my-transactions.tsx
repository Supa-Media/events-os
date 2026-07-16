/**
 * FINANCES · MY TRANSACTIONS — the member/cardholder's mini-reconcile (D3).
 *
 * A no-finance-seat caller's own transactions (`api.finances.personTransactions`
 * — caller-scoped: it returns the CALLER's own rows without needing a finance
 * grant), with exactly two actions per row: attach a receipt and flag a charge
 * as personal. NO category / budget / link editing here — that's the bookkeeper's
 * Reconcile grid, which this tab intentionally doesn't expose.
 *
 * Relocated from the old MemberView-inside-Dashboard (the "My transactions"
 * table) now that it has its own tab in the member tab bar (`_layout.tsx`).
 * The receipt-upload affordance is the exact same `ReceiptCell` the Reconcile
 * grid uses (exported from `ReconcileList.tsx`) so uploading looks and behaves
 * identically everywhere in the app.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Narrow,
  Row,
  Screen,
  Table,
  TableHeader,
  ToastView,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { SignedMoney, txnStatusTone } from "../../../components/finance/dashboard/parts";
import { ReceiptCell } from "../../../components/finance/reconcile/ReconcileList";

/** `YYYY-MM-DD` in the finance timezone for display (mirrors MemberView). */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export default function MyTransactionsScreen() {
  const transactions = useQuery(api.finances.personTransactions, {});
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const flagPersonalCharge = useMutation(api.cards.flagPersonalCharge);
  const { run, toast, dismiss } = useActionRunner();

  // Charges flagged personal this session. `personTransactions` doesn't carry
  // `isPersonal` (it's a plain txn summary), so — same as `MemberCardsView` —
  // we track what the caller just flagged locally rather than re-deriving it.
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});

  async function handleFlag(id: string) {
    const res = await run(
      () => flagPersonalCharge({ transactionId: id as Id<"transactions"> }),
      { errorTitle: "Couldn't flag this charge" },
    );
    if (res) setFlagged((m) => ({ ...m, [id]: true }));
  }

  if (transactions === undefined) {
    return (
      <Screen>
        <Narrow>
          <EmptyState title="Loading your transactions…" />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">My transactions</Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Charges and entries attributed to you. Attach a receipt or flag a
          charge as personal — everything else is a finance manager's job.
        </Text>

        {transactions.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            message="Charges and entries attributed to you show up here."
          />
        ) : (
          <Table>
            <TableHeader>
              <HeaderCell flex={2}>Transaction</HeaderCell>
              <HeaderCell width={110} align="right">
                Amount
              </HeaderCell>
              <HeaderCell width={120} align="right">
                Status
              </HeaderCell>
              <HeaderCell width={130}>Receipt</HeaderCell>
              <HeaderCell width={150} align="right">
                Personal charge
              </HeaderCell>
            </TableHeader>
            {transactions.map((t, i) => {
              const status = txnStatusTone(t.status);
              const isPersonal = flagged[t.id] === true;
              return (
                <Row key={t.id} last={i === transactions.length - 1}>
                  <Cell flex={2}>
                    <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                      {t.merchantName ?? t.description ?? "—"}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {[dateStr(t.postedAt), t.merchantName ? t.description : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </Cell>
                  <Cell width={110} align="right">
                    <SignedMoney
                      cents={t.amountCents}
                      flow={t.flow}
                      className="text-sm font-semibold"
                    />
                  </Cell>
                  <Cell width={120} align="right">
                    <Badge label={status.label} tone={status.tone} />
                  </Cell>
                  <Cell width={130}>
                    <ReceiptCell
                      hasReceipt={t.hasReceipt}
                      reminderStage={t.reminderStage}
                      onUpload={async (storageId) => {
                        await run(
                          () =>
                            attachReceipt({
                              transactionId: t.id as Id<"transactions">,
                              storageId,
                            }),
                          { errorTitle: "Couldn't attach receipt" },
                        );
                      }}
                      generateUploadUrl={generateUploadUrl}
                    />
                  </Cell>
                  <Cell width={150} align="right">
                    {isPersonal ? (
                      <Badge label="Personal" tone="accent" />
                    ) : (
                      <Button
                        title="Flag personal"
                        variant="ghost"
                        size="sm"
                        icon="flag"
                        onPress={() => handleFlag(t.id)}
                      />
                    )}
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
