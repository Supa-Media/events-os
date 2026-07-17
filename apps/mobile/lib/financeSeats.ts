/**
 * Finance seat helpers — shared by the finance dashboard parts and the
 * app-wide context switcher (WP-S), which absorbed the dashboard's local
 * `SeatSwitcher` into the shell header. Kept structurally typed (not coupled
 * to the generated `api.financeRoles.mySeats` return type) so both a
 * presentational file and the app-wide provider can use it without importing
 * generated backend types.
 */
import {
  FINANCE_ROLE_LABELS,
  specializedRoleLabel,
  type FinanceRole,
  type SpecializedRoleTitle,
} from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * One of the caller's REAL desks — either a `financeRoles`-granted seat (as
 * returned by `api.financeRoles.mySeats`) or an org-chart-seat-only desk (WP-S
 * switcher fix, from `api.seats.myDeskChapters`) with no finance grant behind
 * it. `role` is `undefined` for the latter: an org-chart seat (e.g.
 * `chapter_director`) is a real desk without necessarily carrying a
 * `financeRoles` role — see `ChapterContext`'s doc for how the two are
 * unioned. `role` being present/absent is DISPLAY-ONLY here (the fallback
 * label below); it is NEVER read for access control anywhere in the app —
 * every finance capability check goes through the backend gates
 * (`lib/finance.ts`), not this type.
 */
export type Seat =
  | { scope: "central"; role?: FinanceRole; title?: SpecializedRoleTitle }
  | {
      scope: "chapter";
      chapterId: Id<"chapters">;
      chapterName: string;
      role?: FinanceRole;
      title?: SpecializedRoleTitle;
    };

/** The stable key identifying a seat ("central" or the chapter id). */
export function seatKeyOf(seat: Seat): string {
  return seat.scope === "central" ? "central" : seat.chapterId;
}

/**
 * One desk scope from `api.seats.myDeskChapters` — the caller's org-chart
 * seat-assignment-derived desks (WP-S switcher fix). Structurally typed to
 * match that query's return shape, mirroring `Seat`'s own convention.
 */
export type DeskChapter =
  | { scope: "central"; title?: SpecializedRoleTitle }
  | { scope: Id<"chapters">; chapterName: string; title?: SpecializedRoleTitle };

/**
 * Union `financeRoles.mySeats`-derived seats with `seats.myDeskChapters`-
 * derived org-chart-only desks (WP-S switcher fix — see `ChapterContext`'s
 * "What counts as a desk" doc for the full rationale). A scope `financeSeats`
 * already covers keeps ITS entry (real `role` + its own `title` enrichment,
 * both resolved server-side by `mySeats`); `deskChapters` only ADDS scopes
 * `financeSeats` doesn't have, as a role-less desk. Central first, chapters
 * alphabetical — mirrors `financeRoles.mySeats`' own ordering, so `seats[0]`
 * stays a valid "central-first default desk" pick downstream.
 */
export function mergeDesks(financeSeats: Seat[], deskChapters: DeskChapter[]): Seat[] {
  const byKey = new Map<string, Seat>();
  for (const s of financeSeats) byKey.set(seatKeyOf(s), s);
  for (const d of deskChapters) {
    // `"chapterName" in d` (not `d.scope === "central"`) so TS actually
    // narrows the union — `d.scope`'s two arms are the literal `"central"`
    // vs. the branded string `Id<"chapters">`, and a branded string isn't a
    // literal type, so an equality check against `"central"` doesn't
    // eliminate the chapter arm for the compiler. Presence of the
    // chapter-only `chapterName` field is an unambiguous discriminant.
    if ("chapterName" in d) {
      if (byKey.has(d.scope)) continue; // financeRoles already covers this desk
      byKey.set(d.scope, {
        scope: "chapter",
        chapterId: d.scope,
        chapterName: d.chapterName,
        title: d.title,
      });
    } else {
      if (byKey.has("central")) continue; // financeRoles already covers this desk
      byKey.set("central", { scope: "central", title: d.title });
    }
  }
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    if (a.scope === "central") return -1;
    if (b.scope === "central") return 1;
    return a.chapterName.localeCompare(b.chapterName);
  });
  return merged;
}

/**
 * "Central · Executive Director" / "New York · Chapter Director" / "New York
 * · Treasurer" when the caller holds an org-chart specialized title at this
 * seat's scope (WP-1.1, via `specializedRoleLabel` — the single source for
 * that scope-aware mapping); otherwise falls back to the generic finance-role
 * label, e.g. "Central · Manager" / "New York · Bookkeeper". An org-chart-only
 * desk with neither a title nor a `financeRoles` grant (e.g. a plain seat with
 * no `legacyTitle`, like `music_lead`) falls back to "Member" — there is no
 * finance-role rank to show.
 */
export function seatLabelOf(seat: Seat): string {
  const desk = seat.scope === "central" ? "Central" : seat.chapterName;
  const roleLabel = seat.title
    ? specializedRoleLabel(seat.title, seat.scope === "central")
    : seat.role
      ? FINANCE_ROLE_LABELS[seat.role]
      : "Member";
  return `${desk} · ${roleLabel}`;
}
