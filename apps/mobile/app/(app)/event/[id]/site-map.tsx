import { useLocalSearchParams } from "expo-router";
import { SiteMapEditor } from "../../../../components/event/SiteMapEditor";

/**
 * Standalone site-map route — a deep-link target that renders the shared
 * SiteMapEditor with full page chrome. The same component renders inline as the
 * site_map module's section on the event screen (see ModuleSection).
 */
export default function SiteMapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SiteMapEditor eventId={id as string} />;
}
