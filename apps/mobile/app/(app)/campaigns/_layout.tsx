import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Pill } from "../../../components/ui";

/**
 * Campaigns (email-blast desk) sub-navigation — its own desk beside `giving/`
 * (an ongoing-responsibility function, same PARA group). The outer AppShell
 * provides the app chrome; this layout adds the in-app campaigns tabs above
 * the active screen, cloning the `giving/_layout` pill-nav pattern exactly.
 *
 * Campaigns · Audiences · Replies. The tabs render only for a caller who can
 * see the desk (`audiences.myCampaignsAccess.canView`) — each screen keeps
 * its own backend gate too, same as Giving.
 */
const TABS: { label: string; path: string }[] = [
  { label: "Campaigns", path: "/campaigns" },
  { label: "Audiences", path: "/campaigns/audiences" },
  { label: "Replies", path: "/campaigns/replies" },
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /campaigns/audiences lights Audiences, /campaigns lights
 *  Campaigns. */
function isActive(pathname: string, path: string): boolean {
  if (path === "/campaigns") {
    return pathname === "/campaigns" || pathname === "/campaigns/index";
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function CampaignsLayout() {
  const pathname = usePathname();
  const router = useRouter();
  // undefined while loading → render no tabs (mirrors finances/giving
  // `_layout`, which shows nothing until access resolves rather than
  // flashing tabs a caller can't use).
  const access = useQuery(api.audiences.myCampaignsAccess, {});
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
