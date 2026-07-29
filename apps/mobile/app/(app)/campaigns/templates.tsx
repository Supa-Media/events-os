/**
 * TEMPLATES tab — the campaign template library (list, preview, rename,
 * describe, remove). Body lives in
 * `components/campaign/CampaignTemplatesView.tsx` (see that file for why).
 *
 * Gated the same way every other Emails-desk screen does: check
 * `audiences.myCampaignsAccess` BEFORE rendering the body, so a
 * non-privileged caller who deep-links here never fires the gated
 * `campaignTemplates.listTemplates` query — it throws `FORBIDDEN`
 * server-side, which without this gate lands as an unhandled error in the
 * ErrorBoundary instead of a graceful message.
 */
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, EmptyState } from "../../../components/ui";
import { CampaignTemplatesView } from "../../../components/campaign/CampaignTemplatesView";

export default function CampaignTemplatesScreen() {
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="The Emails desk is available to org leadership"
            message="Ask a central Executive Director, Financial Manager, or Marketing Director to grant you email design, compose, or approve power."
          />
        </Narrow>
      </Screen>
    );
  }
  return <CampaignTemplatesView />;
}
