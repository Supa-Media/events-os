/**
 * FINANCES — the native money layer (funds, budgets, transactions,
 * reimbursements, cards). Phase 0 ships this PLACEHOLDER only: the nav entry +
 * tier gate are wired, but the dashboards/reconcile/cards screens land in
 * Phase 1 (built to the `finances.html` prototype). Kept behind an admin-or-lead
 * nav gate AND this in-screen guard while under construction; the real
 * capability check is the backend `financeRoles` gate.
 */
import { View, Text } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { EmptyState, Narrow, Screen } from "../../../components/ui";

export default function FinancesScreen() {
  const org = useQuery(api.org.nav);

  // In-screen guard: finance is admin-or-lead for now (mirrors the nav gate).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Finances is restricted"
            message="Only chapter admins and leads can access finances."
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
          <Text className="font-display text-2xl text-ink">Finances</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Coming soon
          </Text>
        </View>
        <EmptyState
          title="Finances is under construction"
          message="Funds, budgets, transactions, reimbursements, and cards are on the way."
        />
      </Narrow>
    </Screen>
  );
}
