/**
 * Member perspective of the finance dashboard — the caller's own money. Phase 1
 * ships "My transactions" (from `api.finances.personTransactions`); the virtual
 * card and personal-repayment banner land in later phases, so that surface
 * shows a forward-looking note rather than fabricated data. Reimbursements are
 * now live: a "Request a reimbursement" CTA opens the in-app submit form, and
 * `api.reimbursements.myReimbursements` (no finance-role gate — it's the
 * caller's own history) backs the list below it.
 */
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Row,
  SectionHeader,
  Table,
  TableHeader,
} from "../../ui";
import { STATUS_BADGE, shortDate } from "../reimbursements/helpers";
import { SignedMoney, txnStatusTone } from "./parts";

type PersonTxns = FunctionReturnType<typeof api.finances.personTransactions>;

/** `YYYY-MM-DD` in the finance timezone for display. */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function MemberView({ transactions }: { transactions: PersonTxns }) {
  const router = useRouter();
  const reimbursements = useQuery(api.reimbursements.myReimbursements, {});

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

      <SectionHeader
        title="My reimbursements"
        count={reimbursements?.length || undefined}
        right={
          <Button
            title="Request a reimbursement"
            size="sm"
            icon="plus"
            onPress={() => router.push("/finances/reimbursements/new")}
          />
        }
      />
      {reimbursements === undefined ? null : reimbursements.length === 0 ? (
        <EmptyState
          icon="file-text"
          title="No reimbursements yet"
          message="Paid for something out of pocket? Submit a request and a finance manager will review it."
        />
      ) : (
        <Table>
          <TableHeader>
            <HeaderCell flex={2}>Reference</HeaderCell>
            <HeaderCell width={110} align="right">
              Amount
            </HeaderCell>
            <HeaderCell width={130} align="right">
              Status
            </HeaderCell>
          </TableHeader>
          {reimbursements.map((r, i) => {
            const status = STATUS_BADGE[r.status];
            return (
              <Row key={r._id} last={i === reimbursements.length - 1}>
                <Cell flex={2}>
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                    {r.reference}
                  </Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {shortDate(r.submittedDate)} · {r.lineItemCount}{" "}
                    {r.lineItemCount === 1 ? "line item" : "line items"}
                  </Text>
                </Cell>
                <Cell width={110} align="right">
                  <Text className="text-sm font-semibold text-ink">
                    {formatCents(r.totalCents)}
                  </Text>
                </Cell>
                <Cell width={130} align="right">
                  <Badge label={r.statusBadge} tone={status.tone} icon={status.icon} />
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </View>
  );
}
