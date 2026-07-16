/**
 * FINANCES · CARDS — the real Cards tab (Phase 5).
 *
 * Person-owned Increase cards + the personal-repayment flow, now that
 * `api.cards.*` is live. Rendered in one of two perspectives, mirroring the
 * `finances.html` prototype's manager-only / member-only split:
 *
 *  - **Manager** (holds a finance seat): the cardholders view — KPI tiles, the
 *    cardholders table with lock / unlock / edit-controls, an "Issue card"
 *    flow, and the card-philosophy explainer. Reads gate on the `financeRoles`
 *    ladder server-side too — the FinanceBoundary fallback is defense-in-depth,
 *    not the primary gate.
 *  - **Member** (no finance seat): their OWN card — the red virtual-card art, a
 *    status/spend summary with a receipt warning, the two hard controls shown
 *    read-only, and the flag-a-charge → pay-it-back personal-repayment flow.
 *
 * Perspective resolves from `api.financeRoles.mySeats` (WP-0.2's REAL seats),
 * not the org-chart tier — a tier=admin/lead caller with no financeRoles grant
 * (e.g. a growth-team lead) is exactly the no-finance-seat "member" this Cards
 * tab's D3 strip-down targets, and previously landed on the manager view's
 * permission wall instead of their own card.
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
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (seats === undefined) return <Screen loading />;

  const isManager = seats.length > 0;

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
