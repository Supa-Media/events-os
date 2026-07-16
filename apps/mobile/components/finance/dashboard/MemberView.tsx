/**
 * Member perspective of the finance dashboard — reachable only by deep link now
 * that the member tab bar (`_layout.tsx`, D3) replaces Dashboard with its own
 * My Card / My Transactions / Reimbursements tabs for a no-finance-seat caller.
 * The card content lives in My Card (`cards.tsx`'s `MemberCardsView`) and the
 * transactions mini-reconcile lives in its own tab (`my-transactions.tsx`), so
 * this view no longer duplicates either — it's just "My reimbursements": a
 * "Request a reimbursement" CTA that opens the in-app submit form, and
 * `api.reimbursements.myReimbursements` (no finance-role gate — it's the
 * caller's own history) backing the list below it.
 */
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  Row,
  SectionHeader,
  Table,
  TableHeader,
  HeaderCell,
} from "../../ui";
import { STATUS_BADGE, shortDate } from "../reimbursements/helpers";
import { api } from "@events-os/convex/_generated/api";

export function MemberView() {
  const router = useRouter();
  const reimbursements = useQuery(api.reimbursements.myReimbursements, {});

  return (
    <View>
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
