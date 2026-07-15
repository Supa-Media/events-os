/**
 * FINANCES · CARDS — Phase-1 SHELL.
 *
 * Card issuance (Increase-issued, person-owned cards + real-time auth + the
 * personal-repayment flow) lands in Phase 5, so there is no `api.finances.cards`
 * yet. This screen renders the prototype's Cards tab as a faithful "here's how
 * it will work" surface: the later-phase info callout, illustrative manager
 * tiles (labels + meta, NO fabricated numbers), a "no cards yet" empty state,
 * the red virtual-card art (a plain gradient-styled View — no native dep), and
 * the static "Card philosophy" + "pay it back" explainers.
 *
 * Guarded admin-or-lead in-screen (mirrors the nav gate) so a member who
 * deep-links lands on a friendly restricted state. Matches `finances.html`
 * (§ Cards) and `docs/plans/finance.md` (§ Cards, § Money model).
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { RECEIPT_GRACE_DAYS } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { CardTile } from "../../../components/finance/cards/CardTile";
import { CardPhilosophy } from "../../../components/finance/cards/CardPhilosophy";
import { VirtualCardArt } from "../../../components/finance/cards/VirtualCardArt";

export default function CardsScreen() {
  const org = useQuery(api.org.nav);

  // In-screen guard: cards are a finance-manager surface (admin or lead for now,
  // mirroring the nav gate).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Cards are restricted"
            message="Only chapter admins and finance managers can manage cards."
          />
        </Narrow>
      </Screen>
    );
  }

  if (org === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <View className="mb-1 flex-row items-center gap-2">
          <Text className="font-display text-2xl text-ink">Cards</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Coming soon
          </Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Person-owned spending cards on the chapter's Increase account. Here's
          how they'll work.
        </Text>

        {/* Later-phase info callout (prototype's blue "Later phase" banner). */}
        <View className="mb-5 flex-row gap-3 rounded-lg border border-info bg-info-bg px-4 py-3">
          <Icon name="info" size={16} color={colors.info} />
          <Text className="flex-1 text-sm text-ink">
            <Text className="font-bold">Later phase.</Text> Cards are shown here
            to make the model concrete. They ship after budgets, reconciliation,
            and reimbursements are live — issued on the chapter's Increase
            account.
          </Text>
        </View>

        {/* Illustrative manager tiles — labels + meta only, never fake numbers. */}
        <View className="flex-row flex-wrap gap-3">
          <CardTile label="Team cards" meta="one per team member" />
          <CardTile label="Spent · month" meta="across all cards" />
          <CardTile label="Receipts due" meta="cardholders on the hook" />
          <CardTile label="Personal to repay" meta="charges flagged" />
        </View>

        {/* Cardholders — empty until issuance ships. */}
        <SectionHeader
          title="Cardholders"
          count="everyone gets one"
          right={
            <Button
              title="Issue card"
              icon="plus"
              size="sm"
              disabled
              onPress={() => {}}
            />
          }
        />
        <EmptyState
          icon="credit-card"
          title="No cards issued yet"
          message="Card issuance ships in a later phase. Every team member will get one card on the chapter's Increase account."
        />

        {/* The virtual-card art, as an illustrative preview of the member view. */}
        <SectionHeader title="What a card looks like" />
        <View className="flex-row flex-wrap gap-4">
          <View className="min-w-[260px] flex-1">
            <VirtualCardArt />
          </View>
          <View className="min-w-[260px] flex-1">
            <Card>
              <View className="gap-3">
                <View className="flex-row items-center justify-between">
                  <Text className="font-semibold text-ink">Your card</Text>
                  <Badge label="Active" tone="success" icon="check" />
                </View>
                <Text className="text-xs text-muted">
                  <Text className="font-semibold text-ink">
                    This card is yours.
                  </Text>{" "}
                  No budget limit — but every charge is yours to receipt &
                  reconcile. It locks if a receipt is more than{" "}
                  {RECEIPT_GRACE_DAYS} days late, and unlocks the moment you add
                  it.
                </Text>
              </View>
            </Card>
          </View>
        </View>

        {/* Static philosophy + pay-it-back explainers. */}
        <SectionHeader title="Card philosophy" />
        <CardPhilosophy />
      </Narrow>
    </Screen>
  );
}
