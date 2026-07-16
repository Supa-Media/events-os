/**
 * Manager perspective of the Cards tab — the finance manager's cardholders view.
 * Real data from `api.cards.listCards`: a KPI tile row, the cardholders table
 * (lock / unlock / edit-controls per row), an "Issue card" flow, and the static
 * card-philosophy explainer. Matches `finances.html` (§ Cards, manager-only).
 *
 * "Personal to repay" is backed by `api.cards.personalRepaymentsOutstanding`
 * (D4) — the chapter-scope aggregate of not-yet-paid personal-charge
 * repayments, viewer+ gated. The same query backs the matching tile on the
 * Reimbursements manager queue.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Avatar,
  Button,
  EmptyState,
  HeaderCell,
  SectionHeader,
  Table,
  TableHeader,
  ToastView,
} from "../../ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { CardTile } from "./CardTile";
import { CardPhilosophy } from "./CardPhilosophy";
import { CardholderRow } from "./CardholderRow";
import { IssueCardModal } from "./IssueCardModal";
import { CardControlsModal } from "./CardControlsModal";
import { RelayCardsSection } from "./RelayCardsSection";
import { hasReceiptDue, type CardSummary } from "./helpers";

export function ManagerCardsView() {
  const cards = useQuery(api.cards.listCards, {});
  const personalToRepay = useQuery(api.cards.personalRepaymentsOutstanding, {});
  const requests = useQuery(api.cards.listCardRequests, {});
  const lockCard = useMutation(api.cards.lockCard);
  const unlockCard = useMutation(api.cards.unlockCard);
  const cancelCard = useAction(api.cards.cancelCard);
  const decideCardRequest = useAction(api.cards.decideCardRequest);
  const { run, toast, dismiss } = useActionRunner();

  const [issueOpen, setIssueOpen] = useState(false);
  const [controlsFor, setControlsFor] = useState<CardSummary | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  // A canceled card is a terminal, permanently-closed record — WP-C.1 excludes
  // it from the active cardholders table + KPI aggregates (it can never
  // authorize again; there's nothing left to manage). It stays in the DB for
  // audit/spend history, just not in this operational view.
  const activeCards = useMemo(
    () => (cards ?? []).filter((c) => c.status !== "canceled"),
    [cards],
  );

  const stats = useMemo(() => {
    return {
      count: activeCards.length,
      spentCents: activeCards.reduce((sum, c) => sum + c.spentThisMonthCents, 0),
      receiptsDue: activeCards.filter(hasReceiptDue).length,
    };
  }, [activeCards]);

  const loading = cards === undefined;

  const handleLock = (id: string) =>
    run(() => lockCard({ cardId: id as Id<"cards"> }), {
      errorTitle: "Couldn't lock card",
    });
  const handleUnlock = (id: string) =>
    run(() => unlockCard({ cardId: id as Id<"cards"> }), {
      errorTitle: "Couldn't unlock card",
    });
  const handleCancel = (id: string) =>
    run(() => cancelCard({ cardId: id as Id<"cards"> }), {
      errorTitle: "Couldn't cancel card",
    });

  async function handleDecideRequest(
    requestId: Id<"cardRequests">,
    decision: "approve" | "deny",
  ) {
    setDecidingId(requestId);
    await run(() => decideCardRequest({ requestId, decision }), {
      errorTitle: decision === "approve" ? "Couldn't approve request" : "Couldn't deny request",
    });
    setDecidingId(null);
  }

  return (
    <View>
      <View className="mb-1 flex-row items-baseline gap-2">
        <Text className="font-display text-2xl text-ink">Cards</Text>
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {stats.count} {stats.count === 1 ? "card" : "cards"}
        </Text>
      </View>
      <Text className="mb-4 text-sm text-muted">
        Person-owned spending cards on the chapter's Increase account. Everyone
        gets one, and each holder owns their own receipts.
      </Text>

      {/* KPI tiles. */}
      <View className="mb-1 flex-row flex-wrap gap-3">
        <CardTile
          label="Team cards"
          value={String(stats.count)}
          meta="one per team member"
        />
        <CardTile
          label="Spent · month"
          value={formatCents(stats.spentCents)}
          meta="across all cards"
        />
        <CardTile
          label="Receipts due"
          value={String(stats.receiptsDue)}
          valueClassName={stats.receiptsDue > 0 ? "text-warn" : "text-ink"}
          meta="cardholders on the hook"
        />
        <CardTile
          label="Personal to repay"
          value={
            personalToRepay === undefined
              ? undefined
              : formatCents(personalToRepay.totalCents)
          }
          valueClassName={
            personalToRepay && personalToRepay.count > 0 ? "text-warn" : "text-ink"
          }
          meta={
            personalToRepay === undefined
              ? "flagged by cardholders"
              : `${personalToRepay.count} outstanding`
          }
        />
      </View>

      {/* Pending card requests — a member's `requestCard` waiting on
          approve/deny. Approving triggers the same `issueCard` flow as
          "Issue card" above. */}
      {requests !== undefined && requests.length > 0 ? (
        <>
          <SectionHeader title="Pending requests" count={requests.length} />
          <View className="mb-1 overflow-hidden rounded-lg border border-border bg-raised shadow-card">
            {requests.map((req, i) => (
              <View
                key={req.id}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  i === requests.length - 1 ? "" : "border-b border-border"
                }`}
              >
                <Avatar name={req.personName ?? "?"} size={30} />
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                    {req.personName ?? "Unknown"}
                  </Text>
                  {req.note ? (
                    <Text className="text-xs text-faint" numberOfLines={1}>
                      {req.note}
                    </Text>
                  ) : null}
                </View>
                <Button
                  title="Deny"
                  variant="ghost"
                  size="sm"
                  loading={decidingId === req.id}
                  onPress={() => handleDecideRequest(req.id, "deny")}
                />
                <Button
                  title="Approve"
                  variant="secondary"
                  size="sm"
                  icon="check"
                  loading={decidingId === req.id}
                  onPress={() => handleDecideRequest(req.id, "approve")}
                />
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* Cardholders table. */}
      <SectionHeader
        title="Cardholders"
        count={loading ? undefined : "everyone gets one"}
        right={
          <Button
            title="Issue card"
            icon="plus"
            size="sm"
            onPress={() => setIssueOpen(true)}
          />
        }
      />
      {loading ? (
        <EmptyState title="Loading cards…" />
      ) : activeCards.length === 0 ? (
        <EmptyState
          icon="credit-card"
          title="No cards issued yet"
          message="Issue the first person-owned card on the chapter's Increase account."
        />
      ) : (
        <Table>
          <TableHeader>
            <HeaderCell flex={2}>Cardholder</HeaderCell>
            <HeaderCell flex={1.6}>Receipts</HeaderCell>
            <HeaderCell width={110} align="right">
              Spent · month
            </HeaderCell>
            <HeaderCell width={132} align="right">
              Status
            </HeaderCell>
          </TableHeader>
          {activeCards.map((card, i) => (
            <CardholderRow
              key={card.id}
              card={card}
              last={i === activeCards.length - 1}
              onLock={() => handleLock(card.id)}
              onUnlock={() => handleUnlock(card.id)}
              onEditControls={() => setControlsFor(card)}
              onCancel={() => handleCancel(card.id)}
            />
          ))}
        </Table>
      )}

      {/* External (Relay) card linking — bind synced last-4s to a cardholder. */}
      <RelayCardsSection />

      {/* Static philosophy + pay-it-back explainers. */}
      <SectionHeader title="Card philosophy" />
      <CardPhilosophy />

      {issueOpen ? <IssueCardModal onClose={() => setIssueOpen(false)} /> : null}
      {controlsFor ? (
        <CardControlsModal
          card={controlsFor}
          onClose={() => setControlsFor(null)}
        />
      ) : null}
      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}
