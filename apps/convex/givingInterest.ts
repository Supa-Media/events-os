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
} from "./schema/givingInterest";
import { requireGivingManage, requireGivingView } from "./lib/givingAccess";
import { requireUserId } from "./lib/context";

const kindValidator = v.union(
  ...GIVING_INTEREST_KINDS.map((k) => v.literal(k)),
);
const statusValidator = v.union(
  ...GIVING_INTEREST_STATUSES.map((s) => v.literal(s)),
);

/** A generous free-text-ask cap — not an essay, but no reason to truncate a
 *  real message either. */
const MESSAGE_MAX_LEN = 2000;
/** "Queens, NY" not a full mailing address, but generous. */
const LOCATION_MAX_LEN = 200;

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

// ── Public (no auth) ─────────────────────────────────────────────────────────

/**
 * PUBLIC entry point for the `/give` page's interest + suggest-a-space CTAs
 * (no auth — like `givingPledges.startPledgeCheckout` / the donation flow).
 * Every field besides `kind` is individually optional, but at least ONE of
 * name/email/location/message must be present: a submission with nothing to
 * act on (no way to reach the person, no context) isn't a usable lead.
 * `kind` is validated at the argument boundary (the union above); no payment
 * or Stripe interaction here at all. Backed by `/api/give/interest`
 * (`lib/giveApiRoutes.ts`, orchestrator-owned).
 */
export const submitInterest = mutation({
  args: {
    kind: kindValidator,
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    location: v.optional(v.string()),
    message: v.optional(v.string()),
    territorySlug: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const name = trimmedOrUndefined(args.name);
    const email = trimmedOrUndefined(args.email)?.toLowerCase();
    const location = trimmedOrUndefined(args.location);
    const message = trimmedOrUndefined(args.message);
    const territorySlug = trimmedOrUndefined(args.territorySlug);

    if (!name && !email && !location && !message) {
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

    await ctx.db.insert("givingInterest", {
      kind: args.kind,
      name,
      email,
      location,
      message,
      territorySlug,
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
 * `wantInCity` counts kind `"want_in_city"` only.
 */
export const publicInterestStats = query({
  args: {},
  returns: v.object({ total: v.number(), wantInCity: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("givingInterest").take(INTEREST_STATS_LIMIT);
    const wantInCity = rows.filter((r) => r.kind === "want_in_city").length;
    return { total: rows.length, wantInCity };
  },
});

// ── Admin (central `giving.view`/`giving.manage`) ────────────────────────────

const interestRowValidator = v.object({
  _id: v.id("givingInterest"),
  kind: kindValidator,
  name: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  location: v.union(v.string(), v.null()),
  message: v.union(v.string(), v.null()),
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
      kind: r.kind,
      name: r.name ?? null,
      email: r.email ?? null,
      location: r.location ?? null,
      message: r.message ?? null,
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
