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
 * (`financeRoles.mySeats`, WP-0.2): a seat holder gets the manager tab bar
 * (Dashboard · Reconcile · Receipts · Cards · Reimbursements) — the desk each of those
 * renders (central / chapter) still resolves INSIDE the screen. A caller with
 * NO finance seat (the member/cardholder case, D3) gets the reduced member
 * set instead — My Card · My Transactions · Reimbursements — so they never
 * land on a tab that only ever shows them a permission wall.
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
const ACCOUNTS_TAB = { label: "Accounts", path: "/finances/accounts" };

// Budgets — "budgets at a glance" — is the one tab BOTH sets carry: read-only
// spent-vs-room-left visibility is deliberately open to every team member
// (the FM's top ask — cardholders shouldn't have to ask her), and seat
// holders get the same tab so both personas are looking at one shared page
// when a cardholder asks about it. Backed by the ungated-by-design
// `finances.budgetsGlance` (see its doc comment).
const BUDGETS_TAB = { label: "Budgets", path: "/finances/budgets" };

// Sales — merch, snacks and drinks sold in person — is seat-only. It's the
// third revenue stream (alongside gifts and ticket orders) and the last one to
// get a surface; before this its money reached Stripe and stopped there. Gated
// with the rest of the seat tabs rather than added to MEMBER_TABS: a cardholder
// has no reason to read chapter revenue detail.
// Coding — your own charges to explain, AND the codings you can decide — is
// the other tab both sets carry, and it is the reason this comment exists.
// Its cardholder half used to live at `/finances/my-transactions`, which
// appeared ONLY in MEMBER_TABS: every seat holder could reach it by URL and no
// other way, which is exactly why the owner had never seen it. It's one tab
// now, in both sets, and `/finances/my-transactions` redirects to it.
//
// Gated on `transactionCodings.workload` rather than on seats, because the two
// halves have different audiences: a cardholder with no seat at all still owns
// charges to code, and a reviewer with no charges of their own still has a
// queue. Somebody with NEITHER gets no tab instead of a dead one.
const CODING_TAB = { label: "Coding", path: "/finances/coding" };

const SEAT_TABS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/finances" },
  { label: "Reconcile", path: "/finances/reconcile" },
  { label: "Coding", path: "/finances/coding" },
  { label: "Receipts", path: "/finances/receipts" },
  { label: "Sales", path: "/finances/sales" },
  BUDGETS_TAB,
  { label: "Cards", path: "/finances/cards" },
  { label: "Reimbursements", path: "/finances/reimbursements" },
  // Publish — the last step of the close: a month is prepared here, reviewed
  // by a second person, and frozen onto the public finances page. Seat-only
  // and LAST in the bar, both deliberately: it's the one finance surface
  // whose audience is outside the org, and it's the step that only makes
  // sense once everything to its left is done. Reading the queue is viewer+;
  // the publish button itself needs the `finance.publish` seat capability
  // (`lib/publicLedgerAccess.ts`), which the screen resolves for itself.
  { label: "Publish", path: "/finances/publish" },
];

const MEMBER_TABS: { label: string; path: string }[] = [
  { label: "My Card", path: "/finances/cards" },
  CODING_TAB,
  BUDGETS_TAB,
  { label: "Reimbursements", path: "/finances/reimbursements" },
];

/** Active when the pathname is the tab's route (exact for the index, prefix for
 *  the rest) — so /finances/reconcile lights Reconcile, /finances lights Dashboard. */
function isActive(pathname: string, path: string): boolean {
  if (path === "/finances") {
    return pathname === "/finances" || pathname === "/finances/index";
  }
  return pathname === path || pathname.startsWith(`${path}/`);
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
  ).filter((t) => t.path !== CODING_TAB.path || hasCodingWork);

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
              selected={isActive(pathname, t.path)}
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
