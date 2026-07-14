/**
 * TEMPLATES — reusable event blueprints.
 *
 * This route is kept for deep links; it's dropped from the nav (Templates now
 * lives inside the Events tab's Templates segment). It's a thin wrapper: the
 * list body lives in `components/template/TemplatesView`, shared with the Events
 * tab. Access stays enforced server-side by the `templates.*` functions.
 */
import { Screen } from "../../../components/ui";
import { TemplatesView } from "../../../components/template/TemplatesView";

export default function TemplatesScreen() {
  return (
    <Screen>
      <TemplatesView />
    </Screen>
  );
}
