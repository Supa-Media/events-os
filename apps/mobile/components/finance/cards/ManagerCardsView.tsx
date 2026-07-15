/**
 * Manager perspective of the Cards tab — the finance manager's cardholders view.
 * Real data from `api.cards.listCards`: a KPI tile row, the cardholders table
 * (lock / unlock / edit-controls per row), an "Issue card" flow, and the static
 * card-philosophy explainer. Matches `finances.html` (§ Cards, manager-only).
 *
 * "Personal to repay" has no manager-level aggregate read in the Phase-5 card
 * contract (repayments are surfaced per-cardholder), so that tile shows a dash
 * rather than a fabricated number.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
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
  const lockCard = useMutation(api.cards.lockCard);
  const unlockCard = useMutation(api.cards.unlockCard);
  const { run, toast, dismiss } = useActionRunner();

  const [issueOpen, setIssueOpen] = useState(false);
  const [controlsFor, setControlsFor] = useState<CardSummary | null>(null);

  const stats = useMemo(() => {
    const list = cards ?? [];
    return {
      count: list.length,
      spentCents: list.reduce((sum, c) => sum + c.spentThisMonthCents, 0),
      receiptsDue: list.filter(hasReceiptDue).length,
    };
  }, [cards]);

  const loading = cards === undefined;

  const handleLock = (id: string) =>
    run(() => lockCard({ cardId: id as Id<"cards"> }), {
      errorTitle: "Couldn't lock card",
    });
  const handleUnlock = (id: string) =>
    run(() => unlockCard({ cardId: id as Id<"cards"> }), {
      errorTitle: "Couldn't unlock card",
    });

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
          meta="flagged by cardholders"
        />
      </View>

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
      ) : cards.length === 0 ? (
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
          {cards.map((card, i) => (
            <CardholderRow
              key={card.id}
              card={card}
              last={i === cards.length - 1}
              onLock={() => handleLock(card.id)}
              onUnlock={() => handleUnlock(card.id)}
              onEditControls={() => setControlsFor(card)}
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
