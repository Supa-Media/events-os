/**
 * People / Volunteer roster.
 *
 * Chapter-scoped roster CRUD. Every function resolves the caller's chapter via
 * `requireChapterId` and scopes reads/writes to it.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireUserId, requireChapterId, requireInChapter } from "./lib/context";

const vettingStatus = v.union(
  v.literal("unvetted"),
  v.literal("pending"),
  v.literal("vetted"),
);

/** List the chapter roster sorted by name. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await requireChapterId(ctx);
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    return people.sort((a: any, b: any) => a.name.localeCompare(b.name));
  },
});

/** Fetch a single person in the caller's chapter. */
export const get = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = await requireChapterId(ctx);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    return person;
  },
});

/** Add a person to the chapter roster. */
export const create = mutation({
  args: {
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
    vettingStatus: v.optional(vettingStatus),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireUserId(ctx);
    return await ctx.db.insert("people", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      email: args.email,
      phone: args.phone,
      skills: args.skills,
      vettingStatus: args.vettingStatus ?? "unvetted",
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/** Update a person's profile fields. */
export const update = mutation({
  args: {
    personId: v.id("people"),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
    vettingStatus: v.optional(vettingStatus),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { personId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) fields[key] = value;
    }
    await ctx.db.patch(personId, fields);
    return personId;
  },
});
