import { defineTable } from "convex/server";
import { v } from "convex/values";
import { BRAND_FONT_ROLES, DESIGN_KINDS } from "@events-os/shared";

/**
 * THE BRAND KIT AND THE DESIGN LIBRARY — the Marketing desk's Designs tab, as
 * tables.
 *
 * Read `@events-os/shared`'s `marketingDesigns.ts` first: it holds the
 * vocabulary, the bounds, the embed rule, and the wire contract these four
 * tables serialize into. This file is only where the rows live.
 *
 * ── Why these are tables at all ─────────────────────────────────────────────
 * Same argument `schema/marketing.ts` makes for the homepage, one step further
 * out: before this, "what red is our red?" was answered by an Academy lesson,
 * a Notion page, and a Dropbox folder nobody outside the founding team had a
 * link to. A brand kit that lives in three places drifts, and the drift shows
 * up on a flyer in another city three weeks later. Rows in the OS mean the
 * answer is one place, it is current, and changing it is a marketer's action
 * rather than a pull request.
 *
 * ── CENTRAL ONLY — no `chapterId`, deliberately ─────────────────────────────
 * Unlike `serviceOptions` (which this file copies its nesting rule from) there
 * is no chapter-local variant of any row here. There is ONE brand. A chapter
 * with its own reds and its own logo folder is precisely the outcome the kit
 * exists to prevent, so the schema declines to express it — matching
 * `marketing.designs.edit`'s `scope: "central"` declaration in `powers.ts`.
 * If a chapter ever legitimately needs local artwork, that is a new table with
 * its own name, not an optional `chapterId` bolted onto these.
 *
 * ── Reading is ungated; writing is not ──────────────────────────────────────
 * Nothing in here is PII and nothing in here is a draft: every row is an answer
 * to "how do I make this look right?", which anybody signed in may ask. So
 * `marketingDesigns.ts#library` requires no power at all, and every write
 * requires `marketing.designs.edit` through `requireDesignsEdit`. There is no
 * `published` flag on any of these tables — a half-finished brand color is not
 * a thing, and a design nobody should use yet simply isn't added yet.
 *
 * ── One level of folder nesting only ────────────────────────────────────────
 * `designFolders.parentId` copies `serviceOptions`' rule verbatim, including
 * the reason it cannot be a schema constraint: a row may point at a parent, but
 * a row that HAS a parent may never be pointed at as someone else's parent.
 * Convex has no cross-row schema constraint, so `marketingDesigns.ts#upsertFolder`
 * enforces it at write time. Two levels covers "Social / Stories" and stops
 * before the point where somebody has to remember which of four nested folders
 * a flyer went in.
 *
 * ── Why the image URLs are stored next to the storage ids ───────────────────
 * `emailImages` (`schema/campaigns.ts`) settled this: the row carries the
 * `storageId` PLUS the resolved public `url`. Without the cache, rendering a
 * library of fifty designs costs fifty `ctx.storage.getUrl` round trips inside
 * one query. `marketingDesigns.ts` rejects a `storageId` that does not resolve
 * rather than storing a null URL, for the same reason `emailImages.addImage`
 * does: a row whose picture can never render is worse than no row, because
 * nobody notices until it is on a wall.
 */

const fontRoleValidator = v.union(...BRAND_FONT_ROLES.map((r) => v.literal(r)));
const designKindValidator = v.union(...DESIGN_KINDS.map((k) => v.literal(k)));

/**
 * One color in the brand kit — "PW Red", `#891d1a`, and where it goes.
 *
 * `hex` is stored already normalized (`normalizeBrandHex`: lowercase, `#rgb`
 * expanded to `#rrggbb`) so two spellings of one color compare equal in the
 * database, not merely on screen. The validation lives in the shared module so
 * the Convex write, the Expo form, and the tests all agree on what a color is.
 *
 * `usage` is the half people actually need — "the one color that has to show up
 * somewhere on anything public-facing" is worth more to a volunteer at 11pm
 * than the hex is. Optional, because a swatch with no story is still a swatch.
 */
export const brandColors = defineTable({
  name: v.string(),
  /** `#rrggbb`, lowercased — see `normalizeBrandHex`. */
  hex: v.string(),
  usage: v.optional(v.string()),
  /** Ascending display order. Sparse by design (the seed spaces rows 100
   *  apart) so a reorder rewrites the moved rows, not every row after them. */
  order: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
}).index("by_order", ["order"]);

/**
 * One typeface, and what it is FOR.
 *
 * `role` is a closed union rather than free text for the reason
 * `BRAND_FONT_ROLES`' doc gives: the useful question is "what do I set a
 * headline in?", and three people typing "headings", "Headings" and "titles"
 * turns a kit into a list. Several fonts may share a role — the kit ships with
 * a documented conflict between the Academy's three faces and the newsletter's
 * Inter (see `lib/seed/brandKit.ts`), and the schema must be able to hold both
 * sides of an unresolved question rather than forcing a premature winner.
 *
 * `sourceUrl` is where to GET the face. Times New Roman Condensed is not on a
 * new volunteer's laptop, and "download it from here" is the difference between
 * the kit being followed and being approximated.
 */
export const brandFonts = defineTable({
  name: v.string(),
  role: fontRoleValidator,
  sourceUrl: v.optional(v.string()),
  notes: v.optional(v.string()),
  /** Ascending display order — sparse, like `brandColors.order`. */
  order: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
}).index("by_order", ["order"]);

/**
 * One shelf in the library — "Logos", "Flyers", "Social media overlays".
 *
 * ONE LEVEL OF NESTING ONLY, exactly as `schema/services.ts#serviceOptions`
 * defines it: absent `parentId` = a top-level shelf (which may itself hold
 * designs — a parent is not a category header); present = a sub-shelf under
 * that parent. A row with `parentId` set may NEVER be pointed at as someone
 * else's parent. That rule cannot be written here — Convex has no cross-row
 * schema constraint — so `marketingDesigns.ts#upsertFolder` enforces it on
 * every write, and the same file's `deleteFolder` refuses while a child
 * exists.
 *
 * There is no `designCount` column. It is computed in `library` from the
 * designs already being read, because a stored counter is a second source of
 * truth that goes wrong the first time a design is moved by any path that
 * forgets to decrement it.
 */
export const designFolders = defineTable({
  name: v.string(),
  /** Absent = top-level. Present = a sub-shelf; such a row may not itself be a
   *  parent (enforced in `marketingDesigns.ts#upsertFolder`). */
  parentId: v.optional(v.id("designFolders")),
  /** Ascending display order — sparse, like `brandColors.order`. */
  order: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
})
  .index("by_order", ["order"])
  .index("by_parent", ["parentId"]);

/**
 * One design: a Canva or Figma file, a link to somewhere else, or an uploaded
 * image.
 *
 * ── `url` is the EDIT/SHARE link, never a CDN preview ───────────────────────
 * The Canva CDN trap, written down because it already cost this repo real
 * artwork: `*.canva-cdn.email` image URLs EXPIRE, which is part of why
 * `emailHtmlImport.ts` exists — pasted newsletter designs went blank weeks
 * later and had to be re-hosted. So `url` holds the stable Canva/Figma link a
 * human actually wants to land on, and `embedUrl` is DERIVED from it at read
 * time by `designEmbedUrl` rather than stored, so fixing the embed rule fixes
 * every existing row at once.
 *
 * ── Two image slots, both ours ──────────────────────────────────────────────
 * `imageStorage` is the artwork itself and only means anything on `kind:
 * "image"`. `thumbnailStorage` is the preview card for ANY kind — including a
 * Canva link, which otherwise renders as a title and nothing else. Both are
 * uploads we host, never a third party's URL, for the CDN reason above. Each
 * carries its resolved `*Url` alongside the storage id (the `emailImages`
 * pattern) so listing the library is one query and not N storage lookups; the
 * pair is written together or not at all.
 */
export const designAssets = defineTable({
  kind: designKindValidator,
  title: v.string(),
  /** Absent = unfiled. The tab shows those in their own "Unfiled" group rather
   *  than hiding them — a design with no shelf is still findable. */
  folderId: v.optional(v.id("designFolders")),
  /** The stable share/edit link. Absent only on an `image` whose entire content
   *  is the upload. */
  url: v.optional(v.string()),
  notes: v.optional(v.string()),
  /** The uploaded artwork (`kind: "image"`), plus its resolved public URL —
   *  cached together, see this file's doc. */
  imageStorage: v.optional(v.id("_storage")),
  imageUrl: v.optional(v.string()),
  /** The hosted preview card, for any kind. Always an upload. */
  thumbnailStorage: v.optional(v.id("_storage")),
  thumbnailUrl: v.optional(v.string()),
  /** Ascending order WITHIN the whole library — folders group the list at read
   *  time, so one order sequence stays coherent when a design moves shelves. */
  order: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
})
  .index("by_order", ["order"])
  .index("by_folder", ["folderId", "order"]);
