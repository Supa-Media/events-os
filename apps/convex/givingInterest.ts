/**
 * Interest capture + suggest-a-space (giving-territories addendum, the
 * `/give` redesign) — see `schema/givingInterest.ts` for the table's full
 * design doc. Three surfaces, mirroring `territories.ts`'s PUBLIC/ADMIN split:
 *  - PUBLIC `submitInterest` (no auth) — the write path behind
 *    `POST /api/give/interest` (wired in `lib/giveApiRoutes.ts`,
 *    orchestrator-owned) — "want this in my city," volunteer, join the
 *    founding team, help fund, or suggest a space.
 *  - PUBLIC `publicInterestStats` (no auth) — the PII-free aggregate counts
 *    the `/give` page renders, mirroring `territories.getPublicMapData`'s
 *    bounded-count discipline (no denormalized rollup — see that function's
 *    doc for why a bounded `.take()` count is the right call here too).
 *  - ADMIN `listInterest` / `setInterestStatus` (central `giving.view`/
 *    `giving.manage`) — the OS triage inbox
 *    (`apps/mobile/app/(app)/giving/interest.tsx`). Interest capture is a
 *    central surface, not chapter-scoped, like the territory map.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  GIVING_INTEREST_KINDS,
  GIVING_INTEREST_STATUSES,
  type GivingInterestKind,
} from "./schema/givingInterest";
import { requireGivingManage, requireGivingView } from "./lib/givingAccess";
import { requireUserId } from "./lib/context";

const kindValidator = v.union(
  ...GIVING_INTEREST_KINDS.map((k) => v.literal(k)),
);
const kindsValidator = v.array(kindValidator);
const statusValidator = v.union(
  ...GIVING_INTEREST_STATUSES.map((s) => v.literal(s)),
);

/** Set for O(1) "is this a known kind" membership checks in `submitInterest`. */
const KNOWN_KINDS = new Set<string>(GIVING_INTEREST_KINDS);

/** Type guard narrowing a loose string to a `GivingInterestKind`, backed by
 *  the same `KNOWN_KINDS` set `submitInterest` validates against. */
function isGivingInterestKind(k: string): k is GivingInterestKind {
  return KNOWN_KINDS.has(k);
}

/** A generous free-text-ask cap — not an essay, but no reason to truncate a
 *  real message either. */
const MESSAGE_MAX_LEN = 2000;
/** "Queens, NY" not a full mailing address, but generous. */
const LOCATION_MAX_LEN = 200;
/** A phone number, not an essay. */
const PHONE_MAX_LEN = 40;
/** "@handle" or a profile URL. */
const SOCIAL_HANDLE_MAX_LEN = 100;
/** Founding-team fields (F7): a role interest is a short label ("Chapter
 *  Director," "Wherever I'm needed"), not a paragraph. */
const ROLE_MAX_LEN = 60;
/** No more than one per `CHAPTER_CORE_ROLES` row plus a little headroom for
 *  "wherever I'm needed"-style catch-alls — a real person doesn't pick more
 *  than a handful. */
const ROLES_MAX_COUNT = 12;
/** "What skills do you bring" — a short pitch, not a resume. */
const SKILLS_MAX_LEN = 1000;
/** A church name/description, not an address. */
const CHURCH_MAX_LEN = 200;

/** Bounded scan for `publicInterestStats`'s counts (Convex has no count
 *  operator). Mirrors `territories.getPublicMapData`'s bounded-read decision
 *  rather than a denormalized rollup counter: interest submissions are a
 *  launch-phase volume nowhere near this bound, so a rollup would be
 *  premature machinery for numbers this small. */
const INTEREST_STATS_LIMIT = 5000;

/** A generous bound on the triage inbox — a handful of submissions at a time
 *  in the current launch phase, nowhere near this. */
const INTEREST_LIST_LIMIT = 500;

/** `undefined` for a blank/whitespace-only string, else the trimmed value. */
function trimmedOrUndefined(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

/** Trims every entry, drops blanks, and returns `undefined` for an empty
 *  result — the array analogue of `trimmedOrUndefined`, used for `roles`. */
function trimmedRolesOrUndefined(
  roles: string[] | undefined,
): string[] | undefined {
  if (!roles) return undefined;
  const trimmed = roles.map((r) => r.trim()).filter((r) => r.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Public (no auth) ─────────────────────────────────────────────────────────

/**
 * PUBLIC entry point for the `/give` page's interest + suggest-a-space CTAs
 * (no auth — like `givingPledges.startPledgeCheckout` / the donation flow).
 *
 * MULTI-SELECT (wave 2, F4): `kinds` is an array — a person can pick several
 * intents at once ("want in my city" + "volunteer" + "help fund"). At least
 * ONE kind is required, every entry is validated against
 * `GIVING_INTEREST_KINDS`, and duplicates are silently deduped (the client
 * shouldn't be able to send the same checkbox twice, but don't trust it).
 *
 * BASELINE rule (no `join_team`): at least ONE of name/email/location/message
 * must be present — a submission with nothing to act on (no way to reach the
 * person, no context) isn't a usable lead.
 *
 * FOUNDING-TEAM rule (F7, `kinds` includes `join_team`): stricter — `name`,
 * `phone`, `email`, and at least one `roles` entry are ALL REQUIRED. A
 * founding-team lead is a real leadership ask (see F7's "who we're looking
 * for" copy) and central needs a name + two ways to reach them + a sense of
 * which role(s) they're interested in to follow up meaningfully; the looser
 * baseline rule isn't enough for this kind. `skills`/`church` stay optional
 * even for `join_team` (helpful context, not a hard requirement).
 *
 * No payment or Stripe interaction here at all. Backed by
 * `/api/give/interest` (`lib/giveApiRoutes.ts`, orchestrator-owned).
 */
export const submitInterest = mutation({
  args: {
    // Deliberately `v.array(v.string())`, NOT the strict `kindsValidator`
    // union: a loose args validator lets an unknown entry reach the handler
    // below, which rejects it with a friendly `ConvexError` (a helpful
    // message for the public form) instead of Convex's generic argument-
    // validation failure. The strict union still guards the SCHEMA (what
    // actually lands in the table) and the read-side row validators.
    kinds: v.array(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    socialHandle: v.optional(v.string()),
    location: v.optional(v.string()),
    message: v.optional(v.string()),
    territorySlug: v.optional(v.string()),
    roles: v.optional(v.array(v.string())),
    skills: v.optional(v.string()),
    church: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const name = trimmedOrUndefined(args.name);
    const email = trimmedOrUndefined(args.email)?.toLowerCase();
    const phone = trimmedOrUndefined(args.phone);
    const socialHandle = trimmedOrUndefined(args.socialHandle);
    const location = trimmedOrUndefined(args.location);
    const message = trimmedOrUndefined(args.message);
    const territorySlug = trimmedOrUndefined(args.territorySlug);
    const skills = trimmedOrUndefined(args.skills);
    const church = trimmedOrUndefined(args.church);
    const roles = trimmedRolesOrUndefined(args.roles);

    for (const kind of args.kinds) {
      if (!isGivingInterestKind(kind)) {
        throw new ConvexError({
          code: "INVALID_KIND",
          message: `Unknown interest kind: ${kind}.`,
        });
      }
    }
    // Dedupe while preserving first-seen order (Set iteration order). Safe to
    // narrow to `GivingInterestKind[]` — every entry passed the loop above.
    const kinds = [...new Set(args.kinds)].filter(isGivingInterestKind);
    if (kinds.length === 0) {
      throw new ConvexError({
        code: "INVALID_KINDS",
        message: "Pick at least one option.",
      });
    }
    const wantsJoinTeam = kinds.includes("join_team");

    if (wantsJoinTeam) {
      // Founding-team asks need a real way to follow up + a sense of role —
      // stricter than the baseline "give us SOMETHING" rule below.
      const missing: string[] = [];
      if (!name) missing.push("name");
      if (!phone) missing.push("phone");
      if (!email) missing.push("email");
      if (!roles || roles.length === 0) missing.push("at least one role");
      if (missing.length > 0) {
        throw new ConvexError({
          code: "INVALID_JOIN_TEAM_SUBMISSION",
          message: `Joining the founding team needs a bit more: ${missing.join(", ")}.`,
        });
      }
    } else if (!name && !email && !location && !message) {
      throw new ConvexError({
        code: "INVALID_SUBMISSION",
        message:
          "Tell us a bit about yourself — a name, email, location, or message.",
      });
    }

    if (location && location.length > LOCATION_MAX_LEN) {
      throw new ConvexError({
        code: "INVALID_LOCATION",
        message: `Location must be ${LOCATION_MAX_LEN} characters or fewer.`,
      });
    }
    if (message && message.length > MESSAGE_MAX_LEN) {
      throw new ConvexError({
        code: "INVALID_MESSAGE",
        message: `Message must be ${MESSAGE_MAX_LEN} characters or fewer.`,
      });
    }
    if (phone && phone.length > PHONE_MAX_LEN) {
      throw new ConvexError({
        code: "INVALID_PHONE",
        message: `Phone must be ${PHONE_MAX_LEN} characters or fewer.`,
      });
    }
    if (socialHandle && socialHandle.length > SOCIAL_HANDLE_MAX_LEN) {
      throw new ConvexError({
        code: "INVALID_SOCIAL_HANDLE",
        message: `Social handle must be ${SOCIAL_HANDLE_MAX_LEN} characters or fewer.`,
      });
    }
    if (roles) {
      if (roles.length > ROLES_MAX_COUNT) {
        throw new ConvexError({
          code: "INVALID_ROLES",
          message: `Pick ${ROLES_MAX_COUNT} roles or fewer.`,
        });
      }
      for (const role of roles) {
        if (role.length > ROLE_MAX_LEN) {
          throw new ConvexError({
            code: "INVALID_ROLES",
            message: `Each role must be ${ROLE_MAX_LEN} characters or fewer.`,
          });
        }
      }
    }
    if (skills && skills.length > SKILLS_MAX_LEN) {
      throw new ConvexError({
        code: "INVALID_SKILLS",
        message: `Skills must be ${SKILLS_MAX_LEN} characters or fewer.`,
      });
    }
    if (church && church.length > CHURCH_MAX_LEN) {
      throw new ConvexError({
        code: "INVALID_CHURCH",
        message: `Church must be ${CHURCH_MAX_LEN} characters or fewer.`,
      });
    }

    await ctx.db.insert("givingInterest", {
      kinds,
      name,
      email,
      phone,
      socialHandle,
      location,
      message,
      territorySlug,
      roles,
      skills,
      church,
      status: "new",
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * PUBLIC aggregate counts for the `/give` page (no auth): `{ total,
 * wantInCity }`, PII-free. Bounded `.take(INTEREST_STATS_LIMIT)` counts ONLY
 * — never a name/email/location/message field — mirroring
 * `territories.getPublicMapData`'s bounded-count discipline (see
 * `INTEREST_STATS_LIMIT`'s doc for why a rollup counter isn't warranted yet).
 * `wantInCity` counts submissions whose `kinds` INCLUDES `"want_in_city"`
 * (wave 2, F4: a row can carry several kinds at once, so this is a membership
 * check, not an equality check).
 */
export const publicInterestStats = query({
  args: {},
  returns: v.object({ total: v.number(), wantInCity: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("givingInterest").take(INTEREST_STATS_LIMIT);
    const wantInCity = rows.filter((r) =>
      r.kinds.includes("want_in_city"),
    ).length;
    return { total: rows.length, wantInCity };
  },
});

// ── Admin (central `giving.view`/`giving.manage`) ────────────────────────────

const interestRowValidator = v.object({
  _id: v.id("givingInterest"),
  kinds: kindsValidator,
  name: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  socialHandle: v.union(v.string(), v.null()),
  location: v.union(v.string(), v.null()),
  message: v.union(v.string(), v.null()),
  roles: v.union(v.array(v.string()), v.null()),
  skills: v.union(v.string(), v.null()),
  church: v.union(v.string(), v.null()),
  territorySlug: v.union(v.string(), v.null()),
  status: statusValidator,
  createdAt: v.number(),
  handledAt: v.union(v.number(), v.null()),
  handledBy: v.union(v.id("users"), v.null()),
});

/** Every interest submission, newest first — the triage inbox's full read
 *  (full fields, unlike the public surfaces above). Central `giving.view`:
 *  interest capture is a central surface, not chapter-scoped, like the
 *  territory map. */
export const listInterest = query({
  args: {},
  returns: v.array(interestRowValidator),
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");
    const rows = await ctx.db
      .query("givingInterest")
      .withIndex("by_createdAt")
      .order("desc")
      .take(INTEREST_LIST_LIMIT);
    return rows.map((r) => ({
      _id: r._id,
      kinds: r.kinds,
      name: r.name ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      socialHandle: r.socialHandle ?? null,
      location: r.location ?? null,
      message: r.message ?? null,
      roles: r.roles ?? null,
      skills: r.skills ?? null,
      church: r.church ?? null,
      territorySlug: r.territorySlug ?? null,
      status: r.status,
      createdAt: r.createdAt,
      handledAt: r.handledAt ?? null,
      handledBy: r.handledBy ?? null,
    }));
  },
});

/**
 * Update a submission's triage status (central `giving.manage`). Stamps
 * `handledAt`/`handledBy` on EVERY call — including re-affirming the current
 * status — so the desk always reflects who last touched the row.
 */
export const setInterestStatus = mutation({
  args: { id: v.id("givingInterest"), status: statusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");
    const row = await ctx.db.get(args.id);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Interest submission not found.",
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await ctx.db.patch(args.id, {
      status: args.status,
      handledAt: Date.now(),
      handledBy: userId,
    });
    return null;
  },
});
