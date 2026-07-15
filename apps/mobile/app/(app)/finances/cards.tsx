/**
 * FINANCES · CARDS — the real Cards tab (Phase 5).
 *
 * Person-owned Increase cards + the personal-repayment flow, now that
 * `api.cards.*` is live. Rendered in one of two perspectives, mirroring the
 * `finances.html` prototype's manager-only / member-only split:
 *
 *  - **Manager** (admin/lead, the finance-manager surface): the cardholders view
 *    — KPI tiles, the cardholders table with lock / unlock / edit-controls, an
 *    "Issue card" flow, and the card-philosophy explainer. Reads gate on the
 *    `financeRoles` ladder server-side; a lead without a finance grant degrades
 *    to a friendly "access needed" state via the shared FinanceBoundary.
 *  - **Member** (everyone else): their OWN card — the red virtual-card art, a
 *    status/spend summary with a receipt warning, the two hard controls shown
 *    read-only, and the flag-a-charge → pay-it-back personal-repayment flow.
 *
 * Perspective resolves from the caller's `api.org.nav` tier (the same probe the
 * finances nav gate uses), so a member who deep-links here lands on their card
 * rather than a restricted wall.
 */
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { EmptyState, Narrow, Screen } from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { ManagerCardsView } from "../../../components/finance/cards/ManagerCardsView";
import { MemberCardsView } from "../../../components/finance/cards/MemberCardsView";

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Finance access needed"
      message="Ask a finance manager to grant you access to the cardholders view."
    />
  );
}

export default function CardsScreen() {
  const org = useQuery(api.org.nav);

  if (org === undefined) return <Screen loading />;

  const tier = org.tier;
  const isManager = tier === "admin" || tier === "lead";

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        {isManager ? (
          // The cardholders view still gates on the finance-role ladder server
          // side; catch a role throw locally instead of blanking the screen.
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <ManagerCardsView />
          </FinanceBoundary>
        ) : (
          <MemberCardsView />
        )}
      </Narrow>
    </Screen>
  );
}
