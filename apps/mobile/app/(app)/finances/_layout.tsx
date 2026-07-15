import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { Pill } from "../../../components/ui";
import { SandboxModeBanner } from "../../../components/finance/SandboxModeBanner";

/**
 * Finance sub-navigation. The outer AppShell provides the app chrome; this
 * layout adds the in-app finance tabs (Dashboard · Reconcile · Cards ·
 * Reimbursements) above the active screen, matching the prototype's tabbed
 * finance app. Each tab is its own route so the Phase-1 UI agents own disjoint
 * screen files. Perspective (central / chapter / member) is resolved INSIDE
 * each screen from the caller's finance role — not by hiding tabs here.
 *
 * Orchestrator-owned (shared across the finance screens); screens render their
 * own <Screen>/content into the <Slot/> below.
 */
const TABS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/finances" },
  { label: "Reconcile", path: "/finances/reconcile" },
  { label: "Cards", path: "/finances/cards" },
  { label: "Reimbursements", path: "/finances/reimbursements" },
  { label: "Accounts", path: "/finances/accounts" },
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /finances/reconcile lights Reconcile, /finances lights Dashboard. */
function isActive(pathname: string, path: string): boolean {
  if (path === "/finances") {
    return pathname === "/finances" || pathname === "/finances/index";
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function FinancesLayout() {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <View className="flex-1">
      {/* Deployment-wide sandbox-mode banner (shows on every finance tab when on). */}
      <SandboxModeBanner />
      <View className="border-b border-border bg-raised px-4 py-2.5">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {TABS.map((t) => (
            <Pill
              key={t.path}
              label={t.label}
              selected={isActive(pathname, t.path)}
              onPress={() => router.navigate(t.path as never)}
            />
          ))}
        </ScrollView>
      </View>
      <View className="flex-1">
        <Slot />
      </View>
    </View>
  );
}
