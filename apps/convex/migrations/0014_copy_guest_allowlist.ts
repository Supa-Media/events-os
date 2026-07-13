import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Copy `guestAllowlist` rows → the new `accessAllowlist` table (Chapter-OS
 * rename). New grants/revokes already write `accessAllowlist`; this brings the
 * historical rows across so login and the admin list see them there too.
 * Additive: the legacy `guestAllowlist` rows are left intact (and read as a
 * fallback in `lib/access.ts`); the table is dropped only in a later Deploy C.
 *
 * Idempotent: an email already present in `accessAllowlist` is left untouched
 * (the new table is authoritative once populated), so a re-run copies nothing
 * and never clobbers a newer grant/revoke. The allowlist is small (individually
 * seeded emails), so a single-pass sweep is safe.
 */
export async function runCopyGuestAllowlist(ctx: MutationCtx) {
  let copied = 0;
  // `guestAllowlist` was dropped from the schema in Deploy C; this ledgered
  // migration only needs to typecheck (it never re-runs on prod), so query the
  // now-undeclared table via `any` (same pattern as `cleanupLegacyRoles`).
  for (const guest of await (ctx.db as any).query("guestAllowlist").collect()) {
    const existing = await ctx.db
      .query("accessAllowlist")
      .withIndex("by_email", (q) => q.eq("email", guest.email))
      .first();
    if (existing) continue;
    await ctx.db.insert("accessAllowlist", {
      email: guest.email,
      note: guest.note,
      isActive: guest.isActive,
      createdAt: guest.createdAt,
    });
    copied++;
  }
  return { copied };
}

export const copyGuestAllowlist: Migration = {
  name: "0014_copy_guest_allowlist",
  run: runCopyGuestAllowlist,
};
