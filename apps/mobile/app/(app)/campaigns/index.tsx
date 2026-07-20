import { Screen } from "../../../components/ui";
import { CampaignsListView } from "../../../components/campaign/CampaignsListView";

/** CAMPAIGNS tab — the campaign list + inline creator. Body lives in
 *  `CampaignsListView` (see that file for why). */
export default function CampaignsScreen() {
  return (
    <Screen>
      <CampaignsListView />
    </Screen>
  );
}
