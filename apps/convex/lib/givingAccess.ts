/**
 * Giving Platform (F-6 P1) authorization — the donor-CRM gate, mirroring
 * `lib/finance.ts`'s `requireFinanceRole` family.
 *
 * Resolution (no stored grant table of its own — giving capability is PURELY
 * seat-derived, unlike finance's stored `financeRoles` ladder):
 *  - Superusers pass everything (the bootstrap path, mirrored across the repo).
 *  - Otherwise the caller's giving capability is the union of
 *    `lib/seats.ts#getSeatDerivedGivingCapabilities` across EVERY non-placeholder
 *    `people` row the caller's `userId` owns (the same whole-user walk
 *    `financeRoles.mySeats` / `lib/finance.ts#isCentralEdOrFm` do, so a seat on
 *    a non-home roster row still counts).
 *  - A CENTRAL capability holder sees/manages every scope (org-wide reach — the
 *    development director / ED stewards central's own donors AND every
 *    chapter's). A CHAPTER `giving.view` seat (chapter director / treasurer)
 *    sees only its OWN chapter.
 *
 * Every refusal throws `ConvexError({ code, message })` (never a plain `Error`)
 * so the app's AuthErrorBoundary can surface it, exactly like the finance gates.
 */
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { requireUserId } from "./context";
import { getSeatDerivedGivingCapabilities } from "./seats";

/** A giving scope: a real chapter, or the org level (`"central"` sentinel) —
 *  the same union as `FinanceScope` / `donors.scope` / `seatAssignments.scope`. */
export type GivingScope = Id<"chapters"> | "central";

/** The caller's resolved giving reach, unioned across their roster rows. */
export interface GivingAccess {
  /** Superuser (or a central capability holder) — sees/manages every scope. */
  isSuperuser: boolean;
  /** Central-scope giving.view (implies view of every scope). */
  centralView: boolean;
  /** Central-scope giving.manage (implies manage of every scope). */
  centralManage: boolean;
  /** Central-scope nav.giving (surface the desk at the central lens). */
  centralNav: boolean;
  /** Chapters where the caller holds a chapter-scope `giving.view` seat. */
  viewChapters: Set<string>;
  /** Chapters where the caller holds a chapter-scope `giving.manage` seat. */
  manageChapters: Set<string>;
  /** Any nav.giving anywhere (central or a chapter) — surfaces the desk. */
  anyNav: boolean;
}

/**
 * Resolve the caller's giving reach across every non-placeholder `people` row
 * their `userId` owns. Superuser short-circuits to full reach. Pure read.
 */
export async function resolveGivingAccess(ctx: QueryCtx): Promise<GivingAccess> {
  const access: GivingAccess = {
    isSuperuser: false,
    centralView: false,
    centralManage: false,
    centralNav: false,
    viewChapters: new Set<string>(),
    manageChapters: new Set<string>(),
    anyNav: false,
  };

  if (await isSuperuser(ctx)) {
    access.isSuperuser = true;
    access.centralView = true;
    access.centralManage = true;
    access.centralNav = true;
    access.anyNav = true;
    return access;
  }

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return access; // signed out — no reach (quiet, not a throw)

  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    const caps = await getSeatDerivedGivingCapabilities(ctx, person._id);
    for (const [scopeKey, scopeCaps] of Object.entries(caps)) {
      if (scopeCaps.nav) access.anyNav = true;
      if (scopeKey === "central") {
        if (scopeCaps.view) access.centralView = true;
        if (scopeCaps.manage) access.centralManage = true;
        if (scopeCaps.nav) access.centralNav = true;
      } else {
        if (scopeCaps.view) access.viewChapters.add(scopeKey);
        if (scopeCaps.manage) access.manageChapters.add(scopeKey);
      }
    }
  }
  return access;
}

/** Whether the resolved access grants READ of `scope`. */
function accessCanView(access: GivingAccess, scope: GivingScope): boolean {
  if (access.isSuperuser || access.centralView) return true;
  if (scope === "central") return false; // central reach is central-only
  return access.viewChapters.has(scope);
}

/** Whether the resolved access grants WRITE of `scope`. */
function accessCanManage(access: GivingAccess, scope: GivingScope): boolean {
  if (access.isSuperuser || access.centralManage) return true;
  if (scope === "central") return false;
  return access.manageChapters.has(scope);
}

/** Assert the caller may READ the giving CRM at `scope`, else throw. */
export async function requireGivingView(
  ctx: QueryCtx,
  scope: GivingScope,
): Promise<GivingAccess> {
  const access = await resolveGivingAccess(ctx);
  if (!accessCanView(access, scope)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to the development desk for this scope.",
    });
  }
  return access;
}

/** Assert the caller may WRITE the giving CRM at `scope`, else throw. */
export async function requireGivingManage(
  ctx: QueryCtx,
  scope: GivingScope,
): Promise<GivingAccess> {
  const access = await resolveGivingAccess(ctx);
  if (!accessCanManage(access, scope)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to manage donors for this scope.",
    });
  }
  return access;
}
