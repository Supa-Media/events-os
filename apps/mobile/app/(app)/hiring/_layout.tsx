import { Slot } from "expo-router";
import { View } from "react-native";

/**
 * The Hiring desk's route group. Deliberately a bare `Slot`: unlike Giving —
 * which is a dozen surfaces that need pill navigation between them — hiring is
 * one pipeline and one candidate's file, and a tab bar over two screens is
 * furniture. The outer AppShell still provides the app chrome, and each screen
 * keeps its own `hiring.view` gate (`apps/convex/lib/hiringAccess.ts`).
 */
export default function HiringLayout() {
  return (
    <View className="flex-1">
      <Slot />
    </View>
  );
}
