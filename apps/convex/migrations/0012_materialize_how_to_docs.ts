import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { makeShareId } from "../lib/platformGuides";

/**
 * Materialize legacy `responsibilities.howTo` plain text into a standalone
 * `docs` note row, and point the duty at it via `howToDocId`.
 *
 * A duty's "how to actually do this" used to be a plain-text field; it's now a
 * standalone doc (the same primitive behind event-grid How-To cells), so it
 * gets its own page + share URL. For every duty that has non-empty `howTo` text
 * but no `howToDocId`, this creates a `kind: "note"` doc carrying that text and
 * links it. Additive: the legacy `howTo` text is left in place as a fallback
 * (dropped only in a later Deploy C).
 *
 * A doc is authored AS a roster person (`docs.createdBy` is an `Id<"people">`),
 * so we attribute it to the duty's creating user's linked roster person, else
 * the oldest person in the chapter. A chapter with no roster person at all
 * can't own a doc, so its duties are left on the legacy text (still readable
 * via the fallback) and picked up on a later run once a person exists.
 *
 * Idempotent: a duty that already has `howToDocId` is skipped, so a second run
 * creates no duplicate docs.
 */
export async function runMaterializeHowToDocs(ctx: MutationCtx) {
  let created = 0;
  let skippedNoAuthor = 0;

  // Cache the resolved author person per chapter (cheap, avoids re-querying).
  const authorByChapter = new Map<string, Id<"people"> | null>();
  const resolveAuthor = async (
    chapterId: Id<"chapters">,
    createdByUser: Id<"users">,
  ): Promise<Id<"people"> | null> => {
    const cacheKey = `${chapterId}:${createdByUser}`;
    if (authorByChapter.has(cacheKey)) return authorByChapter.get(cacheKey)!;
    // Prefer the creating user's linked roster person (in this chapter).
    const linked = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", createdByUser))
      .first();
    let author: Id<"people"> | null =
      linked && linked.chapterId === chapterId ? linked._id : null;
    if (!author) {
      // Fall back to the oldest roster person in the chapter.
      const anyPerson = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .first();
      author = anyPerson?._id ?? null;
    }
    authorByChapter.set(cacheKey, author);
    return author;
  };

  for (const duty of await ctx.db.query("responsibilities").collect()) {
    if (duty.howToDocId) continue;
    // `howTo` was dropped from the schema in Deploy C; this ledgered migration
    // only needs to typecheck (it never re-runs on prod), so read it via `any`.
    const text = ((duty as any).howTo as string | undefined)?.trim();
    if (!text) continue;

    const author = await resolveAuthor(duty.chapterId, duty.createdBy);
    if (!author) {
      skippedNoAuthor++;
      continue;
    }

    const now = Date.now();
    const docId = (await ctx.db.insert("docs", {
      chapterId: duty.chapterId,
      kind: "note",
      title: duty.title || "How-to",
      body: text,
      shareId: makeShareId(),
      createdBy: author,
      createdAt: now,
      updatedAt: now,
    })) as Id<"docs">;
    await ctx.db.patch(duty._id, { howToDocId: docId });
    created++;
  }

  return { created, skippedNoAuthor };
}

export const materializeHowToDocs: Migration = {
  name: "0012_materialize_how_to_docs",
  run: runMaterializeHowToDocs,
};
