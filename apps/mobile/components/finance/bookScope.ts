/**
 * ONE BOOK, OR NONE — the guard between finance's TWO scope vocabularies.
 *
 * Finance has two, and they are not interchangeable:
 *
 *  - GRID scope, what the reconcile grid and its view menu speak:
 *    `"all" | "central" | "chapter" | <chapterId>`. `"all"` is the merged
 *    queue (every book at once) and is the DEFAULT for anyone holding both a
 *    central and a chapter desk; `"chapter"` is a relative word meaning
 *    "whichever chapter I'm standing at".
 *  - SINGLE-BOOK scope, what `finances.monthCodingWorklist` and every
 *    `apps/convex/publicLedger.ts` entry point accept:
 *    `v.union(v.id("chapters"), v.literal("central"))`. There is no "all",
 *    and no "chapter".
 *
 * The grid's view menu forwards ITS scope into `/finances/explain?scope=…`
 * and `/finances/publish?scope=…`, so on "All books" both destinations used
 * to hand `"all"` straight to a query that cannot accept it. That fails
 * ARGUMENT VALIDATION before the handler ever runs, which is not a
 * `ConvexError` — `FinanceBoundary` can't catch it, and the founder saw a
 * bare "[CONVEX Q(finances:monthCodingWorklist)] Server Error" on the screen
 * (2026-08-13). A malformed or stale `<chapterId>` in a bookmarked link
 * fails exactly the same way, for exactly the same reason.
 *
 * So the receiving screen sanitizes what it is handed rather than trusting
 * the link. `resolveBookScope` is the whole of that rule, in one pure
 * function, tested — and it is deliberately NOT a silent coercion: it reports
 * WHAT it refused, so the screen can say out loud that it is showing a
 * different book than the URL asked for. A finance screen quietly displaying
 * a book other than the one its address names is its own defect, worse than
 * the crash it replaces.
 *
 * ── THE TYPE SYSTEM DOES THE REST ────────────────────────────────────────────
 * `SingleBookScope` is `Id<"chapters"> | "central"`, and `Id` is a BRANDED
 * string — `"all"` is not assignable to it. Once a screen's scope variable is
 * typed `SingleBookScope | null`, the `as never` casts that used to blind the
 * `useQuery` call sites come off, and the compiler refuses a grid word at the
 * query boundary. The single unchecked cast in this module (`asSingleBook`'s
 * `as Id<"chapters">`) is the one runtime frontier where an untyped URL
 * string becomes a typed id, which is why it lives here and is tested rather
 * than being re-improvised per screen.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";
import { CENTRAL } from "@events-os/shared";

/** A scope a single-book query will actually accept: one chapter's book, or
 *  central's. Mirrors `publicLedger.ts#scopeValidator` exactly. */
export type SingleBookScope = Id<"chapters"> | typeof CENTRAL;

/** Why a requested scope was refused — drives the copy, see `bookScopeNotice`. */
export type BookScopeRefusal =
  /** A GRID word naming more than one book at once (`"all"`). */
  | "multi_book"
  /** Anything else that is not a book: the relative word `"chapter"`, a
   *  truncated or stale id, junk from a hand-edited URL. */
  | "not_a_book";

export type ResolvedBookScope = {
  /** Safe to hand a single-book query. `null` means OMIT the arg entirely —
   *  every one of these queries takes `v.optional(scope)` and falls back to
   *  the caller's own book server-side, which is the same thing passing
   *  nothing has always meant. Never send `null` as a value: an explicit
   *  `null` fails the optional validator (see `useLedgerPreview`'s doc). */
  scope: SingleBookScope | null;
  /** Set only when something WAS asked for and could not be honored. The
   *  screen owes the user a sentence when this is non-null — it is now
   *  showing a book the URL did not name. */
  refused: { value: string; reason: BookScopeRefusal } | null;
};

/**
 * A Convex document id, shape-wise: lowercase base32-ish, and never short.
 *
 * This cannot verify an id EXISTS (only the server can), and it does not try
 * to — it exists to keep the obvious non-ids out of a `v.id("chapters")`
 * argument, where they would throw the same uncatchable validation error
 * `"all"` did. Every grid word (`all`, `chapter`, `central`) and every
 * accidental sentinel (`undefined`, `null`, ``) is far below the length
 * floor. A false negative here is harmless: the screen degrades to the
 * caller's own desk AND says so, which is the same well-lit path a genuinely
 * unknown book takes.
 */
const CHAPTER_ID_SHAPE = /^[a-z0-9_-]{16,64}$/;

/** The one place a raw string becomes a typed single-book scope. `null` for
 *  anything that isn't one. */
function asSingleBook(raw: string | null | undefined): SingleBookScope | null {
  if (!raw) return null;
  if (raw === CENTRAL) return CENTRAL;
  if (CHAPTER_ID_SHAPE.test(raw)) return raw as Id<"chapters">;
  return null;
}

/**
 * Resolve what a single-book screen should actually read.
 *
 * @param requested the `?scope=` param as it arrived — GRID vocabulary, any
 *   string, possibly absent. Absent/empty is not a refusal: nothing was
 *   asked for, so nothing was denied.
 * @param desk where the caller is standing (`ChapterContext` — a peeked
 *   chapter id, or their seat's scope). Already single-book by construction;
 *   passed through the same sanitizer so this function has exactly one idea
 *   of what a book is.
 */
export function resolveBookScope(
  requested: string | null | undefined,
  desk: string | null | undefined,
): ResolvedBookScope {
  const asked = asSingleBook(requested);
  if (asked) return { scope: asked, refused: null };

  const fallback = asSingleBook(desk);
  if (!requested) return { scope: fallback, refused: null };

  return {
    scope: fallback,
    refused: {
      value: requested,
      reason: requested === "all" ? "multi_book" : "not_a_book",
    },
  };
}

/**
 * The sentence the screen shows when a scope was refused.
 *
 * Written to name BOTH ends of the substitution — what was asked for and what
 * is on screen instead — because the failure this replaces was a screen
 * silently showing the wrong book. `showingName` is the server's own
 * `scopeName` (the book actually read), never a client-side guess, so the
 * sentence cannot itself be wrong about which book is displayed.
 */
export function bookScopeNotice(
  refused: { value: string; reason: BookScopeRefusal },
  showingName: string,
): string {
  return refused.reason === "multi_book"
    ? `“All books” isn’t a single book — showing ${showingName}.`
    : `“${refused.value}” isn’t a book this screen can open — showing ${showingName}.`;
}
