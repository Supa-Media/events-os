/**
 * Platform guide seeding — upserts the generated enablement guides
 * (`lib/guides.ts`, synced from docs/guides/*.md) into a chapter's `docs`
 * table as markdown how-to docs.
 *
 * Fork semantics (training-and-enablement plan, Q1): a chapter that edits its
 * copy of a guide keeps its edits — the seeder only overwrites a doc whose
 * body is UNEDITED since the last seed. "Unedited" is detected by comparing
 * the current body's hash against `seedHash` (the hash stored when the
 * platform last wrote the body).
 *
 * Called from the dev-seed entry points in `seed.ts` (new chapters get the
 * guides on creation) and from the `docs:seedPlatformGuides` internal
 * mutation (backfill for existing chapters, dashboard/CLI — mirrors the other
 * seed backfills).
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { PLATFORM_GUIDES, type PlatformGuide } from "./guides";
import { sha256Hex } from "./sha256";

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
  /** Docs left alone because the chapter edited them (fork semantics). */
  skippedEdited: number;
}

/**
 * The person a platform-seeded doc is attributed to. `docs.createdBy` is a
 * roster `people` id (see schema/docs.ts), so — mirroring how seed.ts falls
 * back to "the first user" for template authorship — we pick the most
 * system-owner-like person in the chapter: one linked to a login, else a team
 * member, else anyone. Returns null for a person-less chapter (the caller
 * skips seeding; re-run once the roster exists).
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
  const person =
    people.find((p) => p.userId !== undefined) ??
    people.find((p) => p.isTeamMember) ??
    people[0];
  return person._id;
}

/**
 * Upsert one markdown doc per guide into the chapter, keyed by
 * (chapterId, slug):
 *
 * - missing            → create (kind "markdown", fresh shareId, seedHash)
 * - unedited since seed → overwrite body/title, refresh seedHash
 * - edited by chapter  → leave alone (their fork; platform updates stop)
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
    skippedEdited: 0,
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

    const newHash = sha256Hex(guide.body);

    if (!existing) {
      await ctx.db.insert("docs", {
        chapterId,
        kind: "markdown",
        title: guide.title,
        body: guide.body,
        shareId: makeShareId(),
        slug: guide.slug,
        seedHash: newHash,
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
      result.created++;
      continue;
    }

    // Edited since the last seed? (Missing seedHash — a pre-hash row — is
    // treated as unedited so the backfill can adopt it.)
    const currentHash = sha256Hex(existing.body ?? "");
    if (existing.seedHash !== undefined && currentHash !== existing.seedHash) {
      result.skippedEdited++;
      continue;
    }

    if (existing.body === guide.body && existing.title === guide.title) {
      // Content already current; just make sure the seed hash is recorded.
      if (existing.seedHash !== newHash) {
        await ctx.db.patch(existing._id, { seedHash: newHash });
      }
      result.unchanged++;
      continue;
    }

    await ctx.db.patch(existing._id, {
      title: guide.title,
      body: guide.body,
      seedHash: newHash,
      updatedAt: now,
    });
    result.updated++;
  }

  return result;
}
