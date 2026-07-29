/**
 * WS0 SPIKE ROUTE — not a shipped feature. Proves
 * `docs/plans/maily-editor-overhaul.md`'s Bet 1 (maily's `<Editor>` mounts
 * under react-native-web + Metro) with running code. No nav entry points
 * here (not in `campaigns/_layout.tsx`'s `TABS`) — reachable only by typing
 * the URL. Deleted once the spike's verdict is folded into the plan doc, or
 * replaced by WS3's real host screen.
 *
 * Gated the same way every other Emails-desk screen gates itself
 * (`audiences.myCampaignsAccess` — see `campaigns/themes.tsx`), not because
 * this spike is going anywhere, but because "spike route, no gate" is exactly
 * the kind of inline exception CLAUDE.md's access-power rule warns against —
 * reusing the existing resolver costs nothing here.
 */
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Narrow, EmptyState } from "../../../components/ui";
import { EditorSpikeScreen } from "../../../components/campaign/editorSpike/EditorSpikeScreen";

export default function CampaignEditorSpikeScreen() {
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
      <EditorSpikeScreen />
    </Screen>
  );
}
