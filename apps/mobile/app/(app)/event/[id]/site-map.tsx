import { useLocalSearchParams } from "expo-router";
import { SiteMapEditor } from "../../../../components/event/SiteMapEditor";

/**
 * Standalone site-map route — a deep-link target that renders the shared
 * SiteMapEditor with full page chrome. The same editor renders inline under the
 * Supplies & Logistics workstream's grid (see SiteMapSubsection/ModuleSection).
 */
export default function SiteMapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SiteMapEditor eventId={id as string} />;
}
