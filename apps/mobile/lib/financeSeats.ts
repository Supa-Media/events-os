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
 * One of the caller's REAL finance seats, as returned by
 * `api.financeRoles.mySeats`.
 */
export type Seat =
  | { scope: "central"; role: FinanceRole; title?: SpecializedRoleTitle }
  | {
      scope: "chapter";
      chapterId: Id<"chapters">;
      chapterName: string;
      role: FinanceRole;
      title?: SpecializedRoleTitle;
    };

/** The stable key identifying a seat ("central" or the chapter id). */
export function seatKeyOf(seat: Seat): string {
  return seat.scope === "central" ? "central" : seat.chapterId;
}

/**
 * "Central · Executive Director" / "New York · Chapter Director" / "New York
 * · Treasurer" when the caller holds an org-chart specialized title at this
 * seat's scope (WP-1.1, via `specializedRoleLabel` — the single source for
 * that scope-aware mapping); otherwise falls back to the generic finance-role
 * label, e.g. "Central · Manager" / "New York · Bookkeeper".
 */
export function seatLabelOf(seat: Seat): string {
  const desk = seat.scope === "central" ? "Central" : seat.chapterName;
  const roleLabel = seat.title
    ? specializedRoleLabel(seat.title, seat.scope === "central")
    : FINANCE_ROLE_LABELS[seat.role];
  return `${desk} · ${roleLabel}`;
}
