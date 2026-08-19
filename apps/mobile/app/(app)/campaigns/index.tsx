import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, EmptyState, Card } from "../../../components/ui";
import { CampaignsListView } from "../../../components/campaign/CampaignsListView";

/** CAMPAIGNS tab — the campaign list + inline creator. Body lives in
 *  `CampaignsListView` (see that file for why).
 *
 * Gated the same way `giving/donors.tsx` gates its own screen: check
 * `audiences.myCampaignsAccess` BEFORE rendering the body, so a
 * non-privileged caller who deep-links here (`/campaigns`) never fires the
 * gated `campaigns.listCampaigns`/`audiences.listAudiences` queries — those
 * throw `FORBIDDEN` server-side, which without this gate lands as an
 * unhandled error in the ErrorBoundary instead of a graceful message.
 *
 * ── Parked (2026-08-19) ─────────────────────────────────────────────────────
 * Bulk email goes out through Mailchimp now, and this desk is hidden from nav
 * by default (`audiences.myCampaignsAccess`'s `deskEnabled`). It is
 * deliberately still REACHABLE — an in-flight send has to be finishable and
 * the history has to stay readable — so anyone who arrives here by direct URL
 * or a saved link is told where bulk email actually lives, rather than being
 * left to compose a send in a tool the org no longer sends from. See
 * `docs/plans/email-desk-parked.md`.
 */
export default function CampaignsScreen() {
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
  return (
    <Screen>
      {!access.deskEnabled && (
        <View style={{ marginBottom: 16 }}>
          <Card>
            <Text className="text-sm font-semibold">
              This desk is parked — bulk email goes out through Mailchimp
            </Text>
            <Text className="text-sm text-muted">
              Public Worship&apos;s newsletters and announcements are sent from
              Mailchimp now. The roster syncs onto the Mailchimp audience
              nightly, and an unsubscribe there is honoured everywhere here.
              {"\n\n"}
              Everything below still works and stays readable, so a send already
              in flight can be finished — but don&apos;t start a new one here.
            </Text>
          </Card>
        </View>
      )}
      <CampaignsListView />
    </Screen>
  );
}
