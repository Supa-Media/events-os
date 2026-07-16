/**
 * ChapterContext — app-wide "which desk am I at" state (WP-S).
 *
 * Single source of truth for the shell's context-switcher pill, the finance
 * dashboard's desk (which absorbed its old local seat switcher + drill-down
 * state into this), and any future chapter-scoped screen.
 *
 * Two states:
 *  - `{kind:"seat", scope}` — the caller is at one of their REAL finance seats
 *    (`"central"`, or a chapter id they hold a `financeRoles` grant in).
 *  - `{kind:"peek", chapterId, chapterName}` — a CENTRAL-seat holder browsing
 *    a chapter they do NOT hold a seat in, read-only. Peek is only ever
 *    entered from a central seat, so `exitPeek` always has a central seat to
 *    fall back to.
 *
 * Source of truth for what's available: `financeRoles.mySeats` (the caller's
 * real seats) + `financeRoles.listChaptersForPeek` (every chapter in the org,
 * central-seat holders only — the Peek list, filtered here to exclude any
 * chapter the caller already holds a real seat in). A single-context caller
 * (one chapter seat, no central, no peek reach) gets a fixed context and no
 * pill at all — see `showSwitcher`.
 *
 * SCOPE (WP-S, see the PR for the full writeup): only the Finance dashboard
 * actually reads this context to scope a query — `finances.dashboardChapter`'s
 * optional `chapterId` (the existing #131 central drill-down). Events and
 * Projects have NO org-level/central access model at all: `events.current`/
 * `events.past` and `projects.list` are hard-scoped server-side to the
 * caller's OWN chapter with no chapterId argument whatsoever, unlike
 * Finance's central/chapter split (`isChapterAdmin`/`canViewChapterWork` are
 * strictly per-chapter — there's no "central admin" concept to hang a foreign-
 * chapter read on). The global peek banner still renders over those screens
 * (it's shell chrome), but their data does NOT change — they keep showing the
 * caller's home chapter regardless of the picked context. Extending peek to
 * them needs a real product/authz decision (what does "central" even mean for
 * an event?), which is out of scope here — flagged for the owner instead of
 * invented.
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
import { seatKeyOf, type Seat } from "./financeSeats";

/** A real seat's scope key: `"central"` or a chapter id. */
export type ChapterScope = "central" | Id<"chapters">;

export type ChapterContextValue =
  | { kind: "seat"; scope: ChapterScope }
  | { kind: "peek"; chapterId: Id<"chapters">; chapterName: string };

export type PeekChapter = { chapterId: Id<"chapters">; name: string };

type ChapterSeat = Extract<Seat, { scope: "chapter" }>;

type ChapterContextApi = {
  /** True until `mySeats` resolves. */
  loading: boolean;
  /** The caller's real finance seats, central first. `[]` = no finance seat. */
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
  const seats = useQuery(api.financeRoles.mySeats, isAuthenticated ? {} : "skip");
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
