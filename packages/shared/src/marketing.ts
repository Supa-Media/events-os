/**
 * MARKETING — the homepage's editable surface, as constants.
 *
 * publicworship.life's front page used to be entirely a build artifact: the
 * hero's headline lived in `Hero.astro`, the impact numbers in `impact.yaml`,
 * the Important Links cards in `links.yaml`. Changing a word — or reordering
 * two cards — was a pull request and a deploy, which meant the Marketing seat
 * could not do the one thing its title names. This module is the vocabulary
 * that moved those three things into the OS.
 *
 * THREE SHAPES, and the split is on how the content is USED, not on where it
 * happens to render:
 *
 *   COPY   `SITE_COPY_KEYS` — a fixed catalog of named text slots. The set of
 *          slots is code (a designer chose where a sentence goes); only the
 *          sentences are data. That is why this is a catalog and not a
 *          free-form CMS: nobody can add a heading the layout has no room for.
 *
 *   STATS  `PublicSiteStat` — the "Transformative Impact" cards. A LIST, not a
 *          catalog, because the count is genuinely the org's call (three today;
 *          a fourth is a decision, not a schema change).
 *
 *   LINKS  `PublicSiteLink` — the Important Links grid. Also a list, plus two
 *          AUTO rows: `kind: "events"` stands in for the live event cards, and
 *          `kind: "posts"` for the latest blog posts. Both sit in the SAME
 *          ordered list as the fixed cards, which is what lets "move the
 *          events above Donate" be a drag rather than a code change — and what
 *          made adding the posts row a new row rather than a new section.
 *
 * THE CONTRACT. `PublicSiteContent` is the wire shape three things share and
 * must not drift on: the serializer (`apps/convex/marketingSite.ts`), the
 * public feed (`GET /api/site/home`), and the landing renderer
 * (`apps/landing/src/lib/siteContent.ts`). Same seam, same reasoning, as
 * `hiring.ts`'s `PublicJobListing`.
 *
 * DEFAULTS ARE NOT FALLBACKS. Every copy key carries the words that were in
 * the markup before this desk existed. They are the SEED
 * (`apps/convex/lib/seed/siteContent.ts`) and the landing build's last resort
 * when the backend is unreachable — never a silent substitute for a row
 * somebody deleted. See `resolveSiteCopy` below.
 */

// ── Copy ─────────────────────────────────────────────────────────────────────

/** Which block of the homepage a copy slot belongs to. Drives the editor's
 *  grouping and nothing else — the page's layout is code. */
export const SITE_COPY_SECTIONS = ["hero", "links", "impact"] as const;
export type SiteCopySection = (typeof SITE_COPY_SECTIONS)[number];

/** One editable text slot on the public homepage. */
export interface SiteCopyKeyDef {
  key: SiteCopyKey;
  section: SiteCopySection;
  /** The editor's field label. What a marketer would call this bit of the page. */
  label: string;
  /** One line under the field saying where it shows up. */
  help: string;
  /** The words that shipped in the markup, before the desk existed. */
  defaultValue: string;
  /** Renders as a textarea rather than a single-line input. */
  multiline?: boolean;
  /**
   * A LAYOUT bound, not a policy one. Each number is roughly where the real
   * design starts to break — a hero H1 is set at 68px in a 768px column, so a
   * 200-character headline does not wrap, it wrecks the fold. Enforced on the
   * write path (`marketingSite.setCopy`) so the page cannot be broken from the
   * app, and shown as a counter in the editor so nobody hits it blind.
   */
  maxLen: number;
}

/**
 * Every editable slot on the homepage.
 *
 * The hero headline is TWO keys on purpose. The design sets the second half in
 * red (`<span class="text-red-500">`), and the alternative — one field with
 * markup in it — would mean either shipping raw HTML from a text box to the
 * public site (an injection surface for a convenience nobody asked for) or
 * inventing a markup dialect to strip. Two plain-text fields say the same thing
 * and cannot render anything but text.
 */
export const SITE_COPY_KEYS = [
  "hero.eyebrow",
  "hero.headingLead",
  "hero.headingAccent",
  "hero.body",
  "hero.primaryCtaLabel",
  "hero.secondaryCtaLabel",
  "links.eyebrow",
  "links.headingLead",
  "links.headingAccent",
  "impact.eyebrow",
  "impact.headingLead",
  "impact.headingAccent",
] as const;
export type SiteCopyKey = (typeof SITE_COPY_KEYS)[number];

export const SITE_COPY_DEFS: Record<SiteCopyKey, SiteCopyKeyDef> = {
  "hero.eyebrow": {
    key: "hero.eyebrow",
    section: "hero",
    label: "Eyebrow",
    help: "The small pill above the headline.",
    defaultValue: "Worship with us",
    maxLen: 40,
  },
  "hero.headingLead": {
    key: "hero.headingLead",
    section: "hero",
    label: "Headline — first part",
    help: "Set in black. The sentence starts here.",
    defaultValue: "Together, Let's Forge a Future of",
    maxLen: 90,
  },
  "hero.headingAccent": {
    key: "hero.headingAccent",
    section: "hero",
    label: "Headline — red part",
    help: "The rest of the same sentence, set in red.",
    defaultValue: "Bold and Radical Jesus Worship",
    maxLen: 90,
  },
  "hero.body": {
    key: "hero.body",
    section: "hero",
    label: "Sub-headline",
    help: "The paragraph under the headline.",
    defaultValue:
      "We're building a Revelations 7:9 future where every nation, tribe and tongue will worship God in spirit and in truth.",
    multiline: true,
    maxLen: 260,
  },
  "hero.primaryCtaLabel": {
    key: "hero.primaryCtaLabel",
    section: "hero",
    label: "Red button",
    help: "Always links to the giving page.",
    defaultValue: "Make a Donation",
    maxLen: 30,
  },
  "hero.secondaryCtaLabel": {
    key: "hero.secondaryCtaLabel",
    section: "hero",
    label: "Outline button",
    help: "Always links to the About page.",
    defaultValue: "About Public Worship",
    maxLen: 30,
  },
  "links.eyebrow": {
    key: "links.eyebrow",
    section: "links",
    label: "Eyebrow",
    help: "The small pill above the Important Links heading.",
    defaultValue: "Public Worship",
    maxLen: 40,
  },
  "links.headingLead": {
    key: "links.headingLead",
    section: "links",
    label: "Heading — first part",
    help: "Set in black.",
    defaultValue: "Important",
    maxLen: 60,
  },
  "links.headingAccent": {
    key: "links.headingAccent",
    section: "links",
    label: "Heading — red part",
    help: "Set in red.",
    defaultValue: "Links",
    maxLen: 60,
  },
  "impact.eyebrow": {
    key: "impact.eyebrow",
    section: "impact",
    label: "Eyebrow",
    help: "The small pill above the impact numbers.",
    defaultValue: "Impact",
    maxLen: 40,
  },
  "impact.headingLead": {
    key: "impact.headingLead",
    section: "impact",
    label: "Heading — red part",
    help: "This heading leads with the red words.",
    defaultValue: "Transformative Impact",
    maxLen: 60,
  },
  "impact.headingAccent": {
    key: "impact.headingAccent",
    section: "impact",
    label: "Heading — black part",
    help: "The rest of the heading, in black.",
    defaultValue: "of Our Hard Work",
    maxLen: 60,
  },
};

/** Type guard — the write path's validator and the landing renderer's key
 *  filter share one rule, so an unknown key is rejected identically in both. */
export function isSiteCopyKey(key: string): key is SiteCopyKey {
  return (SITE_COPY_KEYS as readonly string[]).includes(key);
}

/** Every slot filled: stored values where they exist, shipped defaults where
 *  they do not. The ONE place "what does the page actually say" is decided, so
 *  a half-seeded deployment renders a complete page rather than a hole. */
export function resolveSiteCopy(
  stored: Partial<Record<SiteCopyKey, string>>,
): Record<SiteCopyKey, string> {
  const out = {} as Record<SiteCopyKey, string>;
  for (const key of SITE_COPY_KEYS) {
    const value = stored[key]?.trim();
    out[key] = value && value.length > 0 ? value : SITE_COPY_DEFS[key].defaultValue;
  }
  return out;
}

// ── Impact stats ─────────────────────────────────────────────────────────────

/** One "Transformative Impact" card, on the wire. `value` is a STRING, not a
 *  number: the real cards read "700,000+" and "15+", and the "+" is the honest
 *  part — these are floors the org is willing to stand behind, not counts. */
export interface PublicSiteStat {
  id: string;
  value: string;
  label: string;
  sublabel: string | null;
}

/** Layout bounds, same reasoning as `SiteCopyKeyDef.maxLen`. */
export const SITE_STAT_VALUE_MAX = 20;
export const SITE_STAT_LABEL_MAX = 60;
export const SITE_STAT_SUBLABEL_MAX = 240;
/** Three cards fill the row; the grid is `sm:grid-cols-3`, so a fourth starts a
 *  second row of one. Six is two clean rows and well past anything real. */
export const SITE_STAT_MAX_COUNT = 6;

// ── Important Links ──────────────────────────────────────────────────────────

/** How a card's contents sit inside it. Mirrors `LinkCard.astro`. */
export const SITE_LINK_ALIGNS = ["center", "topLeft"] as const;
export type SiteLinkAlign = (typeof SITE_LINK_ALIGNS)[number];

/**
 * What a row in the Important Links grid IS.
 *
 *  `link`   a fixed card — a URL, or a string to copy (the Zelle card).
 *  `events` THE placeholder for the live event cards.
 *  `posts`  THE placeholder for the latest blog posts.
 *
 * The two AUTO kinds behave identically and are singletons: exactly one row may
 * carry each, and neither is deletable. Deleting one would not remove its cards
 * from the page — it would remove the marketer's only handle on where they land
 * and how many show. `published: false` is how you take them off the page.
 *
 * They are separate kinds rather than one `auto` kind with a source field
 * because the two answer to different questions — "what is happening next" vs
 * "what did we last publish" — and a marketer choosing a row's SOURCE from a
 * dropdown is a worse affordance than choosing the row they want.
 */
export const SITE_LINK_KINDS = ["link", "events", "posts"] as const;
export type SiteLinkKind = (typeof SITE_LINK_KINDS)[number];

/** One card in the Important Links grid, on the wire. */
export interface PublicSiteLink {
  id: string;
  kind: SiteLinkKind;
  title: string;
  subtitle: string | null;
  /** Where the card goes. Absent on a copy-only card and on the events row. */
  url: string | null;
  /** Small logo above the text (`/links/instagram-photo.png`, or an uploaded
   *  image served from `GET /api/site/link-image/<id>`). */
  thumbnail: string | null;
  /** Full-bleed photo background — the poster-style card. */
  bgImage: string | null;
  /** A small line under the subtitle ("(Click to Copy)"). */
  cta: string | null;
  /** Text the card copies to the clipboard instead of navigating. */
  copy: string | null;
  align: SiteLinkAlign;
  /**
   * `kind: "events"` only — how many live event cards to show here. 0 keeps
   * the row (and its position) while showing nothing, which is different from
   * unpublishing it only in that the marketer can see it is deliberate.
   */
  maxEvents: number | null;
  /**
   * `kind: "events"` only — RSVP slugs to show ahead of the automatic
   * selection, in this order. The override the desk was asked for: an event
   * that is published but weeks out, or one the team wants leading the grid
   * before it would naturally surface. A slug that names nothing publishable
   * is skipped, never rendered as a dead card.
   */
  pinnedEventSlugs: string[] | null;
  /**
   * `kind: "events"` only — RSVP slugs to keep OUT of the grid even though
   * they would otherwise qualify. The other half of the override: a
   * team-only or invite-only event whose RSVP page is public but which has no
   * business on the front page.
   */
  hiddenEventSlugs: string[] | null;
  /**
   * `kind: "posts"` only — how many published posts to show, newest first. The
   * events row's `maxEvents`, asked about posts; 0 keeps the row and its
   * position while showing nothing.
   */
  maxPosts: number | null;
  /**
   * `kind: "posts"` only — post slugs to show ahead of the automatic selection,
   * in this order. An evergreen essay the team wants leading the grid rather
   * than whatever happened to go up last. A slug naming nothing PUBLISHED is
   * skipped, never rendered as a dead card — the same "intent, not reference"
   * rule the event pins follow, and for the same reason: a post can be taken
   * down, and a pin surviving that must not put a 404 on the front page.
   */
  pinnedPostSlugs: string[] | null;
  /**
   * `kind: "posts"` only — post slugs to keep OUT of the grid though published.
   * A post that is public but not front-page material.
   */
  hiddenPostSlugs: string[] | null;
}

export const SITE_LINK_TITLE_MAX = 60;
export const SITE_LINK_SUBTITLE_MAX = 120;
export const SITE_LINK_CTA_MAX = 40;
export const SITE_LINK_COPY_MAX = 200;
export const SITE_LINK_URL_MAX = 500;
/** Well past the ~6 cards the grid has ever held, and a bound on the read. */
export const SITE_LINK_MAX_COUNT = 30;
/** The grid reserves room for the auto events; more than this and the fixed
 *  cards start scrolling off a phone before anyone reaches the socials. */
export const SITE_LINK_MAX_EVENTS_CAP = 4;
/** Same bound, same reason, for the posts row. Lower than the events cap on
 *  purpose: an event card is a thing you can attend on a date, and a post is
 *  something to read — three of them above the socials is already a lot of
 *  reading to put in front of somebody looking for the Give button. */
export const SITE_LINK_MAX_POSTS_CAP = 3;

/**
 * URL schemes a card may point at. A card's `url` is typed into the OS by a
 * trusted seat and rendered into an `href` on the public site — which is
 * exactly the shape that makes `javascript:` and `data:` worth naming as
 * rejected rather than assumed absent. A site-relative path (`/give`) is the
 * common case and is allowed by the leading-slash branch in `isAllowedLinkUrl`.
 */
export const SITE_LINK_URL_SCHEMES = ["http:", "https:", "mailto:", "tel:"] as const;

/**
 * Whether a card's URL is one the public page may render. Shared so the write
 * path and the renderer agree; see `SITE_LINK_URL_SCHEMES`.
 *
 * Distinct from `emailBlocks.ts`'s `isAllowedLinkUrl`, and the two must not be
 * merged: an email button's href has to be absolute (there is no "this site"
 * inside an inbox) and never wants `tel:`, while a homepage card's most common
 * href is `/give`. Same shape of check, genuinely different allowed sets.
 */
export function isAllowedSiteLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > SITE_LINK_URL_MAX) return false;
  // Site-relative. Rejects "//evil.example" (protocol-relative), which reads
  // like a path and is not one.
  if (trimmed.startsWith("/")) return !trimmed.startsWith("//");
  try {
    const parsed = new URL(trimmed);
    return (SITE_LINK_URL_SCHEMES as readonly string[]).includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * One live event card, already chosen and ordered by the OS.
 *
 * Same fields `GET /api/events/upcoming` has always returned — this is that
 * feed's payload, moved inside the homepage document so the SELECTION (the
 * marketer's pins, hides, and count) happens once, on the server, instead of
 * being re-derived by a page that cannot see the overrides.
 */
export interface PublicSiteEventCard {
  slug: string;
  title: string;
  tagline: string | null;
  venueName: string | null;
  startDate: number;
  endDate: number | null;
  /** The RSVP page's path on this site. */
  href: string;
  coverUrl: string | null;
  coverFocalX: number;
  coverFocalY: number;
  /** True when this card is here because someone pinned it, rather than
   *  because it is the next thing happening. Shown only in the OS's preview —
   *  the public card is identical either way. */
  pinned: boolean;
}

/**
 * One blog post card, already chosen and ordered by the OS.
 *
 * Deliberately NOT `BlogPostSummary` from `marketingBlog.ts`. That type is the
 * blog index's payload and carries fields the homepage has no use for
 * (`status`, `updatedAt`, the preview token). This is the homepage's own view
 * of a post — the four things a link card renders — so the two can move
 * independently, and so a field added for the blog index cannot silently start
 * being published on the front page.
 */
export interface PublicSitePostCard {
  slug: string;
  title: string;
  /** The post's own excerpt, already trimmed by the OS. Null when it has none;
   *  the card then renders title-only rather than an invented summary. */
  excerpt: string | null;
  /** The post's path on this site — `/blog/<slug>`. */
  href: string;
  /** Hero image, when the post has one. */
  coverUrl: string | null;
  /** When it went live. The card shows a date; the ORDER is the OS's. */
  publishedAt: number;
  /** True when a human pinned this rather than it being the newest. Shown only
   *  in the desk's preview — the public card is identical either way. */
  pinned: boolean;
}

// ── The wire contract ────────────────────────────────────────────────────────

/**
 * Everything the public homepage reads from the OS, in one document.
 *
 * ONE payload rather than three endpoints, because the page needs all of it to
 * render one screen and three round-trips would be three chances to render half
 * an update. Served by `GET /api/site/home`.
 */
export interface PublicSiteContent {
  copy: Record<SiteCopyKey, string>;
  stats: PublicSiteStat[];
  /** Published cards only, in render order, including the `events` row (when
   *  published) at its own position. */
  links: PublicSiteLink[];
  /**
   * The live event cards to render AT the `events` row's position, already
   * filtered, ordered, and capped. Empty when nothing qualifies, when the row
   * is unpublished, or when `maxEvents` is 0 — the renderer does not need to
   * know which.
   */
  events: PublicSiteEventCard[];
  /**
   * The blog post cards to render AT the `posts` row's position, already
   * filtered, ordered, and capped. Empty when nothing is published, when the
   * row is unpublished, or when `maxPosts` is 0 — same as `events`, the
   * renderer does not need to know which.
   */
  posts: PublicSitePostCard[];
}

// ── The mailing list ─────────────────────────────────────────────────────────

/**
 * The two lists the desk keeps.
 *
 * They are NOT one list with two columns, and the difference is consent: an
 * email address on the newsletter and a phone number that agreed to be texted
 * are two separate promises, governed by two separate ledgers
 * (`emailSuppressions` and `smsOptOuts`), and someone can be on one and off the
 * other. The desk shows them as two tabs for that reason and not for layout.
 */
export const MAILING_CHANNELS = ["email", "sms"] as const;
export type MailingChannel = (typeof MAILING_CHANNELS)[number];

/**
 * Why someone is not reachable on a channel — the desk's whole vocabulary for
 * "we are not contacting this person", in the order the backend checks it.
 *
 * `opted_out` and `suppressed` are BOTH shown, separately, on purpose. They
 * look the same to a sender and are completely different to a marketer:
 * `opted_out` is a person-level "stop" someone at the org set and can lift with
 * the person's say-so; `suppressed` is address-level and came from the outside
 * world — an unsubscribe click, a hard bounce, a spam complaint — and is never
 * lifted from this desk. Collapsing them into one "unsubscribed" chip is how a
 * team ends up re-adding a complainer.
 */
export const MAILING_EXCLUSIONS = [
  "opted_out",
  "suppressed",
  "no_address",
  "inactive",
] as const;
export type MailingExclusion = (typeof MAILING_EXCLUSIONS)[number];

export const MAILING_EXCLUSION_LABELS: Record<MailingExclusion, string> = {
  opted_out: "Opted out",
  suppressed: "Unsubscribed or bounced",
  no_address: "No address on file",
  inactive: "Inactive",
};

/** One row on the mailing-list desk. A VIEW over `people` — never its own
 *  table, so a person edited on the People tab is the same person here. */
export interface MailingListRow {
  personId: string;
  name: string;
  /** The address or number this person would actually be reached at — the
   *  resolved one (`lib/personEmails.ts#resolveSendAddress`), not whatever is
   *  in the roster column. Null when there is none. */
  destination: string | null;
  /** Empty when this person is reachable on this channel. */
  exclusions: MailingExclusion[];
  chapterName: string | null;
  /** When they said yes, if the org ever recorded it. */
  consentedAt: number | null;
  consentSource: string | null;
  addedAt: number;
}

/** How someone got onto the list. Stored verbatim into `people.consentSource`,
 *  so it survives as prose in the person's record. */
export const MAILING_SIGNUP_SOURCE = "Public signup form";
export const MAILING_MANUAL_SOURCE = "Added by the marketing desk";
