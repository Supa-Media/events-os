/**
 * People / Volunteer roster.
 *
 * Chapter-scoped roster CRUD. Every function resolves the caller's chapter via
 * `requireChapterId` and scopes reads/writes to it.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireUserId,
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";

const vettingStatus = v.union(
  v.literal("unvetted"),
  v.literal("pending"),
  v.literal("vetted"),
);

/** List the chapter roster sorted by name. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    return people.sort((a: any, b: any) => a.name.localeCompare(b.name));
  },
});

/**
 * Team members only — the people who can be event owners or hold lead roles
 * (they have, or will be granted, backend access). A person counts as a team
 * member if explicitly flagged OR already linked to a user account.
 */
export const teamMembers = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    return people
      .filter((p: any) => p.isTeamMember === true || p.userId != null)
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
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
    usualRateUsd: v.optional(v.union(v.number(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    isTeamMember: v.optional(v.boolean()),
    vettingStatus: v.optional(vettingStatus),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { personId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    await ctx.db.patch(personId, fields);
    return personId;
  },
});

/** Remove a person from the roster, plus their event engagements. */
export const remove = mutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = await requireChapterId(ctx);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");
    const engagements = await ctx.db
      .query("engagements")
      .withIndex("by_person", (q: any) => q.eq("personId", personId))
      .collect();
    for (const e of engagements) await ctx.db.delete(e._id);
    await ctx.db.delete(personId);
    return personId;
  },
});
