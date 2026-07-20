import { Screen } from "../../../components/ui";
import { AudiencesView } from "../../../components/campaign/AudiencesView";

/** AUDIENCES tab — segment list + inline create/edit with a live preview. */
export default function AudiencesScreen() {
  return (
    <Screen>
      <AudiencesView />
    </Screen>
  );
}
