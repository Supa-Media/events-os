/**
 * NAMING A FINANCE SCOPE — a chapter, or the org level (`"central"`).
 *
 * `FinanceScope` is `Id<"chapters"> | "central"`, and the sentinel is not a row:
 * there is no `chapters` document for central, so `ctx.db.get(scope)` is a type
 * error at best and `undefined` at worst. Every screen, email and public page
 * that needs to say WHOSE money this is therefore needs one place to ask, or
 * each of them invents its own answer and they drift — one says "Central", the
 * next "Public Worship", a third renders an empty string.
 *
 * THE PUBLIC IDENTITY IS DELIBERATE. A contractor being paid by the org is
 * being paid by *Public Worship* — not by "Central", which is internal
 * vocabulary for a set of books. The internal label says "Central" because a
 * treasurer picking a scope needs to tell it apart from a chapter; the
 * outward-facing one never does.
 *
 * PURE READS ONLY — nothing in `lib/` registers Convex functions.
 */
import { CENTRAL } from "@events-os/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { FinanceScope } from "./finance";

/** The org's own name, as the people it pays would recognise it. Used on the
 *  contractor's page, in their emails, and anywhere else central faces out. */
export const CENTRAL_PUBLIC_NAME = "Public Worship";

/** What a treasurer sees in a scope picker. Distinguishable from a chapter at a
 *  glance, which the public name deliberately is not. */
export const CENTRAL_INTERNAL_NAME = "Central";

/**
 * The path segment central answers to on a public URL —
 * `/contract/central`, alongside `/contract/new-york`.
 *
 * A RESERVED WORD, and the reason `chapters.slug` must never be allowed to take
 * this value: a chapter that managed to claim the slug `central` would shadow
 * the org's own page and serve one scope's agreements under another's name.
 * `resolveContractScope` resolves this segment BEFORE it ever looks a chapter
 * up, so the reservation holds even if such a row exists.
 */
export const CENTRAL_PUBLIC_SLUG = "central";

export function isCentralScope(scope: FinanceScope): boolean {
  return scope === CENTRAL;
}

/** The chapter row behind a scope, or `null` at the org level. The one helper
 *  that makes `ctx.db.get` on a scope safe. */
export async function chapterForScope(
  ctx: QueryCtx,
  scope: FinanceScope,
): Promise<Doc<"chapters"> | null> {
  if (scope === CENTRAL) return null;
  return await ctx.db.get(scope as Id<"chapters">);
}

/** How this scope names itself to the PUBLIC — a contractor, an email, a page.
 *  Central is the organisation; a chapter is its own name. */
export async function scopePublicName(
  ctx: QueryCtx,
  scope: FinanceScope,
): Promise<string> {
  if (scope === CENTRAL) return CENTRAL_PUBLIC_NAME;
  const chapter = await ctx.db.get(scope as Id<"chapters">);
  return chapter?.name ?? "";
}

/** How this scope names itself INSIDE the app, where "Central" has to be
 *  distinguishable from a chapter. */
export async function scopeInternalName(
  ctx: QueryCtx,
  scope: FinanceScope,
): Promise<string> {
  if (scope === CENTRAL) return CENTRAL_INTERNAL_NAME;
  const chapter = await ctx.db.get(scope as Id<"chapters">);
  return chapter?.name ?? "";
}

/**
 * The slug this scope's public pages live under, or `null` when a chapter has
 * none set.
 *
 * Central ALWAYS has one — it is the reserved constant — which is the fix for
 * the "a central desk has no public page of its own" dead end: it does now.
 */
export async function scopePublicSlug(
  ctx: QueryCtx,
  scope: FinanceScope,
): Promise<string | null> {
  if (scope === CENTRAL) return CENTRAL_PUBLIC_SLUG;
  const chapter = await ctx.db.get(scope as Id<"chapters">);
  return chapter?.slug ?? null;
}

/**
 * A public URL segment → the scope it addresses, or `null` for an unknown one.
 *
 * CENTRAL IS CHECKED FIRST, before any chapter lookup — see
 * `CENTRAL_PUBLIC_SLUG` for why that ordering is the reservation.
 */
export async function resolveContractScope(
  ctx: QueryCtx,
  slug: string,
): Promise<{ scope: FinanceScope; name: string; slug: string } | null> {
  if (slug === CENTRAL_PUBLIC_SLUG) {
    return {
      scope: CENTRAL,
      name: CENTRAL_PUBLIC_NAME,
      slug: CENTRAL_PUBLIC_SLUG,
    };
  }
  const chapter = await ctx.db
    .query("chapters")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (!chapter) return null;
  return { scope: chapter._id, name: chapter.name, slug: chapter.slug ?? slug };
}
