/**
 * The migration payload for the homepage content that existed as YAML and
 * markup when the Marketing desk was built:
 * `apps/landing/src/content/links.yaml`, `impact.yaml`, and the hero copy that
 * was hardcoded in `Hero.astro`.
 *
 * Kept verbatim here so `marketingSite.seedSiteContentIfEmpty` can restore it
 * into `siteLinks` / `siteStats` on a fresh deployment — nothing the page
 * showed is lost in the move. Same job, same shape, and the same expiry as
 * `seed/listings.ts`: once every environment has rows, this file is dead
 * weight.
 *
 * COPY IS NOT SEEDED HERE. Every `SITE_COPY_KEYS` entry carries its shipped
 * words as `defaultValue` in `@events-os/shared`'s `marketing.ts`, and
 * `resolveSiteCopy` fills an unset key from it — so the hero renders correctly
 * with zero `siteCopy` rows, and a row is written only when a human actually
 * changes something. That is a better default than seeding twelve rows that
 * merely restate the code.
 *
 * Typed loosely (no generated types) like the other seed data — it is plain
 * content, inserted by the mutation that owns the table shape.
 */

/**
 * Order values, spaced 100 apart so a reorder rewrites one row instead of the
 * whole list. The EVENTS row sits between Donate and the socials, which is
 * exactly where `ImportantLinks.astro` used to inject them from a hardcoded
 * position — the seed preserves the page as it stands, and moving them is now
 * somebody's decision rather than a deploy.
 *
 * The POSTS row follows it, above the socials, for the same reason the events
 * row is there: what is happening next and what we last published are the two
 * things worth reading before someone leaves for Instagram. An existing
 * deployment gets it from `marketingSite.ensurePostsRow` instead — this list
 * only ever runs against an empty table.
 */
export const SITE_LINK_SEED = [
  {
    kind: "link" as const,
    title: "Donate",
    subtitle: "(Card, Apple Pay & Google Pay)",
    url: "/give",
    align: "center" as const,
    order: 100,
    published: true,
  },
  {
    kind: "events" as const,
    // Never rendered — the events row's title is the desk's own label for it.
    title: "Live events",
    align: "center" as const,
    order: 200,
    published: true,
    // Two was the hardcoded `MAX_EVENTS` in `ImportantLinks.astro`.
    maxEvents: 2,
    pinnedEventSlugs: [],
    hiddenEventSlugs: [],
  },
  {
    kind: "posts" as const,
    // Never rendered either — the desk's own label for the row, same as above.
    title: "Latest blog posts",
    align: "center" as const,
    order: 300,
    published: true,
    // ONE, not two. The page never carried a post card before this row
    // existed, so the seed is the smallest change that puts the blog on the
    // homepage at all; the marketer raises it (to `SITE_LINK_MAX_POSTS_CAP`)
    // if the reading earns the space.
    maxPosts: 1,
    pinnedPostSlugs: [],
    hiddenPostSlugs: [],
  },
  {
    kind: "link" as const,
    title: "Instagram",
    url: "https://instagram.com/publicworship.life",
    thumbnailPath: "/links/instagram-photo.png",
    align: "center" as const,
    order: 400,
    published: true,
  },
  {
    kind: "link" as const,
    title: "TikTok",
    url: "https://www.tiktok.com/@publicworship.life",
    thumbnailPath: "/links/tiktok-photo.png",
    align: "center" as const,
    order: 500,
    published: true,
  },
  {
    kind: "link" as const,
    title: "Donate Through Zelle",
    subtitle: "give@publicworship.life",
    // A copy-to-clipboard card, not a navigation. No `url` on purpose.
    copy: "give@publicworship.life",
    cta: "(Click to Copy)",
    align: "center" as const,
    order: 600,
    published: true,
  },
];

/** `apps/landing/src/content/impact.yaml`, verbatim. */
export const SITE_STAT_SEED = [
  {
    value: "700,000+",
    label: "People Reached",
    sublabel:
      "Our worship has reached the hearts of many individuals on social media platforms such as Instagram & TikTok",
    order: 100,
  },
  {
    value: "15+",
    label: "Worship Events",
    sublabel:
      "We have put on a multitude of public worship events and recordings all across the NYC area",
    order: 200,
  },
  {
    value: "10+",
    label: "Team Members",
    sublabel:
      "We have built an amazing team of creatives, and mission driven people to help us execute on this vision, and we are still growing!",
    order: 300,
  },
];
