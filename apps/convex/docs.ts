/**
 * Docs — standalone "How-To" targets (link / video / note / markdown page).
 *
 * Each How-To grid cell stores an `Id<"docs">`; this module is its CRUD. Authed
 * reads/writes are chapter-scoped through the shared context helpers. A doc also
 * carries a short unguessable `shareId` so it can be read with NO auth at
 * `/d/<shareId>` via `getPublic` (same capability model as the crew share
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

/** Public/internal visibility — mirrors the `docs` table union. */
const docVisibility = v.union(v.literal("public"), v.literal("internal"));

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
    // Origin of the doc: a template master (`"template"`) shared by reference, or
    // an event-local doc (`"event"`). Defaults to `"event"` when omitted.
    scope: v.optional(v.union(v.literal("template"), v.literal("event"))),
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
      scope: args.scope ?? "event",
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    const doc = await ctx.db.get(_id);
    return { _id, shareId: doc!.shareId };
  },
});

/**
 * Copy-on-write fork for an event item's How-To cell.
 *
 * When a How-To is edited from an EVENT instance but its cell still points at a
 * template-origin (shared) doc, we must not mutate the master. This clones the
 * doc into a fresh `scope: "event"` copy, repoints THAT event item's
 * `fields[colKey]` at the copy, and returns the new doc id so the caller can
 * apply the actual edit to the copy. The template master and all sibling events
 * keep the original.
 *
 * Both the doc and the event item are authorized against the caller's chapter.
 */
export const forkForEventItem = mutation({
  args: {
    docId: v.id("docs"),
    eventItemId: v.id("eventItems"),
    colKey: v.string(),
  },
  handler: async (ctx, { docId, eventItemId, colKey }) => {
    const chapterId = await requireChapterId(ctx);
    const createdBy = await requireCallerPerson(ctx, chapterId);

    const doc = await ctx.db.get(docId);
    await requireInChapter(ctx, chapterId, doc, "Doc");

    const item = await ctx.db.get(eventItemId);
    if (!item) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Event item not found in your chapter.",
      });
    }
    const event = await ctx.db.get(item.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");

    const now = Date.now();
    const _id = await ctx.db.insert("docs", {
      chapterId: chapterId as Id<"chapters">,
      kind: doc!.kind,
      title: doc!.title,
      url: doc!.url,
      body: doc!.body,
      shareId: makeShareId(),
      scope: "event",
      forkedFromDocId: docId,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });

    // Repoint only this event item's cell at the copy; preserve the rest of fields.
    const nextFields = { ...(item.fields ?? {}), [colKey]: _id };
    await ctx.db.patch(eventItemId, { fields: nextFields });

    return { _id };
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

/** Update a doc's title / url / body / kind / visibility (authed, chapter-scoped). */
export const update = mutation({
  args: {
    docId: v.id("docs"),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    body: v.optional(v.string()),
    kind: v.optional(docKind),
    visibility: v.optional(docVisibility),
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
    if (patch.visibility !== undefined) fields.visibility = patch.visibility;
    await ctx.db.patch(docId, fields);
    return docId;
  },
});

/**
 * PUBLIC, no-auth doc read by share slug — reachable at `/d/<shareId>`.
 *
 * Mirrors `events.publicCrew`: it does NOT call requireChapterId/requireUserId,
 * so a logged-out caller can load it. Returns ONLY the safe display fields; the
 * `chapterId`, `createdBy`, and timestamps are never leaked.
 *
 * Visibility gate: an `internal` doc returns null (looks like a missing link to a
 * logged-out viewer). Undefined or `public` visibility returns the doc — so all
 * existing docs stay public by default.
 */
export const getPublic = query({
  args: { shareId: v.string() },
  handler: async (ctx, { shareId }) => {
    const doc = await ctx.db
      .query("docs")
      .withIndex("by_share", (q: any) => q.eq("shareId", shareId))
      .first();
    if (!doc) return null;
    if (doc.visibility === "internal") return null;
    return {
      // The doc id is not sensitive — it's needed to open the auth-gated editor
      // (`/doc/<docId>`) from the public preview's Edit button. The (app) auth
      // guard still gates whether the caller can actually open it.
      _id: doc._id,
      kind: doc.kind,
      title: doc.title,
      url: doc.url ?? null,
      body: doc.body ?? null,
    };
  },
});

/**
 * Search this chapter's how-to docs for ones relevant to `query` — the doc
 * assistant's "reuse an existing guide" tool. Scoped to the caller's chapter, so
 * the agent can pull in how-tos written for OTHER templates/events in the same
 * community.
 *
 * Considers only `markdown`/`note` docs with a non-empty body, scores each by
 * case-insensitive term overlap of the query against title + body, and returns
 * the top ~5 as `{ title, body }` with each body truncated to ~2000 chars.
 */
export const searchForAi = query({
  args: { query: v.string() },
  handler: async (ctx, { query: rawQuery }) => {
    const chapterId = await requireChapterId(ctx);

    const terms = rawQuery
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);

    const docs = await ctx.db
      .query("docs")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();

    const scored = docs
      .filter(
        (d) =>
          (d.kind === "markdown" || d.kind === "note") &&
          typeof d.body === "string" &&
          d.body.trim().length > 0,
      )
      .map((d) => {
        const hay = `${d.title}\n${d.body ?? ""}`.toLowerCase();
        // Score = number of query terms that appear anywhere in title + body.
        const score = terms.reduce(
          (acc, t) => acc + (hay.includes(t) ? 1 : 0),
          0,
        );
        return { score, title: d.title, body: (d.body ?? "").slice(0, 2000) };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ title, body }) => ({ title, body }));

    return scored;
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
