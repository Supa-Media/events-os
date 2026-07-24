/**
 * Platform guide seeding — upserts the generated enablement guides
 * (`lib/guides.ts`, synced from docs/guides/*.md) into a chapter's `docs`
 * table as markdown how-to docs.
 *
 * Ownership semantics (training-and-enablement plan, Q1): guides are
 * PLATFORM-OWNED and never forked — seeding always brings every chapter's
 * copy up to the latest platform version, and the app renders slug-bearing
 * docs read-only (docs.ts rejects user writes with PLATFORM_GUIDE_READONLY).
 * Chapter-specific knowledge belongs in templates/how-to docs, not guide
 * edits.
 *
 * Called from the dev-seed entry points in `seed.ts` (new chapters get the
 * guides on creation) and from the `docs:seedPlatformGuides` internal
 * mutation (backfill for existing chapters, dashboard/CLI — mirrors the other
 * seed backfills).
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { PLATFORM_GUIDES, type PlatformGuide } from "./guides";

/**
 * A short, unguessable public slug. `Math.random` is fine inside Convex
 * functions (it's seeded per-call, not the insecure script-side singleton), and
 * the slug is a capability, not a secret derived from anything sensitive.
 */
export function makeShareId(): string {
  const rand = () => Math.random().toString(36).slice(2);
  return (rand() + rand()).slice(0, 16);
}

export interface SeedGuidesResult {
  /** False when the chapter has no roster person to attribute authorship to. */
  seeded: boolean;
  created: number;
  updated: number;
  unchanged: number;
}

/**
 * The person a platform-seeded doc is attributed to. `docs.createdBy` is a
 * roster `people` id (see schema/docs.ts), so — mirroring how seed.ts falls
 * back to "the first user" for template authorship — we pick the most
 * system-owner-like person in the chapter: one linked to a login, else a team
 * member, else anyone NON-CONTACT (person-centric audiences Phase 1 — a
 * guest/donor auto-created row is never eligible). Returns null for a
 * person-less (or contacts-only) chapter (the caller skips seeding; re-run
 * once a real roster person exists).
 */
async function resolveAuthorPerson(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"people"> | null> {
  const people = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  if (people.length === 0) return null;
  // The first two tiers (login-linked, team member) already can never be a
  // contact-only row (person-centric audiences Phase 1 — those never carry a
  // `userId` or `isTeamMember: true`). The last-resort "anyone" tier must
  // still exclude them explicitly — a guest/donor auto-created row must never
  // become a doc's author.
  const person =
    people.find((p) => p.userId !== undefined) ??
    people.find((p) => p.isTeamMember) ??
    people.find((p) => p.isContactOnly !== true) ??
    null;
  return person?._id ?? null;
}

/**
 * Upsert one markdown doc per guide into the chapter, keyed by
 * (chapterId, slug):
 *
 * - missing         → create (kind "markdown", fresh shareId)
 * - content differs → overwrite title/body with the platform version
 * - already current → leave alone
 *
 * Guides are platform-owned and read-only in the app, so any drift from the
 * platform version is stale content, never a chapter fork — seeding always
 * wins.
 */
export async function seedPlatformGuidesForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  guides: PlatformGuide[] = PLATFORM_GUIDES,
): Promise<SeedGuidesResult> {
  const result: SeedGuidesResult = {
    seeded: true,
    created: 0,
    updated: 0,
    unchanged: 0,
  };

  const createdBy = await resolveAuthorPerson(ctx, chapterId);
  if (!createdBy) return { ...result, seeded: false };

  const now = Date.now();
  for (const guide of guides) {
    const existing = await ctx.db
      .query("docs")
      .withIndex("by_chapter_and_slug", (q) =>
        q.eq("chapterId", chapterId).eq("slug", guide.slug),
      )
      .unique();

    if (!existing) {
      await ctx.db.insert("docs", {
        chapterId,
        kind: "markdown",
        title: guide.title,
        body: guide.body,
        shareId: makeShareId(),
        slug: guide.slug,
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
      result.created++;
      continue;
    }

    if (existing.body === guide.body && existing.title === guide.title) {
      result.unchanged++;
      continue;
    }

    await ctx.db.patch(existing._id, {
      title: guide.title,
      body: guide.body,
      updatedAt: now,
    });
    result.updated++;
  }

  return result;
}
