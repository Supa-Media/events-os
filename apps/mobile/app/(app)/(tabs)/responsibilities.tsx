/**
 * DUTIES — the chapter's recurring duties as a database grid.
 *
 * This route is kept for deep links; it's dropped from the nav (Duties now lives
 * inside the Work tab's Duties segment). It's a thin wrapper: the in-screen
 * `canManage` guard stays (nav hiding is not access control), and the grid body
 * lives in `components/work/DutiesGrid`, shared with the Work tab.
 */
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, FULL_WIDTH, EmptyState } from "../../../components/ui";
import { DutiesGrid } from "../../../components/work/DutiesGrid";

export default function ResponsibilitiesScreen() {
  const nav = useQuery(api.org.nav);

  if (nav === undefined) return <Screen loading />;

  // The nav hides this tab for non-managers; still guard the direct URL.
  if (!nav.canManage) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Duties are managed by team leads"
            message="The duty catalog is only visible to managers and admins. Your own duties are listed on your Work page."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <DutiesGrid />
    </Screen>
  );
}
