import { ReactNode, useState } from "react";
import { View, Text, useWindowDimensions, Pressable } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { SidebarNavItem } from "./SidebarNav";
import { Avatar } from "./Avatar";
import { Icon, type IconName } from "./Icon";
import { Popover } from "./Popover";
import { BottomSheet, SheetGroup, SheetRow, SheetSectionLabel } from "./BottomSheet";
import {
  ChromePill,
  ChromePillButton,
  FloatingTopBar,
  MobileChromeProvider,
  MobileDock,
  NavSheet,
  chromeInsets,
  type DockItem,
  type NavSheetGroup,
} from "./MobileChrome";
import { useAnchor } from "./useAnchor";
import { colors } from "../../lib/theme";
import { DESKTOP_WIDTH } from "../../lib/breakpoints";
import { dockSelection } from "../../lib/mobileNav";
import { useChapterContext } from "../../lib/ChapterContext";
import { seatKeyOf, seatLabelOf } from "../../lib/financeSeats";

type ParaGroup = "P" | "A" | "R";

type NavEntry = {
  label: string;
  icon: IconName;
  path: string;
  group: ParaGroup;
  /** Extra path prefixes this entry stays highlighted for. Needed only where
   *  one entry fronts SIBLING routes rather than children of its own path —
   *  Recruiting opens the team pipeline but also owns `/people/volunteers`,
   *  which its own path can never prefix-match. */
  alsoActiveOn?: string[];
};

// Fixed order — tabs appear/disappear by tier but NEVER reorder. Briefing sits
// right after Events so a volunteer (who sees Briefing, not Events) still gets
// a stable leading tab. Duties and Templates are gone from the nav (folded into
// Work and Events respectively); their routes survive for deep links.
//
// `group` is a subtle PARA (Tiago Forte) label the desktop Sidebar renders
// above each cluster — see `groupForSidebar` below. It does NOT change this
// array's order (the phone dock and nav sheet read `NAV` in order too) and it
// is NOT access control, same as everything else here.
//   P — project-oriented: what you're actively doing (Events/Briefing, Work).
//   A — areas of ongoing responsibility: People, Songs, Inventory, Finances.
//   R — resources: reference material anyone can consult (Academy, Org Chart).
//   Archive (the 2nd "A") has no nav items yet, so it never renders.
const NAV: NavEntry[] = [
  { label: "Events", icon: "layout", path: "/", group: "P" },
  { label: "Briefing", icon: "clipboard", path: "/briefing", group: "P" },
  { label: "People", icon: "users", path: "/people", group: "A" },
  { label: "Work", icon: "git-branch", path: "/team", group: "P" },
  { label: "Songs", icon: "music", path: "/song-library", group: "A" },
  // Inventory — the chapter gear registry (logistics-lead domain). Gated
  // admin-or-lead in useNav, right after Songs.
  { label: "Inventory", icon: "package", path: "/inventory", group: "A" },
  // Finances — the native money layer. Gated by `org.nav.showFinances`: tier
  // admin/lead (transition grandfather) OR a held `nav.finances` seat. The
  // in-screen guards enforce the real `financeRoles`/seat capability — this
  // is nav visibility only.
  { label: "Finances", icon: "dollar-sign", path: "/finances", group: "A" },
  // Giving — the development team's donor CRM (F-6 P1). Its own desk beside
  // Finances (Development ≠ Finance; PRD §6, B8). Gated by
  // `givingPlatform.myGivingAccess.canView` (a held `nav.giving`/`giving.view`
  // seat, or superuser) — the in-screen `requireGivingView` gate is the real
  // one; this is nav visibility only.
  { label: "Giving", icon: "gift", path: "/giving", group: "A" },
  // NO "Emails" ENTRY, deliberately (removed 2026-08-28). Bulk email went to
  // Mailchimp on 2026-08-19 and the desk was parked behind a `deskEnabled`
  // flag that defaulted to ON for any deployment that had never set it — so on
  // production it was still in the sidebar, advertising a tool the org had
  // decided not to send from. The founder's call: "let's get rid of the emails
  // on the sidebar, since we've already said we're not having that."
  //
  // The ROUTES are untouched. `/campaigns/*` still resolves with its guards
  // intact, so an in-flight send can be finished and the history stays
  // readable — this only stops the app offering it. Where the newsletter
  // actually lives is now answered by Marketing → Emails, which is a signpost
  // written for that question rather than a desk nobody should open.
  //
  // Marketing — the public-face desk: the homepage's own copy and Important
  // Links cards, plus the mailing and SMS lists. Its own desk beside Giving and
  // Emails (same PARA group: an ongoing-responsibility function). It exists
  // because marketing was the one function with no home in here, which meant
  // the team whose entire job is public had to file a pull request to change a
  // headline. Gated by `marketingSite.myMarketingAccess.canViewDesk` — mirrors
  // Giving's gate exactly; the in-screen guards on each route are the real
  // enforcement, this is nav visibility only.
  { label: "Marketing", icon: "megaphone", path: "/marketing", group: "A" },
  // Recruiting — the People seat's two pipelines: applications for a SEAT on
  // the chart (`/people/pipeline`) and volunteer signups for a pair of hands
  // at a gathering (`/people/volunteers`). Not called "Hiring": nobody here is
  // paid, and the word was already wrong on the public side. Sits under
  // /people/* because it is the same domain as the roster tab, but keeps its
  // own nav entry so a recruiting associate can reach their work without the
  // admin-or-lead People tab. Gated by `hiring.myHiringAccess.canView`; the
  // in-screen gates are the real ones.
  {
    label: "Recruiting",
    icon: "user-plus",
    path: "/people/pipeline",
    group: "A",
    alsoActiveOn: ["/people/volunteers"],
  },
  // The Academy is for everyone — never permission-gated (see useNav).
  { label: "Academy", icon: "award", path: "/academy", group: "R" },
  // Org Chart — read-only, org-transparent (mirrors `seats.chart`'s "the whole
  // team may see the whole org" stance). Also never permission-gated.
  { label: "Org Chart", icon: "share-2", path: "/org-chart", group: "R" },
];

// Render order for the PARA groups in the desktop sidebar. Archive ("A") is
// deliberately omitted — nothing is filed there yet, and an empty labelled
// group would just be noise.
const PARA_ORDER: ParaGroup[] = ["P", "A", "R"];

/**
 * Buckets the caller's visible nav entries into PARA groups for the sidebar,
 * preserving each item's relative order from `NAV` within its bucket (a
 * stable partition, not a resort) and dropping any group that ends up empty
 * (e.g. while `org.nav` is still loading and nothing has resolved visible
 * yet). The phone's DOCK does not use this — it takes the leading few entries
 * from `nav` flat; the nav SHEET does, via `navSheetGroups`.
 */
function groupForSidebar(nav: NavEntry[]): { group: ParaGroup; items: NavEntry[] }[] {
  return PARA_ORDER.map((group) => ({
    group,
    items: nav.filter((n) => n.group === group),
  })).filter((g) => g.items.length > 0);
}

/**
 * The nav entries the caller may see, as a per-tier switch on the derived
 * `org.nav.tier` (admin | lead | member | volunteer). The server states the
 * policy once; this and every scoped screen's own guard just render it:
 *   Events   everyone except volunteer      Briefing  volunteer only
 *   People / Inventory  admin or lead        Work  everyone except volunteer
 *   Finances  server-computed `showFinances` (admin/lead OR a `nav.finances`
 *             seat — see `org.nav`'s doc; NOT re-derived from tier here)
 *   Songs / Academy / Org Chart     everyone
 * Nav hiding is NOT access control — each screen keeps its in-screen guard.
 */
function useNav(): NavEntry[] {
  const org = useQuery(api.org.nav);
  // The giving desk's own nav gate (a held `nav.giving`/`giving.view` seat, or
  // superuser) — separate from `org.nav` so the development desk's visibility
  // stays a pure `nav.giving` check, mirroring `financeRoles.mySeats`.
  const giving = useQuery(api.givingPlatform.myGivingAccess, {});
  // Hiring's own nav gate, same shape as Giving's — see the `NAV` entry doc.
  const hiring = useQuery(api.hiring.myHiringAccess, {});
  // Marketing's own nav gate, same shape as Giving's — see the `NAV` entry doc.
  const marketing = useQuery(api.marketingSite.myMarketingAccess, {});
  const tier = org?.tier;
  return NAV.filter((n) => {
    switch (n.path) {
      case "/":
        return tier != null && tier !== "volunteer";
      case "/briefing":
        return tier === "volunteer";
      case "/people":
      case "/inventory":
        return tier === "admin" || tier === "lead";
      case "/finances":
        return org?.showFinances === true;
      case "/giving":
        return giving?.canView === true;
      case "/people/pipeline":
        return hiring?.canView === true;
      case "/marketing":
        return marketing?.canViewDesk === true;
      case "/team":
        // Work: everyone except volunteer — but keep the teamView nuance so a
        // caller with no roster row isn't shown an empty Work tab.
        return tier != null && tier !== "volunteer" && org?.teamView != null;
      case "/song-library":
      case "/academy":
      case "/org-chart":
        return true;
      default:
        return false;
    }
  });
}

/**
 * True when the current pathname maps to this nav entry. Matches on whole path
 * segments so `/people` activates for `/people` and `/people/123` but NOT for a
 * sibling like `/peopleX` (a plain `startsWith` prefix would over-match).
 */
function isActive(pathname: string, path: string, alsoActiveOn?: string[]): boolean {
  if (path === "/") return pathname === "/" || pathname === "/index";
  const matches = (p: string) =>
    pathname === p || pathname.startsWith(`${p}/`);
  return matches(path) || (alsoActiveOn ?? []).some(matches);
}

/**
 * The responsive app shell. On desktop it renders a persistent left sidebar
 * (brand mark, nav, chapter + user footer) beside the page content. Below the
 * breakpoint it collapses to a bottom navigation bar, so the same routes work
 * on phones without a separate navigator.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const desktop = width >= DESKTOP_WIDTH;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const pathname = usePathname();
  // Read-only peek (WP-S): a central-seat holder browsing a chapter they
  // don't hold a seat in. The banner is shell chrome — it renders over every
  // screen — but only SOME surfaces actually re-scope their data to the
  // peeked chapter (Finance's dashboard, and now the Events landing screen —
  // see `ChapterContext`'s file doc for what's scoped and what still isn't,
  // e.g. Work/Projects). Route-aware copy: `scoped` tells the banner whether
  // the CURRENT route is one that actually re-scopes, so it never implies a
  // read-only peek is in effect somewhere it isn't.
  const { context, exitPeek } = useChapterContext();
  const peeking = context?.kind === "peek" ? context : null;
  const scoped = isScopedRoute(pathname);

  if (desktop) {
    return (
      <View className="flex-1 flex-row bg-surface">
        {!sidebarCollapsed && <Sidebar onCollapse={() => setSidebarCollapsed(true)} />}
        <View className="flex-1">
          {peeking ? (
            <PeekBanner
              chapterId={peeking.chapterId}
              chapterName={peeking.chapterName}
              onExit={exitPeek}
              scoped={scoped}
            />
          ) : null}
          {children}
          {sidebarCollapsed && <SidebarOpenButton onPress={() => setSidebarCollapsed(false)} />}
        </View>
      </View>
    );
  }

  return (
    <MobileShell peeking={peeking} scoped={scoped} onExitPeek={exitPeek}>
      {children}
    </MobileShell>
  );
}

/**
 * The phone shell. Page content fills the window edge to edge and the
 * navigation FLOATS over it: a pair of buttons at the top, a dock at the
 * bottom. `Screen` reads `chromeInsets` out of `MobileChromeProvider` and pads
 * itself by exactly what the chrome occupies, so a page starts below the top
 * buttons and ends above the dock while still scrolling underneath both.
 *
 * The chrome is rendered AFTER `children` so it paints on top without needing
 * to fight z-index against whatever a screen puts at its own root.
 */
function MobileShell({
  children,
  peeking,
  scoped,
  onExitPeek,
}: {
  children: ReactNode;
  peeking: { chapterId: Id<"chapters">; chapterName: string } | null;
  scoped: boolean;
  onExitPeek: () => void;
}) {
  const router = useRouter();
  const nav = useNav();
  const pathname = usePathname();
  const safe = useSafeAreaInsets();
  // Same gate as the desktop sidebar footer: only a caller with more than one
  // desk (or peek reach) gets a switcher. For everyone else the chapter is a
  // fact, not a control, and it's named in the account sheet instead.
  const { showSwitcher } = useChapterContext();
  const [navOpen, setNavOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // The peek banner's height is MEASURED, not assumed: its copy runs to one or
  // two lines depending on whether the current route actually re-scopes (see
  // `PeekBanner`), and a hardcoded guess would either overlap the page's title
  // or leave a gap above it.
  const [peekHeight, setPeekHeight] = useState(0);

  const items: DockItem[] = nav.map((n) => ({
    label: n.label,
    icon: n.icon,
    path: n.path,
    active: isActive(pathname, n.path, n.alsoActiveOn),
  }));

  // The dock shows the first few destinations in `NAV` order; the rest live in
  // the sheet. See `dockSelection` for how the destination you're ON is kept
  // visible without reordering anything else.
  const dockItems = dockSelection(items);

  const insets = chromeInsets(safe.top, safe.bottom);
  // A peek banner is chrome too — it sits under the floating buttons, so the
  // page has to start below BOTH.
  const topInset = insets.top + (peeking ? peekHeight + PEEK_BANNER_GAP : 0);

  return (
    <View className="flex-1 bg-surface">
      <MobileChromeProvider top={topInset} bottom={insets.bottom}>
        {children}
      </MobileChromeProvider>

      <FloatingTopBar
        onOpenNav={() => setNavOpen(true)}
        right={
          <ChromePill>
            {showSwitcher ? <ContextPill compact /> : null}
            <ChromePillButton
              icon="user"
              label="Account"
              onPress={() => setAccountOpen(true)}
            />
          </ChromePill>
        }
      />

      {peeking ? (
        <View
          pointerEvents="box-none"
          onLayout={(e) => setPeekHeight(e.nativeEvent.layout.height)}
          style={{ top: insets.top }}
          className="absolute inset-x-0 z-30 px-3"
        >
          <PeekBanner
            chapterId={peeking.chapterId}
            chapterName={peeking.chapterName}
            onExit={onExitPeek}
            scoped={scoped}
            floating
          />
        </View>
      ) : null}

      <MobileDock
        items={dockItems}
        onNavigate={(path) => router.navigate(path as any)}
        onOpenMore={() => setNavOpen(true)}
      />

      <NavSheet
        visible={navOpen}
        onClose={() => setNavOpen(false)}
        groups={navSheetGroups(nav, pathname)}
        onNavigate={(path) => router.navigate(path as any)}
      />
      <AccountSheet visible={accountOpen} onClose={() => setAccountOpen(false)} />
    </View>
  );
}

/** Spelled-out PARA headings for the nav sheet. The desktop sidebar uses the
 *  bare letter because it has a persistent column to hold the reader's place;
 *  a sheet you open, scan, and dismiss has to say what the letter means. */
const PARA_SHEET_LABELS: Record<ParaGroup, string> = {
  P: "Projects",
  A: "Areas",
  R: "Resources",
};

/** The nav sheet's contents: every visible destination, in the same PARA
 *  buckets the sidebar uses, so both navigations describe the app alike. */
function navSheetGroups(nav: NavEntry[], pathname: string): NavSheetGroup[] {
  return groupForSidebar(nav).map(({ group, items }) => ({
    label: PARA_SHEET_LABELS[group],
    items: items.map((n) => ({
      label: n.label,
      icon: n.icon,
      path: n.path,
      active: isActive(pathname, n.path, n.alsoActiveOn),
    })),
  }));
}

/** Breathing room between the floating peek banner and the page beneath it. */
const PEEK_BANNER_GAP = 8;

/**
 * The account sheet behind the top-right person button — the phone's answer to
 * the desktop sidebar footer. Which chapter you're at, then profile and sign
 * out.
 */
function AccountSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { signOut } = useAuthActions();
  const router = useRouter();
  const org = useQuery(api.org.nav);
  const summary = useQuery(api.dashboard.summary);
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {org?.chapterName ? (
        <>
          <SheetSectionLabel label="Chapter" />
          <SheetGroup>
            {/* No `onPress`: which chapter you're at is a fact here, not a
                control. The desktop sidebar footer makes the same call for a
                single-context caller — a switcher only appears for someone
                who has something to switch, and that's the top-right pill. */}
            <SheetRow
              label={org.chapterName}
              sublabel={summary ? `${summary.peopleCount} people` : undefined}
              icon="home"
              first
            />
          </SheetGroup>
        </>
      ) : null}
      <SheetGroup>
        <SheetRow
          label="Profile"
          icon="user"
          first
          onPress={() => {
            onClose();
            router.navigate("/profile");
          }}
        />
        <SheetRow
          label="Sign out"
          icon="log-out"
          destructive
          onPress={() => {
            onClose();
            signOut();
          }}
        />
      </SheetGroup>
    </BottomSheet>
  );
}

/**
 * True when `pathname` is a surface that actually re-scopes to the peeked
 * chapter: `/finances*` (`finances.dashboardChapter`'s original drill-down)
 * and the Events landing screen (`/`, exact — `events.current`/`events.past`
 * now take the peeked `chapterId` too). Matches on whole path segments, same
 * rule as `isActive` above, so `/finances` and `/finances/123` both count but
 * a sibling like `/financesX` doesn't.
 *
 * Event DETAIL routes (`/event/*`) are deliberately NOT included: their tabs
 * (roles, modules, ticketing, budget, gear) are hard-scoped to the caller's
 * OWN chapter via `requireOwned` throughout the app — making them peek-safe
 * would mean adding a central-reach bypass to that one foundational, widely
 * shared primitive, a much bigger change than a read-only events/projects
 * peek calls for. `EventsScreen` disables navigation into an event's detail
 * while peeking instead, so this route is never reached with foreign data.
 * `/team` (which hosts Projects, folded into the org-hierarchy view) is also
 * NOT included — see `ChapterContext`'s file doc for why.
 */
function isScopedRoute(pathname: string): boolean {
  return (
    pathname === "/finances" ||
    pathname.startsWith("/finances/") ||
    pathname === "/" ||
    pathname === "/index"
  );
}

/**
 * The persistent "you're peeking, not at your own desk" banner (WP-S). Spans
 * the content area on desktop (the sidebar keeps its own identity) and the
 * full width on mobile, right under the top chrome. `Exit` always returns to
 * the caller's real seat — peek is only ever entered from a central seat.
 *
 * `scoped` is true only on routes that actually re-scope to the peeked
 * chapter (see `isScopedRoute`). Everywhere else the banner still renders
 * (it's shell chrome, and `Exit` needs to stay reachable), but the copy adds
 * an honest qualifier instead of implying the whole app re-scoped when it
 * didn't.
 *
 * OWNER FIX (2026-07-18): peek is entered from CentralView's own "View
 * chapter"/"Open on chapter ›" drilldowns for ANY chapter in the org-wide
 * rollup — not just the switcher's own "Peek (read-only)" picker, which
 * already excludes chapters the caller holds a real seat in (see
 * `ChapterContext`'s `peekChapters` derivation). So a dual-hat holder (a
 * central seat AND a chapter seat) can land here peeking their OWN chapter
 * read-only, when they could just be AT that desk instead. When that's the
 * case, the banner swaps its copy + primary action to a direct switch
 * (`chooseSeat`, the SAME call the bottom-left `ContextPill`'s "Your seats"
 * entries make) rather than the generic read-only-plus-Exit treatment.
 */
function PeekBanner({
  chapterId,
  chapterName,
  onExit,
  scoped,
  floating = false,
}: {
  chapterId: Id<"chapters">;
  chapterName: string;
  onExit: () => void;
  scoped: boolean;
  /** Phone shell: render as a rounded, shadowed strip that floats over the
   *  page rather than a full-bleed bar with a bottom rule. Same content and
   *  same copy rules — only the frame changes. */
  floating?: boolean;
}) {
  const { chapterSeats, chooseSeat } = useChapterContext();
  const ownSeat = chapterSeats.find((s) => s.chapterId === chapterId);
  const frame = floating
    ? "rounded-md shadow-dock px-3 py-2"
    : "border-b border-border px-4 py-2";

  if (ownSeat) {
    return (
      <Pressable
        onPress={() => chooseSeat(chapterId)}
        accessibilityRole="button"
        accessibilityLabel={`Switch to your seat at ${chapterName}`}
        className={`flex-row items-center gap-3 bg-warn-bg active:opacity-80 web:hover:opacity-90 ${frame}`}
      >
        <Icon name="repeat" size={15} color={colors.warn} />
        <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
          <Text className="font-semibold">You have a seat at {chapterName}</Text>
          <Text className="text-muted"> — switch to it</Text>
        </Text>
        <Icon name="chevron-right" size={14} color={colors.accent} />
      </Pressable>
    );
  }

  return (
    <View className={`flex-row items-center gap-3 bg-warn-bg ${frame}`}>
      <Icon name="eye" size={15} color={colors.warn} />
      <Text className="flex-1 text-sm text-ink" numberOfLines={scoped ? 1 : 2}>
        <Text className="font-semibold">Viewing {chapterName}</Text>
        <Text className="text-muted"> (read-only)</Text>
        {!scoped ? (
          <Text className="text-muted">
            {" "}
            — this screen still shows your own chapter.
          </Text>
        ) : null}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Exit peek"
        hitSlop={6}
        onPress={onExit}
        className="rounded-md px-2.5 py-1 active:bg-sunken web:hover:bg-sunken"
      >
        <Text className="text-sm font-semibold text-accent">Exit</Text>
      </Pressable>
    </View>
  );
}

function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const nav = useNav();
  const [collapseHovered, setCollapseHovered] = useState(false);
  return (
    <View className="w-60 border-r border-border bg-raised">
      <SafeAreaView edges={["top"]} className="flex-1">
        <View className="flex-1 px-3 pb-4 pt-5">
          {/* Brand mark + collapse toggle */}
          <View className="mb-6 flex-row items-center gap-2.5 px-2">
            <View className="h-8 w-8 items-center justify-center rounded-md bg-accent">
              <Icon name="calendar" size={17} color="#FFFFFF" />
            </View>
            <View>
              <Text className="font-display text-lg leading-5 text-ink">Chapter</Text>
              <Text className="-mt-0.5 font-display text-lg leading-5 text-accent">OS</Text>
            </View>
            <View className="flex-1" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Collapse sidebar"
              hitSlop={10}
              onPress={onCollapse}
              onHoverIn={() => setCollapseHovered(true)}
              onHoverOut={() => setCollapseHovered(false)}
              className={`h-7 w-7 items-center justify-center rounded-md ${
                collapseHovered ? "bg-sunken" : ""
              }`}
            >
              <Icon name="chevron-left" size={18} color={colors.muted} />
            </Pressable>
          </View>

          {/* Nav — subtly grouped by PARA (see `groupForSidebar`). */}
          <View>
            {groupForSidebar(nav).map(({ group, items }, i) => (
              <View key={group} className={i === 0 ? "" : "mt-3"}>
                <ParaGroupLabel letter={group} />
                <View className="gap-0.5">
                  {items.map((n) => (
                    <SidebarNavItem
                      key={n.path}
                      label={n.label}
                      icon={n.icon}
                      active={isActive(pathname, n.path, n.alsoActiveOn)}
                      onPress={() => router.navigate(n.path as any)}
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>

          <View className="flex-1" />

          {/* Chapter + user footer */}
          <ChapterFooter />
        </View>
      </SafeAreaView>
    </View>
  );
}

/**
 * A subtle single-letter PARA (Projects / Areas / Resources / Archive) group
 * label above a sidebar cluster — small, low-contrast, not a loud section
 * header. It's a light organizing cue, not a new taxonomy the app teaches
 * anywhere else, so it stays a single muted letter rather than a spelled-out
 * word (spelling out "Projects" in particular would collide with the
 * existing "Projects" view nested inside Work).
 */
function ParaGroupLabel({ letter }: { letter: ParaGroup }) {
  return (
    <Text className="px-3 pb-1 text-2xs font-semibold tracking-wider text-faint">
      {letter}
    </Text>
  );
}

/**
 * Floating affordance shown over the content area when the desktop sidebar is
 * collapsed. Tapping it re-expands the sidebar.
 */
function SidebarOpenButton({ onPress }: { onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <SafeAreaView edges={["top"]} className="absolute left-0 top-0 z-50">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open sidebar"
        hitSlop={8}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        className={`m-3 h-9 w-9 items-center justify-center rounded-md border border-border ${
          hovered ? "bg-sunken" : "bg-raised"
        }`}
      >
        <Icon name="sidebar" size={18} color={colors.ink} />
      </Pressable>
    </SafeAreaView>
  );
}

function ChapterFooter() {
  const { signOut } = useAuthActions();
  const router = useRouter();
  const summary = useQuery(api.dashboard.summary);
  const org = useQuery(api.org.nav);
  const { showSwitcher } = useChapterContext();
  const chapterName = org?.chapterName ?? "Chapter";
  return (
    <View className="gap-1 border-t border-border pt-3">
      {showSwitcher ? (
        // Multi-context caller (WP-S): a REAL interactive switcher, replacing
        // the plain chapter label below.
        <View className="px-2 pb-1">
          <ContextPill />
        </View>
      ) : (
        // Chapter identity — NOT interactive. Single-context callers have
        // nothing to switch, so this stays a plain label (lower opacity, no
        // press affordance) rather than implying it's tappable.
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={
            summary
              ? `Current chapter: ${chapterName}, ${summary.peopleCount} people`
              : `Current chapter: ${chapterName}`
          }
          className="flex-row items-center gap-2.5 px-2 py-1.5 opacity-70"
        >
          <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
            <Icon name="home" size={14} color="#1F5A41" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
              {chapterName}
            </Text>
            <Text className="text-xs text-muted">
              {summary ? `${summary.peopleCount} people` : "—"}
            </Text>
          </View>
        </View>
      )}
      <Pressable
        onPress={() => router.navigate("/profile")}
        className="flex-row items-center gap-2.5 rounded-md px-2 py-2 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="user" size={15} color={colors.muted} />
        <Text className="text-sm text-muted">Profile</Text>
      </Pressable>
      <Pressable
        onPress={() => signOut()}
        className="flex-row items-center gap-2.5 rounded-md px-2 py-2 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="log-out" size={15} color={colors.muted} />
        <Text className="text-sm text-muted">Sign out</Text>
      </Pressable>
    </View>
  );
}

// ── Context switcher (WP-S) ──────────────────────────────────────────────────
/**
 * The app-wide context pill: which desk the caller is at, and (for a
 * central-seat holder) which chapter they can peek into read-only. Only
 * rendered when `showSwitcher` is true (a dual/multi real-seat holder, or
 * anyone with peek reach) — `ChapterFooter` falls back to a plain,
 * non-interactive chapter label otherwise, and on the phone the top-right pill
 * simply omits it (the account sheet still names the chapter).
 *
 * Absorbs the old finance-dashboard-local `SeatSwitcher`: this is now the ONE
 * place a caller picks their desk, app-wide, not just on the Finances screen.
 */
function ContextPill({ compact = false }: { compact?: boolean }) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const {
    context,
    seats,
    centralSeat,
    chapterSeats,
    peekChapters,
    chooseSeat,
    enterPeek,
  } = useChapterContext();

  if (!context) return null;

  const activeSeat =
    context.kind === "seat"
      ? (seats.find((s) => seatKeyOf(s) === context.scope) ?? null)
      : null;
  // The compact pill just names the desk ("Central" / "New York"); the fuller
  // "Central · Executive Director" label is reserved for the accessibility
  // label so sighted users aren't fighting a long string in a small pill.
  const deskName =
    context.kind === "peek"
      ? context.chapterName
      : activeSeat
        ? activeSeat.scope === "central"
          ? "Central"
          : activeSeat.chapterName
        : "Central";
  const a11yLabel =
    context.kind === "peek"
      ? `Peeking ${context.chapterName}, read-only`
      : activeSeat
        ? `Desk: ${seatLabelOf(activeSeat)}`
        : "Desk switcher";

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        className={
          compact
            ? // Inside the phone's floating ChromePill, which already supplies
              // the raised surface and shadow — a second border and background
              // here would draw a box inside a box.
              "h-8 flex-row items-center gap-1 rounded-pill px-2.5 active:bg-sunken web:hover:bg-sunken"
            : "flex-row items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1.5 active:bg-sunken web:hover:bg-sunken"
        }
      >
        {context.kind === "peek" ? (
          <Icon name="eye" size={13} color={colors.warn} />
        ) : null}
        <Text
          className={`text-sm font-semibold text-ink ${compact ? "max-w-[104px]" : "max-w-[120px]"}`}
          numberOfLines={1}
        >
          {deskName}
        </Text>
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>

      <Popover visible={visible} anchor={anchor} width={228} onClose={close}>
        {centralSeat || chapterSeats.length > 0 ? (
          <MenuSectionHeader label="Your seats" />
        ) : null}
        {centralSeat ? (
          <SeatOption
            label="Central"
            active={context.kind === "seat" && context.scope === "central"}
            onPress={() => {
              chooseSeat("central");
              close();
            }}
          />
        ) : null}
        {chapterSeats.map((seat) => (
          <SeatOption
            key={seat.chapterId}
            label={seat.chapterName}
            active={context.kind === "seat" && context.scope === seat.chapterId}
            onPress={() => {
              chooseSeat(seat.chapterId);
              close();
            }}
          />
        ))}

        {peekChapters.length > 0 ? (
          <>
            <MenuSectionHeader label="Peek (read-only)" />
            {peekChapters.map((c) => (
              <SeatOption
                key={c.chapterId}
                label={c.name}
                active={context.kind === "peek" && context.chapterId === c.chapterId}
                onPress={() => {
                  enterPeek(c.chapterId, c.name);
                  close();
                }}
              />
            ))}
          </>
        ) : null}
      </Popover>
    </>
  );
}

function MenuSectionHeader({ label }: { label: string }) {
  return (
    <View className="border-b border-border bg-sunken px-3 py-1.5">
      <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
        {label}
      </Text>
    </View>
  );
}

function SeatOption({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
    >
      <View className="w-4 items-center">
        {active ? <Icon name="check" size={14} color={colors.accent} /> : null}
      </View>
      <Text
        className={`flex-1 text-sm ${active ? "font-semibold text-ink" : "text-muted"}`}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
