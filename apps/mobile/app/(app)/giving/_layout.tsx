import { Slot, usePathname, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { DeskShell } from "../../../components/ui";

/**
 * Giving (development desk) sub-navigation — its own desk beside `finances/`
 * (Development is an org function, not a finance tab; PRD §6, B8). The outer
 * AppShell provides the app chrome; this layout adds the in-app giving tabs
 * above the active screen, mirroring the finances `_layout` pill nav.
 *
 * Phase 1 shipped Dashboard · Donors; the Gifts ledger (a chronological feed
 * of every gift in the book, newest-first, with edit / move-book / audit / add
 * — owner requests #1–#4) sits beside Donors; P2 adds Backers (recurring pledges);
 * P4 adds Sponsorships (the institutional-giving pipeline + package tiers);
 * Territories is the launch-map desk (see `apps/convex/territories.ts`).
 * Territories P6 adds Import (the canonical preview/commit bulk-import flow,
 * `import.tsx` — replaces the old CSV backfill + the inline recurring-import
 * form that used to live on Backers). The `/give` redesign adds Interest (the
 * lead-capture triage inbox for "want this in my city"/volunteer/join team/
 * fund/suggest-a-space submissions, `interest.tsx` — see
 * `apps/convex/schema/givingInterest.ts`). Wall (`wall.tsx`) is the moderation
 * desk for the PUBLIC giving wall on `/give/<slug>` — the takedown path a donor
 * asking to be removed depends on, which until now only a developer could run
 * (`apps/convex/givingActivity.ts`). Notifications (`notifications.tsx`) is the
 * standing-instruction desk for "email these people when money comes in"
 * (`apps/convex/givingNotifications.ts`) — read/write for a manage holder,
 * read-only for anyone who can only view the books a rule watches; it has no
 * "record a gift" affordance on purpose, because gifts come from the ledger.
 * The tabs render only for a caller who
 * can see the desk (`myGivingAccess.canView`) — the same `nav.giving` gate
 * the AppShell nav entry uses; each screen keeps its own backend
 * `requireGivingView`/`requireGivingManage` gate. (Sponsorships, Territories,
 * and Import are all manage-or-central-lens surfaces — but the tabs are shown
 * to anyone with desk access; each screen degrades to an access-needed state
 * for a caller who lacks the specific access it needs, same as every other
 * tab does.)
 */
const TABS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/giving" },
  { label: "Gifts", path: "/giving/gifts" },
  { label: "Donors", path: "/giving/donors" },
  { label: "Backers", path: "/giving/backers" },
  { label: "Sponsorships", path: "/giving/sponsorships" },
  { label: "Territories", path: "/giving/territories" },
  { label: "Import", path: "/giving/import" },
  { label: "Interest", path: "/giving/interest" },
  { label: "Wall", path: "/giving/wall" },
  { label: "Notifications", path: "/giving/notifications" },
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
    <DeskShell
      tabs={tabs}
      isActive={(path) => isActive(pathname, path)}
      onNavigate={(path) => router.navigate(path as never)}
    >
      <Slot />
    </DeskShell>
  );
}
