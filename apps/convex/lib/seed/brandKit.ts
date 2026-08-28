/**
 * The brand kit's starting contents — what `marketingDesigns.seedBrandKitIfEmpty`
 * writes into `brandColors`, `brandFonts`, and `designFolders` on a deployment
 * that has none.
 *
 * Everything here already existed somewhere in this repo; none of it is
 * invented. The colors are read off `@events-os/shared`'s
 * `PUBLIC_WORSHIP_THEME` — the email theme whose own doc says its values were
 * taken from Public Worship's real monthly newsletter, not chosen. The fonts
 * and the folder names come from the Academy's brand lesson
 * (`packages/shared/src/academy/streams/marketing.ts`) and from that same
 * newsletter theme.
 *
 * Referencing the theme rather than retyping the hexes is the point. A brand
 * kit that restates `#891d1a` in a second file is a brand kit with two answers
 * the day somebody adjusts one of them, which is exactly the drift the Designs
 * tab exists to end. If the newsletter's palette moves, this seed follows it.
 *
 * ── FOUR FACES, AND THAT IS NOT A BUG TO BE FIXED ───────────────────────────
 * The brand lesson named three faces — Times New Roman Condensed for
 * headlines, SF Pro Display for captions, Barbra Condensed as the supporting
 * face. `PUBLIC_WORSHIP_THEME`, read off the actual newsletter that goes out,
 * sets both its heading and body stacks to INTER. Rather than have a seed
 * quietly pick a winner between two true statements about this org, the kit
 * carries ALL FOUR, each with the role its source assigns it.
 *
 * That is the founder's call, made 2026-08-28: *"it doesn't matter, put all of
 * the fonts there and then make sure the designer can edit it when they
 * want."* So this is not an open question awaiting resolution — it is the kit
 * in its intended state. The designer owns the list from here: they can add a
 * face, change what one is for, reorder them, or delete one, from Marketing →
 * Designs, with no PR and nobody's approval. **Do not "resolve" this by
 * deleting a row from this seed.** A seed only ever runs on a deployment with
 * an empty table; editing it changes nothing anyone can see, and would only
 * make a fresh environment start out disagreeing with the live one.
 *
 * The Academy no longer lists the faces or prints the hexes at all — it points
 * at this kit — precisely so the designer's edits never leave a lesson behind
 * teaching last season's brand.
 *
 * Typed loosely (no generated types) like every other file in `seed/` — it is
 * plain content, inserted by the mutation that owns the table shape. Same
 * expiry too: once every environment has rows, this file is dead weight.
 */
import { PUBLIC_WORSHIP_THEME, normalizeBrandHex } from "@events-os/shared";

/**
 * The four colors, in the order a person needs them: the brand red first
 * because it is the only one with a rule attached, then the two surface colors
 * the newsletter is built on, then the link blue.
 *
 * Only four of `PUBLIC_WORSHIP_THEME`'s twelve color tokens are here on
 * purpose. The rest (`accentInk`, `hairline`, `border`, the dark-mode
 * overrides) are RENDERER plumbing — a person making a flyer never picks
 * "hairline". A brand kit that listed every token would be a theme dump, and
 * the useful four would be buried in it.
 */
export const BRAND_COLOR_SEED = [
  {
    name: "PW Red",
    hex: normalizeBrandHex(PUBLIC_WORSHIP_THEME.accent),
    usage:
      "The one color that has to show up somewhere on anything public-facing — flyer, banner, overlay, sign. It's also the default accent in the org's email templates, so an email and a flyer carry the same red.",
    order: 100,
  },
  {
    name: "Ink",
    hex: normalizeBrandHex(PUBLIC_WORSHIP_THEME.ink),
    usage:
      "Near-black with warmth in it — headlines and body text, and the fill behind reversed-out type. Not #000: a cream brand going to pure black reads as a different organization.",
    order: 200,
  },
  {
    name: "Cream",
    hex: normalizeBrandHex(PUBLIC_WORSHIP_THEME.cream),
    usage:
      "The warm background the newsletter's feature cards and footer sit on. Use it where white would feel clinical.",
    order: 300,
  },
  {
    name: "Link blue",
    hex: normalizeBrandHex(PUBLIC_WORSHIP_THEME.link),
    usage:
      "Inline links only. It is deliberately not a brand color — it is the color a link has to be for people to know it is one.",
    order: 400,
  },
];

/**
 * The four faces, with the role each source assigns it. See this file's doc for
 * why all four ship and why that is deliberate rather than unfinished.
 *
 * No `sourceUrl` on any of them yet: the lesson points at a Notion page and a
 * Dropbox folder, and neither is a stable link to a font FILE. Leaving the
 * field empty is more honest than seeding a URL that lands somebody on a page
 * they may not have access to; whoever owns the kit can fill it in from the
 * app.
 */
export const BRAND_FONT_SEED = [
  {
    name: "Times New Roman Condensed",
    role: "headline" as const,
    notes:
      "The headline face in the Academy's brand lesson. Condensed specifically — the standard cut is a different look.",
    order: 100,
  },
  {
    name: "Inter",
    role: "body" as const,
    notes:
      "The face the real newsletter is set in, heading and body both — so anything that has to sit next to an email uses it. Sits alongside the three faces from the brand lesson rather than replacing them; the designer decides how the four divide the work.",
    order: 200,
  },
  {
    name: "SF Pro Display",
    role: "caption" as const,
    notes:
      "Captions specifically, per the brand lesson. Already on every Apple device, which is most of why it works for small type.",
    order: 300,
  },
  {
    name: "Barbra Condensed",
    role: "accent" as const,
    notes: "The third supporting face in the brand lesson. Accents, not body copy.",
    order: 400,
  },
];

/**
 * The five shelves, one per row of `mktg-the-look`'s "where the assets live"
 * table. Flat — no `parentId` on any of them — because the lesson's list is
 * flat and a seeded sub-shelf would be this file guessing at a filing system
 * nobody asked for. The one level of nesting the schema allows is there for the
 * marketer to use when they actually need it.
 */
export const DESIGN_FOLDER_SEED = [
  { name: "Logos", order: 100 },
  { name: "Flyers", order: 200 },
  { name: "Banners", order: 300 },
  { name: "Social media overlays", order: 400 },
  { name: "Signage", order: 500 },
];
