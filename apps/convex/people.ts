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
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";

const vettingStatus = v.union(
  v.literal("unvetted"),
  v.literal("pending"),
  v.literal("vetted"),
);

const rosterStatus = v.union(
  v.literal("active"),
  v.literal("inactive"),
  v.literal("transitioning_in"),
  v.literal("transitioning_out"),
  v.literal("unavailable"),
);

const gender = v.union(v.literal("male"), v.literal("female"), v.literal("na"));

/** List the chapter roster sorted by name. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    // These are PER-EVENT materialized copies of a template's placeholder crew
    // (the reusable definitions live on the template as `templatePeople` and are
    // never touched here) — event-scoped stand-ins, not real roster members, so
    // keep them out of the People roster. Replacing one only consumes that
    // event's copy; the template's placeholders persist for future instances.
    const sorted = people
      .filter((p) => p.isPlaceholder !== true)
      .sort((a, b) => a.name.localeCompare(b.name));
    // Resolve each profile photo storageId to a servable URL for display.
    return await Promise.all(
      sorted.map(async (p) => ({
        ...p,
        imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
      })),
    );
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
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    return people
      .filter((p) => p.isTeamMember === true || p.userId != null)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Fetch a single person in the caller's chapter. */
export const get = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    return await requireOwned(ctx, "people", personId, "Person");
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
    status: v.optional(rosterStatus),
    role: v.optional(v.string()),
    gender: v.optional(gender),
    pocName: v.optional(v.string()),
    projects: v.optional(v.array(v.string())),
    commsPreferences: v.optional(v.array(v.string())),
    pwEmail: v.optional(v.string()),
    company: v.optional(v.string()),
    usualRateUsd: v.optional(v.number()),
    isTeamMember: v.optional(v.boolean()),
    image: v.optional(v.id("_storage")),
    socialLink: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireUserId(ctx);
    const status = args.status ?? "active";
    return await ctx.db.insert("people", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      email: args.email,
      phone: args.phone,
      skills: args.skills,
      vettingStatus: args.vettingStatus ?? "unvetted",
      status,
      role: args.role,
      gender: args.gender,
      pocName: args.pocName,
      projects: args.projects,
      commsPreferences: args.commsPreferences,
      pwEmail: args.pwEmail,
      company: args.company,
      usualRateUsd: args.usualRateUsd,
      isTeamMember: args.isTeamMember,
      image: args.image,
      socialLink: args.socialLink,
      isActive: status !== "inactive",
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
    status: v.optional(rosterStatus),
    role: v.optional(v.union(v.string(), v.null())),
    gender: v.optional(gender),
    pocName: v.optional(v.union(v.string(), v.null())),
    projects: v.optional(v.union(v.array(v.string()), v.null())),
    commsPreferences: v.optional(v.union(v.array(v.string()), v.null())),
    pwEmail: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(v.string(), v.null())),
    image: v.optional(v.union(v.id("_storage"), v.null())),
    socialLink: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { personId, ...patch }) => {
    await requireOwned(ctx, "people", personId, "Person");
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    // Keep the convenience isActive flag in sync when status changes (unless the
    // caller set isActive explicitly in the same patch).
    if (patch.status !== undefined && patch.isActive === undefined) {
      fields.isActive = patch.status !== "inactive";
    }
    await ctx.db.patch(personId, fields);
    return personId;
  },
});

/** Remove a person from the roster, plus their event engagements. */
export const remove = mutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    await requireOwned(ctx, "people", personId, "Person");
    const engagements = await ctx.db
      .query("engagements")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    for (const e of engagements) await ctx.db.delete(e._id);
    await ctx.db.delete(personId);
    return personId;
  },
});
