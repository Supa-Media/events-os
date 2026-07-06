import { ReactNode, useState } from "react";
import { View, Text, useWindowDimensions, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { SidebarNavItem } from "./SidebarNav";
import { Avatar } from "./Avatar";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";

type NavEntry = { label: string; icon: IconName; path: string };

const NAV: NavEntry[] = [
  { label: "Events", icon: "layout", path: "/" },
  { label: "Templates", icon: "grid", path: "/templates" },
  { label: "People", icon: "users", path: "/people" },
  { label: "Team", icon: "git-branch", path: "/team" },
  { label: "Songs", icon: "music", path: "/song-library" },
];

/**
 * The nav entries the caller may see. Team is managers/admins only — the
 * server decides (org.nav.canManage: admin, or has direct reports); this
 * just hides the entry. The route itself is also gated server-side.
 */
function useNav(): NavEntry[] {
  const org = useQuery(api.org.nav);
  return NAV.filter((n) => n.path !== "/team" || org?.canManage === true);
}

/**
 * True when the current pathname maps to this nav entry. Matches on whole path
 * segments so `/people` activates for `/people` and `/people/123` but NOT for a
 * sibling like `/peopleX` (a plain `startsWith` prefix would over-match).
 */
function isActive(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/" || pathname === "/index";
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Desktop breakpoint — at/above this width we show the persistent sidebar. */
const DESKTOP = 760;

/**
 * The responsive app shell. On desktop it renders a persistent left sidebar
 * (brand mark, nav, chapter + user footer) beside the page content. Below the
 * breakpoint it collapses to a bottom navigation bar, so the same routes work
 * on phones without a separate navigator.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const desktop = width >= DESKTOP;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  if (desktop) {
    return (
      <View className="flex-1 flex-row bg-surface">
        {!sidebarCollapsed && <Sidebar onCollapse={() => setSidebarCollapsed(true)} />}
        <View className="flex-1">
          {children}
          {sidebarCollapsed && <SidebarOpenButton onPress={() => setSidebarCollapsed(false)} />}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-surface" edges={["top"]}>
      <MobileTopBar />
      <View className="flex-1">{children}</View>
      <BottomNav />
    </SafeAreaView>
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
              <Text className="font-display text-lg leading-5 text-ink">Events</Text>
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

          {/* Nav */}
          <View className="gap-0.5">
            {nav.map((n) => (
              <SidebarNavItem
                key={n.path}
                label={n.label}
                icon={n.icon}
                active={isActive(pathname, n.path)}
                onPress={() => router.navigate(n.path as any)}
              />
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
  return (
    <View className="gap-1 border-t border-border pt-3">
      {/* Static chapter label — NOT interactive. Multi-chapter switching isn't
          built yet, so this is styled as a plain label (lower opacity, no press
          affordance) to avoid implying it's tappable like the rows below. */}
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={
          summary
            ? `Current chapter, ${summary.peopleCount} people`
            : "Current chapter"
        }
        className="flex-row items-center gap-2.5 px-2 py-1.5 opacity-70"
      >
        <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
          <Icon name="home" size={14} color="#1F5A41" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            Chapter
          </Text>
          <Text className="text-xs text-muted">
            {summary ? `${summary.peopleCount} people` : "—"}
          </Text>
        </View>
      </View>
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

function MobileTopBar() {
  const router = useRouter();
  return (
    <View className="flex-row items-center gap-2 border-b border-border bg-raised px-4 py-3">
      <View className="h-7 w-7 items-center justify-center rounded-md bg-accent">
        <Icon name="calendar" size={15} color="#FFFFFF" />
      </View>
      <Text className="font-display text-lg text-ink">Events OS</Text>
      <View className="flex-1" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Profile"
        hitSlop={8}
        onPress={() => router.navigate("/profile")}
        className="h-8 w-8 items-center justify-center rounded-md active:bg-sunken"
      >
        <Icon name="user" size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
}

function BottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const nav = useNav();
  return (
    <SafeAreaView edges={["bottom"]} className="border-t border-border bg-raised">
      <View className="flex-row">
        {nav.map((n) => {
          const active = isActive(pathname, n.path);
          return (
            <Pressable
              key={n.path}
              accessibilityRole="tab"
              accessibilityLabel={n.label}
              accessibilityState={{ selected: active }}
              onPress={() => router.navigate(n.path as any)}
              className="flex-1 items-center gap-1 py-2.5"
            >
              <Icon name={n.icon} size={20} color={active ? colors.accent : colors.muted} />
              <Text className={`text-2xs ${active ? "font-semibold text-accent" : "text-muted"}`}>
                {n.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}
