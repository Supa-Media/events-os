/**
 * People-roster ↔ user-account coupling helpers.
 *
 * Backend access is gated to @publicworship.life accounts (see lib/access.ts),
 * so a signed-in user's email is ALWAYS their publicworship address. A roster
 * person, however, may carry a personal email on `email` and the publicworship
 * address on `pwEmail` (core team are imported that way). To keep User and
 * People tightly coupled — one person row per human, claimed via `userId` — any
 * place that links an account to the roster must match on EITHER address before
 * inserting a fresh row, or it will silently duplicate the person on first
 * sign-in / first event creation.
 *
 * Matching on write isn't enough on its own: a person could have been imported
 * twice, or imported after they'd already self-created a row, leaving two (or
 * more) roster rows for one human. Their events/projects/duties end up split
 * across those rows, so when they sign in and land on the row linked to their
 * account they see only part of "their tasks". `reconcilePersonForUser` fixes
 * that at login — it gathers every row that belongs to the account, merges the
 * extras into a single survivor (re-pointing every reference first so nothing
 * is orphaned), and claims that survivor.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Find a roster person in `chapterId` not yet linked to a user account whose
 * personal `email` OR publicworship `pwEmail` matches `email` (case-insensitive).
 * Returns the person doc, or null when there's no unlinked match.
 */
export async function findUnlinkedPersonByLoginEmail(
  ctx: any,
  chapterId: string,
  email?: string | null,
): Promise<any | null> {
  const target = email?.trim().toLowerCase();
  if (!target) return null;
  const roster = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
    .collect();
  return (
    roster.find(
      (p: any) =>
        p.userId == null &&
        (p.email?.trim().toLowerCase() === target ||
          p.pwEmail?.trim().toLowerCase() === target),
    ) ?? null
  );
}

/**
 * Fields to claim an unlinked roster row for `userId` on sign-in. Records the
 * publicworship login address as `pwEmail` (the canonical backend identity) and
 * only fills the personal `email` when the row has none — never clobbering an
 * existing personal address with the login email.
 */
export function claimFields(
  existing: { email?: string; pwEmail?: string },
  userId: string,
  loginEmail?: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { userId, isTeamMember: true };
  const login = loginEmail?.trim() || undefined;
  if (login) {
    fields.pwEmail = existing.pwEmail ?? login;
    if (!existing.email) fields.email = login;
  }
  return fields;
}

/**
 * Every roster row in `chapterId` that belongs to the human behind `userId`:
 * rows already linked to this account, plus UNLINKED rows whose personal `email`
 * or publicworship `pwEmail` matches the login `email` (case-insensitive). Rows
 * linked to a DIFFERENT account are never included — they're a different human
 * who happens to share an address, and must not be merged away.
 */
export async function collectPersonRowsForUser(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  email?: string | null,
): Promise<Doc<"people">[]> {
  const target = email?.trim().toLowerCase();
  const roster = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  return roster.filter(
    (p) =>
      p.userId === userId ||
      (p.userId == null &&
        !!target &&
        (p.email?.trim().toLowerCase() === target ||
          p.pwEmail?.trim().toLowerCase() === target)),
  );
}

/**
 * Re-point every reference to person `fromId` onto `toId`, across every table
 * that stores a `people` id. Called by `mergePersonInto` before the duplicate
 * row is deleted, so no event owner, project, duty, role assignment, check-in,
 * doc, song, comment, or org-chart edge is left dangling.
 *
 * Tables with a by-person index are re-pointed directly; the rest are swept
 * per-chapter (bounded, and only ever runs when a real duplicate was found).
 */
export async function repointPersonReferences(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  fromId: Id<"people">,
  toId: Id<"people">,
): Promise<void> {
  // ── Indexed by person — cheap, direct re-points. ──
  // Both duplicates may have been engaged on the SAME event (the import-twice
  // case this feature targets), so don't blindly re-point: if the survivor is
  // already engaged of that type on that event, drop the duplicate's row rather
  // than create a second engagement (double-counted volunteer / budget history).
  const engagements = await ctx.db
    .query("engagements")
    .withIndex("by_person", (q) => q.eq("personId", fromId))
    .collect();
  for (const e of engagements) {
    const sameEvent = await ctx.db
      .query("engagements")
      .withIndex("by_event_type", (q) =>
        q.eq("eventId", e.eventId).eq("type", e.type),
      )
      .collect();
    if (sameEvent.some((x) => x.personId === toId)) await ctx.db.delete(e._id);
    else await ctx.db.patch(e._id, { personId: toId });
  }

  // Same for role assignments — one row per (event, role, person). Collapse a
  // clash instead of duplicating the survivor on the same event role.
  const assignments = await ctx.db
    .query("roleAssignments")
    .withIndex("by_person", (q) => q.eq("personId", fromId))
    .collect();
  for (const a of assignments) {
    const sameRole = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q) =>
        q.eq("eventId", a.eventId).eq("roleId", a.roleId),
      )
      .collect();
    if (sameRole.some((x) => x.personId === toId)) await ctx.db.delete(a._id);
    else await ctx.db.patch(a._id, { personId: toId });
  }

  const ownedProjects = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerPersonId", fromId))
    .collect();
  for (const p of ownedProjects) {
    // Bump updatedAt so updatedAt-ordered project views reflect the new owner
    // (matches how people.remove re-assigns ownership).
    await ctx.db.patch(p._id, { ownerPersonId: toId, updatedAt: Date.now() });
  }

  // Email-action tokens are keyed (project, person). Reminders mint them for a
  // project's EFFECTIVE owner — which, for an unowned sub-project, is an owned
  // ANCESTOR's person — so a token can reference someone on a project they don't
  // directly own. There's no by-person index, but a full scan is fine here:
  // tokens are low-volume (reused per send, purged daily) and a merge only runs
  // when duplicates exist. Collapse onto any token the survivor already holds
  // for that project rather than leaving two rows for one (project, person).
  const tokens = await ctx.db.query("projectEmailTokens").collect();
  for (const tk of tokens) {
    if (tk.personId !== fromId) continue;
    const survivorToken = await ctx.db
      .query("projectEmailTokens")
      .withIndex("by_project_and_person", (q) =>
        q.eq("projectId", tk.projectId).eq("personId", toId),
      )
      .first();
    if (survivorToken) await ctx.db.delete(tk._id);
    else await ctx.db.patch(tk._id, { personId: toId });
  }

  // Reports that pointed at the duplicate as their manager move to the survivor.
  // Guard the one case that would create a self-loop: if the SURVIVOR reported
  // to the duplicate, it inherits the duplicate's manager instead of itself.
  const reports = await ctx.db
    .query("people")
    .withIndex("by_manager", (q) => q.eq("managerId", fromId))
    .collect();
  for (const r of reports) {
    if (r._id === toId) {
      const dup = await ctx.db.get(fromId);
      const inherited =
        dup?.managerId && dup.managerId !== toId ? dup.managerId : undefined;
      await ctx.db.patch(toId, { managerId: inherited });
    } else {
      await ctx.db.patch(r._id, { managerId: toId });
    }
  }

  // ── Per-chapter sweeps (no by-person index on these tables). ──
  const checkIns = await ctx.db
    .query("checkIns")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const c of checkIns) {
    const patch: Partial<Doc<"checkIns">> = {};
    if (c.personId === fromId) patch.personId = toId;
    if (c.managerPersonId === fromId) patch.managerPersonId = toId;
    if (Object.keys(patch).length) await ctx.db.patch(c._id, patch);
  }

  const duties = await ctx.db
    .query("responsibilities")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const d of duties) {
    if (!d.assigneePersonIds?.includes(fromId)) continue;
    const next = Array.from(
      new Set(d.assigneePersonIds.map((id) => (id === fromId ? toId : id))),
    );
    await ctx.db.patch(d._id, { assigneePersonIds: next });
  }

  const docs = await ctx.db
    .query("docs")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const doc of docs) {
    if (doc.createdBy === fromId) await ctx.db.patch(doc._id, { createdBy: toId });
  }

  const songs = await ctx.db
    .query("songs")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const s of songs) {
    if (s.createdBy === fromId) await ctx.db.patch(s._id, { createdBy: toId });
  }

  const events = await ctx.db
    .query("events")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const ev of events) {
    const patch: Partial<Doc<"events">> = {};
    if (ev.ownerPersonId === fromId) patch.ownerPersonId = toId;
    if (ev.moduleReadiness?.some((m) => m.markedBy === fromId)) {
      patch.moduleReadiness = ev.moduleReadiness.map((m) =>
        m.markedBy === fromId ? { ...m, markedBy: toId } : m,
      );
    }
    if (Object.keys(patch).length) await ctx.db.patch(ev._id, patch);
  }

  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const it of items) {
    if (it.ownerPersonId === fromId)
      await ctx.db.patch(it._id, { ownerPersonId: toId });
  }

  const comments = await ctx.db
    .query("projectComments")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  for (const c of comments) {
    if (c.authorPersonId === fromId)
      await ctx.db.patch(c._id, { authorPersonId: toId });
  }
}

// Default name a fresh linked row gets before a profile name is known. Treated
// as "no real name yet" so a duplicate's real name wins over it on merge.
export const PLACEHOLDER_PERSON_NAME = "Team member";

// Roster fields carried from a duplicate onto the survivor when the survivor is
// missing them, so merging never loses contact/profile data. Scalars and list
// fields alike fill only when the survivor's is absent/empty — never overwriting
// existing data, and never blending two ordered lists (e.g. commsPreferences is
// a documented priority order, so a set-union would corrupt it). `userId`/status
// are decided by the caller (claimFields + the account's profile); `name` is
// handled specially below.
const CARRY_SCALAR: (keyof Doc<"people">)[] = [
  "email",
  "pwEmail",
  "phone",
  "image",
  "role",
  "gender",
  "company",
  "usualRateUsd",
  "socialLink",
  "notes",
  "pocName",
  "vettingStatus",
];
const CARRY_ARRAY: (keyof Doc<"people">)[] = [
  "services",
  "projects",
  "commsPreferences",
];

/**
 * Fold `duplicateId` into `survivorId`: backfill any roster field the survivor
 * lacks, re-point every reference (`repointPersonReferences`), then delete the
 * duplicate. No-op if the two ids are the same or either row is gone.
 */
export async function mergePersonInto(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  survivorId: Id<"people">,
  duplicateId: Id<"people">,
): Promise<void> {
  if (survivorId === duplicateId) return;
  const survivor = await ctx.db.get(survivorId);
  const dup = await ctx.db.get(duplicateId);
  if (!survivor || !dup) return;

  const patch: Record<string, unknown> = {};
  for (const f of CARRY_SCALAR) {
    if (survivor[f] == null && dup[f] != null) patch[f] = dup[f];
  }
  for (const f of CARRY_ARRAY) {
    const current = (survivor[f] as unknown[] | undefined) ?? [];
    const dupValue = (dup[f] as unknown[] | undefined) ?? [];
    if (current.length === 0 && dupValue.length > 0) patch[f] = dupValue;
  }
  // Adopt the duplicate's real name when the survivor only has the placeholder
  // (e.g. a bare row auto-created on an earlier login), so a real name imported
  // on the duplicate isn't lost when it's deleted.
  const survivorHasRealName =
    !!survivor.name && survivor.name !== PLACEHOLDER_PERSON_NAME;
  if (
    !survivorHasRealName &&
    dup.name &&
    dup.name !== PLACEHOLDER_PERSON_NAME
  ) {
    patch.name = dup.name;
  }
  if (dup.isTeamMember && !survivor.isTeamMember) patch.isTeamMember = true;
  if (Object.keys(patch).length) await ctx.db.patch(survivorId, patch);

  await repointPersonReferences(ctx, chapterId, duplicateId, survivorId);
  await ctx.db.delete(duplicateId);
}

/**
 * The login-time reconciler. Ensures the account behind `userId` maps to exactly
 * ONE roster row in `chapterId`:
 *   - no matching row  → insert a fresh linked team-member row;
 *   - one matching row → claim it;
 *   - several          → pick a survivor (the row already linked to this account
 *     if any, else the oldest match), merge the rest into it, then claim it.
 * Returns the surviving person's id. `fields` carries the account's profile so
 * name/phone stay in sync and the login email is recorded as `pwEmail`.
 */
export async function reconcilePersonForUser(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  fields: { name?: string; email?: string | null; phone?: string | null },
): Promise<Id<"people">> {
  const candidates = await collectPersonRowsForUser(ctx, chapterId, userId, fields.email);

  if (candidates.length === 0) {
    const loginEmail = fields.email ?? undefined;
    return await ctx.db.insert("people", {
      chapterId,
      userId,
      name: fields.name ?? PLACEHOLDER_PERSON_NAME,
      email: loginEmail,
      pwEmail: loginEmail,
      phone: fields.phone ?? undefined,
      isTeamMember: true,
      // Person lifecycle lives on `status` only now (legacy `isActive` retired).
      status: "active",
      createdAt: Date.now(),
    });
  }

  // `by_chapter` returns rows in _creationTime order, so `[0]` is the oldest —
  // a deterministic survivor when none is linked to this account yet.
  const survivor = candidates.find((p) => p.userId === userId) ?? candidates[0];
  for (const dup of candidates) {
    if (dup._id !== survivor._id) {
      await mergePersonInto(ctx, chapterId, survivor._id, dup._id);
    }
  }

  // Re-read: merges may have backfilled email/pwEmail we want claimFields to see.
  const fresh = (await ctx.db.get(survivor._id)) ?? survivor;
  const desired: Record<string, unknown> = {
    chapterId,
    // A user actively signing in is active — don't leave them hidden because the
    // row we claimed was an imported-inactive contact. Lifecycle lives on
    // `status` only now (legacy `isActive` retired).
    ...(fresh.status === "inactive" ? { status: "active" as const } : null),
    ...claimFields(fresh, userId, fields.email),
    ...(fields.name !== undefined ? { name: fields.name } : null),
    ...(fields.phone != null ? { phone: fields.phone } : null),
  };
  // Write only what actually changes, so a routine login (already linked, nothing
  // new) doesn't churn a fresh document version on every app open.
  const patch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(desired)) {
    if ((fresh as Record<string, unknown>)[k] !== val) patch[k] = val;
  }
  if (Object.keys(patch).length) await ctx.db.patch(survivor._id, patch);
  return survivor._id;
}
