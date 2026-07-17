/**
 * Two-party seat-change proposals.
 *
 * ANY seat holder may PROPOSE filling or vacating a seat strictly BELOW one
 * of their own seats in the org-chart tree (walking `parentSlug` on the LIVE
 * `seatDefs` rows, not the static `@events-os/shared` template — runtime-added
 * seats must participate). A chapter chart's root seat (`chapter_director`)
 * hangs under the central `expansion_director` seat via
 * `CHAPTER_ROLLUP_PARENT` (see `packages/shared/src/seats.ts`), so a central
 * holder can propose into any chapter.
 *
 * The proposal only takes effect once APPROVED by a holder of a seat ABOVE
 * THE PROPOSER: starting from the proposer's own qualifying seat (the
 * nearest ancestor-of-target seat they currently hold), climb the tree,
 * skipping vacant seats and any holder who IS the proposer, until the first
 * ancestor seat with at least one OTHER holder — any holder of THAT seat may
 * decide (approve/decline). The proposer can never decide their own proposal
 * (checked by `personId`, not by seat).
 *
 * The ED seat (`executive_director`, the central chart's true root — nobody
 * is above it) and any `derived` seat (holders are computed, never assigned)
 * can never be the SUBJECT of a proposal — rejected at propose time.
 *
 * `approve` EXECUTES the change atomically through the exact same validated
 * path `seats.assignSeat`/`unassignSeat` enforce — `assignSeatImpl`/
 * `unassignSeatImpl` (exported by `seats.ts`, auth-free, mirroring
 * `specializedRoles.assignSpecializedRoleImpl`'s contract exactly): maxHolders
 * replace-or-cap, scope-local SoD, derived-seat rejection, the
 * `specializedRoles`/finance write-through bridge. A proposal approval NEVER
 * bypasses a check direct assignment enforces, and this file never duplicates
 * that validation logic. If execution throws (e.g. a SoD violation that
 * arose after `propose` time), the whole mutation throws too — Convex rolls
 * back the ENTIRE transaction, so the proposal row is untouched and stays
 * `"pending"` with the `ConvexError` surfaced directly to the approver (their
 * client sees exactly the same error `assignSeat` would have thrown). We
 * deliberately do NOT auto-decline on a validation failure — the underlying
 * seat state may become valid again (e.g. the conflicting holder is removed),
 * and the proposal should still be actionable rather than silently dead.
 *
 * ## Chain-top auto-execute
 *
 * Two-party approval requires someone ABOVE THE PROPOSER to exist. That's
 * structurally impossible for whoever sits at the very top of the org chart
 * (today, the ED at the central root) — `resolveEligibleDeciders` would climb
 * the proposer's own ancestor chain and find nothing, ever, and the proposal
 * would sit `"pending"` forever. `propose` special-cases exactly this: when
 * the proposer's qualifying seat (the nearest ancestor-of-target seat they
 * hold) has NO ancestor seat DEF above it at all — they hold the true top of
 * the walked chain, "chain-top" — the proposal EXECUTES IMMEDIATELY instead
 * of going pending, through the SAME `executeProposalChange` path `approve`
 * uses (so maxHolders, SoD, derived-seat rejection, and the legacy
 * write-through all still apply — a chain-top proposal gets ZERO less
 * validation than a two-party one). The row is still written, as `"approved"`
 * with `decidedByPersonId === proposedByPersonId` and `decidedAt ===
 * createdAt`, plus a machine-set note marking the auto-execution — the audit
 * trail is preserved even though nobody else decided it.
 *
 * This is deliberately NARROW: it is NOT "a decider-less proposer may act
 * unilaterally" as a general rule. It only fires when NO ancestor seat DEF
 * exists above the proposer's qualifying seat anywhere in the walk. A
 * MID-CHAIN proposer whose immediate ancestor seat merely happens to be
 * VACANT right now is a completely different case — that ancestor structurally
 * EXISTS, so the proposal stays `"pending"` exactly as it does today, waiting
 * for someone to occupy it (see `resolveEligibleDeciders`'s `"chain-top"` vs
 * `"none"` distinction). And because chain-top is recomputed live off the
 * actual `seatDefs` tree every time (never cached on the proposal row), the
 * day a Board (or any other) seat is added above the ED, the ED's own
 * proposals stop being chain-top automatically and fall back to normal
 * two-party approval — no migration, no flag, nothing to remember to flip.
 */
import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { SEAT_ROOT, CHAPTER_ROLLUP_PARENT, MULTI_HOLDER_CAP } from "@events-os/shared";
import { assignSeatImpl, unassignSeatImpl } from "./seats";
import { requireAccess, requireUserId } from "./lib/context";

type Scope = Id<"chapters"> | "central";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const actionValidator = v.union(v.literal("fill"), v.literal("vacate"));
const statusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("cancelled"),
);

/** Bounded read of a (scope, seatDefId) slot's occupants — mirrors
 *  `seats.ts`'s `MAX_SLOT_READ` (the universal ceiling on any seat's holder
 *  count is `MULTI_HOLDER_CAP`). */
const MAX_SLOT_READ = MULTI_HOLDER_CAP + 1;

/** Bounded scan of pending proposals (duplicate check / `pendingProposals`).
 *  Well above realistic pending-proposal volume; mirrors the
 *  `ROLLUP_SCAN_LIMIT` truncation-warning convention used across the backend
 *  (see `seats.ts`'s `boundedChapters`). */
const PENDING_SCAN_LIMIT = 500;

/** Defensive bound on how many links a tree-walk climbs, guarding against a
 *  cycle a bad runtime edit to `seatDefs` could introduce (mirrors
 *  `@events-os/shared`'s `seatAncestors` cycle guard, applied here to the
 *  LIVE DB rows instead of the static template). */
const MAX_CHAIN_DEPTH = 64;

/** Machine-set note `propose` records on a proposal it auto-executes because
 *  the proposer sits at the top of the approval chain (see the file doc
 *  comment's "Chain-top auto-execute" section) — appended to any caller-
 *  supplied note rather than overwriting it. */
const CHAIN_TOP_AUTO_NOTE =
  "Auto-executed: no seat exists above the proposer's in the org chart to approve this change (chain top).";

const proposalView = v.object({
  proposalId: v.id("seatProposals"),
  seatDefId: v.id("seatDefs"),
  seatSlug: v.string(),
  seatTitle: v.string(),
  scope: scopeValidator,
  scopeName: v.string(),
  action: actionValidator,
  subjectPersonId: v.id("people"),
  subjectName: v.string(),
  proposedByPersonId: v.id("people"),
  proposedByName: v.string(),
  status: statusValidator,
  note: v.optional(v.string()),
  createdAt: v.number(),
  decidedByPersonId: v.optional(v.id("people")),
  decidedByName: v.optional(v.string()),
  decidedAt: v.optional(v.number()),
});

// ── Tree-walk helpers (over the LIVE `seatDefs` rows) ───────────────────────

/** One (scope, seatDef) link in a cross-chart ancestor chain. */
interface ScopedSeat {
  scope: Scope;
  def: Doc<"seatDefs">;
}

async function defBySlug(
  ctx: QueryCtx | MutationCtx,
  slug: string,
): Promise<Doc<"seatDefs"> | null> {
  return ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/** Stable key for a (scope, seatDefId) pair — used for chain-cycle guards and
 *  proposer/held-seat set membership checks. */
function linkKey(scope: Scope, seatDefId: Id<"seatDefs">): string {
  return `${scope}:${seatDefId}`;
}

/**
 * `start`'s full ancestor chain, nearest first, walking `parentSlug` on the
 * LIVE `seatDefs` rows. When climbing off a chapter chart's root seat
 * (`parentSlug === SEAT_ROOT` while `scope` isn't `"central"`), bridges to
 * the central `CHAPTER_ROLLUP_PARENT` seat (`expansion_director`) — this is
 * how a central holder's authority reaches into every chapter. Stops at the
 * central chart's true root (`executive_director`'s `parentSlug ===
 * SEAT_ROOT` while already at `"central"` scope) — nobody is above it.
 *
 * Never includes `start` itself. Defensively bounded against a cycle a
 * runtime edit to `seatDefs` could introduce (throws, mirroring
 * `@events-os/shared`'s `seatAncestors`).
 */
async function ancestorChain(
  ctx: QueryCtx | MutationCtx,
  start: ScopedSeat,
): Promise<ScopedSeat[]> {
  const chain: ScopedSeat[] = [];
  const visited = new Set<string>([linkKey(start.scope, start.def._id)]);
  let scope = start.scope;
  let def = start.def;

  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    if (def.parentSlug === SEAT_ROOT) {
      if (scope === "central") break; // the true top of the tree
      const bridgeDef = await defBySlug(ctx, CHAPTER_ROLLUP_PARENT);
      if (!bridgeDef) break; // rollup target not seeded — nothing further to climb
      scope = "central";
      def = bridgeDef;
    } else {
      const parentDef = await defBySlug(ctx, def.parentSlug);
      if (!parentDef) break; // dangling parentSlug — stop climbing defensively
      def = parentDef;
    }
    const key = linkKey(scope, def._id);
    if (visited.has(key)) {
      throw new Error(
        `seatProposals: cycle detected climbing the seatDefs parent chain at "${def.slug}" (scope ${scope})`,
      );
    }
    visited.add(key);
    chain.push({ scope, def });
  }
  return chain;
}

async function ancestorChainOf(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  seatDefId: Id<"seatDefs">,
): Promise<ScopedSeat[]> {
  const def = await ctx.db.get(seatDefId);
  if (!def) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That seat doesn't exist." });
  }
  return ancestorChain(ctx, { scope, def });
}

/** Every (scope, seatDefId) pair any of `personIds` currently holds, as a Set
 *  of `linkKey` strings. Bounded like `seats.ts`'s
 *  `personHoldsOtherGroupSeatInScope` (a person's own holder-row count). */
async function heldSeatKeys(
  ctx: QueryCtx | MutationCtx,
  personIds: Id<"people">[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const personId of personIds) {
    const rows = await ctx.db
      .query("seatAssignments")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .take(200);
    for (const row of rows) out.add(linkKey(row.scope, row.seatDefId));
  }
  return out;
}

/** The caller's own (non-placeholder) roster rows across every `people` row
 *  tied to their user — mirrors `seats.mySeatAssignments`'s user→people walk
 *  (a person can hold seats via more than one roster row, e.g. one per
 *  chapter). */
async function myPersonIds(ctx: QueryCtx | MutationCtx): Promise<Id<"people">[]> {
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.filter((p) => p.isPlaceholder !== true).map((p) => p._id);
}

/** Which of `personIds` currently holds `link` (scope, seatDefId) — used to
 *  pin down the SPECIFIC roster row to store as `proposedByPersonId` once
 *  `propose` has already established that ONE of the caller's people rows
 *  qualifies. Throws if none match — a caller bug, should be unreachable
 *  given the caller already found `link` via `heldSeatKeys(personIds)`. */
async function personHoldingLink(
  ctx: QueryCtx | MutationCtx,
  personIds: Id<"people">[],
  link: ScopedSeat,
): Promise<Id<"people">> {
  const holders = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope_and_seat", (q) =>
      q.eq("scope", link.scope).eq("seatDefId", link.def._id),
    )
    .take(MAX_SLOT_READ);
  const match = holders.find((h) => personIds.includes(h.personId));
  if (!match) {
    throw new Error(
      "seatProposals: personHoldingLink found no holder — caller invariant violated",
    );
  }
  return match.personId;
}

/** The minimal shape `resolveEligibleDeciders` needs — a subset of
 *  `Doc<"seatProposals">`'s fields, satisfied structurally by an actual
 *  proposal row (`approve`/`decline`/`pendingProposals`) OR by a synthetic
 *  object built from `propose`'s not-yet-inserted args (letting `propose`
 *  reuse this exact resolver instead of forking its walk logic). */
interface DeciderResolutionInput {
  scope: Scope;
  seatDefId: Id<"seatDefs">;
  proposedByPersonId: Id<"people">;
}

type DeciderResolution =
  | { kind: "decider"; deciderSeat: ScopedSeat; eligiblePersonIds: Id<"people">[] }
  /** The proposer's qualifying seat has NO ancestor seat DEF above it at all
   *  — they hold the true top of the walked chain (e.g. the ED at the
   *  central root). Structurally nobody could ever two-party-decide this;
   *  `propose` auto-executes instead. */
  | { kind: "chain-top" }
  /** Either the proposer no longer holds any qualifying seat, or a
   *  qualifying ancestor structurally EXISTS above them but every one of
   *  them is currently vacant — NOT chain-top, stays pending. */
  | { kind: "none" };

/**
 * Resolve who may DECIDE (approve/decline) a proposal — real or not-yet-
 * inserted (see `DeciderResolutionInput`): climb the target's ancestor chain
 * starting just ABOVE the proposer's own qualifying seat (the nearest
 * ancestor-of-target seat they currently hold — recomputed fresh here, not
 * stored, since occupancy can change between propose and decide), skipping
 * vacant seats and any holder who IS the proposer, until the first ancestor
 * with at least one OTHER holder. Any holder of THAT seat is eligible; ties
 * (a multi-holder seat) all qualify.
 *
 * See `DeciderResolution`'s cases — critically, `"chain-top"` (no ancestor
 * seat DEF exists above the proposer at all) is distinct from `"none"`'s
 * merely-vacant-ancestor case: only the former means nobody could EVER decide
 * this proposal.
 */
async function resolveEligibleDeciders(
  ctx: QueryCtx | MutationCtx,
  proposal: DeciderResolutionInput,
): Promise<DeciderResolution> {
  const targetChain = await ancestorChainOf(ctx, proposal.scope, proposal.seatDefId);
  const heldByProposer = await heldSeatKeys(ctx, [proposal.proposedByPersonId]);
  const qualifyingIndex = targetChain.findIndex((link) =>
    heldByProposer.has(linkKey(link.scope, link.def._id)),
  );
  if (qualifyingIndex === -1) return { kind: "none" };
  if (qualifyingIndex === targetChain.length - 1) return { kind: "chain-top" };

  for (let i = qualifyingIndex + 1; i < targetChain.length; i++) {
    const link = targetChain[i]!;
    const holders = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope_and_seat", (q) =>
        q.eq("scope", link.scope).eq("seatDefId", link.def._id),
      )
      .take(MAX_SLOT_READ);
    const eligiblePersonIds = holders
      .map((h) => h.personId)
      .filter((personId) => personId !== proposal.proposedByPersonId);
    if (eligiblePersonIds.length > 0) {
      return { kind: "decider", deciderSeat: link, eligiblePersonIds };
    }
  }
  return { kind: "none" };
}

// ── Display resolution ───────────────────────────────────────────────────────

async function personName(
  ctx: QueryCtx | MutationCtx,
  personId: Id<"people">,
): Promise<string> {
  const person = await ctx.db.get(personId);
  return person?.name ?? "Unknown";
}

async function scopeDisplayName(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
): Promise<string> {
  if (scope === "central") return "Central";
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Unknown chapter";
}

async function toProposalView(ctx: QueryCtx | MutationCtx, row: Doc<"seatProposals">) {
  const def = await ctx.db.get(row.seatDefId);
  return {
    proposalId: row._id,
    seatDefId: row.seatDefId,
    seatSlug: def?.slug ?? "unknown",
    seatTitle: def?.title ?? "Unknown seat",
    scope: row.scope,
    scopeName: await scopeDisplayName(ctx, row.scope),
    action: row.action,
    subjectPersonId: row.subjectPersonId,
    subjectName: await personName(ctx, row.subjectPersonId),
    proposedByPersonId: row.proposedByPersonId,
    proposedByName: await personName(ctx, row.proposedByPersonId),
    status: row.status,
    note: row.note,
    createdAt: row.createdAt,
    decidedByPersonId: row.decidedByPersonId,
    decidedByName: row.decidedByPersonId
      ? await personName(ctx, row.decidedByPersonId)
      : undefined,
    decidedAt: row.decidedAt,
  };
}

/** Bounded scan of every PENDING proposal, optionally narrowed to one scope —
 *  shared by the duplicate-pending check and `pendingProposals`. */
async function pendingRows(
  ctx: QueryCtx | MutationCtx,
  scope: Scope | undefined,
): Promise<Doc<"seatProposals">[]> {
  const rows =
    scope !== undefined
      ? await ctx.db
          .query("seatProposals")
          .withIndex("by_status_and_scope", (q) =>
            q.eq("status", "pending").eq("scope", scope),
          )
          .take(PENDING_SCAN_LIMIT)
      : await ctx.db
          .query("seatProposals")
          .withIndex("by_status_and_scope", (q) => q.eq("status", "pending"))
          .take(PENDING_SCAN_LIMIT);
  if (rows.length === PENDING_SCAN_LIMIT) {
    console.warn(
      `[seatProposals] pending-proposal scan hit PENDING_SCAN_LIMIT (${PENDING_SCAN_LIMIT}); results truncated.`,
    );
  }
  return rows;
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Propose filling or vacating a seat strictly below one of the caller's own
 * seats.
 *
 *  - Rejects a `derived` seat (holders are computed, never assigned) and the
 *    ED seat itself (the central chart's true root — nobody is above it to
 *    ever approve a change to it).
 *  - Rejects a chart/scope mismatch and a nonexistent chapter, mirroring
 *    `assignSeat`'s own structural checks (defense in depth — the
 *    AUTHORITATIVE re-check happens at approval-execution time).
 *  - Rejects a nonexistent or placeholder `subjectPersonId`.
 *  - `"vacate"`: rejects if `subjectPersonId` doesn't currently hold the seat.
 *  - Below-your-seat: rejects unless the caller currently holds SOME strict
 *    ancestor of (`seatDefId`, `scope`) — walking the LIVE `seatDefs` tree,
 *    bridging chapter→central via `CHAPTER_ROLLUP_PARENT`.
 *  - Rejects a duplicate PENDING proposal for the exact same
 *    (seatDefId, scope, action, subjectPersonId).
 */
export const propose = mutation({
  args: {
    seatDefId: v.id("seatDefs"),
    scope: scopeValidator,
    action: actionValidator,
    subjectPersonId: v.id("people"),
    note: v.optional(v.string()),
  },
  returns: v.id("seatProposals"),
  handler: async (ctx, { seatDefId, scope, action, subjectPersonId, note }) => {
    await requireAccess(ctx);

    const def = await ctx.db.get(seatDefId);
    if (!def) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That seat doesn't exist." });
    }
    if (def.derived === true) {
      throw new ConvexError({
        code: "DERIVED_SEAT",
        message: "This seat's holders are computed automatically and can't be proposed.",
      });
    }
    if (def.parentSlug === SEAT_ROOT && def.chart === "central") {
      throw new ConvexError({
        code: "NO_APPROVER",
        message:
          "Nobody is above this seat to approve a change — use direct assignment instead.",
      });
    }

    const scopeIsCentral = scope === "central";
    if (def.chart === "central" && !scopeIsCentral) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "This seat belongs to the central chart.",
      });
    }
    if (def.chart === "chapter" && scopeIsCentral) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "This seat belongs to a chapter chart — pass a chapter id.",
      });
    }
    if (!scopeIsCentral) {
      const chapter = await ctx.db.get(scope as Id<"chapters">);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "That chapter doesn't exist." });
      }
    }

    const subject = await ctx.db.get(subjectPersonId);
    if (!subject) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That person doesn't exist." });
    }
    if (subject.isPlaceholder === true) {
      throw new ConvexError({
        code: "INVALID_PERSON",
        message: "A placeholder person can't be the subject of a proposal.",
      });
    }

    if (action === "vacate") {
      const holders = await ctx.db
        .query("seatAssignments")
        .withIndex("by_scope_and_seat", (q) => q.eq("scope", scope).eq("seatDefId", seatDefId))
        .take(MAX_SLOT_READ);
      if (!holders.some((h) => h.personId === subjectPersonId)) {
        throw new ConvexError({
          code: "NOT_HOLDER",
          message: "That person doesn't currently hold this seat.",
        });
      }
    }

    const callerPersonIds = await myPersonIds(ctx);
    if (callerPersonIds.length === 0) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You don't have a roster row, so you can't propose a seat change.",
      });
    }
    const held = await heldSeatKeys(ctx, callerPersonIds);
    const chain = await ancestorChain(ctx, { scope, def });
    const qualifying = chain.find((link) => held.has(linkKey(link.scope, link.def._id)));
    if (!qualifying) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You can only propose a change to a seat strictly below one of your own seats.",
      });
    }
    const proposedByPersonId = await personHoldingLink(ctx, callerPersonIds, qualifying);

    const duplicate = (await pendingRows(ctx, scope)).find(
      (row) =>
        row.seatDefId === seatDefId &&
        row.action === action &&
        row.subjectPersonId === subjectPersonId,
    );
    if (duplicate) {
      throw new ConvexError({
        code: "DUPLICATE_PENDING",
        message: "There's already a pending proposal for this exact change.",
      });
    }

    const createdAt = Date.now();
    const resolved = await resolveEligibleDeciders(ctx, { scope, seatDefId, proposedByPersonId });

    if (resolved.kind !== "chain-top") {
      // Normal two-party path: goes pending regardless of whether an
      // eligible decider exists RIGHT NOW (`"none"` covers a merely-vacant
      // ancestor — see `resolveEligibleDeciders`'s doc comment) — someone
      // occupying that ancestor later makes it decidable.
      return await ctx.db.insert("seatProposals", {
        seatDefId,
        scope,
        action,
        subjectPersonId,
        proposedByPersonId,
        status: "pending",
        note,
        createdAt,
      });
    }

    // Chain-top: nobody is structurally above the proposer's qualifying seat
    // (see the file doc comment's "Chain-top auto-execute" section) — execute
    // the change immediately through the SAME validated path `approve` uses.
    // If this throws (SoD, maxHolders, derived-seat, stale vacate subject),
    // the whole mutation rolls back — no proposal row is written either.
    const callerUserId = (await requireUserId(ctx)) as Id<"users">;
    await executeProposalChange(ctx, callerUserId, { action, seatDefId, scope, subjectPersonId });

    return await ctx.db.insert("seatProposals", {
      seatDefId,
      scope,
      action,
      subjectPersonId,
      proposedByPersonId,
      status: "approved",
      note: note ? `${note}\n\n${CHAIN_TOP_AUTO_NOTE}` : CHAIN_TOP_AUTO_NOTE,
      createdAt,
      decidedByPersonId: proposedByPersonId,
      decidedAt: createdAt,
    });
  },
});

/**
 * Execute a proposal's underlying seat change through the SAME validated
 * path `assignSeat`/`unassignSeat` enforce (`assignSeatImpl`/
 * `unassignSeatImpl` — see the file doc comment). Shared by `approve`
 * (two-party decision) and `propose`'s chain-top auto-execute path — the
 * ONLY two places a proposal's seat change is ever actually applied, and
 * both go through this one function so neither can drift from the other's
 * validation. Throws (aborting the whole calling mutation) exactly as a
 * direct `assignSeat`/`unassignSeat` call would.
 */
async function executeProposalChange(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  proposal: {
    action: "fill" | "vacate";
    seatDefId: Id<"seatDefs">;
    scope: Scope;
    subjectPersonId: Id<"people">;
  },
): Promise<void> {
  if (proposal.action === "fill") {
    await assignSeatImpl(ctx, callerUserId, {
      seatDefId: proposal.seatDefId,
      scope: proposal.scope,
      personId: proposal.subjectPersonId,
    });
    return;
  }

  const holders = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope_and_seat", (q) =>
      q.eq("scope", proposal.scope).eq("seatDefId", proposal.seatDefId),
    )
    .take(MAX_SLOT_READ);
  const current = holders.find((h) => h.personId === proposal.subjectPersonId);
  if (!current) {
    throw new ConvexError({
      code: "NOT_HOLDER",
      message: "That person no longer holds this seat — nothing to vacate.",
    });
  }
  await unassignSeatImpl(ctx, current._id);
}

/**
 * Approve a pending proposal — EXECUTES the seat change atomically (see the
 * file-level doc comment for why this reuses `seats.ts`'s
 * `assignSeatImpl`/`unassignSeatImpl` rather than duplicating validation).
 * Requires the caller to be an ELIGIBLE DECIDER (see `resolveEligibleDeciders`
 * — same resolver `decline` uses). The proposer may never decide their own
 * proposal. If execution throws (maxHolders, SoD, derived-seat, or a
 * `"vacate"` whose subject no longer holds the seat), the ENTIRE mutation
 * rolls back — the proposal stays `"pending"` and the error surfaces to the
 * approver verbatim; we do not auto-decline (see file doc comment for why).
 */
export const approve = mutation({
  args: { proposalId: v.id("seatProposals") },
  returns: v.null(),
  handler: async (ctx, { proposalId }) => {
    await requireAccess(ctx);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That proposal doesn't exist." });
    }
    if (proposal.status !== "pending") {
      throw new ConvexError({
        code: "NOT_PENDING",
        message: "This proposal has already been decided.",
      });
    }

    const callerUserId = (await requireUserId(ctx)) as Id<"users">;
    const callerPersonIds = await myPersonIds(ctx);
    if (callerPersonIds.includes(proposal.proposedByPersonId)) {
      throw new ConvexError({
        code: "CANNOT_DECIDE_OWN",
        message: "You can't decide your own proposal.",
      });
    }

    const resolved = await resolveEligibleDeciders(ctx, proposal);
    const deciderPersonId =
      resolved.kind === "decider"
        ? resolved.eligiblePersonIds.find((id) => callerPersonIds.includes(id))
        : undefined;
    if (!deciderPersonId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You're not eligible to decide this proposal.",
      });
    }

    // Execute — the exact validated path `assignSeat`/`unassignSeat` enforce
    // (same helper `propose`'s chain-top auto-execute path calls). A thrown
    // ConvexError here aborts the WHOLE transaction (nothing below runs, and
    // nothing above persists either), so the proposal is left exactly as it
    // was: still "pending".
    await executeProposalChange(ctx, callerUserId, {
      action: proposal.action,
      seatDefId: proposal.seatDefId,
      scope: proposal.scope,
      subjectPersonId: proposal.subjectPersonId,
    });

    await ctx.db.patch(proposalId, {
      status: "approved",
      decidedByPersonId: deciderPersonId,
      decidedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Decline a pending proposal. Requires the caller to be an ELIGIBLE DECIDER
 * (see `resolveEligibleDeciders`) — the same authorization `approve` uses.
 * The proposer may never decide their own proposal.
 */
export const decline = mutation({
  args: { proposalId: v.id("seatProposals") },
  returns: v.null(),
  handler: async (ctx, { proposalId }) => {
    await requireAccess(ctx);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That proposal doesn't exist." });
    }
    if (proposal.status !== "pending") {
      throw new ConvexError({
        code: "NOT_PENDING",
        message: "This proposal has already been decided.",
      });
    }

    const callerPersonIds = await myPersonIds(ctx);
    if (callerPersonIds.includes(proposal.proposedByPersonId)) {
      throw new ConvexError({
        code: "CANNOT_DECIDE_OWN",
        message: "You can't decide your own proposal.",
      });
    }

    const resolved = await resolveEligibleDeciders(ctx, proposal);
    const deciderPersonId =
      resolved.kind === "decider"
        ? resolved.eligiblePersonIds.find((id) => callerPersonIds.includes(id))
        : undefined;
    if (!deciderPersonId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You're not eligible to decide this proposal.",
      });
    }

    await ctx.db.patch(proposalId, {
      status: "declined",
      decidedByPersonId: deciderPersonId,
      decidedAt: Date.now(),
    });
    return null;
  },
});

/** Cancel the caller's own pending proposal. */
export const cancel = mutation({
  args: { proposalId: v.id("seatProposals") },
  returns: v.null(),
  handler: async (ctx, { proposalId }) => {
    await requireAccess(ctx);
    const proposal = await ctx.db.get(proposalId);
    if (!proposal) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That proposal doesn't exist." });
    }
    if (proposal.status !== "pending") {
      throw new ConvexError({
        code: "NOT_PENDING",
        message: "This proposal has already been decided.",
      });
    }

    const callerPersonIds = await myPersonIds(ctx);
    if (!callerPersonIds.includes(proposal.proposedByPersonId)) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the proposer can cancel this proposal.",
      });
    }

    await ctx.db.patch(proposalId, {
      status: "cancelled",
      decidedByPersonId: proposal.proposedByPersonId,
      decidedAt: Date.now(),
    });
    return null;
  },
});

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Every PENDING proposal the caller could decide OR that they themselves
 * proposed, optionally narrowed to one `scope`. Bounded scan (see
 * `PENDING_SCAN_LIMIT`) — eligibility is computed per row since it depends on
 * live seat occupancy.
 */
export const pendingProposals = query({
  args: { scope: v.optional(scopeValidator) },
  returns: v.array(proposalView),
  handler: async (ctx, { scope }) => {
    await requireAccess(ctx);
    const callerPersonIds = await myPersonIds(ctx);

    const rows = await pendingRows(ctx, scope);
    const visible: Doc<"seatProposals">[] = [];
    for (const row of rows) {
      if (callerPersonIds.includes(row.proposedByPersonId)) {
        visible.push(row);
        continue;
      }
      const resolved = await resolveEligibleDeciders(ctx, row);
      if (
        resolved.kind === "decider" &&
        resolved.eligiblePersonIds.some((id) => callerPersonIds.includes(id))
      ) {
        visible.push(row);
      }
    }
    return Promise.all(visible.map((row) => toProposalView(ctx, row)));
  },
});

/** Every proposal (any status) the caller has made, newest first. */
export const myProposals = query({
  args: {},
  returns: v.array(proposalView),
  handler: async (ctx) => {
    await requireAccess(ctx);
    const callerPersonIds = await myPersonIds(ctx);
    const rows = (
      await Promise.all(
        callerPersonIds.map((personId) =>
          ctx.db
            .query("seatProposals")
            .withIndex("by_proposer", (q) => q.eq("proposedByPersonId", personId))
            .take(200),
        ),
      )
    ).flat();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(rows.map((row) => toProposalView(ctx, row)));
  },
});
