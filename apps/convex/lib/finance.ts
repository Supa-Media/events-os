/**
 * Finance authorization for Chapter OS.
 *
 * The graded finance-role ladder (viewer < bookkeeper < manager) plus a
 * central/org tier, mirroring `lib/superuser.ts` + `lib/org.ts`. Every
 * finance function resolves the caller through `people` (the finance-actor
 * convention) and gates on their `financeRoles` grant.
 *
 *  - Superusers are implicitly CENTRAL managers (the bootstrap path — they seed
 *    the first grants). Everyone else needs an explicit `financeRoles` row; a
 *    chapter admin is NOT automatically a finance manager, which keeps
 *    separation of duties meaningful.
 *  - A `scope: "central"` grant layers org-wide roll-up reach on top of the
 *    chapter ladder.
 *  - Separation of duties (approver ≠ requester) is a pure assertion the
 *    reimbursement/payout flows call before recording an approval.
 *
 * All checks throw `ConvexError` (never a plain `Error`) so the app's
 * AuthErrorBoundary can surface them instead of dead-ending in the root
 * error boundary.
 */
import { ConvexError } from "convex/values";
import {
  FINANCE_ROLE_RANK,
  FINANCE_ROLE_LABELS,
  financeRoleAtLeast,
  accountIsSandbox,
  type FinanceRole,
  type FinanceRoleScope,
} from "@events-os/shared";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { viewerPerson } from "./org";
import { requireUserId } from "./context";

// A generous bound on a single chapter's funds (they number in the single
// digits post-WP-1.4; this mirrors the scan limits used elsewhere in finance).
const FUND_SCAN_LIMIT = 5000;

/**
 * The chapter's default operating fund for auto-coding: the unrestricted
 * "General Fund" by name, else the lowest-sortOrder UNRESTRICTED fund, else
 * `null`. Never falls back to a restricted fund — spend is never silently
 * defaulted into an earmarked bucket. Lives here (rather than in `finances.ts`)
 * so both `finances.ts` and `increase.ts`/`stripeFinance.ts` can silently
 * default a transaction/budget's fund without a cross-file import cycle
 * (funds are backend-only post-WP-1.4 — every creation path resolves this
 * instead of requiring a client-supplied fundId).
 *
 * Accepts a `FinanceScope`: the org level (`"central"`) has NO funds (funds are
 * chapter-scoped), so it short-circuits to `null` — a central-owned txn/budget
 * stays fund-less (WP-2.1), never inheriting a chapter's General Fund.
 */
export async function defaultFundId(
  ctx: QueryCtx,
  chapterId: FinanceScope,
): Promise<Id<"funds"> | null> {
  if (chapterId === "central") return null;
  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(FUND_SCAN_LIMIT);
  const unrestricted = funds
    .filter((f) => f.restriction === "unrestricted")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (unrestricted.length === 0) return null;
  return (unrestricted.find((f) => f.name === "General Fund") ?? unrestricted[0])._id;
}

/**
 * The account's owning scope for a given environment, or null. A scope (a real
 * chapter, or `"central"` — WP-1.2) may hold up to two rows (one sandbox, one
 * production); every finance view/action selects the row whose environment
 * matches the current `sandboxMode` via this helper — NEVER `.first()`, which
 * would pick an arbitrary row once both exist. The off-mode row is left
 * untouched.
 */
export async function getChapterAccountForMode(
  ctx: QueryCtx,
  chapterId: FinanceScope,
  sandboxMode: boolean,
): Promise<Doc<"increaseAccounts"> | null> {
  const rows = await ctx.db
    .query("increaseAccounts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  return rows.find((a) => accountIsSandbox(a) === sandboxMode) ?? null;
}

/** The caller's resolved finance capability in a chapter. */
export interface FinanceAccess {
  /** The caller's roster person id, or null (superuser without a roster row). */
  personId: Id<"people"> | null;
  /** Their effective graded role, or null when ungranted. */
  role: FinanceRole | null;
  /** The scope of the winning grant (`central` outranks `chapter`). */
  scope: FinanceRoleScope | null;
  /** Convenience: `role === "manager"`. */
  isManager: boolean;
  /** They hold a central/org-wide grant (or are a superuser). */
  isCentral: boolean;
}

/**
 * The caller's roster person id in this chapter, or throw. Finance actors are
 * `people`, so most finance writes start here.
 */
export async function resolveCallerPersonId(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"people">> {
  const person = await viewerPerson(ctx, chapterId);
  if (!person) {
    throw new ConvexError({
      code: "NO_PERSON",
      message: "You don't have a roster profile in this chapter yet.",
    });
  }
  return person._id;
}

/**
 * Resolve the caller's finance capability. Superusers short-circuit to central
 * manager; otherwise the effective role is the highest-ranked of their
 * chapter-scoped and central-scoped `financeRoles` grants.
 */
export async function getFinanceRole(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  if (await isSuperuser(ctx)) {
    const self = await viewerPerson(ctx, chapterId);
    return {
      personId: self?._id ?? null,
      role: "manager",
      scope: "central",
      isManager: true,
      isCentral: true,
    };
  }

  const person = await viewerPerson(ctx, chapterId);
  if (!person) {
    return {
      personId: null,
      role: null,
      scope: null,
      isManager: false,
      isCentral: false,
    };
  }

  const grants = await ctx.db
    .query("financeRoles")
    .withIndex("by_person", (q) => q.eq("personId", person._id))
    .collect();

  // Applicable grants = this chapter's grants + any central (org-wide) grant.
  // Effective role is the STRONGEST across all of them, not the first-created —
  // otherwise an apparent downgrade (a later, weaker re-grant) would silently
  // leave the earlier, stronger role in force. `grantFinanceRole` upserts, so in
  // practice there's one row per (chapter, person); this stays correct even if a
  // stray duplicate exists.
  const applicable = grants.filter(
    (g) => g.chapterId === chapterId || g.scope === "central",
  );
  const isCentral = applicable.some((g) => g.scope === "central");
  let role: FinanceRole | null = null;
  for (const g of applicable) {
    if (role == null || FINANCE_ROLE_RANK[g.role] > FINANCE_ROLE_RANK[role]) {
      role = g.role;
    }
  }

  return {
    personId: person._id,
    role,
    scope: isCentral ? "central" : role != null ? "chapter" : null,
    isManager: role === "manager",
    isCentral,
  };
}

/**
 * Assert the caller holds at least the `min` finance role, returning their
 * resolved access. The single gate every read/write function calls.
 */
export async function requireFinanceRole(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  min: FinanceRole,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, chapterId);
  if (!financeRoleAtLeast(access.role, min)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
    });
  }
  return access;
}

/** Assert the caller is a finance manager (the write/approve gate). */
export async function requireFinanceManager(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  return requireFinanceRole(ctx, chapterId, "manager");
}

/** Assert the caller has central/org-wide finance reach (the roll-up gate). */
export async function requireFinanceCentral(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, chapterId);
  if (!access.isCentral) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "This action needs central (org-wide) finance access.",
    });
  }
  return access;
}

/**
 * Assert the caller has central reach AND at least the `min` graded role — the
 * gate for a central-scoped MONEY WRITE (WP-4.1's skim). `requireFinanceCentral`
 * alone lets a central *viewer* through (it only checks org reach); recording a
 * transfer is a write, so it needs bookkeeper+ too, mirroring the
 * `createManualTransaction` central path's bookkeeper gate (#151).
 */
export async function requireCentralFinanceRole(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  min: FinanceRole,
): Promise<FinanceAccess> {
  const access = await getFinanceRole(ctx, chapterId);
  if (!access.isCentral || !financeRoleAtLeast(access.role, min)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: `This action needs central finance access at the ${FINANCE_ROLE_LABELS[min]} level or higher.`,
    });
  }
  return access;
}

/**
 * A finance scope: a real chapter, or the org level (`"central"` sentinel). The
 * specialized-role layer assigns `finance_manager` at either; the bridge below
 * keys a `financeRoles` grant on this value directly (the schema union allows it).
 */
export type FinanceScope = Id<"chapters"> | "central";

/**
 * Bridge a `finance_manager` SPECIALIZED role to a real `financeRoles` `manager`
 * grant — so holding the title confers finance-write capability. Upserts the one
 * grant per (scope, person): a chapter scope → `scope:"chapter"` keyed on the
 * chapter id, the org level → `scope:"central"` keyed on `"central"`. Mirrors
 * `grantFinanceRole`'s upsert, but is caller-agnostic (invoked by the superuser-
 * gated specialized-role assignment, which grants ON BEHALF OF the holder).
 */
export async function bridgeFinanceManagerGrant(
  ctx: MutationCtx,
  scope: FinanceScope,
  personId: Id<"people">,
): Promise<void> {
  const financeScope: FinanceRoleScope =
    scope === "central" ? "central" : "chapter";
  const existing = await ctx.db
    .query("financeRoles")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", scope).eq("personId", personId),
    )
    .first();
  if (existing) {
    // Re-title / re-assign: ensure the grant is at least manager at this scope.
    await ctx.db.patch(existing._id, { role: "manager", scope: financeScope });
    return;
  }
  await ctx.db.insert("financeRoles", {
    chapterId: scope,
    personId,
    role: "manager",
    scope: financeScope,
    createdAt: Date.now(),
  });
}

/**
 * Revoke the `financeRoles` grant bridged by a `finance_manager` specialized
 * role. Deletes the one (scope, person) grant. The caller only invokes this once
 * it has confirmed the person holds no OTHER finance specialized role at the
 * scope that should keep the capability alive.
 */
export async function revokeBridgedFinanceManagerGrant(
  ctx: MutationCtx,
  scope: FinanceScope,
  personId: Id<"people">,
): Promise<void> {
  const existing = await ctx.db
    .query("financeRoles")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", scope).eq("personId", personId),
    )
    .first();
  if (existing) await ctx.db.delete(existing._id);
}

/**
 * Separation of duties: the approver must be a different person than the
 * requester. Called by the reimbursement/payout approval flows before an
 * approval is recorded. Pure (no ctx) so it's trivially testable.
 */
export function assertSeparationOfDuties(
  approverPersonId: Id<"people">,
  requesterPersonId: Id<"people"> | null | undefined,
): void {
  if (requesterPersonId != null && approverPersonId === requesterPersonId) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message: "The approver must be different from the requester.",
    });
  }
}

/**
 * WP-1.2: true iff the caller holds a CENTRAL `executive_director` or
 * `finance_manager` SPECIALIZED role (or is a superuser — the implicit-central
 * bootstrap path, mirrored everywhere else in finance). TIGHTER than
 * `getFinanceRole(...).isCentral` (which also passes a plain central
 * `financeRoles` grant with no ED/FM title): this is the gate for surfaces that
 * should be invisible to everyone except the two org-level seats named in the
 * PRD (§0.2) — the Accounts tab + the Cards tab's Relay/legacy section.
 *
 * Mirrors `financeRoles.mySeats`' pattern of walking every `people` row the
 * caller's userId owns (a finance seat isn't chapter-scoped the way a normal
 * roster lookup is) rather than requiring the caller's own chapter membership.
 */
export async function isCentralEdOrFm(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;

  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    const roles = await ctx.db
      .query("specializedRoles")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .collect();
    if (
      roles.some(
        (r) =>
          r.scope === "central" &&
          (r.title === "executive_director" || r.title === "finance_manager"),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Assert `isCentralEdOrFm` — the server-side gate behind the Accounts tab /
 *  Relay-cards section (the client-side `canViewAccounts` query is the same
 *  check; this is for functions that must ALSO refuse the write/read itself,
 *  not just hide the affordance). */
export async function requireCentralEdOrFm(ctx: QueryCtx): Promise<void> {
  if (!(await isCentralEdOrFm(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Accounts is visible only to the Executive Director and Financial Manager.",
    });
  }
}
