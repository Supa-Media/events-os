import { Redirect, Stack } from "expo-router";
import { useConvexAuth } from "convex/react";
import { AppShell } from "../../components/ui";

/**
 * Authenticated route group. Redirects to the login screen when signed out.
 * Auth state comes from @convex-dev/auth via `useConvexAuth`.
 *
 * The whole authenticated surface is wrapped in the responsive AppShell so the
 * left sidebar (desktop) / bottom nav (mobile) persists across every screen —
 * pipeline, event detail, templates, people — like a real desktop work app.
 */
export default function AppLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) return null;

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <AppShell>
      <Stack screenOptions={{ headerShown: false }} />
    </AppShell>
  );
}
