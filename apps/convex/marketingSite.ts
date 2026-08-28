/**
 * THE PUBLIC SITE'S CONTENT — the Marketing desk's write surface for
 * publicworship.life's homepage.
 *
 * Read `schema/marketing.ts` for the tables and `@events-os/shared`'s
 * `marketing.ts` for the vocabulary and the wire contract. This module is the
 * functions: what the desk reads, what it may change, and the ONE serializer
 * that turns rows into the JSON the public page renders.
 *
 * ── The shape this copies ───────────────────────────────────────────────────
 * `listings.ts`, exactly: rows in Convex, a public feed the page fetches at
 * runtime (`GET /api/site/home` via `lib/marketingApiRoutes.ts`), and
 * `requireSiteEdit` on every write. The reason it is worth copying twice is
 * that it is the only arrangement where a marketer changing a headline does
 * not need a developer, a pull request, and a deploy — which was the actual
 * problem.
 *
 * ── Why the events row resolves HERE ────────────────────────────────────────
 * The page used to pick its own event cards: fetch `/api/events/upcoming`,
 * take the first two, drop them in a hardcoded slot. That worked while the
 * selection had no policy in it. It now does — a count, a pin list, a hide
 * list, all set by a human in the OS — and a page cannot apply a policy it
 * cannot see. So `resolveEventCards` runs on this side and the payload carries
 * finished cards. The old `/api/events/upcoming` endpoint is untouched and
 * still serves anything else that wants the raw upcoming list.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 * The mailing list. It shares a desk with this and nothing else: this file is
 * public content by definition and is served unauthenticated; that one is
 * nothing but PII and has no public read surface at all. See `mailingList.ts`.
 */
import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  SITE_COPY_KEYS,
  SITE_LINK_ALIGNS,
  SITE_LINK_MAX_COUNT,
  SITE_LINK_MAX_EVENTS_CAP,
  SITE_LINK_MAX_POSTS_CAP,
  SITE_LINK_CTA_MAX,
  SITE_LINK_COPY_MAX,
  SITE_LINK_SUBTITLE_MAX,
  SITE_LINK_TITLE_MAX,
  SITE_STAT_LABEL_MAX,
  SITE_STAT_MAX_COUNT,
  SITE_STAT_SUBLABEL_MAX,
  SITE_STAT_VALUE_MAX,
  SITE_COPY_DEFS,
  blogPostPath,
  isAllowedSiteLinkUrl,
  resolveSiteCopy,
  type PublicSiteContent,
  type PublicSiteEventCard,
  type PublicSiteLink,
  type PublicSitePostCard,
  type PublicSiteStat,
  type SiteCopyKey,
} from "@events-os/shared";
import { requireSiteEdit, resolveMarketingAccess } from "./lib/marketingAccess";
import { requireUserId } from "./lib/context";
import { SITE_LINK_SEED, SITE_STAT_SEED } from "./lib/seed/siteContent";
import {
  listPickableEventPages,
  listUpcomingEventPages,
} from "./lib/upcomingEvents";

/** Generous bound — the grid has never held more than six cards. */
const LINK_SCAN_LIMIT = 100;
/** Same, for the impact row. */
const STAT_SCAN_LIMIT = 50;
/** How far into the upcoming list to look when honoring pins. A pinned event
 *  may be weeks out and therefore well down the date-sorted list; this is the
 *  window a pin can reach into. `listPublishedUpcoming` caps at 24 anyway. */
const UPCOMING_LOOKAHEAD = 24;
/** How far into the published posts to look when honoring pins — the same
 *  window `UPCOMING_LOOKAHEAD` gives an event pin, for the same reason: a
 *  pinned essay may be well down a list ordered by publication date. */
const PUBLISHED_POSTS_LOOKBACK = 24;
/** How many posts the desk's pin/hide picker offers. A blog this size will not
 *  reach it for years, and it bounds the read. */
const POST_PICKER_LIMIT = 30;
/** How far back the desk's event picker reaches. A season, so a marketer can
 *  still see (and un-hide) something that ran last month. */
const PICKER_LOOKBACK_DAYS = 90;
/** Order values are spaced this far apart so a reorder rewrites one row. */
const ORDER_STEP = 100;

const alignValidator = v.union(...SITE_LINK_ALIGNS.map((a) => v.literal(a)));
const copyKeyValidator = v.union(...SITE_COPY_KEYS.map((k) => v.literal(k)));

// ── input hygiene ────────────────────────────────────────────────────────────

/** Trim; treat an empty string as "not set" so a cleared field stops being
 *  stored at all rather than persisting as `""` the renderer has to special-case. */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Enforce a layout bound, naming the field.
 *
 * A throw rather than a truncation, deliberately: silently cutting a headline
 * at 90 characters publishes a sentence nobody wrote. `SiteCopyKeyDef.maxLen`'s
 * doc has the rest of the reasoning.
 */
function requireWithin(
  value: string | undefined,
  max: number,
  field: string,
): void {
  if (value !== undefined && value.length > max) {
    throw new ConvexError({
      code: "TOO_LONG",
      message: `${field} is too long for the page — keep it under ${max} characters.`,
    });
  }
}

/** Trim, drop blanks, dedupe, preserving first-seen order. Used for the pin
 *  and hide slug lists, where a duplicate is a typo and an empty entry is a
 *  half-finished edit. */
function cleanSlugs(slugs: string[] | undefined): string[] | undefined {
  if (slugs === undefined) return undefined;
  const seen = new Set<string>();
  for (const raw of slugs) {
    const s = raw.trim();
    if (s.length > 0) seen.add(s);
  }
  return [...seen];
}

/**
 * The posts row's count, checked.
 *
 * Refused, not clamped, on the way IN: silently showing two posts when a
 * marketer asked for five is the same lie as truncating a headline (see
 * `requireWithin`). `resolvePostCards` still clamps on the way OUT, which
 * covers a row written before the cap was what it is now. Shared by the two
 * write paths (`upsertLink` and `setPostsRow`) so they cannot disagree about
 * what a legal count is.
 */
function requireValidMaxPosts(maxPosts: number): void {
  if (
    !Number.isInteger(maxPosts) ||
    maxPosts < 0 ||
    maxPosts > SITE_LINK_MAX_POSTS_CAP
  ) {
    throw new ConvexError({
      code: "OUT_OF_RANGE",
      message: `Show between 0 and ${SITE_LINK_MAX_POSTS_CAP} blog posts.`,
    });
  }
}

// ── serialization ────────────────────────────────────────────────────────────

/** Where an uploaded card image is served from. Mirrors `rsvpPath(slug,
 *  "cover")` — a same-origin path pw-router already proxies to Convex, so an
 *  uploaded thumbnail needs no CORS story and no signed URL. */
function linkImagePath(id: Id<"siteLinks">, which: "thumb" | "bg"): string {
  return `/api/site/link-image/${id}/${which}`;
}

/**
 * The wire shape the public page consumes. The ONE place a `siteLinks` row
 * becomes public JSON — the landing renderer speaks the same shared type, so
 * this is the seam that must not drift.
 *
 * An OS upload wins over a `/public` path when both are set, so replacing a
 * repo image with an upload needs no cleanup of the old field.
 */
function serializeLink(doc: Doc<"siteLinks">): PublicSiteLink {
  return {
    id: String(doc._id),
    kind: doc.kind,
    title: doc.title,
    subtitle: doc.subtitle ?? null,
    url: doc.url ?? null,
    thumbnail: doc.thumbnailStorage
      ? linkImagePath(doc._id, "thumb")
      : (doc.thumbnailPath ?? null),
    bgImage: doc.bgImageStorage
      ? linkImagePath(doc._id, "bg")
      : (doc.bgImagePath ?? null),
    cta: doc.cta ?? null,
    copy: doc.copy ?? null,
    align: doc.align,
    // The auto rows' CONTROLS are desk-only — see `serializeLinkForDesk`.
    maxEvents: null,
    pinnedEventSlugs: null,
    hiddenEventSlugs: null,
    maxPosts: null,
    pinnedPostSlugs: null,
    hiddenPostSlugs: null,
  };
}

/**
 * The desk's view of a card: the public shape plus the fields only the desk
 * needs.
 *
 * The events row's `hiddenEventSlugs` is the reason this split exists. Its
 * documented use is keeping a team-only or invite-only gathering off the front
 * page, so the list is a small inventory of "events we have deliberately not
 * advertised" — and `GET /api/site/home` is read by anyone. The page never
 * needed those fields (the OS already resolved the selection into
 * `content.events`), so publishing them was pure leak with no consumer.
 *
 * `hiddenPostSlugs` is the same inventory about the blog — "published, but not
 * something we put on the front page" is a judgment about our own writing, and
 * it stays on this side of the wire for the same reason.
 */
function serializeLinkForDesk(
  doc: Doc<"siteLinks">,
): PublicSiteLink & { published: boolean; order: number } {
  return {
    ...serializeLink(doc),
    maxEvents: doc.kind === "events" ? (doc.maxEvents ?? 0) : null,
    pinnedEventSlugs: doc.kind === "events" ? (doc.pinnedEventSlugs ?? []) : null,
    hiddenEventSlugs: doc.kind === "events" ? (doc.hiddenEventSlugs ?? []) : null,
    maxPosts: doc.kind === "posts" ? (doc.maxPosts ?? 0) : null,
    pinnedPostSlugs: doc.kind === "posts" ? (doc.pinnedPostSlugs ?? []) : null,
    hiddenPostSlugs: doc.kind === "posts" ? (doc.hiddenPostSlugs ?? []) : null,
    published: doc.published,
    order: doc.order,
  };
}

function serializeStat(doc: Doc<"siteStats">): PublicSiteStat {
  return {
    id: String(doc._id),
    value: doc.value,
    label: doc.label,
    sublabel: doc.sublabel ?? null,
  };
}

/** Every stored copy row, as a partial map. Unset keys fall back to their
 *  shipped `defaultValue` in `resolveSiteCopy` — see that function's doc. */
async function readCopy(
  ctx: QueryCtx,
): Promise<Partial<Record<SiteCopyKey, string>>> {
  const rows = await ctx.db.query("siteCopy").take(SITE_COPY_KEYS.length * 2);
  const out: Partial<Record<SiteCopyKey, string>> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/**
 * The live event cards for the `events` row, with the desk's overrides applied.
 *
 * The rule, in order:
 *  1. Start from `ticketing.listPublishedUpcoming` — published, non-training,
 *     not yet past, soonest first. A pin can only REORDER what is already
 *     publishable: pinning an unpublished page would put a 404 on the front
 *     page, which is a worse outcome than the pin not working.
 *  2. Drop anything in `hiddenEventSlugs`.
 *  3. Lift anything in `pinnedEventSlugs` to the front, in the order the
 *     marketer listed them — that ordering is the point of the feature.
 *  4. Take `maxEvents`.
 *
 * A pinned slug that names nothing publishable is skipped silently. That is the
 * documented behavior of a pin list (see `siteLinks`'s doc): it is an intent,
 * not a reference, so a stale entry costs nothing and needs no cleanup.
 */
async function resolveEventCards(
  ctx: QueryCtx,
  row: Doc<"siteLinks"> | undefined,
): Promise<PublicSiteEventCard[]> {
  if (!row || row.kind !== "events" || !row.published) return [];
  const max = Math.max(0, Math.min(row.maxEvents ?? 0, SITE_LINK_MAX_EVENTS_CAP));
  if (max === 0) return [];

  const upcoming = await listUpcomingEventPages(ctx, UPCOMING_LOOKAHEAD);

  const hidden = new Set(row.hiddenEventSlugs ?? []);
  const pinned = row.pinnedEventSlugs ?? [];
  const bySlug = new Map(upcoming.map((e) => [e.slug, e]));

  const ordered: { event: (typeof upcoming)[number]; pinned: boolean }[] = [];
  const taken = new Set<string>();
  for (const slug of pinned) {
    if (hidden.has(slug)) continue; // hide beats pin — the later, narrower "no"
    const event = bySlug.get(slug);
    if (!event) continue; // stale pin: an intent, not a reference
    ordered.push({ event, pinned: true });
    taken.add(slug);
  }
  for (const event of upcoming) {
    if (hidden.has(event.slug) || taken.has(event.slug)) continue;
    ordered.push({ event, pinned: false });
  }

  return ordered.slice(0, max).map(({ event, pinned: isPinned }) => ({
    slug: event.slug,
    title: event.eventName,
    tagline: event.tagline,
    venueName: event.venueName,
    startDate: event.startDate,
    endDate: event.endDate,
    // Matches `rsvpPath` in `http.ts` — the canonical prefix, not an alias.
    href: `/rsvp/${event.slug}`,
    coverUrl: event.hasCover ? `/rsvp/${event.slug}/cover` : null,
    coverFocalX: event.coverFocalX,
    coverFocalY: event.coverFocalY,
    pinned: isPinned,
  }));
}

/**
 * A post's hero image, as a servable URL.
 *
 * The same two-step `marketingBlog.ts#heroUrl` does — cached URL first, live
 * `getUrl` when the cache was never written — restated here because that one is
 * module-private to the blog's own file. It is three lines and no policy; if it
 * ever grows a rule, export it there and delete this. What must NOT happen is
 * this side reading `heroImageUrl` alone, which would silently drop the image
 * on any row seeded or written before the cache existed.
 */
async function postCoverUrl(
  ctx: QueryCtx,
  doc: Doc<"blogPosts">,
): Promise<string | null> {
  if (doc.heroImageUrl) return doc.heroImageUrl;
  if (!doc.heroStorage) return null;
  return await ctx.storage.getUrl(doc.heroStorage);
}

/**
 * The blog cards for the `posts` row, with the desk's overrides applied.
 *
 * `resolveEventCards`, asked about posts — same rule, same order, and
 * deliberately the same shape so the two rows cannot drift into behaving
 * differently for reasons nobody chose:
 *  1. Start from PUBLISHED posts, newest first (`by_status_published`, so this
 *     never walks the drafts). A pin can only REORDER what is already public:
 *     pinning a draft would put a 404 on the front page.
 *  2. Drop anything in `hiddenPostSlugs`.
 *  3. Lift anything in `pinnedPostSlugs` to the front, in the marketer's order.
 *  4. Take `maxPosts`, clamped to `SITE_LINK_MAX_POSTS_CAP`.
 *
 * A pinned slug naming nothing published is skipped silently — intent, not
 * reference, exactly as for events. Hide beats pin, being the later and
 * narrower "no".
 */
async function resolvePostCards(
  ctx: QueryCtx,
  row: Doc<"siteLinks"> | undefined,
): Promise<PublicSitePostCard[]> {
  if (!row || row.kind !== "posts" || !row.published) return [];
  // Clamped on the READ path as well as validated on the write path: a row
  // written before the cap was lowered must not out-vote the current cap.
  const max = Math.max(0, Math.min(row.maxPosts ?? 0, SITE_LINK_MAX_POSTS_CAP));
  if (max === 0) return [];

  const posts = await ctx.db
    .query("blogPosts")
    .withIndex("by_status_published", (q) => q.eq("status", "published"))
    .order("desc")
    .take(PUBLISHED_POSTS_LOOKBACK);

  const hidden = new Set(row.hiddenPostSlugs ?? []);
  const pinned = row.pinnedPostSlugs ?? [];
  const bySlug = new Map(posts.map((p) => [p.slug, p]));

  const ordered: { post: Doc<"blogPosts">; pinned: boolean }[] = [];
  const taken = new Set<string>();
  for (const slug of pinned) {
    if (hidden.has(slug)) continue; // hide beats pin — the later, narrower "no"
    const post = bySlug.get(slug);
    if (!post) continue; // stale pin: an intent, not a reference
    ordered.push({ post, pinned: true });
    taken.add(slug);
  }
  for (const post of posts) {
    if (hidden.has(post.slug) || taken.has(post.slug)) continue;
    ordered.push({ post, pinned: false });
  }

  return await Promise.all(
    ordered.slice(0, max).map(async ({ post, pinned: isPinned }) => ({
      slug: post.slug,
      title: post.title,
      // Straight through, untrimmed and un-truncated: this is the same
      // sentence the post's own page and the blog index show, and the whole
      // point of reusing it is that there is only one of it to keep true.
      description: post.description,
      // The shared path helper, never a retyped string: the page, the feed,
      // the sitemap, and this card must agree on where a post lives.
      href: blogPostPath(post.slug),
      coverUrl: await postCoverUrl(ctx, post),
      // `setPostStatus` stamps `publishedAt` on the way to "published", so a
      // row reached through this index has one. The fallback keeps a
      // hand-written row from rendering an empty date rather than a wrong one.
      publishedAt: post.publishedAt ?? post._creationTime,
      pinned: isPinned,
    })),
  );
}

// ── Public read (no auth) ────────────────────────────────────────────────────

/**
 * Everything the public homepage renders, in one document.
 *
 * Internal because its ONLY caller is the HTTP route
 * (`lib/marketingApiRoutes.ts`) — the same arrangement `listings.publicListings`
 * uses. Unauthenticated by design: every row it returns is content written to
 * be read by strangers (see `schema/marketing.ts`'s disclosure note).
 *
 * Unpublished cards are dropped here rather than filtered by the caller, so
 * there is exactly one place a draft can leak from and it is this line.
 */
export const publicSiteContent = internalQuery({
  args: {},
  handler: async (ctx): Promise<PublicSiteContent> => {
    const links = await ctx.db
      .query("siteLinks")
      .withIndex("by_order")
      .take(LINK_SCAN_LIMIT);
    const stats = await ctx.db
      .query("siteStats")
      .withIndex("by_order")
      .take(STAT_SCAN_LIMIT);

    const published = links.filter((l) => l.published);
    const eventsRow = published.find((l) => l.kind === "events");
    const postsRow = published.find((l) => l.kind === "posts");

    return {
      copy: resolveSiteCopy(await readCopy(ctx)),
      stats: stats.map(serializeStat),
      links: published.map(serializeLink),
      events: await resolveEventCards(ctx, eventsRow),
      posts: await resolvePostCards(ctx, postsRow),
    };
  },
});

/** The storage id behind an uploaded card image, for the public image route.
 *  Returns null for a card that has none, so the route 404s rather than
 *  throwing. */
export const getLinkImageStorageId = internalQuery({
  args: { linkId: v.string(), which: v.union(v.literal("thumb"), v.literal("bg")) },
  handler: async (ctx, { linkId, which }) => {
    // The id comes off a URL path, so it may be anything at all.
    const normalized = ctx.db.normalizeId("siteLinks", linkId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc) return null;
    return (which === "thumb" ? doc.thumbnailStorage : doc.bgImageStorage) ?? null;
  },
});

// ── The desk ─────────────────────────────────────────────────────────────────

/** The caller's reach on the Marketing desk — the nav gate and the per-tab
 *  gate, resolved once. Quiet for a signed-out caller (see
 *  `resolveMarketingAccess`). */
export const myMarketingAccess = query({
  args: {},
  returns: v.object({
    canViewDesk: v.boolean(),
    canEditSite: v.boolean(),
    canEditDesigns: v.boolean(),
    canEditBlog: v.boolean(),
    canPublishBlog: v.boolean(),
    canViewList: v.boolean(),
    canEditList: v.boolean(),
  }),
  handler: async (ctx) => {
    const access = await resolveMarketingAccess(ctx);
    return {
      canViewDesk: access.canViewDesk,
      canEditSite: access.canEditSite,
      canEditDesigns: access.canEditDesigns,
      canEditBlog: access.canEditBlog,
      canPublishBlog: access.canPublishBlog,
      // "Anywhere" rather than "at central" — a chapter Marketing Lead's desk
      // is real, it is just narrower. The list screen resolves the scope.
      canViewList:
        access.centralListView || access.listViewChapters.size > 0 || access.isSuperuser,
      canEditList:
        access.centralListEdit || access.listEditChapters.size > 0 || access.isSuperuser,
    };
  },
});

/**
 * Everything the Site tab shows: every card (drafts included), every stat, and
 * every copy slot already resolved to what the page currently says.
 *
 * Also returns the live event cards the `events` row would produce right now,
 * and the blog cards the `posts` row would, so the desk answers "what will the
 * page look like?" without the marketer having to open the site in another tab
 * and refresh it. Both previews are the SAME `resolveEventCards` /
 * `resolvePostCards` calls the public feed makes — a second implementation
 * would be a preview that can lie.
 */
export const siteContent = query({
  args: {},
  handler: async (ctx) => {
    await requireSiteEdit(ctx);
    const links = await ctx.db
      .query("siteLinks")
      .withIndex("by_order")
      .take(LINK_SCAN_LIMIT);
    const stats = await ctx.db
      .query("siteStats")
      .withIndex("by_order")
      .take(STAT_SCAN_LIMIT);
    const eventsRow = links.find((l) => l.kind === "events");
    const postsRow = links.find((l) => l.kind === "posts");

    return {
      copy: resolveSiteCopy(await readCopy(ctx)),
      stats: stats.map(serializeStat),
      links: links.map(serializeLinkForDesk),
      // Unpublishing a row hides its cards from the page but NOT from this
      // preview — the marketer needs to see what turning it back on would do.
      eventPreview: await resolveEventCards(
        ctx,
        eventsRow ? { ...eventsRow, published: true } : undefined,
      ),
      postPreview: await resolvePostCards(
        ctx,
        postsRow ? { ...postsRow, published: true } : undefined,
      ),
    };
  },
});

/** Write one copy slot. An empty value DELETES the row, which restores the
 *  shipped default rather than blanking the page — the only sane reading of
 *  "clear this field" for a slot the layout requires. */
export const setCopy = mutation({
  args: { key: copyKeyValidator, value: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, value }) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const trimmed = value.trim();
    requireWithin(trimmed, SITE_COPY_DEFS[key].maxLen, SITE_COPY_DEFS[key].label);

    const existing = await ctx.db
      .query("siteCopy")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();

    if (trimmed.length === 0) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const patch = { value: trimmed, updatedAt: Date.now(), updatedBy: userId };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("siteCopy", { key, ...patch });
    return null;
  },
});

// ── Impact stats ─────────────────────────────────────────────────────────────

/** Create or update one impact card. A new card lands at the end of the row. */
export const upsertStat = mutation({
  args: {
    statId: v.optional(v.id("siteStats")),
    value: v.string(),
    label: v.string(),
    sublabel: v.optional(v.string()),
  },
  returns: v.id("siteStats"),
  handler: async (ctx, args) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const value = clean(args.value);
    const label = clean(args.label);
    const sublabel = clean(args.sublabel);
    if (!value || !label) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "An impact card needs both a number and a label.",
      });
    }
    requireWithin(value, SITE_STAT_VALUE_MAX, "The number");
    requireWithin(label, SITE_STAT_LABEL_MAX, "The label");
    requireWithin(sublabel, SITE_STAT_SUBLABEL_MAX, "The description");

    const now = Date.now();
    if (args.statId) {
      const existing = await ctx.db.get(args.statId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That impact card no longer exists.",
        });
      }
      await ctx.db.patch(args.statId, {
        value,
        label,
        sublabel,
        updatedAt: now,
        updatedBy: userId,
      });
      return args.statId;
    }

    const existing = await ctx.db.query("siteStats").take(STAT_SCAN_LIMIT);
    if (existing.length >= SITE_STAT_MAX_COUNT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `The impact row holds at most ${SITE_STAT_MAX_COUNT} cards.`,
      });
    }
    const lastOrder = existing.reduce((max, s) => Math.max(max, s.order), 0);
    return await ctx.db.insert("siteStats", {
      value,
      label,
      sublabel,
      order: lastOrder + ORDER_STEP,
      updatedAt: now,
      updatedBy: userId,
    });
  },
});

export const deleteStat = mutation({
  args: { statId: v.id("siteStats") },
  returns: v.null(),
  handler: async (ctx, { statId }) => {
    await requireSiteEdit(ctx);
    const existing = await ctx.db.get(statId);
    if (existing) await ctx.db.delete(statId);
    return null;
  },
});

/**
 * Reorder the impact row by naming the ids in their new order.
 *
 * A whole-list reorder rather than a move-one-row delta, because the caller is
 * a drag-and-drop list that already knows the final order, and because
 * rewriting `order` from a list it supplies cannot leave two cards claiming the
 * same slot. Ids not in the list keep their place after everything named.
 */
export const reorderStats = mutation({
  args: { statIds: v.array(v.id("siteStats")) },
  returns: v.null(),
  handler: async (ctx, { statIds }) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    let order = ORDER_STEP;
    const seen = new Set<string>();
    for (const id of statIds) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      const doc = await ctx.db.get(id);
      if (!doc) continue; // deleted mid-drag — skip, don't fail the whole move
      await ctx.db.patch(id, { order, updatedAt: now, updatedBy: userId });
      order += ORDER_STEP;
    }
    const rest = await ctx.db.query("siteStats").take(STAT_SCAN_LIMIT);
    for (const doc of rest) {
      if (seen.has(String(doc._id))) continue;
      await ctx.db.patch(doc._id, { order, updatedAt: now, updatedBy: userId });
      order += ORDER_STEP;
    }
    return null;
  },
});

// ── Important Links ──────────────────────────────────────────────────────────

/**
 * Create or update one Important Links card.
 *
 * `kind` is settable only on CREATE, and never to `"events"` — that row is
 * created by the seed and edited through `setEventsRow`. Letting an existing
 * card change kind (or a second placeholder of either kind appear) would give
 * the page two placeholders and no rule for which wins, which is why the
 * singleton check below is on the create path rather than in the UI.
 *
 * The POSTS row is CREATED here — `kind: "posts"`, once — and renamed or
 * unpublished here like any row. Its count and slug lists have a second,
 * narrower door in `setPostsRow`, which is what the desk's pickers call; both
 * validate through `requireValidMaxPosts`, and the difference between them is
 * only what an omitted list means (kept here, cleared there — see
 * `postFields`).
 */
export const upsertLink = mutation({
  args: {
    linkId: v.optional(v.id("siteLinks")),
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
    published: v.boolean(),
    /**
     * Remove this card's image entirely — BOTH the OS upload and the
     * repo-path form.
     *
     * Necessary because "not sent" cannot mean "remove" on an update: the
     * editor posts its whole form on every save and carries neither the file
     * bytes nor, for the seeded cards, the `/links/…` path they were authored
     * with. Without an explicit flag, renaming the Instagram card would delete
     * its logo from the live site with no way to put it back from inside the
     * app. So an omitted image field is KEPT and removing one is a deliberate
     * act.
     */
    clearThumbnail: v.optional(v.boolean()),
    clearBgImage: v.optional(v.boolean()),
    /** CREATE only. `"posts"` mints the latest-posts placeholder (at most one
     *  can exist); omitted means an ordinary card. An existing row's kind is
     *  never changed — see this mutation's doc. */
    kind: v.optional(v.union(v.literal("link"), v.literal("posts"))),
    // ── the posts row's controls ─────────────────────────────────────────────
    // Refused on any other row, so a card cannot carry settings that would
    // silently do nothing.
    maxPosts: v.optional(v.number()),
    pinnedPostSlugs: v.optional(v.array(v.string())),
    hiddenPostSlugs: v.optional(v.array(v.string())),
  },
  returns: v.id("siteLinks"),
  handler: async (ctx, args) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const existing = args.linkId ? await ctx.db.get(args.linkId) : null;
    if (args.linkId && !existing) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That card no longer exists.",
      });
    }
    if (existing && existing.kind === "events") {
      throw new ConvexError({
        code: "WRONG_KIND",
        message:
          "The live-events row is edited from the Events section, not as a card.",
      });
    }
    // Decided ONCE, before anything is validated, because half the rules below
    // read differently for a placeholder than for a card. An existing row keeps
    // the kind it was created with.
    const isPostsRow = existing
      ? existing.kind === "posts"
      : args.kind === "posts";

    const postFieldsGiven =
      args.maxPosts !== undefined ||
      args.pinnedPostSlugs !== undefined ||
      args.hiddenPostSlugs !== undefined;
    if (postFieldsGiven && !isPostsRow) {
      throw new ConvexError({
        code: "WRONG_KIND",
        message:
          "Only the latest-posts row chooses which posts to show — an ordinary card has no such setting.",
      });
    }
    if (args.maxPosts !== undefined) requireValidMaxPosts(args.maxPosts);

    const title = clean(args.title);
    const subtitle = clean(args.subtitle);
    const url = clean(args.url);
    const cta = clean(args.cta);
    const copy = clean(args.copy);

    if (!title) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "A card needs a title.",
      });
    }
    requireWithin(title, SITE_LINK_TITLE_MAX, "The title");
    requireWithin(subtitle, SITE_LINK_SUBTITLE_MAX, "The subtitle");
    requireWithin(cta, SITE_LINK_CTA_MAX, "The small line");
    requireWithin(copy, SITE_LINK_COPY_MAX, "The copy-to-clipboard text");

    // A card that neither goes anywhere nor copies anything is a dead tile. The
    // Zelle card is the reason `copy` counts: it navigates nowhere on purpose.
    // The posts row is exempt: it is a placeholder marking where the post cards
    // land, and the cards carry their own hrefs.
    if (!isPostsRow && !url && !copy) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message:
          "A card needs somewhere to go — either a link, or text it copies when tapped.",
      });
    }
    // `LinkCard.astro` (and its runtime twin) treat ANY card with `copy` as a
    // tap-to-copy button, so a card carrying both would silently lose its link.
    // Refused rather than resolved by precedence: whichever way the tie broke,
    // half the people who set both would get the other one.
    if (url && copy) {
      throw new ConvexError({
        code: "AMBIGUOUS_CARD",
        message:
          "A card either goes somewhere or copies something — not both. Clear one of them.",
      });
    }
    if (url && !isAllowedSiteLinkUrl(url)) {
      throw new ConvexError({
        code: "INVALID_URL",
        message:
          "That link isn't one the site can use. Use a full https:// address, an email or phone link, or a path on this site like /give.",
      });
    }

    const now = Date.now();
    const fields = {
      title,
      subtitle,
      url,
      cta,
      copy,
      align: args.align,
      published: args.published,
      updatedAt: now,
      updatedBy: userId,
    };
    // KEEP-IF-NOT-RESENT here too, and for the same reason as the images: the
    // pins and hides are set from their own picker, so a save from the row
    // editor does not carry them — and "not sent" meaning "cleared" would let
    // renaming the row quietly un-hide a post somebody took off the page.
    const postFields = isPostsRow
      ? {
          maxPosts: args.maxPosts ?? existing?.maxPosts ?? 0,
          pinnedPostSlugs:
            cleanSlugs(args.pinnedPostSlugs) ?? existing?.pinnedPostSlugs ?? [],
          hiddenPostSlugs:
            cleanSlugs(args.hiddenPostSlugs) ?? existing?.hiddenPostSlugs ?? [],
        }
      : {};

    if (args.linkId && existing) {
      // KEEP-IF-NOT-RESENT, on all four image fields — see `clearThumbnail`'s
      // doc for why an omitted image must not mean "delete it".
      await ctx.db.patch(args.linkId, {
        ...fields,
        ...postFields,
        thumbnailStorage: args.clearThumbnail
          ? undefined
          : (args.thumbnailStorage ?? existing.thumbnailStorage),
        thumbnailPath: args.clearThumbnail
          ? undefined
          : (clean(args.thumbnailPath) ?? existing.thumbnailPath),
        bgImageStorage: args.clearBgImage
          ? undefined
          : (args.bgImageStorage ?? existing.bgImageStorage),
        bgImagePath: args.clearBgImage
          ? undefined
          : (clean(args.bgImagePath) ?? existing.bgImagePath),
      });
      return args.linkId;
    }

    const all = await ctx.db.query("siteLinks").take(LINK_SCAN_LIMIT);
    if (all.length >= SITE_LINK_MAX_COUNT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `The links grid holds at most ${SITE_LINK_MAX_COUNT} cards.`,
      });
    }
    // The singleton. Two posts rows would be two placeholders for one list of
    // cards, with no rule for which one the page honors.
    if (isPostsRow && all.some((l) => l.kind === "posts")) {
      throw new ConvexError({
        code: "DUPLICATE_ROW",
        message:
          "There is already a latest-posts row — edit that one, or turn it off.",
      });
    }
    const lastOrder = all.reduce((max, l) => Math.max(max, l.order), 0);
    return await ctx.db.insert("siteLinks", {
      kind: isPostsRow ? "posts" : "link",
      ...fields,
      ...postFields,
      thumbnailPath: clean(args.thumbnailPath),
      thumbnailStorage: args.thumbnailStorage,
      bgImagePath: clean(args.bgImagePath),
      bgImageStorage: args.bgImageStorage,
      order: lastOrder + ORDER_STEP,
      createdAt: now,
    });
  },
});

/** Show or hide one card without editing it — the fast path the editor's
 *  toggle uses, and the only way to take the events row off the page. */
export const setLinkPublished = mutation({
  args: { linkId: v.id("siteLinks"), published: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { linkId, published }) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.get(linkId);
    if (!existing) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That card no longer exists.",
      });
    }
    await ctx.db.patch(linkId, {
      published,
      updatedAt: Date.now(),
      updatedBy: userId,
    });
    return null;
  },
});

/** Delete a card. Neither AUTO row is deletable — see `SITE_LINK_KINDS`'s doc:
 *  removing one does not remove the events (or the posts), it removes the only
 *  handle on them. Unpublish it instead, which the error says. */
export const deleteLink = mutation({
  args: { linkId: v.id("siteLinks") },
  returns: v.null(),
  handler: async (ctx, { linkId }) => {
    await requireSiteEdit(ctx);
    const existing = await ctx.db.get(linkId);
    if (!existing) return null;
    if (existing.kind === "events") {
      throw new ConvexError({
        code: "NOT_DELETABLE",
        message:
          "The live-events row can't be deleted — turn it off instead, or set it to show 0 events.",
      });
    }
    if (existing.kind === "posts") {
      throw new ConvexError({
        code: "NOT_DELETABLE",
        message:
          "The latest-posts row can't be deleted — turn it off instead, or set it to show 0 posts.",
      });
    }
    await ctx.db.delete(linkId);
    return null;
  },
});

/** Reorder the whole grid, events row included. Same whole-list contract as
 *  `reorderStats` — see that mutation's doc. */
export const reorderLinks = mutation({
  args: { linkIds: v.array(v.id("siteLinks")) },
  returns: v.null(),
  handler: async (ctx, { linkIds }) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    let order = ORDER_STEP;
    const seen = new Set<string>();
    for (const id of linkIds) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      const doc = await ctx.db.get(id);
      if (!doc) continue;
      await ctx.db.patch(id, { order, updatedAt: now, updatedBy: userId });
      order += ORDER_STEP;
    }
    const rest = await ctx.db.query("siteLinks").take(LINK_SCAN_LIMIT);
    for (const doc of rest) {
      if (seen.has(String(doc._id))) continue;
      await ctx.db.patch(doc._id, { order, updatedAt: now, updatedBy: userId });
      order += ORDER_STEP;
    }
    return null;
  },
});

/**
 * Set how the automatic event cards behave: how many, which to lead with, which
 * to keep off the page.
 *
 * Creates the row if a deployment somehow has none (an old database, or one
 * where it was deleted before the guard existed), so the desk always has the
 * control rather than showing an empty section with no way to fix it.
 */
export const setEventsRow = mutation({
  args: {
    maxEvents: v.number(),
    pinnedEventSlugs: v.optional(v.array(v.string())),
    hiddenEventSlugs: v.optional(v.array(v.string())),
  },
  returns: v.id("siteLinks"),
  handler: async (ctx, args) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    if (
      !Number.isInteger(args.maxEvents) ||
      args.maxEvents < 0 ||
      args.maxEvents > SITE_LINK_MAX_EVENTS_CAP
    ) {
      throw new ConvexError({
        code: "OUT_OF_RANGE",
        message: `Show between 0 and ${SITE_LINK_MAX_EVENTS_CAP} event cards.`,
      });
    }

    const now = Date.now();
    const patch = {
      maxEvents: args.maxEvents,
      pinnedEventSlugs: cleanSlugs(args.pinnedEventSlugs) ?? [],
      hiddenEventSlugs: cleanSlugs(args.hiddenEventSlugs) ?? [],
      updatedAt: now,
      updatedBy: userId,
    };

    const links = await ctx.db.query("siteLinks").take(LINK_SCAN_LIMIT);
    const existing = links.find((l) => l.kind === "events");
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    const lastOrder = links.reduce((max, l) => Math.max(max, l.order), 0);
    return await ctx.db.insert("siteLinks", {
      kind: "events",
      title: "Live events",
      align: "center",
      order: lastOrder + ORDER_STEP,
      published: true,
      createdAt: now,
      ...patch,
    });
  },
});

/**
 * The published RSVP pages the desk can pin or hide — the picker's options.
 *
 * ── Why this shows finished events too ──────────────────────────────────────
 * It used to return exactly what the homepage would render, on the reasoning
 * that the desk should never offer a pin the page would refuse. That reasoning
 * was right about pins and wrong about the picker: the founder's report was
 * that he wanted to see "the things that already appear in that section" and
 * "past event links" here, and both were missing. An event that finished
 * yesterday dropped out of the list entirely — taking with it any hide he had
 * set on it, which then had no way to be un-set.
 *
 * So the picker reaches back (`listPickableEventPages`), and each row says
 * which side of the line it is on:
 *   `isUpcoming` — the page would render it, so a pin does something.
 *   `onPageNow`  — it is on the homepage AT THIS MOMENT, pinned or not.
 * The desk shows a finished event as finished rather than offering it as
 * though pinning would bring it back; `resolveEventCards` is unchanged and
 * still drops it.
 */
export const pinnableEvents = query({
  args: {},
  handler: async (ctx) => {
    await requireSiteEdit(ctx);
    const rows = await listPickableEventPages(ctx, {
      recentDays: PICKER_LOOKBACK_DAYS,
    });

    // What the page is showing right now — the same resolver the public feed
    // runs, so "on the page" here means exactly what a visitor sees.
    const links = await ctx.db
      .query("siteLinks")
      .withIndex("by_order")
      .take(LINK_SCAN_LIMIT);
    const eventsRow = links.find((l) => l.kind === "events");
    const live = new Set(
      (await resolveEventCards(ctx, eventsRow)).map((e) => e.slug),
    );

    return rows.map((e) => ({
      slug: e.slug,
      title: e.eventName,
      startDate: e.startDate,
      venueName: e.venueName,
      isUpcoming: e.isUpcoming,
      onPageNow: live.has(e.slug),
    }));
  },
});

/**
 * Set how the automatic post cards behave: how many, which to lead with, which
 * to keep off the page.
 *
 * `setEventsRow`'s twin, and it exists for the same reason that one does: the
 * desk edits this row through a count and two pickers, not through the card
 * form, and a mutation that takes exactly those three things cannot be talked
 * into changing anything else about the row. `upsertLink` still accepts the
 * same three fields — that is the path that CREATES the row and the one that
 * renames it — and both validate through `requireValidMaxPosts`.
 *
 * Creates the row if a deployment somehow has none, so the desk always has the
 * control rather than an empty section it cannot fix. Singleton by
 * construction: it patches the row it finds.
 */
export const setPostsRow = mutation({
  args: {
    maxPosts: v.number(),
    pinnedPostSlugs: v.optional(v.array(v.string())),
    hiddenPostSlugs: v.optional(v.array(v.string())),
  },
  returns: v.id("siteLinks"),
  handler: async (ctx, args) => {
    await requireSiteEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    requireValidMaxPosts(args.maxPosts);

    const now = Date.now();
    // Omitted means EMPTY here, unlike `upsertLink`: this mutation IS the
    // pickers' save button, so a list it does not send is a list the marketer
    // just cleared.
    const patch = {
      maxPosts: args.maxPosts,
      pinnedPostSlugs: cleanSlugs(args.pinnedPostSlugs) ?? [],
      hiddenPostSlugs: cleanSlugs(args.hiddenPostSlugs) ?? [],
      updatedAt: now,
      updatedBy: userId,
    };

    const links = await ctx.db.query("siteLinks").take(LINK_SCAN_LIMIT);
    const existing = links.find((l) => l.kind === "posts");
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    await ensurePostsRow(ctx);
    const created = (await ctx.db.query("siteLinks").take(LINK_SCAN_LIMIT)).find(
      (l) => l.kind === "posts",
    )!;
    await ctx.db.patch(created._id, patch);
    return created._id;
  },
});

/**
 * The posts the desk can pin or hide — the picker's options.
 *
 * Published AND archived, for the reason `pinnableEvents` learned the hard way:
 * a picker that offers only what the page would render loses the row for
 * anything taken down, and with it any hide set on that thing — which then has
 * no way to be un-set. So a taken-down post still appears, marked
 * `isPublished: false`, and `resolvePostCards` is unchanged and still drops it.
 *
 * Drafts are NOT here. An event page is either published or not; a draft post
 * is a thing a writer is still writing, there can be many, and neither a pin
 * nor a hide on one does anything until it goes live — at which point it shows
 * up here on its own.
 */
export const pinnablePosts = query({
  args: {},
  handler: async (ctx) => {
    await requireSiteEdit(ctx);

    const [published, archived] = await Promise.all([
      ctx.db
        .query("blogPosts")
        .withIndex("by_status_published", (q) => q.eq("status", "published"))
        .order("desc")
        .take(POST_PICKER_LIMIT),
      ctx.db
        .query("blogPosts")
        .withIndex("by_status_published", (q) => q.eq("status", "archived"))
        .order("desc")
        .take(POST_PICKER_LIMIT),
    ]);

    // What the page is showing right now — the same resolver the public feed
    // runs, so "on the page" here means exactly what a visitor sees.
    const links = await ctx.db
      .query("siteLinks")
      .withIndex("by_order")
      .take(LINK_SCAN_LIMIT);
    const live = new Set(
      (await resolvePostCards(ctx, links.find((l) => l.kind === "posts"))).map(
        (p) => p.slug,
      ),
    );

    return [...published, ...archived]
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .slice(0, POST_PICKER_LIMIT)
      .map((post) => ({
        slug: post.slug,
        title: post.title,
        publishedAt: post.publishedAt ?? null,
        isPublished: post.status === "published",
        onPageNow: live.has(post.slug),
      }));
  },
});

/** Upload URL for a card image. Gated on `marketing.site.edit` rather than
 *  reusing `storage.generateUploadUrl` (which any signed-in user can call), so
 *  the desk's uploads carry the desk's power. */
export const generateLinkImageUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSiteEdit(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// ── Seed ─────────────────────────────────────────────────────────────────────

/**
 * Restore the homepage content that was YAML before this desk existed.
 *
 * Idempotent and all-or-nothing per table: a deployment that already has cards
 * is left alone.
 *
 * ── This is NOT a "run it after deploy" seed, and that is the point ─────────
 * It shipped as one, and the desk was empty on the founder's first look — the
 * grid showed nothing, so the tab read as broken rather than as unseeded, and
 * the honest failure ("somebody has to run a command") is invisible from
 * inside the app. A seed whose absence looks like a bug is a seed that belongs
 * in the deploy, so the body lives in `seedSiteContent` below and migration
 * `0080` calls it on every deploy until it has run. The internal mutation
 * stays for a manual re-run.
 */
export async function seedSiteContent(
  ctx: MutationCtx,
): Promise<{ links: number; stats: number }> {
  const now = Date.now();
  let links = 0;
  let stats = 0;

  if (!(await ctx.db.query("siteLinks").first())) {
    for (const row of SITE_LINK_SEED) {
      await ctx.db.insert("siteLinks", { ...row, createdAt: now, updatedAt: now });
      links++;
    }
  }
  if (!(await ctx.db.query("siteStats").first())) {
    for (const row of SITE_STAT_SEED) {
      await ctx.db.insert("siteStats", { ...row, updatedAt: now });
      stats++;
    }
  }
  return { links, stats };
}

/** The seeded posts row, as the single definition of what a fresh one is. */
const POSTS_SEED = SITE_LINK_SEED.find(
  (row): row is Extract<(typeof SITE_LINK_SEED)[number], { kind: "posts" }> =>
    row.kind === "posts",
)!;

/**
 * Give a deployment the latest-posts row if it has none.
 *
 * ── Why insert-if-missing is safe HERE, and would not be for a card ─────────
 * `seedSiteContent` is all-or-nothing per table: a deployment that already has
 * `siteLinks` rows is left alone, which is right — re-adding a card somebody
 * deleted would be the seed overruling a human. The posts row cannot get into
 * that argument, because it CANNOT have been deleted: `deleteLink` refuses it
 * and always has (`SITE_LINK_KINDS`'s doc says why). So on an existing
 * deployment "absent" has exactly one meaning — the row was added to the seed
 * after this database was seeded — and inserting it is restoring a missing
 * part, not second-guessing a decision. `published: false` remains the way to
 * take the row off the page, and this never touches `published` on a row that
 * exists.
 *
 * Idempotent, so the migration that calls it can run on every deploy.
 */
export async function ensurePostsRow(
  ctx: MutationCtx,
): Promise<{ inserted: boolean }> {
  const links = await ctx.db.query("siteLinks").take(LINK_SCAN_LIMIT);
  if (links.some((l) => l.kind === "posts")) return { inserted: false };

  // Half a step after the events row, wherever the marketer has since dragged
  // it: the seed's own position (posts follow events, above the socials)
  // without renumbering a grid somebody already arranged. With no events row
  // to anchor to, it lands at the end, which is where a new card would go.
  const eventsRow = links.find((l) => l.kind === "events");
  const order = eventsRow
    ? eventsRow.order + ORDER_STEP / 2
    : links.reduce((max, l) => Math.max(max, l.order), 0) + ORDER_STEP;

  const now = Date.now();
  await ctx.db.insert("siteLinks", {
    ...POSTS_SEED,
    order,
    createdAt: now,
    updatedAt: now,
  });
  return { inserted: true };
}

export const ensurePostsRowIfMissing = internalMutation({
  args: {},
  returns: v.object({ inserted: v.boolean() }),
  handler: async (ctx: MutationCtx) => await ensurePostsRow(ctx),
});

export const seedSiteContentIfEmpty = internalMutation({
  args: {},
  returns: v.object({ links: v.number(), stats: v.number() }),
  handler: async (ctx: MutationCtx) => await seedSiteContent(ctx),
});
