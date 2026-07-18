import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Pill } from "../../../components/ui";

/**
 * Giving (development desk) sub-navigation — its own desk beside `finances/`
 * (Development is an org function, not a finance tab; PRD §6, B8). The outer
 * AppShell provides the app chrome; this layout adds the in-app giving tabs
 * above the active screen, mirroring the finances `_layout` pill nav.
 *
 * Phase 1 shipped Dashboard · Donors; P2 adds Backers (recurring pledges);
 * P4 adds Sponsorships (the institutional-giving pipeline + package tiers);
 * P3 adds Cities (the City Launch map desk — see `apps/convex/cityCampaigns.ts`).
 * The tabs render only for a caller who can see the desk
 * (`myGivingAccess.canView`) — the same `nav.giving` gate the AppShell nav
 * entry uses; each screen keeps its own backend `requireGivingView` gate.
 * (Sponsorships and Cities are both central-lens only — see
 * `schema/sponsorships.ts` / `cityCampaigns.ts` — but the tabs are shown to
 * anyone with desk access; each screen degrades to an access-needed state
 * for a chapter-only or view-only caller, same as every other tab does.)
 */
const TABS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/giving" },
  { label: "Donors", path: "/giving/donors" },
  { label: "Backers", path: "/giving/backers" },
  { label: "Sponsorships", path: "/giving/sponsorships" },
  { label: "Cities", path: "/giving/cities" },
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /giving/donors lights Donors, /giving lights Dashboard. */
function isActive(pathname: string, path: string): boolean {
  if (path === "/giving") {
    return pathname === "/giving" || pathname === "/giving/index";
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function GivingLayout() {
  const pathname = usePathname();
  const router = useRouter();
  // undefined while loading → render no tabs (mirrors finances `_layout`, which
  // shows nothing until access resolves rather than flashing tabs).
  const access = useQuery(api.givingPlatform.myGivingAccess, {});
  const tabs = access?.canView === true ? TABS : [];

  return (
    <View className="flex-1">
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
