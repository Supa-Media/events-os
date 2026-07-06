/**
 * PERSON WORKLOAD route — thin wrapper over the shared WorkloadView (also
 * rendered by the Team tab as the "my work" view for people with no reports).
 */
import { useLocalSearchParams } from "expo-router";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Screen } from "../../../components/ui";
import { WorkloadView } from "../../../components/team/WorkloadView";

export default function PersonWorkloadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return <Screen loading />;
  return <WorkloadView personId={id as Id<"people">} />;
}
