import { Slot, usePathname, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Pill } from "../../../components/ui";
import { SandboxModeBanner } from "../../../components/finance/SandboxModeBanner";
import { ScopeBadge } from "../../../components/finance/ScopeBadge";

/**
 * Finance sub-navigation. The outer AppShell provides the app chrome; this
 * layout adds the in-app finance tabs above the active screen, matching the
 * prototype's tabbed finance app. Each tab is its own route so the Phase-1 UI
 * agents own disjoint screen files.
 *
 * The tab SET itself branches on the caller's REAL finance seats
 * (`financeRoles.mySeats`, WP-0.2): a seat holder gets the manager bar
 * (Dashboard · Reconcile · Coding · Receipts · Sales · Budgets · Cards) — the
 * desk each renders (central / chapter) still resolves INSIDE the screen. A
 * caller with NO finance seat (the member/cardholder case, D3) gets the
 * reduced member set — My Card · Coding · Budgets — so they never land on a
 * tab that only ever shows them a permission wall. Two of the chips are
 * GROUPS (see below): Coding carries Explain and Publish as a sub-row, Cards
 * carries Reimbursements.
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
const ACCOUNTS_TAB: Tab = { label: "Accounts", path: "/finances/accounts" };

// ── Grouped tabs (owner directive, 2026-08-11) ───────────────────────────────
// "This is just way too much... coding, publish, and explain can be one thing.
// Cards and reimbursements can be one thing." The bar had grown to eleven
// chips by accretion — every workstream added one — and eleven chips is a
// navigation problem pretending to be a feature list.
//
// A GROUP is one primary chip; its members appear as a second, smaller pill
// row only while you're inside the group. The routes themselves are unchanged
// (deep links, the Academy's screenshots, and the publish console's
// cross-links all keep working) — only the bar is consolidated.
//
// The three primary finance activities, per the owner's own requirements:
//   overview it (Dashboard / Reconcile / Accounts) · explain it (Coding) ·
//   spend it (Cards). Receipts, Sales and Budgets stay their own chips —
//   no directive on them, and merging beyond the ask invents an information
//   architecture nobody requested.
type Tab = {
  label: string;
  path: string;
  /** Sub-destinations shown as a second pill row while this tab is active.
   *  The first member is the tab's own landing path. */
  children?: { label: string; path: string }[];
};

// Coding, Explain and Publish are one activity read in one direction: explain
// the transactions, then publish the month they belong to. Kept under the
// "Coding" label because the Academy teaches that word for the §274(d) work
// and a tab rename ripples into lessons (CLAUDE.md's Academy rule).
const CODING_GROUP: Tab = {
  label: "Coding",
  path: "/finances/coding",
  children: [
    { label: "Code", path: "/finances/coding" },
    { label: "By month", path: "/finances/explain" },
    { label: "Publish", path: "/finances/publish" },
  ],
};

// Cards and reimbursements are both "money a person spends and the org makes
// right" — one chip, two sub-views.
const CARDS_GROUP: Tab = {
  label: "Cards",
  path: "/finances/cards",
  children: [
    { label: "Cards", path: "/finances/cards" },
    { label: "Reimbursements", path: "/finances/reimbursements" },
  ],
};

const BUDGETS_TAB: Tab = { label: "Budgets", path: "/finances/budgets" };

const SEAT_TABS: Tab[] = [
  { label: "Dashboard", path: "/finances" },
  { label: "Reconcile", path: "/finances/reconcile" },
  CODING_GROUP,
  { label: "Receipts", path: "/finances/receipts" },
  { label: "Sales", path: "/finances/sales" },
  BUDGETS_TAB,
  CARDS_GROUP,
];

// The member (no-seat) set: their card + reimbursements under one chip, their
// own charges to code, and the read-only budgets view. Three chips.
const MEMBER_CODING_TAB: Tab = { label: "Coding", path: "/finances/coding" };
const MEMBER_TABS: Tab[] = [
  {
    label: "My Card",
    path: "/finances/cards",
    children: [
      { label: "My Card", path: "/finances/cards" },
      { label: "Reimbursements", path: "/finances/reimbursements" },
    ],
  },
  MEMBER_CODING_TAB,
  BUDGETS_TAB,
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /finances/reconcile lights Reconcile, /finances lights Dashboard. */
function isActive(pathname: string, path: string): boolean {
  if (path === "/finances") {
    return pathname === "/finances" || pathname === "/finances/index";
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** A grouped tab lights up when ANY of its members is the active route, so
 *  standing on /finances/publish still highlights "Coding" in the bar. */
function isTabActive(pathname: string, tab: Tab): boolean {
  if (tab.children) return tab.children.some((c) => isActive(pathname, c.path));
  return isActive(pathname, tab.path);
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
  // Does the Coding tab have anything behind it for THIS person? Same query
  // the screen reads, so the tab and the screen can never disagree about
  // whether there's work. `undefined` while loading → no tab, matching the
  // rest of this function's don't-guess posture.
  const coding = useQuery(api.transactionCodings.workload, {});
  const hasCodingWork =
    coding !== undefined &&
    (coding.mineToCode > 0 || coding.awaitingMyReview > 0 || coding.orgWide);
  const tabs = (
    seats === undefined
      ? []
      : seats.length === 0
        ? MEMBER_TABS
        : canViewAccounts === true
          ? [...SEAT_TABS, ACCOUNTS_TAB]
          : SEAT_TABS
  ).filter(
    // The member set drops Coding when there is genuinely nothing behind it
    // (same rule as before the grouping). Seat holders always keep the group:
    // Explain and Publish are inside it, and those exist independent of the
    // caller's personal coding workload.
    (t) => seats?.length !== 0 || t.path !== MEMBER_CODING_TAB.path || hasCodingWork,
  );

  // The active group's second row, when there is one.
  const activeGroup = tabs.find((t) => t.children && isTabActive(pathname, t));

  return (
    <View className="flex-1">
      {/* Deployment-wide sandbox-mode banner (shows on every finance tab when
          on) — seat-gated: it's only relevant to finance seat holders, and
          mounting it for the no-seat member persona is the same crash class
          this banner itself was the trigger for (see [hotfix]). */}
      {seats !== undefined && seats.length > 0 && <SandboxModeBanner />}
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
              selected={isTabActive(pathname, t)}
              onPress={() => router.navigate(t.path as never)}
            />
          ))}
        </ScrollView>
      </View>
      {/* The group's members — a second, quieter row that exists only while
          you're inside the group, so the primary bar stays seven chips
          instead of eleven. */}
      {activeGroup?.children ? (
        <View className="border-b border-border bg-sunken px-4 py-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {activeGroup.children.map((c) => (
              <Pill
                key={c.path}
                label={c.label}
                selected={isActive(pathname, c.path)}
                onPress={() => router.navigate(c.path as never)}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {/* Founder directive: finance scope must be unmistakable, even from a
          bare screenshot of just this content column — see `ScopeBadge`'s
          doc for the three distinct treatments (Central / chapter desk /
          peek). Lives here (not inside a screen) so every finance tab, not
          just the Dashboard, carries it. Its own horizontal inset matches
          `Screen`'s content padding without touching the Slot wrapper below
          (every screen manages its own padding via `Screen`/`Narrow`). */}
      <View className="px-4 pt-3 sm:px-6">
        <ScopeBadge />
      </View>
      <View className="flex-1">
        <Slot />
      </View>
    </View>
  );
}
