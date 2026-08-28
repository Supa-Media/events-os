/**
 * MARKETING authorization — the Marketing desk's gate.
 *
 * The named resolvers CLAUDE.md's "Gate It Behind a Power" section requires:
 * nothing in `marketingSite.ts`, `mailingList.ts`, `marketingDesigns.ts`, or
 * `marketingBlog.ts` checks a seat, a title, or a chapter inline. Read
 * `@events-os/shared`'s `powers.ts` for the strings themselves; this module is
 * only how they are enforced.
 *
 * ── ONE DESK, FOUR SURFACES, THREE SHAPES OF GATE ───────────────────────────
 * This is the thing to understand before adding a call site, because the desk
 * looks like one surface and is governed like several:
 *
 *   GLOBAL, NO SCOPE ARGUMENT — the site, the brand kit, the blog. There is one
 *   homepage, one brand, and one blog, so their `require*` functions take no
 *   scope argument at all: there is no second copy to name. That is a statement
 *   about the RESOURCE, and for the site and the blog it also settles the
 *   editors — those two powers are declared `scope: "central"` and a
 *   chapter-scope grant reaches nothing, enforced at derivation
 *   (`lib/seats.ts#getSeatDerivedMarketingCapabilities`) rather than merely
 *   rendered honestly on the chart.
 *
 *   THE BRAND KIT IS THE EXCEPTION, and it is the interesting one. It is just
 *   as global, but `marketing.designs.edit` is NOT `scope: "central"`: a
 *   Chapter Director holding it at their chapter edits the org's one kit, which
 *   is the only kit there is. "One brand" was never an argument about who may
 *   change the brand — the two got conflated, and were separated on 2026-08-28
 *   when the founder asked for the ED and Chapter Directors to be able to edit
 *   it. So `canEditDesigns` is an OR across every scope the caller holds a seat
 *   at, while `canEditSite` / `canEditBlog` can only ever come from central.
 *
 *   CHAPTER-SCOPED — the mailing list, exactly like the giving CRM. A central
 *   holder reaches every chapter's people; a chapter's Marketing Lead reaches
 *   their own and nobody else's. `requireMailingListView` /
 *   `requireMailingListEdit` therefore mirror `requireGivingView` /
 *   `requireGivingManage` one-for-one, including the `canView*`/`canManage*`
 *   filtering twins a list surface needs when the wrong shape would be a
 *   throw-per-row.
 *
 *   NOT GATED AT ALL — READING the brand kit. Deliberate, and the only
 *   ungated read on this desk: a chapter volunteer making a flyer needs the hex
 *   code and the logo file, and a brand kit behind a permission is one people
 *   work around. There is no `requireDesignsView`; do not add one.
 *
 * ── ONE PLACE THIS DESK ASKS FOR A SECOND PARTY ─────────────────────────────
 * `requireBlogPublish`. Everything else here trusts the seat that holds it,
 * including changing the homepage's headline — because a headline is a sentence
 * and a blog post is an argument published under the Corporation's name that
 * gets quoted back years later.
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
  /** May change the brand kit and the design library. NOT central-only: one
   *  kit, but a chapter-scope holder (the Chapter Director) editing it edits
   *  the org's kit rather than a chapter one, so any scope grants it.
   *  READING the library needs nothing at all — see `marketing.designs.edit`. */
  canEditDesigns: boolean;
  /** May write a blog post. Central-only. */
  canEditBlog: boolean;
  /** May put a post on the public blog, or take one down. Central-only, and
   *  implies `canEditBlog`. */
  canPublishBlog: boolean;
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
    canEditDesigns: false,
    canEditBlog: false,
    canPublishBlog: false,
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
    access.canEditDesigns = true;
    access.canEditBlog = true;
    access.canPublishBlog = true;
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
      // `site`, `blogEdit` and `blogPublish` are already false at any chapter
      // scope — the derivation drops them rather than trusting this loop to
      // remember the rule. `designs` is NOT dropped there, deliberately: a
      // chapter-scoped Chapter Director editing the org's one brand kit is the
      // intended grant, so this OR is what carries it through.
      if (scopeCaps.site) access.canEditSite = true;
      if (scopeCaps.designs) access.canEditDesigns = true;
      if (scopeCaps.blogEdit) access.canEditBlog = true;
      if (scopeCaps.blogPublish) access.canPublishBlog = true;
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
    access.canEditDesigns ||
    access.canEditBlog ||
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

/**
 * Assert the caller may CHANGE the brand kit — add a color, a font, a design
 * file, or a folder.
 *
 * There is no `requireDesignsView` and there must not be one. The library is
 * readable by anybody signed in: a chapter volunteer making a flyer needs the
 * hex code and the logo, and a brand kit behind a permission is a brand kit
 * people work around. `marketing.designs.edit`'s doc has the rest.
 */
export async function requireDesignsEdit(
  ctx: QueryCtx,
): Promise<MarketingAccess> {
  const access = await resolveMarketingAccess(ctx);
  if (!access.canEditDesigns) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "You don't have permission to change the brand kit. Ask the Marketing Director, a designer, or your Chapter Director.",
    });
  }
  return access;
}

/** Assert the caller may WRITE a blog post (draft, edit, revise). */
export async function requireBlogEdit(
  ctx: QueryCtx,
): Promise<MarketingAccess> {
  const access = await resolveMarketingAccess(ctx);
  if (!access.canEditBlog) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to write blog posts.",
    });
  }
  return access;
}

/**
 * Assert the caller may PUBLISH a post — or take a published one down.
 *
 * Separate from `requireBlogEdit` on purpose, and the one place in this module
 * where the split costs somebody a click: a post goes on the internet under the
 * Corporation's name and gets quoted back years later. See
 * `marketing.blog.publish`'s doc for why this is `finance.ledger.publish`'s
 * relative and not `marketing.site.edit`'s.
 */
export async function requireBlogPublish(
  ctx: QueryCtx,
): Promise<MarketingAccess> {
  const access = await resolveMarketingAccess(ctx);
  if (!access.canPublishBlog) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only the Marketing Director or the ED can publish a post. Save it as a draft and share the preview link for review.",
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
