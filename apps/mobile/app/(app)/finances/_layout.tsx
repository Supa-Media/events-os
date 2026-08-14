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

// ── ONE ROW, NO NESTING (founder directive, 2026-08-13) ──────────────────────
// "I'm fine with this being two tabs, but I'm not fine with this being two
// tabs and then one of the tabs has three subtypes under it. That's just
// unacceptable." — and, after the grouping shipped: "the tab is still a mess."
//
// The bar reached eleven chips by accretion, and the first fix (2026-08-11)
// hid four of them under two GROUP chips with a second pill row. That deferred
// the problem rather than solving it: the destinations never went away, they
// moved down a row, and a row of pills under a row of pills is the same
// navigation problem wearing a hat.
//
// What actually removed them was consolidating the SCREENS, not the chips:
//   · Code            → `/code`, its own page outside the finance tabs
//                       entirely (no seat required — it's the one surface a
//                       cardholder with no finance grant can use).
//   · By month        → Group by → Month on the Transactions grid.
//   · Publish         → a month band's own Publish button there, and still
//                       the Dashboard's publishability card.
//   · Reimbursements  → a view in the Cards page's own menu.
// Every route still exists and every deep link still resolves; nothing is
// reachable ONLY from a chip that no longer exists.
//
// There is deliberately no `children` concept left in this file. A tab is a
// destination. If a future workstream wants a fifth thing under Cards, the
// answer is a menu on the Cards page, not a second row here.
//
// ── EXCEPT REIMBURSEMENTS, WHICH CAME BACK (founder, 2026-08-14) ─────────────
// "The reimbursement stuff is hidden within cards, which makes no sense. We
// should just take that out, make it its own thing, make its own page."
//
// The consolidation above was right about ten destinations being too many and
// wrong about this one. Reimbursements is not a view OF cards — it is the
// other direction of money entirely (the org paying a person back, and a
// person paying the org back), it has its own approval queue with its own
// separation-of-duties rules, and the persona who lives in it is the finance
// manager. Filing it under Cards meant the one chip a member ALREADY had
// (`MEMBER_TABS` never lost it) was missing for exactly the person who
// approves. The Cards page's lone "Reimbursements" button — added when the
// flattening left the route unreachable at zero pending requests — is deleted
// in the same change; this chip replaces it.
//
// Repayments (a member paying the org back for a personal charge) is
// deliberately NOT a seventh chip: it's the member's own half of the same
// surface, reached from Reimbursements and from the owe banner. See
// `/finances/repayments`.
type Tab = { label: string; path: string };

const BUDGETS_TAB: Tab = { label: "Budgets", path: "/finances/budgets" };
const REIMBURSEMENTS_TAB: Tab = {
  label: "Reimbursements",
  path: "/finances/reimbursements",
};

// "Book", not "Reconcile": the tab now holds every question you can ask of
// the ledger — what needs attention, what's waiting on you, a month's
// backfill, the receipt chase — and "reconcile" names only one of them (close
// the month). The org already says "book" for this ("all books", "Central's
// book", "which book are we publishing"), so the word costs nobody a lesson.
const SEAT_TABS: Tab[] = [
  { label: "Dashboard", path: "/finances" },
  { label: "Book", path: "/finances/reconcile" },
  { label: "Receipts", path: "/finances/receipts" },
  { label: "Sales", path: "/finances/sales" },
  BUDGETS_TAB,
  { label: "Cards", path: "/finances/cards" },
  REIMBURSEMENTS_TAB,
];

// The member (no-seat) set. Their own charges live at `/code` now — off this
// bar entirely, which is why the Coding chip and its had-work/no-work
// conditional are both gone: a page that requires no seat has no business
// being gated behind a finance tab bar in the first place.
const MEMBER_TABS: Tab[] = [
  { label: "My Card", path: "/finances/cards" },
  REIMBURSEMENTS_TAB,
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

/** The Book's menu leads to screens that are still their own routes (the chase
 *  list, the publish console, the review queue). Standing on one of those must
 *  keep the Book chip lit, or the bar would say you had left finance's main tab
 *  by using its own menu.
 *
 *  `/finances/explain` is deliberately absent: it is no longer a screen but a
 *  redirect INTO `/finances/reconcile` (the grid absorbed it — see that file),
 *  so nobody is ever standing on it long enough for the chip to matter, and
 *  listing it would claim a satellite that no longer exists. */
const BOOK_SATELLITES = [
  "/finances/receipt-chase",
  "/finances/publish",
  "/finances/coding",
] as const;

/** The two owe-direction screens that hang off Reimbursements: the member's
 *  own "pay the org back" page and the manager's collections desk. Both are
 *  reached FROM Reimbursements, so standing on one must keep that chip lit —
 *  same rule, same reason, as `BOOK_SATELLITES` above. */
const REIMBURSEMENT_SATELLITES = [
  "/finances/repayments",
  "/finances/personal-charges",
] as const;

function isTabActive(pathname: string, tab: Tab): boolean {
  if (tab.path === "/finances/reconcile") {
    return (
      isActive(pathname, tab.path) ||
      BOOK_SATELLITES.some((p) => isActive(pathname, p))
    );
  }
  if (tab.path === "/finances/reimbursements") {
    return (
      isActive(pathname, tab.path) ||
      REIMBURSEMENT_SATELLITES.some((p) => isActive(pathname, p))
    );
  }
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
  // No workload probe any more: the Coding chip it existed to show-or-hide is
  // gone, and `/code` — the page it used to gate — is now reachable by URL
  // whether or not the caller has work, which is the whole point of a link
  // you can send to forty people.
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
