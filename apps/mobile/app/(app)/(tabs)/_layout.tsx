import { Slot } from "expo-router";

/**
 * The primary tab routes (Events / Templates / People). Navigation chrome —
 * the persistent sidebar / bottom nav — is provided by the AppShell in the
 * parent (app) layout, so these screens just render into it.
 */
export default function TabsLayout() {
  return <Slot />;
}
