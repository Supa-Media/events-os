import { defineTable } from "convex/server";
import { v } from "convex/values";
import { SITE_COPY_KEYS, SITE_LINK_ALIGNS, SITE_LINK_KINDS } from "@events-os/shared";

/**
 * MARKETING — the public homepage's content, as tables.
 *
 * Read `@events-os/shared`'s `marketing.ts` first; it holds the vocabulary,
 * the layout bounds, and the wire contract these three tables serialize into.
 * This file is only where the rows live.
 *
 * ── Why these are tables at all ─────────────────────────────────────────────
 * Before this, the homepage's words were markup (`Hero.astro`) and its cards
 * were YAML (`links.yaml`, `impact.yaml`) in the landing repo. Every change was
 * a pull request, so in practice the Marketing seat could not change the
 * marketing. The same move `jobListings` made for `/team` (`schema/hiring.ts`),
 * for the same reason, with the same shape: rows here, a public JSON feed the
 * page reads at runtime, and a named power on every write.
 *
 * ── Nothing here is PII ─────────────────────────────────────────────────────
 * Every row in this file is, by definition, content meant to be read by
 * strangers on the internet. That is what lets `GET /api/site/home` be
 * unauthenticated and cacheable. The mailing list — which is nothing but PII —
 * is deliberately NOT in this file and has no public read surface at all; it
 * lives on `people` (`schema/people.ts`) and is served only through the gated
 * desk (`mailingList.ts`). The two halves of the marketing desk have opposite
 * disclosure rules, and keeping them in separate files is the cheapest way to
 * stop that distinction eroding.
 *
 * ── Draft vs. live ──────────────────────────────────────────────────────────
 * `siteLinks.published` is a DRAFT gate, not a second authority: one power
 * (`marketing.site.edit`) writes all of it, and the flag exists so a card can
 * be built before its event announcement goes out. Copy and stats have no
 * draft state — a headline is either the headline or it is not, and a
 * half-written one has nowhere to hide.
 */

const alignValidator = v.union(...SITE_LINK_ALIGNS.map((a) => v.literal(a)));
const kindValidator = v.union(...SITE_LINK_KINDS.map((k) => v.literal(k)));
const copyKeyValidator = v.union(...SITE_COPY_KEYS.map((k) => v.literal(k)));

/**
 * One named text slot on the homepage — hero headline, section eyebrow, button
 * label. At most one row per `key`; a key with no row renders its shipped
 * default (`resolveSiteCopy`), which is what makes seeding optional rather than
 * load-bearing.
 *
 * PLAIN TEXT, ALWAYS. No row here is ever rendered as markup. The hero's
 * two-tone headline is two rows for exactly this reason — see
 * `SITE_COPY_DEFS`'s doc.
 */
export const siteCopy = defineTable({
  key: copyKeyValidator,
  value: v.string(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
}).index("by_key", ["key"]);

/** One "Transformative Impact" card. `value` is a string ("700,000+") — see
 *  `PublicSiteStat`'s doc for why the "+" is the honest part. */
export const siteStats = defineTable({
  value: v.string(),
  label: v.string(),
  sublabel: v.optional(v.string()),
  /** Ascending render order. Sparse by design (see `siteLinks.order`). */
  order: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
}).index("by_order", ["order"]);

/**
 * One card in the Important Links grid — or, for the single `kind: "events"`
 * row, the PLACEHOLDER marking where the live event cards render and how they
 * are chosen.
 *
 * ── The events row ──────────────────────────────────────────────────────────
 * Putting the automatic cards in the same ordered list as the fixed ones is the
 * design decision this table turns on. The page already injected live events
 * between Donate and the socials (`ImportantLinks.astro`), but their POSITION
 * was hardcoded in the component and their COUNT was a constant. Modeling them
 * as a row means "show three, above Donate, but hide the team retreat and lead
 * with the December service" is four fields on one row instead of four code
 * changes — and the marketer can SEE, in the same list, what the page will do.
 *
 * `pinnedEventSlugs` / `hiddenEventSlugs` name RSVP slugs rather than event
 * ids. A slug is what the marketer can read off the page's own URL, it is
 * stable across the event doc being replaced, and — the reason that matters
 * here — a slug that stops resolving degrades to "this pin does nothing",
 * while a dangling id would have to be either an error or a silent skip. The
 * pin list is an intent, not a reference.
 *
 * ── The posts row ───────────────────────────────────────────────────────────
 * `kind: "posts"` is the same row, asked about the blog: `maxPosts` /
 * `pinnedPostSlugs` / `hiddenPostSlugs` mean to published posts exactly what
 * the events trio means to RSVP pages, down to the slug-not-id reasoning above
 * — a post can be taken down, and a pin that outlives it must degrade to
 * "this pin does nothing" rather than to a 404 on the front page.
 *
 * Two triples rather than one generic pair (`maxItems`, `pinnedSlugs`) because
 * the two lists name things in DIFFERENT namespaces: an RSVP slug and a post
 * slug can collide, and a shared column would let a hide meant for an event
 * silently suppress a post. See `SITE_LINK_KINDS`'s doc for why the kinds
 * themselves stayed separate.
 *
 * ── Images ──────────────────────────────────────────────────────────────────
 * `thumbnailPath` / `bgImagePath` hold a path into the landing site's own
 * `/public` (`/links/instagram-photo.png`) — how every card was authored before
 * this table. `thumbnailStorage` / `bgImageStorage` hold an OS upload instead,
 * served from `GET /api/site/link-image/<id>/(thumb|bg)`. Both exist because
 * the existing cards' art lives in the landing repo and re-uploading it would
 * be busywork; a NEW card uploads. The serializer prefers the upload when both
 * are set, so replacing a repo image with an upload needs no cleanup.
 */
export const siteLinks = defineTable({
  kind: kindValidator,
  title: v.string(),
  subtitle: v.optional(v.string()),
  url: v.optional(v.string()),
  thumbnailPath: v.optional(v.string()),
  thumbnailStorage: v.optional(v.id("_storage")),
  bgImagePath: v.optional(v.string()),
  bgImageStorage: v.optional(v.id("_storage")),
  cta: v.optional(v.string()),
  copy: v.optional(v.string()),
  align: alignValidator,
  /**
   * Ascending render order across the WHOLE grid, events row included.
   * Deliberately sparse (the seed spaces rows 100 apart) so a reorder rewrites
   * the moved row only, not every row after it.
   */
  order: v.number(),
  /** The draft gate. `false` keeps the card out of the public feed entirely. */
  published: v.boolean(),
  // ── `kind: "events"` only ──────────────────────────────────────────────────
  maxEvents: v.optional(v.number()),
  pinnedEventSlugs: v.optional(v.array(v.string())),
  hiddenEventSlugs: v.optional(v.array(v.string())),
  // ── `kind: "posts"` only ───────────────────────────────────────────────────
  maxPosts: v.optional(v.number()),
  pinnedPostSlugs: v.optional(v.array(v.string())),
  hiddenPostSlugs: v.optional(v.array(v.string())),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.id("users")),
}).index("by_order", ["order"]);
