import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, EmptyState } from "../../../components/ui";
import { AudiencesView } from "../../../components/campaign/AudiencesView";

/** AUDIENCES tab — segment list + inline create/edit with a live preview.
 *
 * Gated the same way `campaigns/index.tsx` (and `giving/donors.tsx` before
 * it) gates its own screen — see that file's doc. */
export default function AudiencesScreen() {
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
  return (
    <Screen>
      <AudiencesView />
    </Screen>
  );
}
