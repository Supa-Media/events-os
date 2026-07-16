import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Pill } from "../../../components/ui";
import { SandboxModeBanner } from "../../../components/finance/SandboxModeBanner";

/**
 * Finance sub-navigation. The outer AppShell provides the app chrome; this
 * layout adds the in-app finance tabs above the active screen, matching the
 * prototype's tabbed finance app. Each tab is its own route so the Phase-1 UI
 * agents own disjoint screen files.
 *
 * The tab SET itself branches on the caller's REAL finance seats
 * (`financeRoles.mySeats`, WP-0.2): a seat holder gets the manager tab bar
 * (Dashboard · Reconcile · Cards · Reimbursements) — the desk each of those
 * renders (central / chapter) still resolves INSIDE the screen. A caller with
 * NO finance seat (the member/cardholder case, D3) gets the reduced member
 * set instead — My Card · My Transactions · Reimbursements — so they never
 * land on a tab that only ever shows them a permission wall.
 *
 * Accounts is its OWN gate on top of that (WP-1.2): the tab only appears for
 * the Executive Director / Financial Manager seats (`financeRoles.
 * canViewAccounts` — tighter than a plain finance seat), now that account
 * provisioning is fully automatic and there's nothing left for a regular
 * chapter/central manager to DO there.
 *
 * Orchestrator-owned (shared across the finance screens); screens render their
 * own <Screen>/content into the <Slot/> below.
 */
const ACCOUNTS_TAB = { label: "Accounts", path: "/finances/accounts" };

const SEAT_TABS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/finances" },
  { label: "Reconcile", path: "/finances/reconcile" },
  { label: "Cards", path: "/finances/cards" },
  { label: "Reimbursements", path: "/finances/reimbursements" },
];

const MEMBER_TABS: { label: string; path: string }[] = [
  { label: "My Card", path: "/finances/cards" },
  { label: "My Transactions", path: "/finances/my-transactions" },
  { label: "Reimbursements", path: "/finances/reimbursements" },
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
  // [] (no grants at all) = a no-seat member; undefined while loading. Render
  // NO tabs while loading rather than guessing — defaulting to the full
  // seat-holder set would flash Dashboard/Reconcile/Cards/Accounts at every
  // no-seat member for a paint before `seats` resolves to `[]`.
  const seats = useQuery(api.financeRoles.mySeats, {});
  // Loading (`undefined`) → treated as "no access yet" so Accounts never
  // flashes in for a seat holder who turns out not to be ED/FM.
  const canViewAccounts = useQuery(api.financeRoles.canViewAccounts, {});
  const tabs =
    seats === undefined
      ? []
      : seats.length === 0
        ? MEMBER_TABS
        : canViewAccounts === true
          ? [...SEAT_TABS, ACCOUNTS_TAB]
          : SEAT_TABS;

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
          {tabs.map((t) => (
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
