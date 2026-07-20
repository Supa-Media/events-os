import { useEffect } from "react";
import { Redirect, Stack, usePathname, useGlobalSearchParams } from "expo-router";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { AppShell } from "../../components/ui";
import { AccessDeniedScreen } from "../../components/onboarding/AccessDeniedScreen";
import { OnboardingScreen } from "../../components/onboarding/OnboardingScreen";
import { ChapterContextProvider } from "../../lib/ChapterContext";

/** Reassembles the current route's path + query string (`usePathname` gives
 *  the clean path, e.g. `/event/abc`; `useGlobalSearchParams` gives every
 *  dynamic-segment AND query param) so a signed-out deep link — an email's
 *  "Open →" into `/event/<id>?tab=crew`, a manager rollup's `/team/<id>`,
 *  a receipt CTA's `/finances/reconcile?filter=missing_receipt` — can round-
 *  trip through `/(auth)/login?redirect=` and land back on the exact screen
 *  instead of the app home. Mirrors `reimburse-request.tsx`'s single static
 *  `?redirect=/reimburse-request` precedent, generalized to any path +
 *  params. A param that's also a dynamic route segment (already baked into
 *  `pathname`) ends up duplicated in the query string too — harmless, the
 *  router matches on the path and ignores the redundant extra param. */
function currentDestination(
  pathname: string,
  params: Record<string, string | string[] | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const qs = search.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Authenticated route group. Redirects to login when signed out; otherwise
 * resolves the caller's access + onboarding status via `profiles.me` and routes
 * to one of three surfaces:
 *
 *   - not on @publicworship.life  → Access Denied
 *   - allowed but not onboarded   → Onboarding (name + phone + chapter)
 *   - allowed + onboarded         → the app (wrapped in ChapterContextProvider + AppShell)
 *
 * The whole authenticated surface is wrapped in the responsive AppShell so the
 * left sidebar (desktop) / bottom nav (mobile) persists across every screen.
 * `ChapterContextProvider` (WP-S) sits just outside it so the shell's context
 * pill + peek banner, and every scoped screen, share one "which desk" state.
 */
export default function AppLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const pathname = usePathname();
  const params = useGlobalSearchParams<Record<string, string | string[]>>();
  const me = useQuery(api.profiles.me, isAuthenticated ? {} : "skip");
  const reconcileMyPerson = useMutation(api.profiles.reconcileMyPerson);

  // On login, make sure the account maps to exactly one roster row: create it
  // if missing, and merge any duplicates so the user sees all of their tasks.
  // Idempotent + best-effort — a hiccup here must never block the app.
  useEffect(() => {
    if (me?.onboarded) {
      reconcileMyPerson().catch((err) => {
        // Best-effort: never block the app, but leave a breadcrumb so a
        // persistently failing reconcile (e.g. transaction limits on a huge
        // chapter) isn't completely silent.
        console.warn("reconcileMyPerson failed", err);
      });
    }
  }, [me?.onboarded, reconcileMyPerson]);

  if (isLoading) return null;

  if (!isAuthenticated) {
    const destination = currentDestination(pathname, params);
    return (
      <Redirect
        href={`/(auth)/login?redirect=${encodeURIComponent(destination)}`}
      />
    );
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
    <ChapterContextProvider>
      <AppShell>
        <Stack screenOptions={{ headerShown: false }} />
      </AppShell>
    </ChapterContextProvider>
  );
}
