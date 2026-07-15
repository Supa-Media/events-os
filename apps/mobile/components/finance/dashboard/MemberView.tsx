/**
 * Member perspective of the finance dashboard — the caller's own money. Phase 1
 * ships "My transactions" (from `api.finances.personTransactions`); the virtual
 * card, personal-repayment banner, and reimbursements land in later phases, so
 * those surfaces show a forward-looking note rather than fabricated data.
 */
import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  Badge,
  Cell,
  EmptyState,
  HeaderCell,
  Row,
  SectionHeader,
  Table,
  TableHeader,
} from "../../ui";
import { SignedMoney, txnStatusTone } from "./parts";

type PersonTxns = FunctionReturnType<typeof api.finances.personTransactions>;

/** `YYYY-MM-DD` in the finance timezone for display. */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function MemberView({ transactions }: { transactions: PersonTxns }) {
  return (
    <View>
      <SectionHeader title="My card" />
      <EmptyState
        icon="credit-card"
        title="Your card arrives in a later phase"
        message="Member cards, receipt reminders, and personal-charge repayment ship once card issuance is live."
      />

      <SectionHeader title="My transactions" count={transactions.length || undefined} />
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
          </TableHeader>
          {transactions.map((t, i) => {
            const status = txnStatusTone(t.status);
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
                  <SignedMoney cents={t.amountCents} flow={t.flow} className="text-sm font-semibold" />
                </Cell>
                <Cell width={120} align="right">
                  <Badge label={status.label} tone={status.tone} />
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}

      <SectionHeader title="My reimbursements" />
      <EmptyState
        icon="file-text"
        title="Reimbursements arrive in a later phase"
        message="Submit and track reimbursements here once the reimbursement flow is live."
      />
    </View>
  );
}
