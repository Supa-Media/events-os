/**
 * COMPATIBILITY SHIM — `guests` → `accessAllowlist` (Chapter-OS rename).
 *
 * The allowlist API moved to `accessAllowlist.ts` (`api.accessAllowlist.*` /
 * `internal.accessAllowlist.*`). This module re-exports those exact registered
 * functions so `api.guests.*` and `internal.guests.*` keep resolving for
 * OTA-lagged mobile clients that shipped before the rename. Each re-exported
 * name is the SAME underlying Convex function — a true delegation, not a copy.
 *
 * Writes go to the new `accessAllowlist` table; reads fall back to the legacy
 * `guestAllowlist` (see `accessAllowlist.ts` + `lib/access.ts`). Remove this
 * shim once every client has updated past `api.guests.*`.
 */
export {
  checkEmail,
  allow,
  revoke,
  list,
  grantAccess,
  revokeAccess,
  listGuests,
  sendAccessGrantedEmail,
} from "./accessAllowlist";
