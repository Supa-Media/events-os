/**
 * ChapterContext — app-wide "which desk am I at" state (WP-S).
 *
 * Single source of truth for the shell's context-switcher pill, the finance
 * dashboard's desk (which absorbed its old local seat switcher + drill-down
 * state into this), and any future chapter-scoped screen.
 *
 * Two states:
 *  - `{kind:"seat", scope}` — the caller is at one of their REAL desks
 *    (`"central"`, or a chapter id) — see "What counts as a desk" below.
 *  - `{kind:"peek", chapterId, chapterName}` — a CENTRAL-seat holder browsing
 *    a chapter they do NOT hold a desk in, read-only. Peek is only ever
 *    entered from a central seat, so `exitPeek` always has a central seat to
 *    fall back to.
 *
 * Source of truth for what's available: `financeRoles.mySeats` (the caller's
 * REAL `financeRoles`-granted seats) UNIONED with `seats.myDeskChapters` (the
 * caller's org-chart-SEAT-only desks — see "What counts as a desk" below),
 * plus `financeRoles.listChaptersForPeek` (every chapter in the org,
 * central-seat holders only — the Peek list, filtered here to exclude any
 * chapter the caller already holds a real DESK in, from either source). A
 * single-context caller (one chapter desk, no central, no peek reach) gets a
 * fixed context and no pill at all — see `showSwitcher`.
 *
 * ## What counts as a desk (WP-S switcher fix, 2026-07-17)
 *
 * A chapter where the caller holds ANY org-chart seat (`seatAssignments`, via
 * `seats.myDeskChapters`) is a REAL DESK, not a peek — org-chart seats are the
 * source of truth for desk MEMBERSHIP, independent of `financeRoles`. Before
 * this fix, desks were derived ONLY from `financeRoles.mySeats`, so a
 * `chapter_director` seat holder with no separate `financeRoles` grant (that
 * seat carries `nav.finances`/`finance.approve`, not `finance.manager` — see
 * `SEAT_DEFS`) fell through to the Peek list for their OWN chapter, read-only.
 * Central desk = a central-chart seat assignment OR the pre-existing central
 * `financeRoles`/seat-derived finance reach (the union keeps a finance-only
 * central grant holder with no central seat assignment from losing their
 * desk). This changes DESK/READ SCOPING only (which desk the switcher shows
 * and what a peek-vs-seat context resolves to) — every finance WRITE gate is
 * untouched, still keyed off `financeRoles`/seat CAPABILITIES
 * (`lib/finance.ts#getFinanceRole`), never this union. A desk with no
 * matching finance capability can still get a `FORBIDDEN` from a finance read
 * (e.g. `finances.dashboardChapter`'s viewer floor) — `FinanceBoundary`
 * degrades that to a friendly "Finance access needed" state rather than
 * crashing (see `apps/mobile/app/(app)/finances/index.tsx`); it is NOT
 * widened by this fix. See the seat's own doc comment on `myDeskChapters`.
 *
 * SCOPE (WP-S, see the PR for the full writeup; extended by the Events/
 * Projects peek follow-up):
 *  - Finance dashboard: `finances.dashboardChapter`'s optional `chapterId`
 *    (the original #131 central drill-down).
 *  - Events landing screen: `events.current`/`events.past` now take the same
 *    kind of optional, central-gated `chapterId` (`lib/centralReach.ts`
 *    reuses the SAME central-reach check `dashboardChapter` and
 *    `financeRoles.listChaptersForPeek` use — no new role concept). Write
 *    affordances ("New event") hide while peeking, and event DETAIL
 *    navigation is disabled while peeking — an event's other tabs (roles,
 *    modules, ticketing, budget, gear) are hard-scoped to the caller's OWN
 *    chapter via `requireOwned` throughout the app; making the full detail
 *    screen peek-safe would mean adding a central-reach bypass to that one
 *    foundational, widely shared primitive, well beyond what a read-only
 *    events peek calls for.
 *  - Projects: `projects.list`/`projects.get` accept the same optional
 *    central-gated `chapterId` server-side (so the capability + its authz
 *    are tested), but NO screen wires it up yet — there is no standalone
 *    "Projects" tab. Projects render inside the Work tab (`/team`) folded
 *    into the org-hierarchy view (manager subtrees, chapter-admin-only
 *    unassigned-work triage via `org.overview`), which has no foreign-
 *    chapter equivalent for a peeking central caller (they hold no roster
 *    row, and "admin"/"manager" is itself per-chapter) — extending peek
 *    there is a real product/UI decision, not a mechanical parameter add,
 *    so it's flagged for the owner instead of invented. `/team` keeps the
 *    peek banner's read-only-elsewhere qualifier.
 *
 * Every other tab (Briefing, People, Songs, Inventory, Academy) is unchanged:
 * hard-scoped server-side to the caller's own chapter, no ChapterContext
 * usage at all.
 */
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { mergeDesks, seatKeyOf, type Seat } from "./financeSeats";

/** A real seat's scope key: `"central"` or a chapter id. */
export type ChapterScope = "central" | Id<"chapters">;

export type ChapterContextValue =
  | { kind: "seat"; scope: ChapterScope }
  | { kind: "peek"; chapterId: Id<"chapters">; chapterName: string };

export type PeekChapter = { chapterId: Id<"chapters">; name: string };

type ChapterSeat = Extract<Seat, { scope: "chapter" }>;

type ChapterContextApi = {
  /** True until `mySeats` and `myDeskChapters` both resolve. */
  loading: boolean;
  /** The caller's real desks (finance seats UNIONED with org-chart-seat-only
   *  desks), central first. `[]` = no desk at all. */
  seats: Seat[];
  /** The caller's central seat, or null. */
  centralSeat: Seat | null;
  /** The caller's chapter seats (excludes central). */
  chapterSeats: ChapterSeat[];
  /** Every OTHER chapter a central-seat holder may peek into (excludes
   *  chapters the caller already holds a real seat in). `[]` for everyone
   *  else. */
  peekChapters: PeekChapter[];
  /** Whether the shell should render the context pill at all: a dual/multi
   *  real-seat holder, or anyone with peek reach. A single-context caller
   *  (one seat, nothing to peek into) gets none — the context stays fixed. */
  showSwitcher: boolean;
  /** The active context. `null` while loading, or for a caller with no
   *  finance seat at all (nothing to switch between — Finance itself
   *  redirects those callers to My Card before ever reading this). */
  context: ChapterContextValue | null;
  /** Switch to one of the caller's REAL seats — clears any active peek. */
  chooseSeat: (scope: ChapterScope) => void;
  /** Enter read-only peek into a chapter the caller does NOT hold a seat in
   *  (central-seat holders only; every scoped read re-checks central reach
   *  server-side regardless of this client-side gate). */
  enterPeek: (chapterId: Id<"chapters">, chapterName: string) => void;
  /** Exit peek, back to the caller's seat. */
  exitPeek: () => void;
};

const ChapterCtx = createContext<ChapterContextApi | null>(null);

export function ChapterContextProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const financeSeats = useQuery(api.financeRoles.mySeats, isAuthenticated ? {} : "skip");
  const deskChapters = useQuery(api.seats.myDeskChapters, isAuthenticated ? {} : "skip");
  const peekChaptersRaw = useQuery(
    api.financeRoles.listChaptersForPeek,
    isAuthenticated ? {} : "skip",
  );

  // The last REAL seat the caller explicitly picked. `null` defers to the
  // default desk (central when held, else the caller's first chapter seat —
  // `mySeats` returns central first, so `seats[0]` is always the default).
  const [pickedScope, setPickedScope] = useState<ChapterScope | null>(null);
  // Peek is tracked separately from `pickedScope` — entering peek doesn't
  // disturb which real seat is "underneath" it, so exiting always lands back
  // on the caller's last-picked (or default) real seat.
  const [peek, setPeek] = useState<{
    chapterId: Id<"chapters">;
    chapterName: string;
  } | null>(null);

  // The caller's real desks: `financeRoles.mySeats` UNIONED with
  // `seats.myDeskChapters` — see the module doc's "What counts as a desk" and
  // `mergeDesks`' own doc for exactly how the two are combined.
  const seats: Seat[] | undefined = useMemo(() => {
    if (financeSeats === undefined || deskChapters === undefined) return undefined;
    return mergeDesks(financeSeats, deskChapters);
  }, [financeSeats, deskChapters]);

  const centralSeat = seats?.find((s) => s.scope === "central") ?? null;
  const chapterSeats = useMemo(
    () => (seats ?? []).filter((s): s is ChapterSeat => s.scope === "chapter"),
    [seats],
  );

  const peekChapters: PeekChapter[] = useMemo(() => {
    if (!centralSeat || !peekChaptersRaw) return [];
    const heldChapterIds = new Set(chapterSeats.map((s) => s.chapterId));
    return peekChaptersRaw.filter((c) => !heldChapterIds.has(c.chapterId));
  }, [centralSeat, peekChaptersRaw, chapterSeats]);

  const loading = seats === undefined;
  const showSwitcher =
    !loading && (centralSeat != null || chapterSeats.length >= 2);

  const context: ChapterContextValue | null = useMemo(() => {
    if (loading || !seats || seats.length === 0) return null;
    if (peek) {
      return { kind: "peek", chapterId: peek.chapterId, chapterName: peek.chapterName };
    }
    const scope =
      pickedScope != null && seats.some((s) => seatKeyOf(s) === pickedScope)
        ? pickedScope
        : (seatKeyOf(seats[0]) as ChapterScope); // central-first default desk
    return { kind: "seat", scope };
  }, [loading, seats, peek, pickedScope]);

  function chooseSeat(scope: ChapterScope) {
    setPeek(null);
    setPickedScope(scope);
  }

  function enterPeek(chapterId: Id<"chapters">, chapterName: string) {
    setPeek({ chapterId, chapterName });
  }

  function exitPeek() {
    setPeek(null);
  }

  const value: ChapterContextApi = {
    loading,
    seats: seats ?? [],
    centralSeat,
    chapterSeats,
    peekChapters,
    showSwitcher,
    context,
    chooseSeat,
    enterPeek,
    exitPeek,
  };

  return <ChapterCtx.Provider value={value}>{children}</ChapterCtx.Provider>;
}

export function useChapterContext(): ChapterContextApi {
  const ctx = useContext(ChapterCtx);
  if (!ctx) {
    throw new Error(
      "useChapterContext must be used within a ChapterContextProvider",
    );
  }
  return ctx;
}
