import { Slot, usePathname, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { DeskShell } from "../../../components/ui";

/**
 * Marketing desk sub-navigation — its own desk beside `giving/` and
 * `campaigns/` (an ongoing-responsibility function, same PARA group).
 * The outer AppShell provides the app chrome; this layout adds the in-app
 * desk tabs above the active screen, cloning the `giving/_layout` pill-nav
 * pattern exactly.
 *
 * Site · Designs · Blog · Links · Mailing list · Emails.
 *
 * WHY THIS DESK EXISTS. Every other function in the org had a home in here and
 * marketing did not, which meant the one team whose work is entirely public had
 * the least control over anything public: changing a headline, reordering the
 * link cards, publishing a post, or adding someone to the newsletter each
 * required a developer. Each tab is one of those things.
 *
 * EMAILS IS DELIBERATELY INERT. Bulk email goes out through Mailchimp
 * (2026-08-19, `docs/plans/email-desk-parked.md`), so the tab is here as a
 * signpost — it explains where the newsletter actually lives and links out —
 * rather than hiding the fact that this app once sent mail and no longer does.
 * A missing tab reads as "not built yet"; a tab that says "Mailchimp, for now"
 * reads as a decision, which is what it is.
 *
 * DESIGNS IS THE ONE TAB ANYONE CAN OPEN, and making that TRUE rather than
 * merely stated is why this layout filters per-tab instead of all-or-nothing.
 *
 * The brand kit is readable by every signed-in person on purpose
 * (`marketing.designs.edit` has no `view` sibling; its doc carries the
 * argument — "nobody should have to ask permission to look right"). But a
 * Marketing entry in every volunteer's sidebar would be five tabs of noise for
 * the sake of one, so the AppShell's nav entry stays gated on `canViewDesk`.
 * That leaves a volunteer who follows a link to the brand kit — from the
 * Academy's brand lesson, or from a teammate — landing on a desk whose tabs
 * they mostly cannot use.
 *
 * So each tab declares what it needs, and a caller sees exactly the tabs that
 * will work. A volunteer gets a one-tab desk that is entirely theirs; the
 * Marketing Director gets all six. The alternative — showing every tab and
 * letting five of them refuse — is the shape that teaches people the app is
 * full of doors that don't open.
 *
 * Order reads outward: what the world sees (Site, Links, Designs, Blog), then
 * who we reach (Mailing list), then Emails, which is a signpost rather than a
 * desk and belongs last.
 */
type MarketingAccessFlags = {
  canViewDesk: boolean;
  canEditSite: boolean;
  canEditDesigns: boolean;
  canEditBlog: boolean;
  canViewList: boolean;
};

const TABS: {
  label: string;
  path: string;
  /** Absent = everyone. Only Designs is absent, and that is the feature. */
  needs?: (a: MarketingAccessFlags) => boolean;
}[] = [
  { label: "Site", path: "/marketing", needs: (a) => a.canEditSite },
  { label: "Links", path: "/marketing/links", needs: (a) => a.canEditSite },
  { label: "Designs", path: "/marketing/designs" },
  { label: "Blog", path: "/marketing/blog", needs: (a) => a.canEditBlog },
  { label: "Mailing list", path: "/marketing/list", needs: (a) => a.canViewList },
  // The Emails signpost answers "where did the newsletter go?", which is only
  // a question for someone who works this desk.
  { label: "Emails", path: "/marketing/emails", needs: (a) => a.canViewDesk },
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
  // undefined while loading → no tabs, rather than flashing a set that then
  // shrinks (the finances/giving `_layout` rule).
  const tabs = access ? TABS.filter((t) => !t.needs || t.needs(access)) : [];

  return (
    <DeskShell
      tabs={tabs}
      isActive={(path) => isActive(pathname, path)}
      onNavigate={(path) => router.navigate(path as never)}
    >
      <Slot />
    </DeskShell>
  );
}
