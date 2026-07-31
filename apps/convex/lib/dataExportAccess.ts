/**
 * Data Export authorization — the gate on bulk extraction.
 *
 * Modelled on `lib/givingAccess.ts` (purely seat-derived, no stored grant
 * table of its own) with one rule that is specific to export and matters more
 * than anything else in this file:
 *
 *   EXPORT NEVER WIDENS REACH. `data.export` says "this person may take data
 *   out of the app at all". It does NOT say which data. Every dataset and
 *   every column group keeps its own pre-existing gate: gifts/donors/pledges
 *   still need `giving.view`, transactions still need a finance role. A
 *   Marketing Director holding `data.export` can export the roster and gets a
 *   people file with NO giving columns — not an error, and not the numbers.
 *
 * That layering is why `ExportAccess` carries `giving`/`finance` reach
 * alongside the export scopes: the runner needs to answer "which columns may
 * this file contain?" for every page it writes, and it must get the same
 * answer the picker gave the user (`@events-os/shared#allowedSections` is the
 * single function both call).
 *
 * SILENT NARROWING IS A REPORTED EVENT, NOT A NO-OP. When a section is dropped
 * for lack of reach it is recorded on the job's `omittedSectionIds` so the UI
 * can say "giving columns were left out". A file that is quietly narrower than
 * what was ticked is the same class of defect as a silently truncated one.
 *
 * Chapter reach: a `data.export` seat at a chapter exports THAT chapter. A
 * seat at `central` exports central and every chapter — matching how
 * `givingAccess` treats a central capability holder. Superusers pass, the
 * bootstrap path mirrored across the repo.
 *
 * Every refusal throws `ConvexError({ code, message })`, never a plain
 * `Error`, so the app's AuthErrorBoundary can surface it.
 */
import { ConvexError } from "convex/values";
import type { ExportDatasetId, ExportRequirement } from "@events-os/shared";
import { EXPORT_DATASETS, satisfiesRequirement } from "@events-os/shared";
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { requireUserId, getChapterIdOrNull } from "./context";
import { getSeatDerivedExportScopes } from "./seats";
import { resolveGivingAccess } from "./givingAccess";
import { getFinanceRole } from "./finance";

/** A chapter, or the org level. Same union as `GivingScope`/`FinanceScope`. */
export type ExportScope = Id<"chapters"> | "central";

export interface ExportAccess {
  isSuperuser: boolean;
  /** Holds `data.export` at `central` — may export every scope. */
  centralExport: boolean;
  /** Chapters where the caller holds a chapter-scope `data.export` seat. */
  exportChapters: Set<string>;
  /** True if they may export ANYTHING anywhere — drives nav visibility. */
  canExportAnywhere: boolean;
}

/**
 * Resolve export reach across every non-placeholder `people` row the caller's
 * `userId` owns — the same whole-user walk `resolveGivingAccess` and
 * `financeRoles.mySeats` do, so a seat held on a non-home roster row still
 * counts. Pure read; signed-out returns empty reach quietly rather than
 * throwing (a signed-out client asking "can I export?" deserves `false`, not
 * an error boundary).
 */
export async function resolveExportAccess(
  ctx: QueryCtx,
): Promise<ExportAccess> {
  const access: ExportAccess = {
    isSuperuser: false,
    centralExport: false,
    exportChapters: new Set<string>(),
    canExportAnywhere: false,
  };

  if (await isSuperuser(ctx)) {
    access.isSuperuser = true;
    access.centralExport = true;
    access.canExportAnywhere = true;
    return access;
  }

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return access; // signed out — no reach (quiet, not a throw)

  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    const scopes = await getSeatDerivedExportScopes(ctx, person._id);
    for (const scopeKey of scopes) {
      if (scopeKey === "central") access.centralExport = true;
      else access.exportChapters.add(scopeKey);
    }
  }

  access.canExportAnywhere =
    access.centralExport || access.exportChapters.size > 0;
  return access;
}

/** Whether resolved access permits exporting at `scope`. */
export function accessCanExport(
  access: ExportAccess,
  scope: ExportScope,
): boolean {
  if (access.isSuperuser || access.centralExport) return true;
  if (scope === "central") return false; // central reach is central-only
  return access.exportChapters.has(scope);
}

/** Assert the caller may run an export at `scope`, else throw. */
export async function requireExport(
  ctx: QueryCtx,
  scope: ExportScope,
): Promise<ExportAccess> {
  const access = await resolveExportAccess(ctx);
  if (!accessCanExport(access, scope)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to export data for this scope.",
    });
  }
  return access;
}

/**
 * The caller's DATA reach at `scope` — what the export is allowed to contain,
 * as opposed to whether it may run at all.
 *
 * Deliberately reuses the existing domain resolvers rather than re-deriving
 * from seats: if `giving.view`'s meaning changes, export follows automatically
 * instead of drifting into a second, staler opinion of the same question.
 */
export async function resolveExportDataReach(
  ctx: QueryCtx,
  scope: ExportScope,
): Promise<{ giving: boolean; finance: boolean }> {
  const giving = await resolveGivingAccess(ctx);
  const givingOk =
    giving.isSuperuser ||
    giving.centralView ||
    (scope !== "central" && giving.viewChapters.has(scope));

  // Finance reach is the graded ladder in `lib/finance.ts`. Any rung at all
  // (viewer and up) is enough to READ the ledger, which is all export does —
  // so this is `role !== null`, not `isManager`.
  //
  // `getFinanceRole` is keyed on a REAL chapter id; there is no central-only
  // entry point anywhere in the finance lib (`requireFinanceCentral` also
  // takes a chapterId and reads `isCentral` off the result). So a central
  // export resolves through the caller's home chapter and asks for the
  // org-wide flag, exactly as that gate does. No home chapter — e.g. a
  // superuser with no roster row — falls back to the superuser short-circuit
  // `getFinanceRole` already applies, and otherwise means no reach.
  // `getChapterIdOrNull` is typed `string | null` repo-wide; cast at the
  // boundary the same way `resolveGivingAccess` casts `requireUserId`.
  const homeChapterId = (await getChapterIdOrNull(
    ctx,
  )) as Id<"chapters"> | null;
  const financeChapterId: Id<"chapters"> | null =
    scope === "central" ? homeChapterId : scope;
  if (financeChapterId === null) {
    return { giving: givingOk, finance: await isSuperuser(ctx) };
  }

  const financeAccess = await getFinanceRole(ctx, financeChapterId);
  const financeOk =
    scope === "central"
      ? financeAccess.isCentral
      : financeAccess.role !== null;

  return { giving: givingOk, finance: financeOk };
}

/** Assert the caller may export `datasetId` at `scope` — the export gate AND
 *  the dataset's own pre-existing gate. Throws with a message naming the
 *  missing power, because "forbidden" alone sends people to the wrong person
 *  for help. */
export async function requireExportDataset(
  ctx: QueryCtx,
  scope: ExportScope,
  datasetId: ExportDatasetId,
): Promise<void> {
  await requireExport(ctx, scope);
  const requirement: ExportRequirement = EXPORT_DATASETS[datasetId].requires;
  if (requirement === "none") return;

  const reach = await resolveExportDataReach(ctx, scope);
  if (!satisfiesRequirement(requirement, reach)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        requirement === "giving.view"
          ? `Exporting ${EXPORT_DATASETS[datasetId].label.toLowerCase()} needs access to the development desk.`
          : `Exporting ${EXPORT_DATASETS[datasetId].label.toLowerCase()} needs a finance role for this scope.`,
    });
  }
}
