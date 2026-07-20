import { Screen } from "../../../components/ui";
import { RepliesView } from "../../../components/campaign/RepliesView";

/** REPLIES tab — org-wide inbox of replies to sent campaigns. */
export default function RepliesScreen() {
  return (
    <Screen>
      <RepliesView />
    </Screen>
  );
}
