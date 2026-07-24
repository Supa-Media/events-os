/**
 * People / Volunteer roster.
 *
 * Chapter-scoped roster CRUD. Every function resolves the caller's chapter via
 * `requireChapterId` and scopes reads/writes to it.
 */
import { query, mutation, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import { isChapterAdmin } from "./lib/org";
import { isCardEligible } from "@events-os/shared";
import { writePersonAudit, diffFields } from "./lib/givingAudit";
import { recordPersonEmail } from "./lib/personEmails";

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

/** Assert the caller may rewire the org tree (admins only). */
async function requireCanSetManager(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (!(await isChapterAdmin(ctx, chapterId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only chapter admins can change who reports to whom.",
    });
  }
}

/**
 * Assert that making `managerId` the manager of `personId` keeps the org tree
 * acyclic: walk up the proposed manager's chain and throw if it passes through
 * the person (or the person IS the manager). Bounded so a corrupt chain can't
 * loop forever.
 */
async function assertNoManagerCycle(
  ctx: QueryCtx,
  personId: Id<"people">,
  managerId: Id<"people">,
): Promise<void> {
  let cur: Id<"people"> | undefined = managerId;
  for (let hops = 0; cur && hops < 100; hops++) {
    if (cur === personId) {
      throw new ConvexError({
        code: "MANAGER_CYCLE",
        message: "That would make someone their own manager (directly or through the chain).",
      });
    }
    const doc: Doc<"people"> | null = await ctx.db.get(cur);
    cur = doc?.managerId;
  }
}

/**
 * TRAINING-SANDBOX people scope. Pickers rendered inside an Academy training
 * event pass that event's id; when it really is a training event in the
 * caller's chapter, the roster collapses to the CALLER + PLACEHOLDER people
 * (the sandbox's sample bench) — never the real roster, so a learner can't
 * accidentally rope real teammates into a drill. Returns null for any
 * non-training event (normal scoping applies); enforced here server-side, not
 * in the picker UI.
 */
async function sandboxPeopleFilter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  eventId: Id<"events">,
): Promise<((p: Doc<"people">) => boolean) | null> {
  const event = await ctx.db.get(eventId);
  if (!event || event.chapterId !== chapterId || event.isTraining !== true) {
    return null;
  }
  const userId = await requireUserId(ctx);
  const mine = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
    .first();
  const meId = mine?.chapterId === chapterId ? mine._id : null;
  // THIS sandbox's own crew slots — placeholders engaged on this event. Other
  // events' placeholder stand-ins (real events', other learners' sandboxes')
  // must never surface here.
  const engaged = new Set(
    (
      await ctx.db
        .query("engagements")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
    ).map((e) => String(e.personId)),
  );
  return (p) =>
    (meId != null && p._id === meId) ||
    p.isSamplePerson === true ||
    (p.isPlaceholder === true && engaged.has(String(p._id)));
}

/** List the chapter roster sorted by name. In a training sandbox (`eventId`
 *  of a training event), lists only the caller + placeholder people.
 *
 * `contactsOnly` (person-centric audiences Phase 1 item 1) flips the default
 * roster-facing view: unset/false returns the ROSTER only (excludes
 * `isContactOnly` rows — the fix for the People tab default list, every
 * person picker/mention/duty-assignment surface, and the org-chart consumers
 * that all call this same query with `{}`), `true` returns ONLY contacts —
 * the People tab's deliberate "Contacts" persona filter, so a contact-only
 * row (auto-created from a donor gift, an import, or a public RSVP) is still
 * findable/editable, just never mixed into the default roster. */
export const list = query({
  args: {
    eventId: v.optional(v.id("events")),
    contactsOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { eventId, contactsOnly }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const sandbox = eventId
      ? await sandboxPeopleFilter(ctx, chapterId as Id<"chapters">, eventId)
      : null;
    // Placeholders are PER-EVENT materialized copies of a template's crew
    // (the reusable definitions live on the template as `templatePeople` and
    // are never touched here) — event-scoped stand-ins, not real roster
    // members, so keep them out of the People roster. Replacing one only
    // consumes that event's copy. Inside a training sandbox the rule flips:
    // placeholders (+ the caller) are the ONLY people offered — sandbox mode
    // ignores `contactsOnly` (a training drill never shows contacts).
    const sorted = people
      .filter(
        sandbox ??
          ((p) =>
            p.isPlaceholder !== true &&
            p.isSamplePerson !== true &&
            (contactsOnly === true
              ? p.isContactOnly === true
              : p.isContactOnly !== true)),
      )
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
 * Card-eligible people — the chapter roster filtered to those with a Public
 * Worship email (`@publicworship.life`, via `isCardEligible`). Feeds the card
 * pickers (issue a card, link a legacy card), which may only target eligible
 * people. Same read shape as `people.list` (the person row + a resolved
 * `imageUrl`); placeholders + sample people are excluded like the roster list.
 */
export const cardEligible = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const sorted = people
      .filter(
        (p) =>
          p.isPlaceholder !== true &&
          p.isSamplePerson !== true &&
          // Roster UX (card issuance is a team-member action) — see
          // `lib/org.ts#excludeContacts`'s doc. Belt-and-suspenders: a
          // contact-only row practically never carries a `pwEmail` anyway.
          p.isContactOnly !== true &&
          isCardEligible(p.pwEmail),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
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
 * member if explicitly flagged OR already linked to a user account. In a
 * training sandbox (`eventId` of a training event), returns the caller +
 * placeholder people instead — the sandbox's sample bench holds the roles.
 */
export const teamMembers = query({
  args: { eventId: v.optional(v.id("events")) },
  handler: async (ctx, { eventId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const sandbox = eventId
      ? await sandboxPeopleFilter(ctx, chapterId as Id<"chapters">, eventId)
      : null;
    // No explicit `isContactOnly` check needed: a contact-only row is always
    // written with `isTeamMember: false` and no `userId` (see
    // `lib/rsvpPeople.ts`/`lib/givingDonors.ts`), so it already fails the
    // `isTeamMember === true || userId != null` test below.
    return people
      .filter(
        sandbox ??
          ((p) =>
            p.isSamplePerson !== true &&
            (p.isTeamMember === true || p.userId != null)),
      )
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

/** How many person-audit breadcrumbs the detail renders (newest-first). */
const PERSON_AUDIT_READ_CAP = 100;

/**
 * A person's contact-edit audit trail (owner feedback #4), newest-first, with
 * the actor's display name resolved. Scoped to the caller's chapter via
 * `requireOwned`; bounded `by_person`.
 */
export const listPersonAudit = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    await requireOwned(ctx, "people", personId, "Person");
    const rows = await ctx.db
      .query("personAudit")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .order("desc")
      .take(PERSON_AUDIT_READ_CAP);
    const actorNames = new Map<string, string>();
    for (const id of new Set(rows.map((a) => a.actorUserId))) {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", id))
        .unique();
      actorNames.set(
        id,
        profile?.name ?? (await ctx.db.get(id))?.email ?? "Someone",
      );
    }
    return rows.map((a) => ({
      _id: a._id,
      at: a.at,
      changes: a.changes,
      note: a.note ?? null,
      actorName: actorNames.get(a.actorUserId) ?? "Someone",
    }));
  },
});

/** Add a person to the chapter roster. */
export const create = mutation({
  args: {
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    // `skills` is the legacy arg name (OTA-lagged clients still send it);
    // `services` is the Chapter-OS name. Either is accepted; the writer stores
    // the value in the new `services` field.
    skills: v.optional(v.array(v.string())),
    services: v.optional(v.array(v.string())),
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
    managerId: v.optional(v.id("people")),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireUserId(ctx);
    if (args.managerId) {
      await requireCanSetManager(ctx, chapterId as Id<"chapters">);
      await requireOwned(ctx, "people", args.managerId, "Manager");
    }
    const status = args.status ?? "active";
    const personId = await ctx.db.insert("people", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      email: args.email,
      phone: args.phone,
      // Writer targets the new `services` field only; the legacy `skills` arg
      // (OTA-lagged clients) is accepted but its value is stored in `services`.
      services: args.services ?? args.skills,
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
      managerId: args.managerId,
      createdAt: Date.now(),
    });
    // Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
    // write-through: a fresh roster row's own contact fields seed its
    // `personEmails` ledger immediately, same as every other automated
    // person-creation path (`linkDonorToPerson`/`linkRsvpToPerson`).
    if (args.email) {
      await recordPersonEmail(ctx, { personId, email: args.email, source: "roster", verified: true });
    }
    if (args.pwEmail) {
      await recordPersonEmail(ctx, { personId, email: args.pwEmail, source: "pw", verified: true });
    }
    return personId;
  },
});

/** Update a person's profile fields. */
export const update = mutation({
  args: {
    personId: v.id("people"),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    // Either arg accepted; the writer stores it in the new `services` field.
    skills: v.optional(v.union(v.array(v.string()), v.null())),
    services: v.optional(v.union(v.array(v.string()), v.null())),
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
    managerId: v.optional(v.union(v.id("people"), v.null())),
    // Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
    // the person-level marketing opt-out, layered over `emailSuppressions`.
    marketingOptOut: v.optional(v.boolean()),
    // Owner feedback #4: optional "why", recorded on the person-audit breadcrumb
    // when a contact field (name/email/phone) changes.
    why: v.optional(v.string()),
  },
  handler: async (ctx, { personId, why, ...patch }) => {
    const person = await requireOwned(ctx, "people", personId, "Person");
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;
    if (patch.managerId !== undefined) {
      // Setting AND clearing a manager both reshape the org tree — admin only.
      await requireCanSetManager(ctx, person.chapterId);
    }
    if (patch.managerId != null) {
      await requireOwned(ctx, "people", patch.managerId, "Manager");
      await assertNoManagerCycle(ctx, personId, patch.managerId);
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    // Services rename: the writer targets the new `services` field. Accept the
    // legacy `skills` arg (OTA-lagged clients) but never write the legacy field.
    if (patch.services !== undefined || patch.skills !== undefined) {
      const val = patch.services !== undefined ? patch.services : patch.skills;
      fields.services = val === null ? undefined : val;
      delete fields.skills;
    }
    // Person lifecycle lives on `status` only now; the legacy `isActive` flag is
    // no longer written (accept the arg from OTA-lagged clients, then drop it).
    delete fields.isActive;
    await ctx.db.patch(personId, fields);

    // Person-centric audiences Phase 2 — write-through: a changed `email`/
    // `pwEmail` value (a real string) seeds/upgrades the `personEmails`
    // ledger. `pwEmail` can be explicitly cleared (`null`, this arg's own
    // union validator) — that's NOT treated as "forget this address" either:
    // the ledger keeps every address ever seen, so a cleared roster field
    // doesn't silently drop known provenance.
    if (typeof fields.email === "string" && fields.email) {
      await recordPersonEmail(ctx, { personId, email: fields.email, source: "roster", verified: true });
    }
    if (typeof fields.pwEmail === "string" && fields.pwEmail) {
      await recordPersonEmail(ctx, { personId, email: fields.pwEmail, source: "pw", verified: true });
    }

    // Owner feedback #4: narrate a name/email/phone change on the person audit
    // trail (cheap, additive — only the three contact fields, mirroring the
    // donor audit). `fields` holds the resolved values the patch actually wrote.
    const contactAfter = (key: "name" | "email" | "phone"): string | undefined =>
      key in fields ? (fields[key] as string | undefined) : (person as any)[key];
    const contactChanges = diffFields(
      { name: "Name", email: "Email", phone: "Phone" },
      { name: person.name, email: person.email, phone: person.phone },
      {
        name: contactAfter("name"),
        email: contactAfter("email"),
        phone: contactAfter("phone"),
      },
    );
    if (contactChanges.length > 0) {
      await writePersonAudit(ctx, {
        personId,
        chapterId: person.chapterId,
        actorUserId,
        changes: contactChanges,
        note: why,
      });
    }
    return personId;
  },
});

/** Remove a person from the roster, plus their event engagements. */
export const remove = mutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const person = await requireOwned(ctx, "people", personId, "Person");
    // Removing someone WITH reports rewires the org tree (their reports get a
    // new manager) — that's the admin-only operation, same as the Manager cell.
    const reports = await ctx.db
      .query("people")
      .withIndex("by_manager", (q) => q.eq("managerId", personId))
      .collect();
    if (reports.length > 0) {
      await requireCanSetManager(ctx, person.chapterId);
    }
    const engagements = await ctx.db
      .query("engagements")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    for (const e of engagements) await ctx.db.delete(e._id);
    // Re-point direct reports at the removed person's own manager (or none) so
    // the org tree closes over the gap instead of stranding a subtree.
    for (const r of reports) {
      await ctx.db.patch(r._id, { managerId: person.managerId });
    }
    // Their projects roll up to their manager (so the work stays visible in
    // that manager's Team view); with no manager they go unowned, surfacing in
    // the admin-only "Unassigned" triage section.
    const owned = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerPersonId", personId))
      .collect();
    for (const p of owned) {
      await ctx.db.patch(p._id, {
        ownerPersonId: person.managerId,
        updatedAt: Date.now(),
      });
    }
    // Strip them from direct responsibility assignments (no dangling '?' chips)
    // and delete the 1:1 record about them — it's unreachable once they're gone.
    const duties = await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) => q.eq("chapterId", person.chapterId))
      .collect();
    for (const d of duties) {
      if (!d.assigneePersonIds?.includes(personId)) continue;
      const remaining = d.assigneePersonIds.filter((id) => id !== personId);
      await ctx.db.patch(d._id, {
        assigneePersonIds: remaining.length > 0 ? remaining : undefined,
        updatedAt: Date.now(),
      });
    }
    const theirCheckIns = await ctx.db
      .query("checkIns")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    for (const c of theirCheckIns) await ctx.db.delete(c._id);
    await ctx.db.delete(personId);
    return personId;
  },
});
