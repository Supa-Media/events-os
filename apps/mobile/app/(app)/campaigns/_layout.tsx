import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Pill } from "../../../components/ui";

/**
 * Emails desk sub-navigation — its own desk beside `giving/`
 * (an ongoing-responsibility function, same PARA group). The outer AppShell
 * provides the app chrome; this layout adds the in-app desk tabs above
 * the active screen, cloning the `giving/_layout` pill-nav pattern exactly.
 *
 * Emails · Segments · Templates · Themes · Replies. The tabs render only
 * for a caller who can see the desk (`audiences.myCampaignsAccess.canView`) —
 * each screen keeps its own backend gate too, same as Giving.
 *
 * "Segments" is the label for what the backend still calls audiences
 * (`api.audiences.*`, the `audiences` table): the route and every function
 * name are unchanged, this is vocabulary only — see `AudiencesView.tsx`.
 *
 * Templates and Themes sit between the AUTHORING tabs and the inbox: they're
 * the two libraries an email is assembled from (a starting document and its
 * branding), so they belong beside the things you make, not beside the
 * replies you read.
 */
// The first tab's route stays `/campaigns` — the paths and the API keep the
// older name; only the words on screen changed. See
// `docs/guides/email-terminology.md`.
const TABS: { label: string; path: string }[] = [
  { label: "Emails", path: "/campaigns" },
  { label: "Segments", path: "/campaigns/audiences" },
  { label: "Templates", path: "/campaigns/templates" },
  { label: "Themes", path: "/campaigns/themes" },
  { label: "Replies", path: "/campaigns/replies" },
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /campaigns/audiences lights Segments, /campaigns lights
 *  Emails. */
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
