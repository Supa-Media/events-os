/**
 * Ticketing — public event pages, RSVPs, ticket sales, comments & reactions.
 *
 * Three surfaces:
 *   - ADMIN (requireAccess via chapter helpers): page setup, ticket types,
 *     guest list, orders, check-in. Used by the Tickets tab in the app.
 *   - PUBLIC, no-auth: everything the landing page (/event/<slug>, served from
 *     http.ts — the legacy /e/<slug> alias still resolves) needs. Guests are
 *     identified by their RSVP row's secret
 *     `token` — never by auth. Mirrors `setlists.publicBoard`.
 *   - INTERNAL: order preparation/fulfillment shared by the Stripe checkout
 *     action and the webhook.
 *
 * Money is always integer cents. Counters are denormalized on `eventPages`
 * and `ticketTypes` (never counted at read time).
 */
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { requireEvent, requireOwned, requireUserId } from "./lib/context";
import { beginEmailVerification, clearEmailCode } from "./lib/emailCodes";
import { RSVP_STATUSES } from "./schema/ticketing";

// ── Small helpers ────────────────────────────────────────────────────────────

const rsvpStatusValidator = v.union(...RSVP_STATUSES.map((s) => v.literal(s)));

/** Unambiguous charset for ticket codes (no 0/O/1/I/L). */
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomFrom(chars: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** Secret guest token (URL-safe, 32 chars). Shared with the giving flow. */
export function newGuestToken(): string {
  return randomFrom(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    32,
  );
}

/** Human-safe ticket code, e.g. "PW-8FK2-QW9T". */
function newTicketCode(): string {
  return `PW-${randomFrom(CODE_CHARS, 4)}-${randomFrom(CODE_CHARS, 4)}`;
}

/** URL slug from an event name: "Summer Worship Night" → "summer-worship-night". */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "event";
}

/** Load a published page by slug (null if missing or unpublished). */
export async function getPublishedPage(
  ctx: QueryCtx,
  slug: string,
): Promise<Doc<"eventPages"> | null> {
  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (!page || !page.published) return null;
  return page;
}

/** Load the viewer's RSVP for this event from their guest token (or null). */
export async function getViewerRsvp(
  ctx: QueryCtx,
  eventId: Id<"events">,
  token?: string | null,
): Promise<Doc<"rsvps"> | null> {
  if (!token) return null;
  const rsvp = await ctx.db
    .query("rsvps")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!rsvp || rsvp.eventId !== eventId) return null;
  return rsvp;
}

/** Shift the page's per-status RSVP counters when a status changes. */
export async function bumpRsvpCounters(
  ctx: MutationCtx,
  page: Doc<"eventPages">,
  from: (typeof RSVP_STATUSES)[number] | null,
  to: (typeof RSVP_STATUSES)[number] | null,
): Promise<void> {
  const key = (s: (typeof RSVP_STATUSES)[number]) =>
    s === "going"
      ? ("goingCount" as const)
      : s === "maybe"
        ? ("maybeCount" as const)
        : ("notGoingCount" as const);
  const patch: Partial<Doc<"eventPages">> = {};
  if (from) patch[key(from)] = Math.max(0, page[key(from)] - 1);
  if (to) {
    const k = key(to);
    patch[k] = (patch[k] ?? page[k]) + 1;
  }
  await ctx.db.patch(page._id, patch);
}

/** Availability for a ticket type: remaining seats or null for unlimited. */
function remainingFor(tt: Doc<"ticketTypes">): number | null {
  if (tt.capacity === undefined) return null;
  return Math.max(0, tt.capacity - tt.soldCount);
}

function ticketTypeIsOnSale(tt: Doc<"ticketTypes">, now: number): boolean {
  if (!tt.isActive) return false;
  if (tt.salesStart !== undefined && now < tt.salesStart) return false;
  if (tt.salesEnd !== undefined && now > tt.salesEnd) return false;
  const remaining = remainingFor(tt);
  return remaining === null || remaining > 0;
}

/** Public projection of a ticket type (no internal counters). */
function publicTicketType(tt: Doc<"ticketTypes">, now: number) {
  const remaining = remainingFor(tt);
  return {
    id: tt._id,
    name: tt.name,
    description: tt.description ?? null,
    priceCents: tt.priceCents,
    currency: tt.currency,
    maxPerOrder: tt.maxPerOrder ?? null,
    onSale: ticketTypeIsOnSale(tt, now),
    // Only reveal scarcity when it's actually low (Posh-style "3 left").
    lowRemaining: remaining !== null && remaining <= 10 ? remaining : null,
  };
}

// ── ADMIN: page setup ────────────────────────────────────────────────────────

/** The Tickets tab's everything-query: page + ticket types + rollups. */
export const getAdminPage = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await requireEvent(ctx, eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) return { page: null, ticketTypes: [], coverUrl: null };
    const ticketTypes = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(100);
    const coverUrl = page.coverImage
      ? await ctx.storage.getUrl(page.coverImage)
      : null;
    return {
      page,
      event: { name: event.name, eventDate: event.eventDate },
      ticketTypes: ticketTypes.sort((a, b) => a.sortOrder - b.sortOrder),
      coverUrl,
    };
  },
});

/** Create the public page for an event (idempotent — returns existing). */
export const createPage = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await requireEvent(ctx, eventId);
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) return existing._id;

    // Find a free slug: name, then name-xxxx.
    let slug = slugify(event.name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await ctx.db
        .query("eventPages")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (!clash) break;
      slug = `${slugify(event.name)}-${randomFrom(CODE_CHARS.toLowerCase(), 4)}`;
    }

    const now = Date.now();
    return await ctx.db.insert("eventPages", {
      eventId,
      chapterId: event.chapterId,
      slug,
      published: false,
      hostName: "Public Worship",
      addressVisibility: "public",
      rsvpEnabled: true,
      ticketsEnabled: false,
      showGuestList: true,
      activityRestricted: true,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 0,
      revenueCents: 0,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updatePage = mutation({
  args: {
    pageId: v.id("eventPages"),
    patch: v.object({
      slug: v.optional(v.string()),
      published: v.optional(v.boolean()),
      coverImage: v.optional(v.union(v.id("_storage"), v.null())),
      tagline: v.optional(v.string()),
      description: v.optional(v.string()),
      hostName: v.optional(v.string()),
      endDate: v.optional(v.union(v.number(), v.null())),
      venueName: v.optional(v.string()),
      address: v.optional(v.string()),
      addressVisibility: v.optional(
        v.union(v.literal("public"), v.literal("after_rsvp")),
      ),
      rsvpEnabled: v.optional(v.boolean()),
      ticketsEnabled: v.optional(v.boolean()),
      givingEnabled: v.optional(v.boolean()),
      givingPrompt: v.optional(v.union(v.string(), v.null())),
      suggestedAmountsCents: v.optional(v.union(v.array(v.number()), v.null())),
      showGuestList: v.optional(v.boolean()),
      activityRestricted: v.optional(v.boolean()),
      capacity: v.optional(v.union(v.number(), v.null())),
    }),
  },
  handler: async (ctx, { pageId, patch }) => {
    const page = await requireOwned(ctx, "eventPages", pageId, "Page");

    // Slug changes must stay unique.
    if (patch.slug !== undefined && patch.slug !== page.slug) {
      const slug = slugify(patch.slug);
      if (!slug) {
        throw new ConvexError({ code: "INVALID_SLUG", message: "Slug can't be empty." });
      }
      const clash = await ctx.db
        .query("eventPages")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (clash && clash._id !== pageId) {
        throw new ConvexError({
          code: "SLUG_TAKEN",
          message: `"${slug}" is already used by another event page.`,
        });
      }
      patch.slug = slug;
    }

    // Suggested amounts are integer cents ≥ 0 (mirror the ticket INVALID_PRICE guard).
    if (
      patch.suggestedAmountsCents != null &&
      patch.suggestedAmountsCents.some(
        (c) => c < 0 || !Number.isInteger(c),
      )
    ) {
      throw new ConvexError({
        code: "INVALID_PRICE",
        message: "Suggested amounts must be whole numbers of cents ≥ 0.",
      });
    }

    // v.null() sentinels → unset the optional field.
    const { coverImage, endDate, capacity, givingPrompt, suggestedAmountsCents, ...rest } =
      patch;
    await ctx.db.patch(pageId, {
      ...rest,
      ...(coverImage !== undefined ? { coverImage: coverImage ?? undefined } : {}),
      ...(endDate !== undefined ? { endDate: endDate ?? undefined } : {}),
      ...(capacity !== undefined ? { capacity: capacity ?? undefined } : {}),
      ...(givingPrompt !== undefined
        ? { givingPrompt: givingPrompt ?? undefined }
        : {}),
      ...(suggestedAmountsCents !== undefined
        ? { suggestedAmountsCents: suggestedAmountsCents ?? undefined }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── ADMIN: ticket types ──────────────────────────────────────────────────────

export const createTicketType = mutation({
  args: {
    eventId: v.id("events"),
    name: v.string(),
    description: v.optional(v.string()),
    priceCents: v.number(),
    capacity: v.optional(v.number()),
    maxPerOrder: v.optional(v.number()),
    salesStart: v.optional(v.number()),
    salesEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    if (args.priceCents < 0 || !Number.isInteger(args.priceCents)) {
      throw new ConvexError({
        code: "INVALID_PRICE",
        message: "Price must be a whole number of cents ≥ 0.",
      });
    }
    const siblings = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .take(100);
    const now = Date.now();
    return await ctx.db.insert("ticketTypes", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      name: args.name.trim() || "General Admission",
      description: args.description,
      priceCents: args.priceCents,
      currency: "usd",
      capacity: args.capacity,
      soldCount: 0,
      maxPerOrder: args.maxPerOrder,
      salesStart: args.salesStart,
      salesEnd: args.salesEnd,
      sortOrder: siblings.length,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateTicketType = mutation({
  args: {
    ticketTypeId: v.id("ticketTypes"),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.union(v.string(), v.null())),
      priceCents: v.optional(v.number()),
      capacity: v.optional(v.union(v.number(), v.null())),
      maxPerOrder: v.optional(v.union(v.number(), v.null())),
      salesStart: v.optional(v.union(v.number(), v.null())),
      salesEnd: v.optional(v.union(v.number(), v.null())),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { ticketTypeId, patch }) => {
    await requireOwned(ctx, "ticketTypes", ticketTypeId, "Ticket type");
    if (
      patch.priceCents !== undefined &&
      (patch.priceCents < 0 || !Number.isInteger(patch.priceCents))
    ) {
      throw new ConvexError({
        code: "INVALID_PRICE",
        message: "Price must be a whole number of cents ≥ 0.",
      });
    }
    const unsettable = ["description", "capacity", "maxPerOrder", "salesStart", "salesEnd"] as const;
    const resolved: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val === undefined) continue;
      resolved[k] =
        val === null && (unsettable as readonly string[]).includes(k)
          ? undefined
          : val;
    }
    await ctx.db.patch(ticketTypeId, resolved);
    return null;
  },
});

/** Hard-delete only if nothing sold; otherwise deactivate to keep history. */
export const deleteTicketType = mutation({
  args: { ticketTypeId: v.id("ticketTypes") },
  handler: async (ctx, { ticketTypeId }) => {
    const tt = await requireOwned(ctx, "ticketTypes", ticketTypeId, "Ticket type");
    if (tt.soldCount > 0) {
      await ctx.db.patch(ticketTypeId, { isActive: false, updatedAt: Date.now() });
    } else {
      await ctx.db.delete(ticketTypeId);
    }
    return null;
  },
});

// ── ADMIN: guest list, orders, check-in ──────────────────────────────────────

/** Guest list for the Tickets tab (tokens stripped). */
export const listRsvpsAdmin = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    const rows = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(1000);
    return rows.map((r) => ({
      id: r._id,
      name: r.name,
      email: r.email,
      phone: r.phone ?? null,
      status: r.status,
      source: r.source ?? "rsvp",
      createdAt: r.createdAt,
    }));
  },
});

export const listOrdersAdmin = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    return await ctx.db
      .query("ticketOrders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(500);
  },
});

export const listTicketsAdmin = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    return await ctx.db
      .query("tickets")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(1000);
  },
});

/** Door check-in by ticket code (idempotent-safe: reports prior check-in). */
export const checkInTicket = mutation({
  args: { eventId: v.id("events"), code: v.string() },
  handler: async (ctx, { eventId, code }) => {
    await requireEvent(ctx, eventId);
    const userId = await requireUserId(ctx);
    const normalized = code.trim().toUpperCase();
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_code", (q) => q.eq("code", normalized))
      .unique();
    if (!ticket || ticket.eventId !== eventId) {
      return { result: "not_found" as const };
    }
    if (ticket.status === "void") return { result: "void" as const };
    if (ticket.status === "checked_in") {
      return {
        result: "already" as const,
        attendeeName: ticket.attendeeName,
        checkedInAt: ticket.checkedInAt ?? null,
      };
    }
    await ctx.db.patch(ticket._id, {
      status: "checked_in",
      checkedInAt: Date.now(),
      checkedInBy: userId as Id<"users">,
    });
    return {
      result: "ok" as const,
      attendeeName: ticket.attendeeName,
      ticketTypeName: ticket.ticketTypeName,
    };
  },
});

// ── PUBLIC: landing page data ────────────────────────────────────────────────

/**
 * Everything the public landing page renders. No auth — access control is
 * "the page is published". `token` (optional) personalizes: reveals the
 * viewer's RSVP, unlocks gated address/activity.
 */
export const getPublicPage = query({
  args: { slug: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, token }) => {
    const page = await getPublishedPage(ctx, slug);
    if (!page) return null;
    const event = await ctx.db.get(page.eventId);
    if (!event) return null;
    const now = Date.now();

    const viewer = await getViewerRsvp(ctx, page.eventId, token);
    const hasRsvpd = !!viewer && viewer.status !== "not_going";

    // Ticket tiers (active only, sorted).
    const allTypes = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", page.eventId))
      .take(100);
    const ticketTypes = allTypes
      .filter((t) => t.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => publicTicketType(t, now));

    // Guest preview: a Partiful-style avatar row (names only, going first).
    const going = await ctx.db
      .query("rsvps")
      .withIndex("by_event_status", (q) =>
        q.eq("eventId", page.eventId).eq("status", "going"),
      )
      .order("desc")
      .take(18);
    const maybe = await ctx.db
      .query("rsvps")
      .withIndex("by_event_status", (q) =>
        q.eq("eventId", page.eventId).eq("status", "maybe"),
      )
      .order("desc")
      .take(6);
    const guests = page.showGuestList === false
      ? []
      : [...going, ...maybe].map((r) => ({ name: r.name, status: r.status }));

    // Address gating (Partiful's "RSVP for full location").
    const addressLocked =
      page.addressVisibility === "after_rsvp" && !hasRsvpd;

    // Activity feed gating.
    const activityLocked = (page.activityRestricted ?? true) && !hasRsvpd;
    const activity = activityLocked
      ? null
      : await buildActivity(ctx, page.eventId, viewer);

    return {
      slug: page.slug,
      eventName: event.name,
      startDate: event.eventDate,
      endDate: page.endDate ?? null,
      tagline: page.tagline ?? null,
      description: page.description ?? null,
      hostName: page.hostName ?? "Public Worship",
      venueName: page.venueName ?? null,
      address: addressLocked ? null : (page.address ?? null),
      addressLocked,
      hasCover: !!page.coverImage,
      rsvpEnabled: page.rsvpEnabled !== false,
      ticketsEnabled: page.ticketsEnabled === true && ticketTypes.length > 0,
      givingEnabled: page.givingEnabled === true,
      givingPrompt: page.givingPrompt ?? null,
      suggestedAmountsCents: page.suggestedAmountsCents ?? [],
      donationsCents: page.donationsCents ?? 0,
      donationsCount: page.donationsCount ?? 0,
      capacity: page.capacity ?? null,
      counts: {
        going: page.goingCount,
        maybe: page.maybeCount,
        ticketsSold: page.ticketsSoldCount,
      },
      guests,
      ticketTypes,
      viewer: viewer
        ? {
            name: viewer.name,
            email: viewer.email,
            status: viewer.status,
            // Legacy rows (undefined) predate verification — treat as verified.
            emailVerified: viewer.emailVerified !== false,
          }
        : null,
      activityLocked,
      activity,
    };
  },
});

/** Reaction rollup for one activity target. */
async function reactionsFor(
  ctx: QueryCtx,
  targetType: "rsvp" | "comment",
  targetId: string,
  viewerKey: string | null,
) {
  const rows = await ctx.db
    .query("pageReactions")
    .withIndex("by_target", (q) =>
      q.eq("targetType", targetType).eq("targetId", targetId),
    )
    .take(200);
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    const entry = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    entry.count++;
    if (viewerKey && r.actorKey === viewerKey) entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.entries()].map(([emoji, e]) => ({ emoji, ...e }));
}

/**
 * The Partiful-style activity feed: RSVP entries and top-level comments,
 * newest first, each with reactions and replies. Bounded takes throughout.
 */
async function buildActivity(
  ctx: QueryCtx,
  eventId: Id<"events">,
  viewer: Doc<"rsvps"> | null,
) {
  const viewerKey = viewer ? String(viewer._id) : null;

  const recentRsvps = await ctx.db
    .query("rsvps")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .order("desc")
    .take(40);
  const comments = await ctx.db
    .query("eventComments")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .order("desc")
    .take(60);

  const topLevel = comments.filter((c) => !c.parentId && !c.replyToRsvpId);
  const byParent = new Map<string, Doc<"eventComments">[]>();
  for (const c of comments) {
    const key = c.parentId
      ? String(c.parentId)
      : c.replyToRsvpId
        ? `rsvp:${String(c.replyToRsvpId)}`
        : null;
    if (!key) continue;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }

  const commentShape = async (c: Doc<"eventComments">) => ({
    id: String(c._id),
    type: "comment" as const,
    authorName: c.authorName,
    isViewer: !!viewer && c.rsvpId === viewer._id,
    body: c.body,
    createdAt: c.createdAt,
    reactions: await reactionsFor(ctx, "comment", String(c._id), viewerKey),
  });

  const items: Array<Record<string, unknown>> = [];
  for (const r of recentRsvps.filter((r) => r.status !== "not_going")) {
    const replies = (byParent.get(`rsvp:${String(r._id)}`) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    items.push({
      id: String(r._id),
      type: "rsvp",
      authorName: r.name,
      isViewer: !!viewer && r._id === viewer._id,
      status: r.status,
      createdAt: r.updatedAt,
      reactions: await reactionsFor(ctx, "rsvp", String(r._id), viewerKey),
      replies: await Promise.all(replies.map(commentShape)),
    });
  }
  for (const c of topLevel) {
    const replies = (byParent.get(String(c._id)) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    items.push({
      ...(await commentShape(c)),
      replies: await Promise.all(replies.map(commentShape)),
    });
  }

  items.sort(
    (a, b) => (b.createdAt as number) - (a.createdAt as number),
  );
  return items.slice(0, 60);
}

// ── PUBLIC: RSVP / comments / reactions ──────────────────────────────────────

/**
 * Create or update an RSVP. Identity resolution, in order:
 *   1. A valid guest `token` → that row (rename/status change).
 *   2. Same email on this event → that row (frictionless return visitor; the
 *      token is re-issued, which is acceptable for this product's threat model).
 *   3. Fresh row.
 * Returns the guest token the browser should store.
 */
export const submitRsvp = mutation({
  args: {
    slug: v.string(),
    // Optional when a valid token already identifies the guest.
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    status: rsvpStatusValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await getPublishedPage(ctx, args.slug);
    if (!page) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event page not found." });
    }
    if (page.rsvpEnabled === false) {
      throw new ConvexError({ code: "RSVP_CLOSED", message: "RSVPs are closed." });
    }
    const known = await getViewerRsvp(ctx, page.eventId, args.token);
    const name = args.name?.trim() || known?.name;
    const email = normalizeEmail(args.email) ?? known?.email;
    if (!name || !email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A name and valid email are required.",
      });
    }
    if (
      args.status === "going" &&
      page.capacity !== undefined &&
      page.goingCount >= page.capacity
    ) {
      throw new ConvexError({
        code: "AT_CAPACITY",
        message: "This event is at capacity.",
      });
    }

    const now = Date.now();
    let rsvp = known;
    if (!rsvp) {
      rsvp = await ctx.db
        .query("rsvps")
        .withIndex("by_event_email", (q) =>
          q.eq("eventId", page.eventId).eq("email", email),
        )
        .first();
    }

    if (rsvp) {
      const emailChanged = email !== rsvp.email;
      if (rsvp.status !== args.status) {
        await bumpRsvpCounters(ctx, page, rsvp.status, args.status);
      }
      await ctx.db.patch(rsvp._id, {
        name,
        email,
        ...(args.phone !== undefined ? { phone: args.phone } : {}),
        status: args.status,
        updatedAt: now,
      });
      // A changed email must be re-verified; an unchanged one keeps its state.
      if (emailChanged) {
        await beginEmailVerification(ctx, { _id: rsvp._id, email });
      }
      return {
        token: rsvp.token,
        status: args.status,
        needsEmailVerification: emailChanged || rsvp.emailVerified === false,
      };
    }

    const token = newGuestToken();
    const rsvpId = await ctx.db.insert("rsvps", {
      eventId: page.eventId,
      chapterId: page.chapterId,
      name,
      email,
      phone: args.phone,
      status: args.status,
      token,
      source: "rsvp",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await bumpRsvpCounters(ctx, page, null, args.status);
    await beginEmailVerification(ctx, { _id: rsvpId, email });
    if (args.status !== "not_going") {
      await ctx.scheduler.runAfter(0, internal.ticketingEmails.sendRsvpEmail, {
        slug: page.slug,
        name,
        email,
        status: args.status,
      });
    }
    return { token, status: args.status, needsEmailVerification: true };
  },
});

/** Post a comment (requires an RSVP'd guest token — Partiful's rule). */
export const addComment = mutation({
  args: {
    slug: v.string(),
    token: v.string(),
    body: v.string(),
    parentId: v.optional(v.id("eventComments")),
    replyToRsvpId: v.optional(v.id("rsvps")),
  },
  handler: async (ctx, args) => {
    const page = await getPublishedPage(ctx, args.slug);
    if (!page) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event page not found." });
    }
    const viewer = await getViewerRsvp(ctx, page.eventId, args.token);
    if (!viewer) {
      throw new ConvexError({
        code: "RSVP_REQUIRED",
        message: "RSVP to join the conversation.",
      });
    }
    const body = args.body.trim().slice(0, 1000);
    if (!body) {
      throw new ConvexError({ code: "EMPTY", message: "Say something first." });
    }
    // Replies must target activity on this same event.
    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent || parent.eventId !== page.eventId || parent.parentId) {
        throw new ConvexError({ code: "BAD_PARENT", message: "Can't reply there." });
      }
    }
    if (args.replyToRsvpId) {
      const target = await ctx.db.get(args.replyToRsvpId);
      if (!target || target.eventId !== page.eventId) {
        throw new ConvexError({ code: "BAD_PARENT", message: "Can't reply there." });
      }
    }
    await ctx.db.insert("eventComments", {
      eventId: page.eventId,
      chapterId: page.chapterId,
      parentId: args.parentId,
      replyToRsvpId: args.parentId ? undefined : args.replyToRsvpId,
      rsvpId: viewer._id,
      authorName: viewer.name,
      body,
      createdAt: Date.now(),
    });
    return null;
  },
});

/** Toggle an emoji reaction on an RSVP entry or comment. */
export const toggleReaction = mutation({
  args: {
    slug: v.string(),
    token: v.string(),
    targetType: v.union(v.literal("rsvp"), v.literal("comment")),
    targetId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, args) => {
    const page = await getPublishedPage(ctx, args.slug);
    if (!page) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event page not found." });
    }
    const viewer = await getViewerRsvp(ctx, page.eventId, args.token);
    if (!viewer) {
      throw new ConvexError({
        code: "RSVP_REQUIRED",
        message: "RSVP to react.",
      });
    }
    const emoji = args.emoji.slice(0, 8);
    const actorKey = String(viewer._id);

    // Verify the target belongs to this event.
    if (args.targetType === "rsvp") {
      const target = await ctx.db.get(args.targetId as Id<"rsvps">);
      if (!target || target.eventId !== page.eventId) {
        throw new ConvexError({ code: "BAD_TARGET", message: "Nothing to react to." });
      }
    } else {
      const target = await ctx.db.get(args.targetId as Id<"eventComments">);
      if (!target || target.eventId !== page.eventId) {
        throw new ConvexError({ code: "BAD_TARGET", message: "Nothing to react to." });
      }
    }

    const existing = await ctx.db
      .query("pageReactions")
      .withIndex("by_target_actor", (q) =>
        q
          .eq("targetType", args.targetType)
          .eq("targetId", args.targetId)
          .eq("actorKey", actorKey),
      )
      .take(20);
    const mine = existing.find((r) => r.emoji === emoji);
    if (mine) {
      await ctx.db.delete(mine._id);
      return { reacted: false };
    }
    await ctx.db.insert("pageReactions", {
      eventId: page.eventId,
      chapterId: page.chapterId,
      targetType: args.targetType,
      targetId: args.targetId,
      emoji,
      actorKey,
      createdAt: Date.now(),
    });
    return { reacted: true };
  },
});

// ── PUBLIC: ticket lookup (the /t/<code> page) ───────────────────────────────

export const getPublicTicket = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
      .unique();
    if (!ticket) return null;
    const event = await ctx.db.get(ticket.eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", ticket.eventId))
      .unique();
    return {
      code: ticket.code,
      status: ticket.status,
      attendeeName: ticket.attendeeName,
      ticketTypeName: ticket.ticketTypeName,
      eventName: event?.name ?? "Event",
      startDate: event?.eventDate ?? null,
      venueName: page?.venueName ?? null,
      slug: page?.slug ?? null,
      hasCover: !!page?.coverImage,
    };
  },
});

// ── INTERNAL: order lifecycle (shared by stripe.ts + webhook) ────────────────

/**
 * Validate a cart and create a pending order (+ ensure an RSVP identity for
 * the buyer). Called by the checkout action right before Stripe.
 */
export const prepareOrder = internalMutation({
  args: {
    slug: v.string(),
    name: v.string(),
    email: v.string(),
    token: v.optional(v.string()),
    items: v.array(
      v.object({ ticketTypeId: v.id("ticketTypes"), quantity: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    const page = await getPublishedPage(ctx, args.slug);
    if (!page || page.ticketsEnabled !== true) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Tickets aren't on sale." });
    }
    const name = args.name.trim();
    const email = normalizeEmail(args.email);
    if (!name || !email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A name and valid email are required.",
      });
    }
    if (args.items.length === 0 || args.items.length > 10) {
      throw new ConvexError({ code: "INVALID_CART", message: "Pick some tickets first." });
    }

    const now = Date.now();
    const lines: Array<{
      ticketTypeId: Id<"ticketTypes">;
      name: string;
      quantity: number;
      unitPriceCents: number;
    }> = [];
    for (const item of args.items) {
      const tt = await ctx.db.get(item.ticketTypeId);
      if (!tt || tt.eventId !== page.eventId || !ticketTypeIsOnSale(tt, now)) {
        throw new ConvexError({
          code: "UNAVAILABLE",
          message: `${tt?.name ?? "That ticket"} is no longer available.`,
        });
      }
      const qty = Math.floor(item.quantity);
      if (qty < 1 || qty > (tt.maxPerOrder ?? 10)) {
        throw new ConvexError({
          code: "INVALID_QTY",
          message: `Quantity for ${tt.name} must be between 1 and ${tt.maxPerOrder ?? 10}.`,
        });
      }
      const remaining = remainingFor(tt);
      if (remaining !== null && qty > remaining) {
        throw new ConvexError({
          code: "SOLD_OUT",
          message: `Only ${remaining} ${tt.name} ticket${remaining === 1 ? "" : "s"} left.`,
        });
      }
      lines.push({
        ticketTypeId: tt._id,
        name: tt.name,
        quantity: qty,
        unitPriceCents: tt.priceCents,
      });
    }

    // Ensure the buyer has an RSVP identity (status set on fulfillment).
    let rsvp = await getViewerRsvp(ctx, page.eventId, args.token);
    if (!rsvp) {
      rsvp = await ctx.db
        .query("rsvps")
        .withIndex("by_event_email", (q) =>
          q.eq("eventId", page.eventId).eq("email", email),
        )
        .first();
    }
    let rsvpId: Id<"rsvps">;
    let guestToken: string;
    let needsEmailVerification: boolean;
    if (rsvp) {
      rsvpId = rsvp._id;
      guestToken = rsvp.token;
      needsEmailVerification = rsvp.emailVerified === false;
      await ctx.db.patch(rsvp._id, { name, updatedAt: now });
    } else {
      guestToken = newGuestToken();
      needsEmailVerification = true;
      rsvpId = await ctx.db.insert("rsvps", {
        eventId: page.eventId,
        chapterId: page.chapterId,
        name,
        email,
        status: "maybe", // flips to "going" when the order is fulfilled
        token: guestToken,
        source: "ticket",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
      await bumpRsvpCounters(ctx, page, null, "maybe");
    }

    const totalCents = lines.reduce(
      (sum, l) => sum + l.quantity * l.unitPriceCents,
      0,
    );
    // Free carts fulfill instantly with no Stripe step, so the code email goes
    // out now. Paid carts wait: a completed Stripe payment verifies the email.
    if (needsEmailVerification && totalCents === 0) {
      await beginEmailVerification(ctx, { _id: rsvpId, email });
    }
    const orderId = await ctx.db.insert("ticketOrders", {
      eventId: page.eventId,
      chapterId: page.chapterId,
      rsvpId,
      name,
      email,
      items: lines,
      totalCents,
      currency: "usd",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    const event = await ctx.db.get(page.eventId);
    return {
      orderId,
      totalCents,
      guestToken,
      needsEmailVerification,
      eventName: event?.name ?? "Event",
      lines,
    };
  },
});

export const attachStripeSession = internalMutation({
  args: {
    orderId: v.id("ticketOrders"),
    sessionId: v.string(),
  },
  handler: async (ctx, { orderId, sessionId }) => {
    await ctx.db.patch(orderId, {
      stripeCheckoutSessionId: sessionId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Issue tickets for a paid (or free) order: one row per admission, counters,
 * RSVP → going, confirmation email. Idempotent — a second call no-ops.
 * Shared by `fulfillOrder` (free carts) and `markSessionPaid` (webhook).
 */
async function fulfill(
  ctx: MutationCtx,
  orderId: Id<"ticketOrders">,
  stripePaymentIntentId?: string,
): Promise<null> {
  const order = await ctx.db.get(orderId);
  if (!order) return null;
  if (order.status === "paid") return null; // idempotent (webhook retries)

  const now = Date.now();
  await ctx.db.patch(orderId, {
    status: "paid",
    ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
    updatedAt: now,
  });

  let issued = 0;
  for (const line of order.items) {
    for (let i = 0; i < line.quantity; i++) {
      // Codes are 32^8 — collisions are vanishingly rare; one retry is plenty.
      let code = newTicketCode();
      const clash = await ctx.db
        .query("tickets")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (clash) code = newTicketCode();
      await ctx.db.insert("tickets", {
        eventId: order.eventId,
        chapterId: order.chapterId,
        orderId,
        ticketTypeId: line.ticketTypeId,
        ticketTypeName: line.name,
        attendeeName: order.name,
        attendeeEmail: order.email,
        code,
        status: "valid",
        createdAt: now,
      });
      issued++;
    }
    const tt = await ctx.db.get(line.ticketTypeId);
    if (tt) {
      await ctx.db.patch(tt._id, { soldCount: tt.soldCount + line.quantity });
    }
  }

  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", order.eventId))
    .unique();
  if (page) {
    await ctx.db.patch(page._id, {
      ticketsSoldCount: page.ticketsSoldCount + issued,
      revenueCents: page.revenueCents + order.totalCents,
    });
    // Ticket buyers count as going.
    if (order.rsvpId) {
      const rsvp = await ctx.db.get(order.rsvpId);
      if (rsvp && rsvp.status !== "going") {
        await bumpRsvpCounters(
          ctx,
          (await ctx.db.get(page._id))!,
          rsvp.status,
          "going",
        );
        await ctx.db.patch(rsvp._id, {
          status: "going",
          source: "ticket",
          updatedAt: now,
        });
      }
      // A completed Stripe payment proves the buyer controls this email —
      // count it as verified. Free (no-Stripe) claims still need the code.
      const paidViaStripe =
        stripePaymentIntentId !== undefined ||
        order.stripeCheckoutSessionId !== undefined;
      if (
        rsvp &&
        paidViaStripe &&
        rsvp.email === order.email &&
        rsvp.emailVerified === false
      ) {
        await ctx.db.patch(rsvp._id, { emailVerified: true });
        await clearEmailCode(ctx, rsvp._id);
      }
    }
  }

  await ctx.scheduler.runAfter(0, internal.ticketingEmails.sendTicketsEmail, {
    orderId,
  });
  return null;
}

export const fulfillOrder = internalMutation({
  args: {
    orderId: v.id("ticketOrders"),
    stripePaymentIntentId: v.optional(v.string()),
  },
  handler: (ctx, { orderId, stripePaymentIntentId }) =>
    fulfill(ctx, orderId, stripePaymentIntentId),
});

/**
 * Mark a pending order paid from the Stripe webhook (by session id). Returns
 * whether an order matched — the shared `/stripe/webhook` uses this to know the
 * session was an order (and to no-op silently when it wasn't, since the same
 * session may instead be a donation settled by `giving.markDonationPaid`).
 */
export const markSessionPaid = internalMutation({
  args: {
    sessionId: v.string(),
    paymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, paymentIntentId }) => {
    const order = await ctx.db
      .query("ticketOrders")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", sessionId),
      )
      .unique();
    if (!order) return false; // not an order session — safe no-op
    await fulfill(ctx, order._id, paymentIntentId);
    return true;
  },
});

/** Expire/cancel a pending order (buyer backed out of Stripe checkout). */
export const cancelPendingOrder = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const order = await ctx.db
      .query("ticketOrders")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", sessionId),
      )
      .unique();
    if (order && order.status === "pending") {
      await ctx.db.patch(order._id, { status: "expired", updatedAt: Date.now() });
    }
    return null;
  },
});

// ── INTERNAL: payloads for emails + the public cover endpoint ────────────────

export const getOrderEmailPayload = internalQuery({
  args: { orderId: v.id("ticketOrders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order) return null;
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .take(100);
    const event = await ctx.db.get(order.eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", order.eventId))
      .unique();
    return {
      order,
      tickets: tickets.map((t) => ({
        code: t.code,
        ticketTypeName: t.ticketTypeName,
      })),
      eventName: event?.name ?? "Event",
      startDate: event?.eventDate ?? null,
      venueName: page?.venueName ?? null,
      slug: page?.slug ?? null,
    };
  },
});

/** Resolve a published page's cover image for the public /event/<slug>/cover route. */
export const getCoverStorageId = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const page = await getPublishedPage(ctx, slug);
    return page?.coverImage ?? null;
  },
});
