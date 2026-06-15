/**
 * Docs — standalone "How-To" targets (link / video / note / markdown page).
 *
 * Each How-To grid cell stores an `Id<"docs">`; this module is its CRUD. Authed
 * reads/writes are chapter-scoped through the shared context helpers. A doc also
 * carries a short unguessable `shareId` so it can be read with NO auth at
 * `/doc/<shareId>` via `getPublic` (same capability model as the crew share
 * page) — that path returns ONLY the doc's safe display fields, never chapter
 * data.
 */
import { query, mutation, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { requireChapterId, requireUserId, requireInChapter } from "./lib/context";

/** The doc kinds — mirrors the `docs` table union. */
const docKind = v.union(
  v.literal("link"),
  v.literal("video"),
  v.literal("note"),
  v.literal("markdown"),
);

/**
 * A short, unguessable public slug. `Math.random` is fine inside Convex
 * functions (it's seeded per-call, not the insecure script-side singleton), and
 * the slug is a capability, not a secret derived from anything sensitive.
 */
function makeShareId(): string {
  const rand = () => Math.random().toString(36).slice(2);
  return (rand() + rand()).slice(0, 16);
}

/** The caller's linked roster person (for `createdBy`); falls back to any chapter person. */
async function requireCallerPerson(
  ctx: any,
  chapterId: string,
): Promise<Id<"people">> {
  const userId = await requireUserId(ctx);
  const linked = await ctx.db
    .query("people")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  if (linked) return linked._id as Id<"people">;
  const any = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
    .first();
  if (any) return any._id as Id<"people">;
  throw new ConvexError({
    code: "NO_PERSON",
    message: "No roster person to attribute this doc to.",
  });
}

/** Create a doc scoped to the caller's chapter. Returns its id + public share slug. */
export const create = mutation({
  args: {
    kind: docKind,
    title: v.string(),
    url: v.optional(v.string()),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const createdBy = await requireCallerPerson(ctx, chapterId);
    const now = Date.now();
    const _id = await ctx.db.insert("docs", {
      chapterId: chapterId as Id<"chapters">,
      kind: args.kind,
      title: args.title.trim() || "Untitled",
      url: args.url,
      body: args.body,
      shareId: makeShareId(),
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await ctx.db.get(_id);
    return { _id, shareId: doc!.shareId };
  },
});

/** Load one doc (authed, chapter-scoped). */
export const get = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc || doc.chapterId !== chapterId) return null;
    return doc;
  },
});

/** Update a doc's title / url / body / kind (authed, chapter-scoped). */
export const update = mutation({
  args: {
    docId: v.id("docs"),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    body: v.optional(v.string()),
    kind: v.optional(docKind),
  },
  handler: async (ctx, { docId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    await requireInChapter(ctx, chapterId, doc, "Doc");
    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.url !== undefined) fields.url = patch.url;
    if (patch.body !== undefined) fields.body = patch.body;
    if (patch.kind !== undefined) fields.kind = patch.kind;
    await ctx.db.patch(docId, fields);
    return docId;
  },
});

/**
 * PUBLIC, no-auth doc read by share slug — reachable at `/doc/<shareId>`.
 *
 * Mirrors `events.publicCrew`: it does NOT call requireChapterId/requireUserId,
 * so a logged-out caller can load it. Returns ONLY the safe display fields; the
 * `chapterId`, `createdBy`, and timestamps are never leaked.
 */
export const getPublic = query({
  args: { shareId: v.string() },
  handler: async (ctx, { shareId }) => {
    const doc = await ctx.db
      .query("docs")
      .withIndex("by_share", (q: any) => q.eq("shareId", shareId))
      .first();
    if (!doc) return null;
    return {
      kind: doc.kind,
      title: doc.title,
      url: doc.url ?? null,
      body: doc.body ?? null,
    };
  },
});

/** Internal: overwrite a doc's body (used by the AI generate/improve action). */
export const setBody = internalMutation({
  args: { docId: v.id("docs"), body: v.string() },
  handler: async (ctx, { docId, body }) => {
    const doc = await ctx.db.get(docId);
    if (!doc) return;
    await ctx.db.patch(docId, { body, updatedAt: Date.now() });
  },
});

/** Internal: a doc's chapter + current body, for the AI action's budget gate / prompt. */
export const forAi = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    if (!doc || doc.chapterId !== chapterId) return null;
    return { title: doc.title, body: doc.body ?? "", kind: doc.kind };
  },
});
