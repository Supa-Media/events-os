/**
 * Specialized roles — super-admin-managed leadership + finance TITLES at the org
 * (`"central"`) or a chapter level, with scope-local separation of duties.
 *
 * A title carries a fixed KIND (leadership: executive_director / president;
 * finance: finance_manager) and a valid-scope constraint (ED central-only,
 * president chapter-only, finance_manager either). One holder per (scope, title)
 * SLOT; assigning a filled slot replaces the holder. Within a SINGLE scope a
 * person may not hold both a leadership AND a finance title (SoD) — across scopes
 * it's unrestricted. Assigning a `finance_manager` title additionally BRIDGES to
 * a `financeRoles` `manager` grant (so the title confers finance-write
 * capability); removing it revokes that grant.
 *
 * All four functions are SUPER-ADMIN gated (`requireSuperuser`) — super-admins
 * govern these, NOT finance managers. Leadership titles (ED/president) are used
 * for oversight + the SoD constraint; they do NOT themselves grant finance write
 * capability (only the finance bridge does). Superusers remain implicit central
 * finance managers.
 *
 * // TODO: wire president/ED into approval flows (leadership oversight over
 * // reimbursement/payout approvals) — out of scope for this backend phase.
 */
import { query, mutation, type MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  SPECIALIZED_ROLE_TITLES,
  SPECIALIZED_ROLE_KINDS,
  specializedRoleLabel,
  titleKind,
  titleAllowsScope,
  type SpecializedRoleKind,
  type SpecializedRoleTitle,
} from "@events-os/shared";
import { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireSuperuser } from "./lib/superuser";
import {
  bridgeFinanceManagerGrant,
  revokeBridgedFinanceManagerGrant,
  type FinanceScope,
} from "./lib/finance";

const titleValidator = v.union(...SPECIALIZED_ROLE_TITLES.map((t) => v.literal(t)));
const kindValidator = v.union(...SPECIALIZED_ROLE_KINDS.map((k) => v.literal(k)));
const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

/** The other kind — the one a person must NOT already hold in this scope (SoD). */
function otherKind(kind: SpecializedRoleKind): SpecializedRoleKind {
  return kind === "leadership" ? "finance" : "leadership";
}

/**
 * Shared implementation behind `assignSpecializedRole` AND the org-chart seats
 * write-through bridge (`seats.assignSeat`, for a seat with a `legacyTitle`).
 * Both entry points are super-admin gated by their CALLERS before reaching
 * here — this helper itself does no auth check, so it must never be exposed
 * directly as a public mutation. `userId` is the caller, recorded as
 * `createdBy`. Enforces scope-validity, the scope-local SoD constraint,
 * one-holder-per-slot (replacing the incumbent), and the finance bridge for
 * finance titles — unchanged from the original `assignSpecializedRole` body.
 */
export async function assignSpecializedRoleImpl(
  ctx: MutationCtx,
  userId: Id<"users">,
  { personId, scope, title }: { personId: Id<"people">; scope: Id<"chapters"> | "central"; title: SpecializedRoleTitle },
): Promise<Id<"specializedRoles">> {
  const scopeIsCentral = scope === "central";

  // 1. Scope-validity: ED → central only, president → chapter only,
  //    finance_manager → either.
  if (!titleAllowsScope(title, scopeIsCentral)) {
    throw new ConvexError({
      code: "INVALID_SCOPE",
      message: `The ${specializedRoleLabel(title, scopeIsCentral)} role can't be assigned at ${
        scopeIsCentral ? "the org (central) level" : "a chapter"
      }.`,
    });
  }

  // 2. Scope + person must exist. A real chapter scope must be a real chapter;
  //    the person must be a real roster person. NOTE: specialized roles are
  //    org-oversight roles a super-admin may grant across chapters, so we do
  //    NOT require the person to belong to the scope chapter — that keeps the
  //    cross-scope SoD carve-out (president@A + finance_manager@B) reachable.
  if (!scopeIsCentral) {
    const chapter = await ctx.db.get(scope as Id<"chapters">);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That chapter doesn't exist." });
    }
  }
  const person = await ctx.db.get(personId);
  if (!person) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That person doesn't exist." });
  }

  const kind = titleKind(title);

  // 3. Separation of duties (scope-local): the target person can't already hold
  //    a role of the OTHER kind in THIS scope.
  const otherKindRows = await ctx.db
    .query("specializedRoles")
    .withIndex("by_scope_and_kind", (q) =>
      q.eq("scope", scope).eq("roleKind", otherKind(kind)),
    )
    .collect();
  if (otherKindRows.some((r) => r.personId === personId)) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message:
        "Separation of duties: one person can't hold both a leadership and a finance role in the same scope.",
    });
  }

  // 4. Slot: one holder per (scope, title). If already filled by a DIFFERENT
  //    person, remove the incumbent (+ unbridge if it was a finance title).
  const slotRows = await ctx.db
    .query("specializedRoles")
    .withIndex("by_scope_and_title", (q) =>
      q.eq("scope", scope).eq("title", title),
    )
    .collect();
  const sameHolder = slotRows.find((r) => r.personId === personId);
  if (sameHolder) {
    // Idempotent: the person already holds this exact slot. Re-affirm the
    // finance bridge (in case a prior grant was revoked) and return.
    if (kind === "finance") {
      await bridgeFinanceManagerGrant(ctx, scope as FinanceScope, personId);
    }
    return sameHolder._id;
  }
  for (const incumbent of slotRows) {
    await ctx.db.delete(incumbent._id);
    if (incumbent.roleKind === "finance") {
      await unbridgeIfNoOtherFinanceRole(ctx, scope, incumbent.personId, incumbent._id);
    }
  }

  // 5. Insert the new assignment.
  const roleId = await ctx.db.insert("specializedRoles", {
    personId,
    scope,
    title,
    roleKind: kind,
    createdBy: userId,
    createdAt: Date.now(),
  });

  // 6. Finance bridge: a finance title confers a `financeRoles` manager grant.
  if (kind === "finance") {
    await bridgeFinanceManagerGrant(ctx, scope as FinanceScope, personId);
  }

  return roleId;
}

/**
 * Assign a specialized role. Super-admin only. Enforces scope-validity, the
 * scope-local SoD constraint, one-holder-per-slot (replacing the incumbent), and
 * the finance bridge for finance titles.
 */
export const assignSpecializedRole = mutation({
  args: {
    personId: v.id("people"),
    scope: scopeValidator,
    title: titleValidator,
  },
  returns: v.id("specializedRoles"),
  handler: async (ctx, { personId, scope, title }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await assignSpecializedRoleImpl(ctx, userId, { personId, scope, title });
  },
});

/**
 * Shared implementation behind `removeSpecializedRole` AND the org-chart seats
 * write-through bridge (`seats.unassignSeat`). No auth check — callers gate.
 * If the role was a finance title, revokes the bridged `financeRoles` grant
 * unless the person still holds another finance specialized role at the same
 * scope that should keep it alive.
 */
export async function removeSpecializedRoleImpl(
  ctx: MutationCtx,
  roleId: Id<"specializedRoles">,
): Promise<void> {
  const row = await ctx.db.get(roleId);
  if (!row) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That role assignment doesn't exist." });
  }

  await ctx.db.delete(roleId);

  if (row.roleKind === "finance") {
    await unbridgeIfNoOtherFinanceRole(ctx, row.scope, row.personId, roleId);
  }
}

/**
 * Remove a specialized role. Super-admin only. If it was a finance title, revoke
 * the bridged `financeRoles` grant — unless the person still holds another
 * finance specialized role at the same scope that should keep it alive.
 */
export const removeSpecializedRole = mutation({
  args: { roleId: v.id("specializedRoles") },
  returns: v.null(),
  handler: async (ctx, { roleId }) => {
    await requireSuperuser(ctx);
    await removeSpecializedRoleImpl(ctx, roleId);
    return null;
  },
});

/**
 * Revoke the bridged finance grant for (scope, person) UNLESS the person still
 * holds another finance specialized role at that scope (excluding `excludeId`,
 * the row just removed). Slots are unique per (scope, title) and finance_manager
 * is the only finance title, so in practice no other row survives — this guard
 * keeps the bridge correct if that ever changes.
 */
async function unbridgeIfNoOtherFinanceRole(
  ctx: MutationCtx,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
  excludeId: Id<"specializedRoles">,
): Promise<void> {
  const financeRows = await ctx.db
    .query("specializedRoles")
    .withIndex("by_scope_and_kind", (q) =>
      q.eq("scope", scope).eq("roleKind", "finance"),
    )
    .collect();
  const stillHolds = financeRows.some(
    (r) => r._id !== excludeId && r.personId === personId,
  );
  if (!stillHolds) {
    await revokeBridgedFinanceManagerGrant(ctx, scope as FinanceScope, personId);
  }
}

/**
 * List specialized roles, enriched with person name/avatar + title label — the
 * governance page + slot view. Optionally narrowed to one scope. Bounded read.
 */
export const listSpecializedRoles = query({
  args: { scope: v.optional(scopeValidator) },
  returns: v.array(
    v.object({
      id: v.id("specializedRoles"),
      personId: v.id("people"),
      personName: v.string(),
      personImageUrl: v.union(v.string(), v.null()),
      scope: scopeValidator,
      title: titleValidator,
      roleKind: kindValidator,
      label: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { scope }) => {
    await requireSuperuser(ctx);

    const rows =
      scope !== undefined
        ? await ctx.db
            .query("specializedRoles")
            .withIndex("by_scope", (q) => q.eq("scope", scope))
            .take(500)
        : await ctx.db.query("specializedRoles").take(500);

    return await Promise.all(
      rows.map(async (r) => {
        const person = await ctx.db.get(r.personId);
        return {
          id: r._id,
          personId: r.personId,
          personName: person?.name ?? "(unknown)",
          personImageUrl:
            person?.image != null ? await ctx.storage.getUrl(person.image) : null,
          scope: r.scope,
          title: r.title,
          roleKind: r.roleKind,
          label: specializedRoleLabel(r.title, r.scope === "central"),
          createdAt: r.createdAt,
        };
      }),
    );
  },
});

/**
 * A person's specialized roles — the read-only People-profile mirror. Super-admin
 * gated (edits route through the governance assignment mutations).
 */
export const personSpecializedRoles = query({
  args: { personId: v.id("people") },
  returns: v.array(
    v.object({
      id: v.id("specializedRoles"),
      scope: scopeValidator,
      title: titleValidator,
      roleKind: kindValidator,
      label: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { personId }) => {
    await requireSuperuser(ctx);
    const rows = await ctx.db
      .query("specializedRoles")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(200);
    return rows.map((r) => ({
      id: r._id,
      scope: r.scope,
      title: r.title,
      roleKind: r.roleKind,
      label: specializedRoleLabel(r.title, r.scope === "central"),
      createdAt: r.createdAt,
    }));
  },
});
