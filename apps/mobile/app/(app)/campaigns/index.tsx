import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, EmptyState } from "../../../components/ui";
import { CampaignsListView } from "../../../components/campaign/CampaignsListView";

/** CAMPAIGNS tab — the campaign list + inline creator. Body lives in
 *  `CampaignsListView` (see that file for why).
 *
 * Gated the same way `giving/donors.tsx` gates its own screen: check
 * `audiences.myCampaignsAccess` BEFORE rendering the body, so a
 * non-privileged caller who deep-links here (`/campaigns`) never fires the
 * gated `campaigns.listCampaigns`/`audiences.listAudiences` queries — those
 * throw `FORBIDDEN` server-side, which without this gate lands as an
 * unhandled error in the ErrorBoundary instead of a graceful message. */
export default function CampaignsScreen() {
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Campaigns is available to org leadership"
            message="Ask a central Executive Director or Financial Manager to grant you access."
          />
        </Narrow>
      </Screen>
    );
  }
  return (
    <Screen>
      <CampaignsListView />
    </Screen>
  );
}
