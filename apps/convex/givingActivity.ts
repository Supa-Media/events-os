/**
 * Public activity wall (`/give` redesign, wave 2, F6; recomposed by
 * give-redesign-v3 C1/C2) — see `schema/givingActivity.ts` for the table's
 * full design doc + lifecycle. Surfaces:
 *  - `recordPendingActivity` (internalMutation) — called by
 *    `givingDonations.startGiveDonationCheckout` /
 *    `givingPledges.startPledgeCheckout` right after the Stripe Checkout
 *    Session is created, for EVERY gift and pledge (v3 D6 — consent gates
 *    attribution, never existence).
 *  - `markActivityVisible` (internalMutation) — called by the orchestrator's
 *    `/stripe/webhook` fan-out (`http.ts`) on settle, alongside
 *    `recordGiveDonationPaid` / `recordPledgeInvoice`.
 *  - `getPublicWall` (PUBLIC query, no auth) — v3 C1: the org-wide or
 *    per-city feed plus the live totals. The `/give` and `/give/<slug>`
 *    renderers' single source.
 *  - `getTerritoryActivity` (PUBLIC query, no auth) — the pre-v3 per-city
 *    wall. NOTHING CALLS IT: the city page was swapped onto `getPublicWall` in
 *    this same change. Kept for one release as the rollback read; see its own
 *    doc.
 *  - `listActivityAdmin` / `hideActivity` / `restoreActivity` (central
 *    `giving.view`/`giving.manage`) — OS moderation, surfaced at
 *    `/giving/wall` in the app so a takedown never requires a developer.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  ACTIVITY_HIDDEN_REASONS,
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
} from "./schema/givingActivity";
import { givingScope } from "./schema/givingPlatform";
import { requireGivingManage, requireGivingView } from "./lib/givingAccess";
import type { GivingScope } from "./lib/givingAccess";
import { requireUserId } from "./lib/context";
import type { Doc, Id } from "./_generated/dataModel";

const activityKindValidator = v.union(
  ...ACTIVITY_KINDS.map((k) => v.literal(k)),
);
const activityStatusValidator = v.union(
  ...ACTIVITY_STATUSES.map((s) => v.literal(s)),
);
const activityHiddenReasonValidator = v.union(
  ...ACTIVITY_HIDDEN_REASONS.map((r) => v.literal(r)),
);

/** A public display name is a short handle ("Sam K."), not a full legal
 *  name — capped well short of the message. */
const DISPLAY_NAME_MAX_LEN = 60;
/** A generous cap on the public message — a sentence or two, not an essay
 *  (mirrors the "Let's make this happen." example in the spec). */
const MESSAGE_MAX_LEN = 280;

/** The wall shows a handful of recent entries, not a full history. */
const TERRITORY_ACTIVITY_LIMIT = 20;

/** C1's defaults for `getPublicWall`: a dozen rows is the page's block, and
 *  thirty is as deep as any renderer is allowed to ask. A public, unauthed
 *  query needs its own ceiling — the caller's `limit` is a request, not an
 *  instruction. */
const PUBLIC_WALL_DEFAULT_LIMIT = 12;
const PUBLIC_WALL_MAX_LIMIT = 30;

/**
 * How many rows the per-city feed reads before sorting.
 *
 * The org-wide feed can take exactly what it needs, because
 * `by_status_and_settledAt` is already in settle order. The per-city feed
 * reads `by_scope_and_status`, which is ordered by the index's implicit
 * `_creationTime` — and migration 0074 wrote every historical gift's wall row
 * at deploy time, so creation order says a gift from last year is newer than
 * one from this morning. Over-reading a bounded window and sorting it by
 * `settledAt` fixes the order without a second per-scope index; the window is
 * many times `PUBLIC_WALL_MAX_LIMIT`, so it can only go wrong for a city with
 * more than this many entries where the oldest of them is still wanted, which
 * the renderer cannot ask for.
 */
const PUBLIC_WALL_SCAN_LIMIT = 120;

/**
 * A territory needs at least this many lifetime gifts before the wall will
 * NAME it (C1). One gift in a small prospect city identifies the giver as
 * surely as printing their name would — "a $500 gift to Ithaca" in a place
 * with one giver is a person, and everyone in that city knows which one. Below
 * the floor the row still appears and still counts; it just doesn't say where.
 * Counted from `givingScopeRollups.giftCount`, which is O(1) and already the
 * number every other giving surface trusts.
 */
const SCOPE_LABEL_MIN_GIFTS = 3;

/** The public name for the `"central"` scope. Central is the org itself, not a
 *  place, so it is never suppressed by `SCOPE_LABEL_MIN_GIFTS` — there is no
 *  small population to re-identify. */
const CENTRAL_SCOPE_LABEL = "Central operations";

/** One rollup read per scope, and there is one rollup row per chapter plus
 *  central — so this is "every book", bounded. */
const SCOPE_ROLLUP_LIMIT = 500;

/** Mirrors `territories.ts#TERRITORY_LIST_LIMIT`: the territory list is
 *  central-authored and small by nature. */
const TERRITORY_LIST_LIMIT = 500;

/** A generous bound on the moderation list — nowhere near this in the
 *  current launch phase (mirrors `givingInterest.ts`'s `INTEREST_LIST_LIMIT`). */
const ACTIVITY_ADMIN_LIST_LIMIT = 500;

/** `undefined` for a blank/whitespace-only string, else the trimmed value,
 *  capped to `maxLen` (mirrors `givingInterest.ts`'s `trimmedOrUndefined`). */
function trimmedCapped(
  s: string | undefined,
  maxLen: number,
): string | undefined {
  const t = s?.trim();
  return t ? t.slice(0, maxLen) : undefined;
}

// ── Capture (internal — called from the checkout-start actions) ─────────────

/**
 * Record a `"pending"` wall entry right after a Stripe Checkout Session is
 * created (called from `givingDonations.startGiveDonationCheckout` /
 * `givingPledges.startPledgeCheckout`). NEVER shown publicly until
 * `markActivityVisible` flips it on settle — so an abandoned checkout never
 * reaches the wall.
 *
 * ── IT NOW WRITES A ROW FOR EVERY GIFT AND EVERY PLEDGE (v3, D6) ────────────
 * Two short-circuits used to live here and both are gone:
 *  - `consent !== true` → insert nothing, and
 *  - no display name and no message → insert nothing.
 * Between them, a row existed only for the givers who both ticked the box AND
 * typed something into a text field. The wall was therefore a highlight reel
 * of the most extroverted fraction of a fraction, on a page headed "every
 * gift, in public". The callers made it worse still: a `"central"` gift was
 * skipped before it ever got here, because the old `scope` type couldn't hold
 * one (D7).
 *
 * `consent` is still required, still stored, and still the giver's EXPLICIT
 * recorded answer — it just answers a narrower question now: MAY WE NAME YOU.
 * Attribution (`displayName` + `message`) is withheld on every read without
 * it; the row itself, an amount and a coarse date against a city, identifies
 * nobody. See `schema/givingActivity.ts#consent`.
 *
 * `consentIndexable` is the same answer for a SEARCHABLE page — see the
 * schema's field doc and the spec's "Privacy posture". Pass it only when the
 * consent was captured under copy that says the page can be found by search;
 * omitted (and therefore absent) means the older, quieter promise, which the
 * read honours by keeping the row anonymous rather than by hiding it.
 *
 * Name and message are still trimmed + capped, and still only stored when
 * non-empty — a blank string is not a name. What changed is that having
 * neither is no longer a reason to drop the giving.
 *
 * Idempotent on `refKey`: a redelivered/duplicate call (the checkout-start
 * action retried, or a defensive re-call) finds the existing row and no-ops
 * rather than inserting a second one.
 */
export const recordPendingActivity = internalMutation({
  args: {
    refKey: v.string(),
    // Chapter OR `"central"` (v3 C2/D7) — a central gift has a wall row like
    // any other; `kind: "central"` is what tells the read how to label it.
    scope: givingScope,
    kind: activityKindValidator,
    amountCents: v.number(),
    displayName: v.optional(v.string()),
    message: v.optional(v.string()),
    // "May we name you?" — required, because an unrecorded answer must never
    // be inferred from the fact that a row exists.
    consent: v.boolean(),
    // "…on a page search engines can find?" Optional: absent is a no.
    consentIndexable: v.optional(v.boolean()),
    // Set only for `kind: "fundraiser"` — the event whose goal card the row
    // renders (C1's `goal`).
    eventId: v.optional(v.id("events")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const displayName = trimmedCapped(args.displayName, DISPLAY_NAME_MAX_LEN);
    const message = trimmedCapped(args.message, MESSAGE_MAX_LEN);

    const existing = await ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", args.refKey))
      .unique();
    if (existing) return null; // idempotent — already recorded for this refKey

    await ctx.db.insert("givingActivity", {
      scope: args.scope,
      kind: args.kind,
      // Attribution is stored ONLY when the giver said yes. Keeping a name we
      // may never show would leave a self-provided public handle sitting in a
      // table whose entire purpose is to be published — pointless, and one
      // read-path bug away from being a disclosure. The consent flags below
      // are then a second gate over data that mostly isn't there.
      ...(args.consent === true && displayName ? { displayName } : {}),
      amountCents: args.amountCents,
      ...(args.consent === true && message ? { message } : {}),
      status: "pending",
      refKey: args.refKey,
      createdAt: Date.now(),
      consent: args.consent === true,
      // Only ever stamped `true`, never `false`: absent already means no, and
      // an explicit `false` would suggest a distinction that doesn't exist.
      ...(args.consent === true && args.consentIndexable === true
        ? { consentIndexable: true }
        : {}),
      ...(args.eventId ? { eventId: args.eventId } : {}),
    });
    return null;
  },
});

// ── Settle (internal — called from the /stripe/webhook fan-out) ─────────────

/**
 * Flip a `"pending"` wall entry to `"visible"` on settle and stamp
 * `settledAt`. `amountCents` is OPTIONAL: pass it for a ONE-TIME gift (the
 * settled Stripe `amount_total` is the truth, never the pre-settle intended
 * amount); OMIT it for a BACKER, whose displayed figure is the recurring
 * monthly pledge amount already stored at pending time (a `mode=subscription`
 * checkout session's `amount_total` is $0/prorated, so there's nothing truer to
 * re-stamp). Resolved by `refKey` (the session id for a gift, the pledge id for
 * a backer) — a `refKey` with no
 * matching row (a payment from before this table existed, or one whose
 * checkout-start write didn't run) is a safe no-op, mirroring the settle
 * handlers' "safe fan-out" pattern elsewhere in the giving stack.
 *
 * Idempotent: only a row still `"pending"` is flipped — a redelivered webhook
 * finds the row already `"visible"` and no-ops, so a duplicate delivery can
 * never re-stamp `settledAt` or re-apply the amount a second time.
 *
 * ── IT NO LONGER WITHHOLDS PUBLICATION OVER CONSENT (v3, D6) ────────────────
 * This used to refuse any row without `consent === true`, leaving it `pending`
 * for ever. That was the right rule while the row's mere existence WAS the
 * attribution — publishing an unconsented row published a name. Under v3 the
 * row is anonymous unless the read decides otherwise, so refusing to settle it
 * doesn't protect anyone; it just deletes that gift from "every gift, in
 * public" and leaves a permanently-pending row that no reader will ever look
 * at. Consent is re-checked where it now matters — on the way OUT, in
 * `getPublicWall`, every time.
 */
export const markActivityVisible = internalMutation({
  args: {
    refKey: v.string(),
    amountCents: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", args.refKey))
      .unique();
    if (!row) return null; // no wall entry for this refKey — safe no-op
    if (row.status !== "pending") return null; // already settled/hidden — idempotent no-op

    await ctx.db.patch(row._id, {
      status: "visible",
      // Overwrite with the settled amount for a gift; keep the stored monthly
      // amount for a backer (amountCents omitted).
      ...(args.amountCents !== undefined ? { amountCents: args.amountCents } : {}),
      settledAt: Date.now(),
    });
    return null;
  },
});

/**
 * Pull a wall entry back off the wall because the payment behind it didn't
 * happen — a bank debit that failed, or settled and was later returned.
 * Called by `givingComms.onAchFailed`.
 *
 * The wall's whole spam deterrent is that an entry means a real, settled
 * payment. A gift that was reversed makes that false, so the public echo has
 * to go with it. Uses `"hidden"` rather than deleting: same terminal state a
 * moderator's `hideActivity` produces, it can't be re-published by a
 * redelivered settle webhook (`markActivityVisible` only touches `"pending"`),
 * and the row survives for anyone asking later what happened.
 *
 * Idempotent and total: no row (the giver never opted in) and an
 * already-hidden row are both no-ops. Safe to call on any refKey.
 *
 * ── IT LOOKS UP BY ONE KEY, AND THAT IS A CONTRACT ON THE WRITERS ───────────
 * The only thing this knows about a payment is its `refKey`, so a row written
 * under a key the reversal paths cannot reconstruct is a row that can never
 * come down. That is why the wall backfill (migration 0076) keys its rows on
 * the gift's own `externalRef` (`give:<session>`) rather than on a synthetic
 * id: the historical rows answer to the same call this already makes. Making
 * this function *guess* at second keys instead — reading `gifts` to map a
 * session back to an id — would put a table read inside a webhook-driven
 * mutation to cover a case the writers can simply not create, so the invariant
 * is kept where it is cheap: at the write.
 */
export const withdrawActivity = internalMutation({
  args: { refKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { refKey }) => {
    const row = await ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", refKey))
      .unique();
    if (!row) return null; // nothing was ever posted for this payment
    if (row.status === "hidden") return null; // already off the wall
    // Stamp WHY, so the staff Wall screen's Restore can refuse this one: the
    // money is gone, and putting the entry back would be a lie.
    await ctx.db.patch(row._id, {
      status: "hidden",
      hiddenReason: "payment_reversed",
    });
    return null;
  },
});

// ── Public (no auth — PII-free) ──────────────────────────────────────────────

/**
 * The two kinds the PRE-v3 city-page renderer can draw
 * (`lib/givePage.ts#TerritoryActivityEntry`). v3 C2 added `"fundraiser"` and
 * `"central"` to the table; this query keeps its original, narrower promise
 * rather than handing that renderer a kind it has no layout for — the new
 * kinds are `getPublicWall`'s business, and this surface exists only until the
 * page is swapped onto it. (`"central"` cannot reach here anyway: the read is
 * keyed on a territory's chapter.)
 */
const legacyActivityKindValidator = v.union(
  v.literal("backer"),
  v.literal("gift"),
);

const territoryActivityRowValidator = v.object({
  kind: legacyActivityKindValidator,
  displayName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  message: v.union(v.string(), v.null()),
  at: v.number(),
});

/**
 * The PRE-v3 public activity wall for one territory (by slug): up to
 * `TERRITORY_ACTIVITY_LIMIT` newest `"visible"` entries that carry attribution
 * consent, PII-free — `displayName` is the giver's self-provided public
 * handle, NEVER a CRM name or email. Resolves slug → chapter the same way
 * `resolveTerritoryForCheckout` does (a hidden/unknown slug renders an empty
 * wall, not an error — a public page should never leak whether a slug exists).
 *
 * SUPERSEDED BY `getPublicWall` (v3 C1), AND IT NOW HAS NO CALLER. `http.ts`'s
 * `/give/<slug>` handler reads `getPublicWall` as of this change, so nothing in
 * the app renders this: it is a public, unauthed endpoint that no page asks
 * for. It is kept for ONE release rather than deleted alongside its consumer —
 * if the new wall has to come back out, this is what the old renderer read —
 * and it should be deleted once that is no longer a question.
 *
 * DELIBERATELY UNCHANGED while it lives. The pre-v3 renderer drew a NAMED row
 * and had no anonymous layout to fall back to, so feeding it the v3 population
 * (every gift through checkout, most of them nameless) would have printed rows
 * with a blank where the name goes. The consent filter therefore stays: this
 * query returns exactly what it always returned — the attributed subset — while
 * `getPublicWall` serves the full feed to the renderer built for it.
 *
 * The `consent === true` filter is therefore still doing its original job, and
 * is still the last gate before a donor's name and gift amount become public:
 * one comparison to make "we showed someone who didn't agree to be shown"
 * impossible rather than merely unlikely.
 */
export const getTerritoryActivity = query({
  args: { slug: v.string() },
  returns: v.array(territoryActivityRowValidator),
  handler: async (ctx, { slug }) => {
    const territory = await ctx.db
      .query("territories")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!territory || !territory.publiclyVisible) return [];

    const rows = await ctx.db
      .query("givingActivity")
      .withIndex("by_scope_and_status", (q) =>
        q.eq("scope", territory.chapterId).eq("status", "visible"),
      )
      .order("desc")
      .take(TERRITORY_ACTIVITY_LIMIT);

    return rows
      .filter(
        (r): r is typeof r & { kind: "backer" | "gift" } =>
          r.consent === true && (r.kind === "backer" || r.kind === "gift"),
      )
      .map((r) => ({
        kind: r.kind,
        displayName: r.displayName ?? null,
        amountCents: r.amountCents,
        message: r.message ?? null,
        at: r.settledAt ?? r.createdAt,
      }));
  },
});

// ── The v3 wall (C1) ─────────────────────────────────────────────────────────

const publicWallRowValidator = v.object({
  kind: activityKindValidator,
  amountCents: v.number(),
  // The raw settle instant. COARSE-BUCKETED ON RENDER (`relativeTimeLabel`'s
  // existing buckets) — the page never prints a precise time, because "at
  // 2:14pm" plus an amount plus a city is a great deal more identifying than
  // "this week". Returned raw only so the renderer can bucket and sort.
  at: v.number(),
  // "New York" / "Central operations", or `null` when naming the place would
  // identify the giver — see `SCOPE_LABEL_MIN_GIFTS`.
  scopeLabel: v.union(v.string(), v.null()),
  scopeSlug: v.union(v.string(), v.null()),
  // Consent-gated, both of them. `null` is the norm, not the exception.
  displayName: v.union(v.string(), v.null()),
  message: v.union(v.string(), v.null()),
  // Fundraiser rows only — the event's goal card. `null` everywhere else.
  goal: v.union(
    v.null(),
    v.object({
      label: v.string(),
      raisedCents: v.number(),
      targetCents: v.number(),
    }),
  ),
});

const publicWallValidator = v.object({
  totals: v.object({
    raisedCents: v.number(),
    giftCount: v.number(),
    giverCount: v.number(),
    backerCount: v.number(),
    cityCount: v.number(),
  }),
  rows: v.array(publicWallRowValidator),
});

/** A scope's denormalized giving rollup, or zeros when it has none yet (a
 *  chapter nobody has given to has no `givingScopeRollups` row at all). */
type ScopeTotals = {
  lifetimeCents: number;
  giftCount: number;
  donorCount: number;
};

const EMPTY_SCOPE_TOTALS: ScopeTotals = {
  lifetimeCents: 0,
  giftCount: 0,
  donorCount: 0,
};

/**
 * Every scope's rollup, keyed by scope. ONE ROW PER CHAPTER PLUS CENTRAL, by
 * construction (`givingScopeRollups`), so this is a small bounded read and the
 * totals it feeds cost O(number of books) — never O(gifts).
 */
async function readScopeRollups(
  ctx: QueryCtx,
  only?: GivingScope,
): Promise<Map<string, ScopeTotals>> {
  const rows = only
    ? await ctx.db
        .query("givingScopeRollups")
        .withIndex("by_scope", (q) => q.eq("scope", only))
        .take(1)
    : await ctx.db.query("givingScopeRollups").take(SCOPE_ROLLUP_LIMIT);
  const out = new Map<string, ScopeTotals>();
  for (const r of rows) {
    out.set(String(r.scope), {
      lifetimeCents: r.lifetimeCents,
      giftCount: r.giftCount,
      donorCount: r.donorCount,
    });
  }
  return out;
}

/**
 * Is this territory one of the "cities taking backers right now" the proof
 * strip counts (C1's `cityCount`)?
 *
 * A `prospect` is NOT. Its chapter is a shadow chapter (`isActive: false` until
 * launch — `schema/territories.ts`); `raising` is the stage that means "this
 * place is collecting backers now". The renderer already draws exactly that
 * line: `givePageSections.ts#cityCardsHtml` filters `stage !== "prospect"` out
 * of the city grid and folds prospects into the single "Ask for a chapter here"
 * card. Counting them here put "6 cities taking backers right now" directly
 * above a grid of 2 — the one number on the strip a reader can check by
 * counting, wrong, on the page's proof block.
 *
 * `publiclyVisible` is still required and still separate: it decides whether a
 * giver can reach the page at all, this decides whether the page is asking for
 * backers.
 */
function takingBackers(t: Doc<"territories">): boolean {
  return t.stage !== "prospect";
}

/**
 * The public giving wall (give-redesign-v3 C1) — the org-wide feed, or one
 * city's when `slug` is given. NO AUTH: this is what `/give` and
 * `/give/<slug>` render, and after D10 those pages are indexable.
 *
 * ── THE TOTAL IS LIVE, AND THAT IS THE POINT (D8) ───────────────────────────
 * `raisedCents` sums `givingScopeRollups.lifetimeCents` — one row per chapter
 * plus central, bumped on every gift write and clamped ≥ 0. A giver must be
 * able to give and immediately watch the number move, which rules out both a
 * published-monthly figure (that's `/finances`, and its "published month by
 * month" language stays there) and a cached snapshot.
 *
 * It also rules out summing `gifts`. That table is unbounded and grows for
 * ever; a public, unauthed, uncacheable query that scans it is a page that
 * gets slower every month and eventually trips its read cap — at which point
 * the headline number on the giving page silently becomes wrong. The rollups
 * exist precisely so no read has to count (Convex has no count operator; see
 * `schema/givingPlatform.ts#givingScopeRollups`), so the wall reads what every
 * other giving surface already trusts.
 *
 * `giftCount` / `giverCount` come from the same rows (`giftCount` /
 * `donorCount`) for the same reason. `giverCount` is therefore DONOR ROWS, not
 * distinct humans: a donor who gave eleven times to one city counts once, but
 * `donors` is scoped per chapter (`donors.scope`, like `gifts.scope`), so
 * somebody who gives to New York AND to Columbus has two donor rows and is
 * counted twice in the org-wide sum.
 *
 * THAT IS DELIBERATE, AND THE COPY CARRIES IT rather than the query. Making the
 * number a true head-count means reading `donors` itself and de-duplicating on
 * email/person — an unbounded scan in a public, unauthed, uncacheable query,
 * which is the exact cost the rollups exist to avoid (see above) and which
 * would get slower every month on the page whose numbers must never go stale.
 * So the cheap number stays and the LABEL says how it counts: the proof strip
 * reads "givers, counted once in each city they give to", not "people"
 * (`givePageSections.ts#proofStripHtml`). If a true distinct-person count is
 * ever wanted, it belongs in a maintained rollup (a `people`-linked counter
 * bumped on `recordGiftForDonor`), not in this read.
 *
 * ── ATTRIBUTION IS DECIDED HERE, ON EVERY READ ──────────────────────────────
 * Every settled row appears (D6). `displayName` and `message` come back only
 * when the row carries BOTH `consent === true` (may we name you) AND
 * `consentIndexable === true` (…on a page search engines can find). The second
 * condition is not belt-and-braces: this query feeds pages that D10 makes
 * indexable, and a consent captured under the old copy — which promised a page
 * that asked not to be indexed — is not consent to that. Those rows still
 * appear and still count; they just stay anonymous. See the spec's "Privacy
 * posture" and `schema/givingActivity.ts#consentIndexable`.
 *
 * ── AND SO IS WHETHER WE NAME THE CITY ──────────────────────────────────────
 * `scopeLabel` is suppressed for a territory with fewer than
 * `SCOPE_LABEL_MIN_GIFTS` lifetime gifts. `scopeSlug` goes with it: a link to
 * `/give/ithaca` beside an amount says the same thing the label would, so
 * suppressing only the one the contract names would be theatre.
 *
 * An unknown or non-public slug returns zeroed totals and an empty feed rather
 * than an error, matching `getTerritoryActivity` — a public page must never
 * leak whether a slug exists.
 */
export const getPublicWall = query({
  args: {
    // Absent → the org-wide feed (`/give`). Present → that city only.
    slug: v.optional(v.string()),
    // Default 12, hard-capped at 30 — see `PUBLIC_WALL_MAX_LIMIT`.
    limit: v.optional(v.number()),
  },
  returns: publicWallValidator,
  handler: async (ctx, args) => {
    // Clamped, floored, and NaN-proofed: Convex's `v.number()` is a float64,
    // so `NaN` and `Infinity` are legal arguments to a PUBLIC endpoint and
    // would otherwise reach `.take()`. The caller's `limit` is a request.
    const requested = args.limit ?? PUBLIC_WALL_DEFAULT_LIMIT;
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(PUBLIC_WALL_MAX_LIMIT, Math.floor(requested)))
      : PUBLIC_WALL_DEFAULT_LIMIT;
    const empty = {
      totals: {
        raisedCents: 0,
        giftCount: 0,
        giverCount: 0,
        backerCount: 0,
        cityCount: 0,
      },
      rows: [],
    };

    // ── Which books are we reporting on? ────────────────────────────────────
    let territory: Doc<"territories"> | null = null;
    if (args.slug !== undefined) {
      territory = await ctx.db
        .query("territories")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug!))
        .first();
      // A hidden territory is indistinguishable from one that never existed.
      if (!territory || !territory.publiclyVisible) return empty;
    }

    const rollups = await readScopeRollups(
      ctx,
      territory ? territory.chapterId : undefined,
    );

    // ── Rows ────────────────────────────────────────────────────────────────
    let visible: Doc<"givingActivity">[];
    if (territory) {
      // Over-read then sort: `by_scope_and_status` orders by the index's
      // implicit `_creationTime`, and the 0074 backfill wrote historical
      // giving at deploy time. See `PUBLIC_WALL_SCAN_LIMIT`.
      const window = await ctx.db
        .query("givingActivity")
        .withIndex("by_scope_and_status", (q) =>
          q.eq("scope", territory!.chapterId).eq("status", "visible"),
        )
        .order("desc")
        .take(PUBLIC_WALL_SCAN_LIMIT);
      visible = window
        .sort((a, b) => (b.settledAt ?? b.createdAt) - (a.settledAt ?? a.createdAt))
        .slice(0, limit);
    } else {
      // Already in settle order — take exactly what the page asked for.
      visible = await ctx.db
        .query("givingActivity")
        .withIndex("by_status_and_settledAt", (q) => q.eq("status", "visible"))
        .order("desc")
        .take(limit);
    }

    // One lookup per distinct CHAPTER, not per row — a feed of thirty rows
    // spans a handful of places (mirrors `listActivityAdmin`'s shape).
    const placeByChapter = new Map<string, { name: string; slug: string } | null>();
    for (const row of visible) {
      if (row.scope === "central") continue;
      const key = String(row.scope);
      if (placeByChapter.has(key)) continue;
      if (territory && key === String(territory.chapterId)) {
        placeByChapter.set(key, {
          name: territory.name,
          slug: territory.slug,
        });
        continue;
      }
      const t = await ctx.db
        .query("territories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", row.scope as Id<"chapters">))
        .first();
      // A chapter with no public territory has no public name to print. Not a
      // suppression — there is simply nothing a reader could be shown.
      placeByChapter.set(
        key,
        t && t.publiclyVisible ? { name: t.name, slug: t.slug } : null,
      );
    }

    // One lookup per distinct fundraiser event, same reasoning.
    const goalByEvent = new Map<
      string,
      { label: string; raisedCents: number; targetCents: number } | null
    >();
    for (const row of visible) {
      if (row.kind !== "fundraiser" || !row.eventId) continue;
      const key = String(row.eventId);
      if (goalByEvent.has(key)) continue;
      const page = await ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", row.eventId!))
        .unique();
      const event = await ctx.db.get(row.eventId);
      // A TRAINING-SANDBOX event never reaches a public page — mirrors
      // `territories.ts#fundraisersForChapter`, which drops `isTraining` before
      // it builds a public fundraiser row. Nothing writes `kind: "fundraiser"`
      // today, so this is unreachable; it is here because the day something
      // does, the page is search-indexable (D10) and a sandbox event's name
      // must not be the thing that gets indexed.
      goalByEvent.set(
        key,
        page &&
          page.published &&
          page.goalCents &&
          page.goalCents > 0 &&
          event &&
          !event.isTraining
          ? {
              label: event.name,
              // The same three-part sum `territories.ts` reports for a
              // fundraiser (tickets + on-page giving + attached gifts), so the
              // wall and the city page never disagree about one event.
              raisedCents:
                page.revenueCents +
                (page.donationsCents ?? 0) +
                (page.externalGiftsCents ?? 0),
              targetCents: page.goalCents,
            }
          : null,
      );
    }

    const rows = visible.map((row) => {
      const isCentral = row.scope === "central";
      const place = isCentral ? null : placeByChapter.get(String(row.scope)) ?? null;
      const scopeGifts =
        (rollups.get(String(row.scope)) ?? EMPTY_SCOPE_TOTALS).giftCount;
      // Central is the org, not a population of givers — nothing to
      // re-identify, so the floor doesn't apply to it.
      const nameThePlace =
        isCentral || (place !== null && scopeGifts >= SCOPE_LABEL_MIN_GIFTS);
      // BOTH consents, every time. See the header.
      const named = row.consent === true && row.consentIndexable === true;
      return {
        kind: row.kind,
        amountCents: row.amountCents,
        at: row.settledAt ?? row.createdAt,
        scopeLabel: isCentral
          ? CENTRAL_SCOPE_LABEL
          : nameThePlace
            ? (place?.name ?? null)
            : null,
        scopeSlug: isCentral ? null : nameThePlace ? (place?.slug ?? null) : null,
        displayName: named ? (row.displayName ?? null) : null,
        message: named ? (row.message ?? null) : null,
        goal:
          row.kind === "fundraiser" && row.eventId
            ? (goalByEvent.get(String(row.eventId)) ?? null)
            : null,
      };
    });

    // ── Totals ──────────────────────────────────────────────────────────────
    let raisedCents = 0;
    let giftCount = 0;
    let giverCount = 0;
    for (const t of rollups.values()) {
      raisedCents += t.lifetimeCents;
      giftCount += t.giftCount;
      giverCount += t.donorCount;
    }

    let backerCount = 0;
    let cityCount = 0;
    if (territory) {
      const chapter = await ctx.db.get(territory.chapterId);
      backerCount = chapter?.backerCount ?? 0;
      cityCount = takingBackers(territory) ? 1 : 0;
    } else {
      const territories = await ctx.db
        .query("territories")
        .take(TERRITORY_LIST_LIMIT);
      for (const t of territories) {
        if (!t.publiclyVisible) continue;
        if (takingBackers(t)) cityCount += 1;
        const chapter = await ctx.db.get(t.chapterId);
        // The ONE backer counter per place (`chapters.backerCount`, derived by
        // `givingPledges.recomputeChapterBackerCount`) — territories
        // deliberately carry none of their own, so this can never drift.
        // Counted for EVERY public territory, prospect included: a prospect
        // with backers has them, and hiding real money would be a different
        // lie from the one `cityCount` is fixing.
        backerCount += chapter?.backerCount ?? 0;
      }
    }

    return {
      totals: { raisedCents, giftCount, giverCount, backerCount, cityCount },
      rows,
    };
  },
});

// ── Admin (central `giving.view`/`giving.manage`) ────────────────────────────

const activityAdminRowValidator = v.object({
  _id: v.id("givingActivity"),
  // Widened with the column (v3 C2): a `"central"` row reaches the moderation
  // desk like any other, and has no territory to name.
  scope: givingScope,
  kind: activityKindValidator,
  displayName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  message: v.union(v.string(), v.null()),
  status: activityStatusValidator,
  refKey: v.string(),
  createdAt: v.number(),
  settledAt: v.union(v.number(), v.null()),
  // The recorded consent + why the row came down, so the staff screen can say
  // out loud which rows are on the public wall and which can be put back.
  consent: v.boolean(),
  hiddenReason: v.union(activityHiddenReasonValidator, v.null()),
  // WHO took it down and WHEN, resolved to a display name for a dumb render.
  // `null` when nobody did (never hidden, or the system pulled it because the
  // payment reversed) — the screen renders "System" for a reasoned takedown
  // with no actor, and rows hidden before these fields existed read as
  // "Unknown".
  hiddenByName: v.union(v.string(), v.null()),
  hiddenAt: v.union(v.number(), v.null()),
  // Which public page this entry appears on (`/give/<slug>`) — a wall entry is
  // meaningless to a moderator without the page it's on. `null` for a chapter
  // with no territory row.
  territoryName: v.union(v.string(), v.null()),
  territorySlug: v.union(v.string(), v.null()),
});

/** Every wall entry (any status), newest first — the OS moderation list.
 *  Central `giving.view`: the wall spans every territory, like the territory
 *  map and interest inbox. */
export const listActivityAdmin = query({
  args: {},
  returns: v.array(activityAdminRowValidator),
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");
    const rows = await ctx.db
      .query("givingActivity")
      .order("desc")
      .take(ACTIVITY_ADMIN_LIST_LIMIT);

    // One lookup per distinct chapter, not per row — the wall spans a handful
    // of territories however many entries it holds.
    const territoryByChapter = new Map<
      string,
      { name: string; slug: string } | null
    >();
    for (const r of rows) {
      // A central row has no chapter and therefore no territory page; it is
      // skipped here and reads back as `null`/`null` below.
      if (r.scope === "central") continue;
      if (territoryByChapter.has(r.scope)) continue;
      const territory = await ctx.db
        .query("territories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", r.scope as Id<"chapters">))
        .first();
      territoryByChapter.set(
        r.scope,
        territory ? { name: territory.name, slug: territory.slug } : null,
      );
    }

    // Same one-lookup-per-distinct-id shape as the territories above: a
    // handful of staff account for however many takedowns.
    const nameByUser = new Map<string, string | null>();
    for (const r of rows) {
      if (!r.hiddenBy || nameByUser.has(r.hiddenBy)) continue;
      const user = await ctx.db.get(r.hiddenBy);
      nameByUser.set(r.hiddenBy, user?.name ?? user?.email ?? null);
    }

    return rows.map((r) => {
      const territory = territoryByChapter.get(r.scope) ?? null;
      return {
        _id: r._id,
        scope: r.scope,
        kind: r.kind,
        displayName: r.displayName ?? null,
        amountCents: r.amountCents,
        message: r.message ?? null,
        status: r.status,
        refKey: r.refKey,
        createdAt: r.createdAt,
        settledAt: r.settledAt ?? null,
        // Absent consent reads as `false` — the same "absent is a NO" rule the
        // publish and public-read paths apply, so the staff screen can never
        // show a row as consented when the record doesn't say so.
        consent: r.consent === true,
        hiddenReason: r.hiddenReason ?? null,
        // A deleted/missing user still leaves the takedown attributed to
        // "Unknown" rather than silently reading as the system.
        hiddenByName: r.hiddenBy
          ? (nameByUser.get(r.hiddenBy) ?? "Unknown")
          : null,
        hiddenAt: r.hiddenAt ?? null,
        territoryName: territory?.name ?? null,
        territorySlug: territory?.slug ?? null,
      };
    });
  },
});

/** Moderate a wall entry off the public wall (central `giving.manage`) — sets
 *  `status: "hidden"` and stamps `hiddenReason: "staff"`, which is what makes
 *  it restorable. Does NOT touch the underlying gift/pledge history, only its
 *  public echo. Idempotent: hiding an already-hidden row is a no-op.
 *
 *  This is the function the "Take down" button on the staff Wall screen calls.
 *  Before that screen existed, the only takedown was a developer running this
 *  by hand — which is not an answer you can give a donor who emails asking to
 *  come off the wall. */
export const hideActivity = mutation({
  args: { id: v.id("givingActivity") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireGivingManage(ctx, "central");
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;
    const row = await ctx.db.get(id);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Activity entry not found.",
      });
    }
    if (row.status !== "hidden") {
      // Who and when, recorded on the row. A takedown changes what the public
      // sees, so it should never be anonymous.
      await ctx.db.patch(id, {
        status: "hidden",
        hiddenReason: "staff",
        hiddenBy: actorUserId,
        hiddenAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Undo a STAFF takedown (central `giving.manage`) — the reason the Take down
 * button is safe to press. Returns the row to where it was before someone hid
 * it: `"visible"` if the payment had already settled, `"pending"` if it hadn't
 * (a never-settled row must not be published by an undo).
 *
 * Refuses, loudly rather than silently, when putting the row back would be
 * wrong:
 *  - not `"hidden"` — nothing to undo.
 *  - `hiddenReason !== "staff"` — a `payment_reversed` row is off the wall
 *    because the money is gone, and an absent reason means we can't say why it
 *    came down. Neither is a human decision this can reverse.
 *
 * IT NO LONGER REFUSES OVER CONSENT (v3, D6). It used to, on the reasoning
 * that "restore is a publish path, so it re-checks consent" — sound while
 * publishing a row meant publishing a name. It doesn't any more: an
 * unconsented row goes back exactly as it came down, anonymous, because
 * attribution is decided by `getPublicWall` on every single read and cannot be
 * conferred by a restore. Keeping the refusal would have meant a staff member
 * who took down an anonymous row by mistake could never put that gift back —
 * a one-way button, which is the exact fear `restoreActivity` exists to remove.
 */
export const restoreActivity = mutation({
  args: { id: v.id("givingActivity") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireGivingManage(ctx, "central");
    const row = await ctx.db.get(id);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Activity entry not found.",
      });
    }
    if (row.status !== "hidden") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "That entry isn't hidden, so there's nothing to restore.",
      });
    }
    if (row.hiddenReason !== "staff") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message:
          "This entry came off the wall because its payment was reversed, not because someone took it down. It can't be restored.",
      });
    }
    await ctx.db.patch(id, {
      // Settled means it was on the wall before someone hid it; unsettled means
      // it was still waiting on the payment, and that's where it goes back to.
      status: row.settledAt !== undefined ? "visible" : "pending",
      // A row that is back up was not taken down by anyone — clear the whole
      // takedown stamp together, so "hidden" state is never half-remembered.
      hiddenReason: undefined,
      hiddenBy: undefined,
      hiddenAt: undefined,
    });
    return null;
  },
});
