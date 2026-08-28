import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Pill } from "../../../components/ui";

/**
 * Marketing desk sub-navigation — its own desk beside `giving/` and
 * `campaigns/` (an ongoing-responsibility function, same PARA group).
 * The outer AppShell provides the app chrome; this layout adds the in-app
 * desk tabs above the active screen, cloning the `giving/_layout` pill-nav
 * pattern exactly.
 *
 * Site · Links · Mailing list · Emails.
 *
 * WHY THIS DESK EXISTS. Every other function in the org had a home in here and
 * marketing did not, which meant the one team whose work is entirely public had
 * the least control over anything public: changing a headline, reordering the
 * link cards, or adding someone to the newsletter each required a developer.
 * The four tabs are the four things that were being asked for by hand.
 *
 * EMAILS IS DELIBERATELY INERT. Bulk email goes out through Mailchimp
 * (2026-08-19, `docs/plans/email-desk-parked.md`), so the tab is here as a
 * signpost — it explains where the newsletter actually lives and links out —
 * rather than hiding the fact that this app once sent mail and no longer does.
 * A missing tab reads as "not built yet"; a tab that says "Mailchimp, for now"
 * reads as a decision, which is what it is.
 *
 * The tabs render only for a caller who can see the desk
 * (`marketingSite.myMarketingAccess.canViewDesk`) — each screen keeps its own
 * backend gate too, same as Giving.
 */
const TABS: { label: string; path: string }[] = [
  { label: "Site", path: "/marketing" },
  { label: "Links", path: "/marketing/links" },
  { label: "Mailing list", path: "/marketing/list" },
  { label: "Emails", path: "/marketing/emails" },
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /marketing/links lights Links, /marketing lights Site. */
function isActive(pathname: string, path: string): boolean {
  if (path === "/marketing") {
    return pathname === "/marketing" || pathname === "/marketing/index";
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function MarketingLayout() {
  const pathname = usePathname();
  const router = useRouter();
  // undefined while loading → render no tabs (mirrors finances/giving
  // `_layout`, which shows nothing until access resolves rather than
  // flashing tabs a caller can't use).
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const tabs = access?.canViewDesk === true ? TABS : [];

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
