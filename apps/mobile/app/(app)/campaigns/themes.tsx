/**
 * THEMES tab — the campaign email theme library + editor. Body lives in
 * `components/campaign/theme/CampaignThemesView.tsx` (see that file for why).
 *
 * Gated the same way `campaigns/index.tsx` gates its own screen: check
 * `audiences.myCampaignsAccess` BEFORE rendering the body, so a
 * non-privileged caller who deep-links here never fires the gated
 * `emailThemes.listThemes` query — it throws `FORBIDDEN` server-side, which
 * without this gate lands as an unhandled error in the ErrorBoundary instead
 * of a graceful message.
 */
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, EmptyState } from "../../../components/ui";
import { CampaignThemesView } from "../../../components/campaign/theme/CampaignThemesView";

export default function CampaignThemesScreen() {
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Campaigns is available to org leadership"
            message="Ask a central Executive Director, Financial Manager, or Marketing Director to grant you campaign compose or approve power."
          />
        </Narrow>
      </Screen>
    );
  }
  return <CampaignThemesView />;
}
