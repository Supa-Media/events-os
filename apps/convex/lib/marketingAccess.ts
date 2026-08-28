/**
 * MARKETING authorization — the Marketing desk's gate.
 *
 * The named resolver pair CLAUDE.md's "Gate It Behind a Power" section
 * requires: nothing in `marketingSite.ts` or `mailingList.ts` checks a seat, a
 * title, or a chapter inline. Read `@events-os/shared`'s `powers.ts` for the
 * three strings themselves; this module is only how they are enforced.
 *
 * ── TWO HALVES, TWO SCOPE MODELS ────────────────────────────────────────────
 * This is the one thing to understand before adding a call site here, because
 * the desk looks like one surface and is governed like two:
 *
 *   THE SITE is central, full stop. publicworship.life is the ORG's homepage;
 *   there is no per-chapter homepage to edit, so `marketing.site.edit` is
 *   declared `scope: "central"` and a chapter-scope grant reaches nothing —
 *   enforced at derivation (`lib/seats.ts#getSeatDerivedMarketingCapabilities`),
 *   not merely rendered honestly on the chart. `requireSiteEdit` takes no
 *   scope argument at all, which is the type system saying the same thing.
 *
 *   THE LIST is chapter-scoped, exactly like the giving CRM. A central holder
 *   reaches every chapter's people; a chapter's Marketing Lead reaches their
 *   own chapter's and nobody else's. `requireMailingListView` /
 *   `requireMailingListEdit` therefore mirror `requireGivingView` /
 *   `requireGivingManage` one-for-one, including the `canView*`/`canManage*`
 *   filtering twins a list surface needs when the wrong shape would be a
 *   throw-per-row.
 *
 * ── EXPORT IS NOT A FOURTH POWER ────────────────────────────────────────────
 * `requireMailingListExport` asks for BOTH `marketing.list.view` at the scope
 * AND `data.export` at the scope, because walking a contact set out of the
 * building as a file is what `data.export` already means org-wide. Inventing a
 * `marketing.list.export` would have said the same thing a second time, in a
 * place where a future "who can take data out of here?" audit would miss it.
 * The Marketing Director carries `data.export` already (a 2026-07-31 founder
 * grant); a seat that reads the list without it gets the desk and not the CSV.
 *
 * Every refusal throws `ConvexError({ code, message })` (never a plain
 * `Error`) so the app's AuthErrorBoundary can surface it, exactly like the
 * finance, giving, and hiring gates.
 */
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { requireUserId } from "./context";
import { getSeatDerivedMarketingCapabilities } from "./seats";
import { accessCanExport, resolveExportAccess } from "./dataExportAccess";

/** A chapter, or the org level. Same union as `GivingScope`/`ExportScope`. */
export type MarketingScope = Id<"chapters"> | "central";

/** The caller's resolved reach on the Marketing desk. */
export interface MarketingAccess {
  /** Superuser — the bootstrap path, mirrored across the repo. */
  isSuperuser: boolean;
  /** May edit the public homepage's copy, stats, and link cards. Central-only
   *  by construction — see the module doc. */
  canEditSite: boolean;
  /** Central-scope `marketing.list.view` (implies view of every chapter). */
  centralListView: boolean;
  /** Central-scope `marketing.list.edit` (implies edit of every chapter). */
  centralListEdit: boolean;
  /** Chapters where the caller holds a chapter-scope `marketing.list.view`. */
  listViewChapters: Set<string>;
  /** Chapters where the caller holds a chapter-scope `marketing.list.edit`. */
  listEditChapters: Set<string>;
  /** Anything at all here — drives whether the desk's nav entry renders. */
  canViewDesk: boolean;
}

function emptyAccess(): MarketingAccess {
  return {
    isSuperuser: false,
    canEditSite: false,
    centralListView: false,
    centralListEdit: false,
    listViewChapters: new Set<string>(),
    listEditChapters: new Set<string>(),
    canViewDesk: false,
  };
}

/**
 * Resolve the caller's marketing reach across every non-placeholder `people`
 * row their `userId` owns — the same whole-user walk `resolveGivingAccess` and
 * `resolveExportAccess` do, so a seat held on a non-home roster row still
 * counts. Superuser short-circuits to full reach. Pure read; signed-out
 * returns empty reach QUIETLY rather than throwing, because the nav asks this
 * question on every render and a signed-out client deserves `false`, not an
 * error boundary.
 */
export async function resolveMarketingAccess(
  ctx: QueryCtx,
): Promise<MarketingAccess> {
  const access = emptyAccess();

  if (await isSuperuser(ctx)) {
    access.isSuperuser = true;
    access.canEditSite = true;
    access.centralListView = true;
    access.centralListEdit = true;
    access.canViewDesk = true;
    return access;
  }

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return access;

  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    const caps = await getSeatDerivedMarketingCapabilities(ctx, person._id);
    for (const [scopeKey, scopeCaps] of Object.entries(caps)) {
      // `site` is already false at any chapter scope — the derivation drops it
      // rather than trusting this loop to remember the rule.
      if (scopeCaps.site) access.canEditSite = true;
      if (scopeKey === "central") {
        if (scopeCaps.listView) access.centralListView = true;
        if (scopeCaps.listEdit) access.centralListEdit = true;
      } else {
        if (scopeCaps.listView) access.listViewChapters.add(scopeKey);
        if (scopeCaps.listEdit) access.listEditChapters.add(scopeKey);
      }
    }
  }

  access.canViewDesk =
    access.canEditSite ||
    access.centralListView ||
    access.listViewChapters.size > 0;
  return access;
}

/** Whether the resolved access grants READ of the list at `scope`. The
 *  filtering twin of `requireMailingListView` — see `canViewGivingScope`. */
export function canViewMailingList(
  access: MarketingAccess,
  scope: MarketingScope,
): boolean {
  if (access.isSuperuser || access.centralListView) return true;
  if (scope === "central") return false; // central reach is central-only
  return access.listViewChapters.has(scope);
}

/** Whether the resolved access grants WRITE of the list at `scope`. */
export function canEditMailingList(
  access: MarketingAccess,
  scope: MarketingScope,
): boolean {
  if (access.isSuperuser || access.centralListEdit) return true;
  if (scope === "central") return false;
  return access.listEditChapters.has(scope);
}

/**
 * Assert the caller may EDIT the public site — its copy, its impact numbers,
 * its Important Links cards.
 *
 * No scope argument, deliberately: see the module doc. One org, one homepage.
 */
export async function requireSiteEdit(
  ctx: QueryCtx,
): Promise<MarketingAccess> {
  const access = await resolveMarketingAccess(ctx);
  if (!access.canEditSite) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "You don't have permission to edit the public site. Ask the Marketing Director or the ED.",
    });
  }
  return access;
}

/** Assert the caller may READ the mailing list at `scope`, else throw. */
export async function requireMailingListView(
  ctx: QueryCtx,
  scope: MarketingScope,
): Promise<MarketingAccess> {
  const access = await resolveMarketingAccess(ctx);
  if (!canViewMailingList(access, scope)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to the mailing list for this scope.",
    });
  }
  return access;
}

/** Assert the caller may CHANGE the mailing list at `scope` — add someone, or
 *  take someone off it. */
export async function requireMailingListEdit(
  ctx: QueryCtx,
  scope: MarketingScope,
): Promise<MarketingAccess> {
  const access = await resolveMarketingAccess(ctx);
  if (!canEditMailingList(access, scope)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to change the mailing list.",
    });
  }
  return access;
}

/**
 * Assert the caller may take the mailing list OUT of the building as a file.
 *
 * Both gates, at the same scope — see the module doc for why this is a
 * composition rather than a fourth power. The refusal names which half is
 * missing, because "you can see this list but not export it" is a genuinely
 * confusing state to hit and worth one honest sentence.
 */
export async function requireMailingListExport(
  ctx: QueryCtx,
  scope: MarketingScope,
): Promise<MarketingAccess> {
  const access = await requireMailingListView(ctx, scope);
  const exportAccess = await resolveExportAccess(ctx);
  if (!accessCanExport(exportAccess, scope)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "You can see the mailing list but not export it. Exporting contacts needs the data-export power — ask the ED.",
    });
  }
  return access;
}
