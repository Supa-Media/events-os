import { Redirect, Stack } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { AppShell } from "../../components/ui";
import { AccessDeniedScreen } from "../../components/onboarding/AccessDeniedScreen";
import { OnboardingScreen } from "../../components/onboarding/OnboardingScreen";

/**
 * Authenticated route group. Redirects to login when signed out; otherwise
 * resolves the caller's access + onboarding status via `profiles.me` and routes
 * to one of three surfaces:
 *
 *   - not on @publicworship.life  → Access Denied
 *   - allowed but not onboarded   → Onboarding (name + phone + chapter)
 *   - allowed + onboarded         → the app (wrapped in AppShell)
 *
 * The whole authenticated surface is wrapped in the responsive AppShell so the
 * left sidebar (desktop) / bottom nav (mobile) persists across every screen.
 */
export default function AppLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const me = useQuery(api.profiles.me, isAuthenticated ? {} : "skip");

  if (isLoading) return null;

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  // me is `undefined` while loading, `null` if the query couldn't resolve a user.
  if (me === undefined) return null;

  if (me && me.allowed === false) {
    return <AccessDeniedScreen email={me.email} />;
  }

  if (me && !me.onboarded) {
    return <OnboardingScreen />;
  }

  return (
    <AppShell>
      <Stack screenOptions={{ headerShown: false }} />
    </AppShell>
  );
}
