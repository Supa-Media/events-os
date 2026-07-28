import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Screen, Narrow, EmptyState } from "../../../components/ui";
import { AudiencesView } from "../../../components/campaign/AudiencesView";

/** SEGMENTS tab — segment list + inline create/edit with a live preview.
 *
 * The route stays `/campaigns/audiences` and the body is still
 * `AudiencesView`: "Segment" is the on-screen label for what the backend
 * calls an audience (see `AudiencesView.tsx`'s doc), a vocabulary change
 * only — no API, table, or path was renamed.
 *
 * Gated the same way `campaigns/index.tsx` (and `giving/donors.tsx` before
 * it) gates its own screen — see that file's doc. `canView` opens the
 * screen; `canCompose` is passed down separately because the three segment
 * WRITES (create/update/archive) sit behind `requireCampaignCompose`, so a
 * design-only holder must get the list without the editor rather than a form
 * whose Save throws `FORBIDDEN` — the same split `campaigns/index.tsx` makes.
 *
 * `seedIncludeIds` (People-CRM UX, People grid's "Email selected" bridge):
 * a comma-joined list of person ids, deep-linked from
 * `router.push(\`/campaigns/audiences?seedIncludeIds=...\`)` — parsed here
 * and handed to `AudiencesView`, which auto-opens a fresh draft with them
 * pre-picked. Absent for every other entry into this screen. */
export default function AudiencesScreen() {
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  const { seedIncludeIds: seedParam } = useLocalSearchParams<{ seedIncludeIds?: string }>();
  const seedIncludeIds = useMemo(
    () =>
      seedParam
        ? (seedParam.split(",").filter(Boolean) as Id<"people">[])
        : undefined,
    [seedParam],
  );
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
  return (
    <Screen>
      <AudiencesView seedIncludeIds={seedIncludeIds} canCompose={access.canCompose} />
    </Screen>
  );
}
