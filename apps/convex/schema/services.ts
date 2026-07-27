import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Service Catalog — the managed dropdown of "what can this person do?" tags
 * (worship leading, vocals, videography, …), replacing the free-text
 * `people.services` array (13 inconsistent lowercase strings across 21 of 305
 * prod people at the time of writing). A person now references catalog rows
 * by id (`people.serviceIds`) instead of typing a string, so a rename here
 * propagates to everyone automatically and a value can only ever be one of
 * the catalog's own options.
 *
 * ORG-WIDE BY DEFAULT, WITH OPTIONAL CHAPTER-LOCAL ADDITIONS — mirrors
 * `schema/finances.ts#financeTeams`'s central/chapter split verbatim: absent
 * `chapterId` = an org-wide option shared by every chapter (the founder's
 * curated canonical catalog — a Tenor is a Tenor in any chapter); present =
 * a LOCAL addition visible only to that one chapter. `serviceOptions.ts#list`
 * returns the union (every org-wide option, plus the caller's own chapter's
 * local ones) — see that file's doc. A parent/child pair must share the same
 * scope (both org-wide, or both the same chapter) — `serviceOptions.ts#create`
 * enforces this.
 *
 * ONE LEVEL OF NESTING ONLY, mirroring `schema/finances.ts#budgetCategories`'s
 * parent/child + `isActive` shape: a row may optionally point at a `parentId`,
 * but a row that itself has a `parentId` may never be pointed at as someone
 * else's parent — `serviceOptions.ts#create`/`rename` enforce this at write
 * time (the schema alone can't express "no grandparents"). A bare PARENT row
 * is itself a selectable option (e.g. `Vocals` with no child = "yes,
 * unspecified") — `parentId` existing or not is the only thing that makes a
 * row a parent or a leaf; there's no separate "is this a parent" flag.
 *
 * The display label is DERIVED, never stored: `parent ? \`${parent.name}:
 * ${child.name}\` : name` — so renaming a parent instantly relabels every
 * child everywhere without a cascading write.
 *
 * Soft-delete only (`isActive`): a catalog option is NEVER hard-deleted while
 * any `people.serviceIds` (or a saved `has_service` audience condition, see
 * `schema/campaigns.ts`) might still reference it — deleting the row out from
 * under a live reference would leave a dangling id with no way to resolve a
 * label. Deactivating a PARENT hides its children from the picker too, but
 * that hiding happens at READ time in `serviceOptions.ts#list` (walking
 * `by_parent`), never by mutating the children's own `isActive` — a later
 * reactivation of the parent should reveal exactly the children that were
 * already there.
 */
export const serviceOptions = defineTable({
  // Optional: absent = an ORG-WIDE option shared by every chapter. Present =
  // a chapter-LOCAL addition visible only to that chapter.
  chapterId: v.optional(v.id("chapters")),
  // Absent = a top-level option (itself a parent, or a standalone leaf with no
  // children, e.g. "Songwriting"). Present = a child under that parent. A row
  // with `parentId` set may never itself be pointed at as a parent — enforced
  // in `serviceOptions.ts#create`/`rename`, not here (Convex has no
  // cross-row schema constraint). A child's `chapterId` must match its
  // parent's (both org-wide, or both the same chapter) — also enforced in
  // `serviceOptions.ts#create`.
  parentId: v.optional(v.id("serviceOptions")),
  // The bare name at this level: "Tenor" for a child, "Vocals" for its parent.
  // Never contains ":" or "," — both are reserved (":" is the derived-label
  // separator; "," was the old free-text list's delimiter) — enforced by
  // `serviceOptions.ts#create`/`rename`.
  name: v.string(),
  sortOrder: v.optional(v.number()),
  // Soft-delete/restore. Absent/false = active (the default before this field
  // existed on any row).
  isActive: v.optional(v.boolean()),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_parent", ["parentId"]);
