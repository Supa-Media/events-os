/**
 * The public ledger — the lifecycle, the console, and the anonymous read.
 *
 * See `@events-os/shared/publicLedger` for the vocabulary and
 * `schema/publicLedger.ts` for the tables. The rule that governs this whole
 * file: THE PUBLIC PAGE READS FROZEN ROWS. Nothing here ever serves the live
 * books to an anonymous caller, and nothing here ever mutates a revision that
 * has already been published.
 *
 * ── THE LOOP ─────────────────────────────────────────────────────────────────
 *   prepare      build/rebuild the working snapshot from the live books
 *   submit       hand it to a reviewer            → in_review
 *   requestChanges  send it back with a note      → changes_requested
 *   publish      freeze it and make it live       → published  (revision N)
 *   startAmendment  begin a correction            → amending   (N stays live)
 *
 * `publish` is the only writer of `financePublicationRevisions` and
 * `financePublicationEntries`, and it only ever INSERTS. There is no
 * unpublish, deliberately — see `publish`'s doc.
 *
 * ── WHAT PUBLISHING REFUSES ──────────────────────────────────────────────────
 * A publish is blocked, loudly, when the snapshot is `truncated` or `overCap`
 * (a scan limit was hit, so the figures may be incomplete). It is NOT blocked
 * on the period being fully reconciled: `publishability.report` measures that
 * gap, the console shows it, and a human decides. Publishing a month with
 * three undocumented rows and SAYING there are three undocumented rows is
 * more honest than waiting a year for a perfect month — and the disclosure
 * fields on every revision exist precisely so that choice can be made in the
 * open. An incomplete ledger presented as complete is the one thing refused
 * outright, because that is the failure the reader cannot detect.
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 * Every gate is `lib/publicLedgerAccess.ts` (CLAUDE.md's "gate it behind a
 * power"); nothing checks a seat or a finance role inline. Separation of
 * duties — publisher ≠ preparer — is enforced HERE, because it is a question
 * about a specific row rather than about a person.
 */
import { v, ConvexError, type Infer } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AMENDMENT_REASONS,
  CENTRAL,
  DOCUMENTATION_STATES,
  EXPENSE_TYPES,
  INCOME_STREAMS,
  MAX_PUBLISHED_ENTRIES,
  MIN_AMENDMENT_NOTE_LENGTH,
  monthsOfYear,
  parsePeriodKey,
  parseYearKey,
  periodLabel,
  PUBLICATION_STATUSES,
  REBUILDABLE_STATUSES,
  SUBMITTABLE_STATUSES,
  type PublicationStatus,
} from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import { listActiveChapters } from "./lib/chapters";
import { readSandbox } from "./financeSettings";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import {
  assertSeparationOfDuties,
  resolveCallerPersonId,
  type FinanceScope,
} from "./lib/finance";
import {
  hasLedgerPublish,
  requireLedgerConsole,
  requireLedgerPrepare,
  requireLedgerPublish,
} from "./lib/publicLedgerAccess";
import { buildSnapshot, type Snapshot } from "./lib/publicLedgerSnapshot";
import { isSuperuser } from "./lib/superuser";

const scopeValidator = v.union(v.id("chapters"), v.literal(CENTRAL));
const statusValidator = v.union(
  ...PUBLICATION_STATUSES.map((s) => v.literal(s)),
);
const amendmentReasonValidator = v.union(
  ...AMENDMENT_REASONS.map((r) => v.literal(r)),
);

/** How many published entries one public page read will return. A month is
 *  hundreds of rows; this bounds a single response without paginating a
 *  server-rendered page (which has nowhere to put a "next" button that
 *  survives being shared as a link). Above it the page says so and points at
 *  the CSV, which is unbounded by design. */
export const PUBLIC_PAGE_ENTRY_LIMIT = 1200;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Reject anything that isn't a real `YYYY-MM` key before it reaches a query
 *  or an index. This parses caller input, including from the public URL. */
function assertPeriodKey(key: string): void {
  if (!parsePeriodKey(key)) {
    throw new ConvexError({
      code: "BAD_PERIOD",
      message: `"${key}" is not a month. Expected YYYY-MM, e.g. 2026-08.`,
    });
  }
}

/**
 * Assert a lifecycle move is legal, naming both states in the refusal.
 * Mirrors `finances.ts#assertBudgetTransition` and
 * `campaigns.ts#assertCampaignTransition` — same shape, same intent, so a
 * third state machine in this codebase reads like the first two.
 */
function assertTransition(
  current: PublicationStatus,
  allowedFrom: readonly PublicationStatus[],
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Can't ${action} a month that's ${current.replace(/_/g, " ")}.`,
    });
  }
}

async function findPublication(
  ctx: QueryCtx,
  scope: FinanceScope,
  periodKey: string,
): Promise<Doc<"financePublications"> | null> {
  return ctx.db
    .query("financePublications")
    .withIndex("by_scope_and_period", (q) =>
      q.eq("scope", scope).eq("periodKey", periodKey),
    )
    .unique();
}

/** Find or create the (book, month) row. The ONLY place a publication is
 *  inserted, which is what keeps the (scope, periodKey) pair unique without a
 *  database-level constraint Convex doesn't offer. */
async function ensurePublication(
  ctx: MutationCtx,
  scope: FinanceScope,
  periodKey: string,
): Promise<Doc<"financePublications">> {
  const existing = await findPublication(ctx, scope, periodKey);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("financePublications", {
    scope,
    periodKey,
    status: "draft",
    isLive: false,
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("publication insert vanished");
  return created;
}

/** The caller's home chapter, or throw. Every console/lifecycle entry point
 *  starts here — a caller with no chapter has no finance identity to resolve
 *  a grant against. */
async function requireHomeChapter(ctx: QueryCtx): Promise<Id<"chapters">> {
  const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
  if (!homeChapterId) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: "You need to belong to a chapter before you can work the books.",
    });
  }
  return homeChapterId;
}

/**
 * Publisher ≠ preparer, with the solo-operator relaxation recorded rather
 * than hidden.
 *
 * Returns the `approvalParty` to stamp on the revision: `"two_party"` for a
 * normal separated decision, `"single"` when a superuser published their own
 * preparation. The temporary relaxation is the one `budgets.approvalParty`
 * already documents (the owner is solo-building the org), and the reason it
 * is recorded per revision is so that when there IS a second person, every
 * past decision can be re-reviewed for which kind it was.
 */
async function resolveApprovalParty(
  ctx: MutationCtx,
  publisherPersonId: Id<"people">,
  preparerPersonId: Id<"people"> | undefined,
): Promise<"single" | "two_party"> {
  if (!preparerPersonId || preparerPersonId !== publisherPersonId) {
    return "two_party";
  }
  if (await isSuperuser(ctx)) return "single";
  assertSeparationOfDuties(publisherPersonId, preparerPersonId);
  // `assertSeparationOfDuties` throws on a match, so this is unreachable; it
  // exists so the function is total rather than relying on that.
  return "two_party";
}

// ── Console reads ────────────────────────────────────────────────────────────

const snapshotTotals = v.object({
  incomeCents: v.number(),
  expenseCents: v.number(),
  netCents: v.number(),
  incomeByStream: v.array(
    v.object({
      stream: v.union(...INCOME_STREAMS.map((s) => v.literal(s))),
      cents: v.number(),
      count: v.number(),
    }),
  ),
  expenseByCategory: v.array(
    v.object({ label: v.string(), cents: v.number(), count: v.number() }),
  ),
  expenseByProject: v.array(
    v.object({ label: v.string(), cents: v.number(), count: v.number() }),
  ),
  spendByBudget: v.array(
    v.object({
      label: v.string(),
      allocatedCents: v.optional(v.number()),
      spentCents: v.number(),
      count: v.number(),
    }),
  ),
  entryCount: v.number(),
  giftCount: v.number(),
  giverCount: v.number(),
  backerCount: v.number(),
  reconstructedCount: v.number(),
  reconstructedCents: v.number(),
  undocumentedCount: v.number(),
  undocumentedCents: v.number(),
  uncodedCount: v.number(),
  uncodedCents: v.number(),
  truncated: v.boolean(),
  overCap: v.boolean(),
});

/** The console's preview: every figure, none of the rows — and never
 *  `giverKeys`, which is identity data that exists only to be counted. */
function totalsOf(s: Snapshot) {
  const { entries: _entries, giverKeys: _giverKeys, ...totals } = s;
  return totals;
}

/**
 * THE CONSOLE — every month on a book, with its status and what's live.
 *
 * Returns months in reverse chronological order, newest first, because the
 * work is always at the recent end. Months with no publication row yet are
 * synthesized as `draft` so the console shows a continuous calendar rather
 * than only the months somebody has already touched — "August isn't in the
 * list" and "August has nothing to publish" are different, and only one of
 * them is true.
 */
export const console_ = query({
  args: {
    scope: v.optional(scopeValidator),
    /** How many months back from the current one to list. */
    months: v.optional(v.number()),
  },
  returns: v.union(
    v.null(),
    v.object({
      scope: scopeValidator,
      scopeName: v.string(),
      canPublish: v.boolean(),
      months: v.array(
        v.object({
          periodKey: v.string(),
          label: v.string(),
          status: statusValidator,
          liveRevision: v.union(v.number(), v.null()),
          publishedAt: v.union(v.number(), v.null()),
          builtAt: v.union(v.number(), v.null()),
          submittedAt: v.union(v.number(), v.null()),
          reviewNote: v.union(v.string(), v.null()),
          amendmentReason: v.union(amendmentReasonValidator, v.null()),
          amendmentNote: v.union(v.string(), v.null()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    // A read degrades to null for a pre-onboarding user, matching the app-wide
    // convention; a caller who HAS a chapter but lacks the power gets the
    // resolver's ConvexError.
    if (!homeChapterId) return null;
    const scope: FinanceScope = args.scope ?? homeChapterId;
    await requireLedgerConsole(ctx, homeChapterId, scope);

    const rows = await ctx.db
      .query("financePublications")
      .withIndex("by_scope_and_period", (q) => q.eq("scope", scope))
      .take(ROLLUP_SCAN_LIMIT);
    const byPeriod = new Map(rows.map((r) => [r.periodKey, r]));

    const count = Math.max(1, Math.min(args.months ?? 18, 60));
    const now = new Date();
    const months: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      );
    }

    return {
      scope,
      scopeName:
        scope === CENTRAL ? "Central" : ((await ctx.db.get(scope))?.name ?? "Chapter"),
      canPublish: await hasLedgerPublish(ctx, homeChapterId, scope),
      months: months.map((periodKey) => {
        const row = byPeriod.get(periodKey);
        return {
          periodKey,
          label: periodLabel(periodKey),
          status: row?.status ?? ("draft" as const),
          liveRevision: row?.liveRevision ?? null,
          publishedAt: row?.publishedAt ?? null,
          builtAt: row?.builtAt ?? null,
          submittedAt: row?.submittedAt ?? null,
          reviewNote: row?.reviewNote ?? null,
          amendmentReason: row?.amendmentReason ?? null,
          amendmentNote: row?.amendmentNote ?? null,
        };
      }),
    };
  },
});

/**
 * PREVIEW — what would publish for this book/month, computed live.
 *
 * The same `buildSnapshot` call `publish` makes, so a reviewer is looking at
 * the artifact rather than at an approximation of it. Deliberately a QUERY
 * with no persistence: preparing is not a state change, and making it one
 * would mean a reviewer's page load could move a month's status.
 */
export const preview = query({
  args: { scope: v.optional(scopeValidator), periodKey: v.string() },
  returns: v.union(v.null(), snapshotTotals),
  handler: async (ctx, args) => {
    assertPeriodKey(args.periodKey);
    const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!homeChapterId) return null;
    const scope: FinanceScope = args.scope ?? homeChapterId;
    await requireLedgerConsole(ctx, homeChapterId, scope);
    const sandboxMode = await readSandbox(ctx);
    return totalsOf(await buildSnapshot(ctx, scope, args.periodKey, sandboxMode));
  },
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * SUBMIT a month for review.
 *
 * The snapshot is NOT frozen here — `publish` rebuilds it. Freezing at submit
 * would mean approving a picture of the books that could already be stale by
 * the time it was approved, and the reviewer would have no way to tell. What
 * is recorded is who submitted and when, which is what the separation-of-
 * duties check and the staleness display need.
 */
export const submit = mutation({
  args: { scope: v.optional(scopeValidator), periodKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertPeriodKey(args.periodKey);
    const homeChapterId = await requireHomeChapter(ctx);
    const scope: FinanceScope = args.scope ?? homeChapterId;
    await requireLedgerPrepare(ctx, homeChapterId, scope);
    const personId = await resolveCallerPersonId(ctx, homeChapterId);

    const pub = await ensurePublication(ctx, scope, args.periodKey);
    assertTransition(pub.status, SUBMITTABLE_STATUSES, "submit");

    const sandboxMode = await readSandbox(ctx);
    const snapshot = await buildSnapshot(ctx, scope, args.periodKey, sandboxMode);
    assertPublishable(snapshot);

    await ctx.db.patch(pub._id, {
      status: "in_review",
      builtAt: Date.now(),
      builtByPersonId: personId,
      submittedAt: Date.now(),
      submittedByPersonId: personId,
      // Cleared on resubmission — the round-by-round history lives in
      // `financeAuditLog`, matching `transactionCodings.reviewNote`.
      reviewNote: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** SEND BACK — a reviewer refuses, with a reason the preparer can act on. */
export const requestChanges = mutation({
  args: {
    scope: v.optional(scopeValidator),
    periodKey: v.string(),
    note: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertPeriodKey(args.periodKey);
    const note = args.note.trim();
    if (note.length < MIN_AMENDMENT_NOTE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_SHORT",
        message:
          "Say what would make it publishable — the preparer only has this note to work from.",
      });
    }
    const homeChapterId = await requireHomeChapter(ctx);
    const scope: FinanceScope = args.scope ?? homeChapterId;
    await requireLedgerPublish(ctx, homeChapterId, scope);

    const pub = await findPublication(ctx, scope, args.periodKey);
    if (!pub) throw new ConvexError({ code: "NOT_FOUND", message: "No such month." });
    assertTransition(pub.status, ["in_review"], "send back");

    await ctx.db.patch(pub._id, {
      status: "changes_requested",
      reviewNote: note,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * PUBLISH — freeze the month and put it in front of the world.
 *
 * The one irreversible action in this file. It rebuilds the snapshot from the
 * live books, writes an append-only revision row plus one frozen entry row per
 * line, and points `liveRevision` at it.
 *
 * ── WHY THERE IS NO UNPUBLISH ────────────────────────────────────────────────
 * Retracting a published month would let the org withdraw a statement it had
 * already made, which is exactly the power a transparency page exists to give
 * up. A wrong month is corrected by publishing a revision that says what was
 * wrong — `startAmendment` → `publish` — leaving the original readable. If a
 * month should never have been published at all, that is a conversation with
 * a human, not a button.
 */
export const publish = mutation({
  args: { scope: v.optional(scopeValidator), periodKey: v.string() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    assertPeriodKey(args.periodKey);
    const homeChapterId = await requireHomeChapter(ctx);
    const scope: FinanceScope = args.scope ?? homeChapterId;
    await requireLedgerPublish(ctx, homeChapterId, scope);
    const publisherPersonId = await resolveCallerPersonId(ctx, homeChapterId);

    const pub = await findPublication(ctx, scope, args.periodKey);
    if (!pub) throw new ConvexError({ code: "NOT_FOUND", message: "No such month." });
    assertTransition(pub.status, ["in_review"], "publish");

    const revision = (pub.liveRevision ?? 0) + 1;
    // From revision 2 on, the amendment has to say what changed — it is the
    // sentence the public amendment log prints.
    if (revision > 1) {
      const note = (pub.amendmentNote ?? "").trim();
      if (!pub.amendmentReason || note.length < MIN_AMENDMENT_NOTE_LENGTH) {
        throw new ConvexError({
          code: "AMENDMENT_UNEXPLAINED",
          message:
            "An amendment needs a reason and a sentence explaining what changed — that explanation is published with it.",
        });
      }
    }

    const sandboxMode = await readSandbox(ctx);
    const snapshot = await buildSnapshot(ctx, scope, args.periodKey, sandboxMode);
    assertPublishable(snapshot);

    const approvalParty = await resolveApprovalParty(
      ctx,
      publisherPersonId,
      pub.submittedByPersonId,
    );
    const now = Date.now();

    await ctx.db.insert("financePublicationRevisions", {
      publicationId: pub._id,
      revision,
      scope,
      periodKey: args.periodKey,
      incomeCents: snapshot.incomeCents,
      expenseCents: snapshot.expenseCents,
      netCents: snapshot.netCents,
      incomeByStream: snapshot.incomeByStream,
      expenseByCategory: snapshot.expenseByCategory,
      expenseByProject: snapshot.expenseByProject,
      spendByBudget: snapshot.spendByBudget,
      entryCount: snapshot.entryCount,
      giftCount: snapshot.giftCount,
      giverCount: snapshot.giverCount,
      backerCount: snapshot.backerCount,
      reconstructedCount: snapshot.reconstructedCount,
      reconstructedCents: snapshot.reconstructedCents,
      undocumentedCount: snapshot.undocumentedCount,
      undocumentedCents: snapshot.undocumentedCents,
      uncodedCount: snapshot.uncodedCount,
      uncodedCents: snapshot.uncodedCents,
      unexplainedCount: snapshot.unexplainedCount,
      unexplainedCents: snapshot.unexplainedCents,
      truncated: snapshot.truncated,
      amendmentReason: revision > 1 ? pub.amendmentReason : undefined,
      note: revision > 1 ? pub.amendmentNote?.trim() : undefined,
      preparedByPersonId: pub.submittedByPersonId,
      preparedAt: pub.submittedAt,
      publishedByPersonId: publisherPersonId,
      publishedAt: now,
      approvalParty,
    });

    for (const entry of snapshot.entries) {
      await ctx.db.insert("financePublicationEntries", {
        publicationId: pub._id,
        revision,
        scope,
        periodKey: args.periodKey,
        ...entry,
      });
    }

    // Frozen giver identities — INTERNAL ONLY, never served (see
    // `schema/publicLedger.ts#financePublicationGiverKeys`). They exist so a
    // year can UNION its months rather than adding twelve distinct counts
    // together and reporting a monthly giver as twelve people.
    const periodYear = args.periodKey.slice(0, 4);
    for (const giver of snapshot.giverKeys) {
      await ctx.db.insert("financePublicationGiverKeys", {
        publicationId: pub._id,
        revision,
        year: periodYear,
        key: giver.key,
        isBacker: giver.isBacker,
      });
    }

    await ctx.db.patch(pub._id, {
      status: "published",
      liveRevision: revision,
      isLive: true,
      publishedAt: now,
      publishedByPersonId: publisherPersonId,
      // The in-flight amendment's reason/note now live on the revision row.
      amendmentReason: undefined,
      amendmentNote: undefined,
      reviewNote: undefined,
      updatedAt: now,
    });

    return { revision };
  },
});

/**
 * START AN AMENDMENT — reopen a published month for correction.
 *
 * The already-published revision STAYS LIVE throughout. The public page keeps
 * showing the last approved numbers while the correction is prepared and
 * reviewed, so there is never a window where a month is publicly blank or
 * publicly half-edited.
 *
 * The reason and note are captured HERE, at the start, rather than at publish
 * time. That ordering is deliberate: the person who noticed the problem is
 * the person who can describe it, and asking for the explanation up front
 * means the amendment log records why the correction was made rather than
 * whatever the publisher could reconstruct afterwards.
 */
export const startAmendment = mutation({
  args: {
    scope: v.optional(scopeValidator),
    periodKey: v.string(),
    reason: amendmentReasonValidator,
    note: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertPeriodKey(args.periodKey);
    const note = args.note.trim();
    if (note.length < MIN_AMENDMENT_NOTE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_SHORT",
        message:
          "Describe what's being corrected — this sentence publishes with the amendment.",
      });
    }
    const homeChapterId = await requireHomeChapter(ctx);
    const scope: FinanceScope = args.scope ?? homeChapterId;
    await requireLedgerPrepare(ctx, homeChapterId, scope);

    const pub = await findPublication(ctx, scope, args.periodKey);
    if (!pub) throw new ConvexError({ code: "NOT_FOUND", message: "No such month." });
    assertTransition(pub.status, ["published"], "amend");

    await ctx.db.patch(pub._id, {
      status: "amending",
      amendmentReason: args.reason,
      amendmentNote: note,
      // `isLive` and `liveRevision` are deliberately untouched — the public
      // keeps seeing revision N while N+1 is prepared.
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Refuse a snapshot that may be incomplete. See the module doc: an
 *  incomplete ledger presented as complete is the failure a reader cannot
 *  detect, so it is the one thing blocked outright. */
function assertPublishable(snapshot: Snapshot): void {
  if (snapshot.truncated) {
    throw new ConvexError({
      code: "SNAPSHOT_TRUNCATED",
      message:
        "This month's read hit the scan limit, so the figures may be incomplete. Publishing was stopped — an incomplete ledger presented as complete is worse than a late one.",
    });
  }
  if (snapshot.overCap) {
    throw new ConvexError({
      code: "SNAPSHOT_TOO_LARGE",
      message: `This month has more than ${MAX_PUBLISHED_ENTRIES} lines, which is past what one published revision holds. Split the period or raise the cap deliberately.`,
    });
  }
}

// ── The anonymous public read ────────────────────────────────────────────────
// NO AUTH, by design. These serve only frozen, human-approved rows. The gift
// entries never contained a donor field to leak (`schema/publicLedger.ts`),
// and the ledger entries' one internal field (`sourceTransactionId`) is
// dropped by the projections below rather than by every caller remembering to.

const publicEntry = v.object({
  occurredAt: v.number(),
  amountCents: v.number(),
  direction: v.union(v.literal("in"), v.literal("out"), v.literal("internal")),
  countsInTotals: v.boolean(),
  bookLabel: v.string(),
  counterparty: v.union(v.string(), v.null()),
  purpose: v.union(v.string(), v.null()),
  categoryLabel: v.union(v.string(), v.null()),
  fundLabel: v.union(v.string(), v.null()),
  budgetLabel: v.union(v.string(), v.null()),
  projectLabel: v.union(v.string(), v.null()),
  eventLabel: v.union(v.string(), v.null()),
  expenseType: v.union(...EXPENSE_TYPES.map((t) => v.literal(t)), v.null()),
  travelFrom: v.union(v.string(), v.null()),
  travelTo: v.union(v.string(), v.null()),
  headcount: v.union(v.number(), v.null()),
  affiliationMix: v.union(v.record(v.string(), v.number()), v.null()),
  groupDescription: v.union(v.string(), v.null()),
  documentation: v.union(
    ...DOCUMENTATION_STATES.map((d) => v.literal(d)),
    v.null(),
  ),
  reconstructed: v.boolean(),
  nonDiscretionaryFee: v.boolean(),
});

const publicGift = v.object({
  occurredAt: v.number(),
  amountCents: v.number(),
  method: v.union(v.string(), v.null()),
  designation: v.union(v.string(), v.null()),
  bookLabel: v.string(),
});

/** Project a frozen row for anonymous consumption. `sourceTransactionId` is
 *  dropped HERE — one place, so no future public reader can forget. */
function toPublicEntry(row: Doc<"financePublicationEntries">) {
  return {
    occurredAt: row.occurredAt,
    amountCents: row.amountCents,
    direction: row.direction,
    countsInTotals: row.countsInTotals,
    bookLabel: row.bookLabel,
    counterparty: row.counterparty ?? null,
    purpose: row.purpose ?? null,
    categoryLabel: row.categoryLabel ?? null,
    fundLabel: row.fundLabel ?? null,
    budgetLabel: row.budgetLabel ?? null,
    projectLabel: row.projectLabel ?? null,
    eventLabel: row.eventLabel ?? null,
    expenseType: row.expenseType ?? null,
    travelFrom: row.travelFrom ?? null,
    travelTo: row.travelTo ?? null,
    headcount: row.headcount ?? null,
    affiliationMix: row.affiliationMix ?? null,
    groupDescription: row.groupDescription ?? null,
    documentation: row.documentation ?? null,
    reconstructed: row.reconstructed ?? false,
    nonDiscretionaryFee: row.nonDiscretionaryFee ?? false,
  };
}

function toPublicGift(row: Doc<"financePublicationEntries">) {
  return {
    occurredAt: row.occurredAt,
    amountCents: row.amountCents,
    method: row.method ?? null,
    designation: row.designation ?? null,
    bookLabel: row.bookLabel,
  };
}

/** Which months are public, newest first. Drives the page's month picker. */
export const publishedMonths = query({
  args: {},
  returns: v.array(
    v.object({
      periodKey: v.string(),
      label: v.string(),
      publishedAt: v.number(),
      /** How many books have published this month. The page says so when it
       *  is fewer than the org has, so a partial month can't read as a total
       *  one. */
      bookCount: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("financePublications")
      .withIndex("by_live_and_period", (q) => q.eq("isLive", true))
      .take(ROLLUP_SCAN_LIMIT);
    const byPeriod = new Map<string, { publishedAt: number; bookCount: number }>();
    for (const row of rows) {
      const entry = byPeriod.get(row.periodKey) ?? { publishedAt: 0, bookCount: 0 };
      entry.publishedAt = Math.max(entry.publishedAt, row.publishedAt ?? 0);
      entry.bookCount += 1;
      byPeriod.set(row.periodKey, entry);
    }
    return [...byPeriod.entries()]
      .map(([periodKey, e]) => ({
        periodKey,
        label: periodLabel(periodKey),
        publishedAt: e.publishedAt,
        bookCount: e.bookCount,
      }))
      .sort((a, b) => (a.periodKey < b.periodKey ? 1 : -1));
  },
});

/**
 * THE PUBLIC STATEMENT — one month, every published book, merged.
 *
 * Returns `null` when nothing is published for the month, which the page
 * renders as an honest "not published yet" rather than as zeros.
 *
 * Totals are SUMMED FROM THE STORED REVISION AGGREGATES, never re-derived
 * from the entries. The stored figures are the ones a human approved; a
 * re-derivation would be a second implementation of the same arithmetic with
 * the power to silently disagree with what was signed off.
 */
// ── The merge (shared by the month view and the year rollup) ────────────────
/**
 * Fold a set of LIVE publications into one statement.
 *
 * One month across several books and one year across several months are the
 * same operation — sum the frozen aggregates, merge the frozen breakdowns,
 * concatenate the frozen lines — so they share this rather than growing two
 * implementations that could disagree about, say, whether an amendment log
 * from a book that stopped publishing still counts.
 *
 * TOTALS COME FROM THE STORED REVISION AGGREGATES, never re-derived from the
 * entries. The stored figures are the ones a human approved; re-deriving them
 * would be a second implementation of the same arithmetic with the power to
 * silently disagree with what was signed off.
 *
 * DISTINCT GIVERS ARE UNIONED, NOT ADDED. Adding two months' giver counts
 * reports somebody who gave in both as two people. The union runs over
 * `financePublicationGiverKeys` — read here, counted here, and never returned
 * from this function or any other.
 */
const budgetRow = v.object({
  label: v.string(),
  allocatedCents: v.union(v.number(), v.null()),
  spentCents: v.number(),
  count: v.number(),
});

const statementShape = {
  incomeCents: v.number(),
  expenseCents: v.number(),
  netCents: v.number(),
  incomeByStream: v.array(
    v.object({
      stream: v.union(...INCOME_STREAMS.map((s) => v.literal(s))),
      cents: v.number(),
      count: v.number(),
    }),
  ),
  expenseByCategory: v.array(
    v.object({ label: v.string(), cents: v.number(), count: v.number() }),
  ),
  expenseByProject: v.array(
    v.object({ label: v.string(), cents: v.number(), count: v.number() }),
  ),
  spendByBudget: v.array(budgetRow),
  reconstructedCount: v.number(),
  reconstructedCents: v.number(),
  undocumentedCount: v.number(),
  undocumentedCents: v.number(),
  uncodedCount: v.number(),
  uncodedCents: v.number(),
  unexplainedCount: v.number(),
  unexplainedCents: v.number(),
  entryCount: v.number(),
  giftCount: v.number(),
  /** DISTINCT people, unioned across everything being merged. */
  giverCount: v.number(),
  backerCount: v.number(),
  /** True when the response carries fewer lines than the period has — the
   *  page says so and points at the CSV, which is never truncated. */
  entriesTruncated: v.boolean(),
  books: v.array(
    v.object({
      bookLabel: v.string(),
      periodKey: v.string(),
      label: v.string(),
      revision: v.number(),
      publishedAt: v.number(),
      amendments: v.array(
        v.object({
          revision: v.number(),
          publishedAt: v.number(),
          reason: v.union(v.string(), v.null()),
          note: v.union(v.string(), v.null()),
        }),
      ),
    }),
  ),
  entries: v.array(publicEntry),
  gifts: v.array(publicGift),
};

type MergeOptions = {
  /** How many lines to return. `0` returns none — the year rollup's default,
   *  because a year of lines is a download, not a page (see `yearStatement`). */
  entryLimit: number;
};

async function mergeLive(
  ctx: QueryCtx,
  pubs: Doc<"financePublications">[],
  { entryLimit }: MergeOptions,
) {
  let incomeCents = 0;
  let expenseCents = 0;
  let reconstructedCount = 0;
  let reconstructedCents = 0;
  let undocumentedCount = 0;
  let undocumentedCents = 0;
  let uncodedCount = 0;
  let uncodedCents = 0;
  let unexplainedCount = 0;
  let unexplainedCents = 0;
  let entryCount = 0;
  let giftCount = 0;
  const incomeByStream = new Map<string, { cents: number; count: number }>();
  const expenseByCategory = new Map<string, { cents: number; count: number }>();
  const expenseByProject = new Map<string, { cents: number; count: number }>();
  // Budgets merge BY LABEL across books and months — the same budget appearing
  // in March and April is one row with the spend added. Allocations are summed
  // only when every contributing row carried one; see `allocatedCents` below.
  const byBudget = new Map<
    string,
    { allocatedCents: number | null; spentCents: number; count: number }
  >();
  const giverKeys = new Set<string>();
  const backerKeys = new Set<string>();
  const books: Infer<typeof statementShape.books> = [];
  const entries: ReturnType<typeof toPublicEntry>[] = [];
  const gifts: ReturnType<typeof toPublicGift>[] = [];
  let entriesTruncated = false;

  const addTo = (
    map: Map<string, { cents: number; count: number }>,
    key: string,
    cents: number,
    count: number,
  ) => {
    const b = map.get(key) ?? { cents: 0, count: 0 };
    b.cents += cents;
    b.count += count;
    map.set(key, b);
  };

  for (const pub of pubs) {
    const live = pub.liveRevision;
    if (live == null) continue;
    const revisions = await ctx.db
      .query("financePublicationRevisions")
      .withIndex("by_publication", (q) => q.eq("publicationId", pub._id))
      .take(200);
    const current = revisions.find((r) => r.revision === live);
    if (!current) continue;

    incomeCents += current.incomeCents;
    expenseCents += current.expenseCents;
    reconstructedCount += current.reconstructedCount;
    reconstructedCents += current.reconstructedCents;
    undocumentedCount += current.undocumentedCount;
    undocumentedCents += current.undocumentedCents;
    uncodedCount += current.uncodedCount;
    uncodedCents += current.uncodedCents;
    // ABSENT on a revision published before the distinction existed.
    unexplainedCount += current.unexplainedCount ?? 0;
    unexplainedCents += current.unexplainedCents ?? 0;
    entryCount += current.entryCount;
    giftCount += current.giftCount;
    for (const r of current.incomeByStream) {
      addTo(incomeByStream, r.stream, r.cents, r.count);
    }
    for (const r of current.expenseByCategory) {
      addTo(expenseByCategory, r.label, r.cents, r.count);
    }
    for (const r of current.expenseByProject) {
      addTo(expenseByProject, r.label, r.cents, r.count);
    }
    // ABSENT on a revision published before budgets were part of the
    // statement — treated as "nothing to say", never as zero spend.
    for (const r of current.spendByBudget ?? []) {
      const existing = byBudget.get(r.label);
      if (!existing) {
        byBudget.set(r.label, {
          allocatedCents: r.allocatedCents ?? null,
          spentCents: r.spentCents,
          count: r.count,
        });
        continue;
      }
      existing.spentCents += r.spentCents;
      existing.count += r.count;
      // An allocation only survives the merge if BOTH sides had one. Adding a
      // known cap to an unknown one would publish a plan figure that is
      // simply wrong, and the reader has no way to tell.
      existing.allocatedCents =
        existing.allocatedCents == null || r.allocatedCents == null
          ? null
          : existing.allocatedCents + r.allocatedCents;
    }

    // Distinct givers: UNION, never sum. The identities are read here and
    // counted here; nothing below returns them.
    const keys = await ctx.db
      .query("financePublicationGiverKeys")
      .withIndex("by_revision", (q) =>
        q.eq("publicationId", pub._id).eq("revision", live),
      )
      .take(ROLLUP_SCAN_LIMIT);
    for (const k of keys) {
      giverKeys.add(k.key);
      if (k.isBacker) backerKeys.add(k.key);
    }

    if (entryLimit > 0) {
      const rows = await ctx.db
        .query("financePublicationEntries")
        .withIndex("by_revision", (q) =>
          q.eq("publicationId", pub._id).eq("revision", live),
        )
        .take(entryLimit + 1);
      if (rows.length > entryLimit) entriesTruncated = true;
      for (const row of rows.slice(0, entryLimit)) {
        if (row.kind === "gift") gifts.push(toPublicGift(row));
        else entries.push(toPublicEntry(row));
      }
    } else if (current.entryCount > 0) {
      entriesTruncated = true;
    }

    const bookLabel =
      pub.scope === CENTRAL
        ? "Central"
        : ((await ctx.db.get(pub.scope))?.name ?? "Chapter");
    books.push({
      bookLabel,
      periodKey: pub.periodKey,
      label: periodLabel(pub.periodKey),
      revision: live,
      publishedAt: current.publishedAt,
      // Revision 1 is not an amendment — it is the original statement, and
      // listing it in the amendment log would read as a correction of
      // something that never existed.
      amendments: revisions
        .filter((r) => r.revision > 1)
        .sort((a, b) => b.revision - a.revision)
        .map((r) => ({
          revision: r.revision,
          publishedAt: r.publishedAt,
          reason: r.amendmentReason ?? null,
          note: r.note ?? null,
        })),
    });
  }

  entries.sort((a, b) => a.occurredAt - b.occurredAt);
  gifts.sort((a, b) => a.occurredAt - b.occurredAt);
  const sortRows = (m: Map<string, { cents: number; count: number }>) =>
    [...m.entries()]
      .map(([label, b]) => ({ label, cents: b.cents, count: b.count }))
      .sort((a, b) => b.cents - a.cents);

  return {
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    incomeByStream: INCOME_STREAMS.map((stream) => ({
      stream,
      cents: incomeByStream.get(stream)?.cents ?? 0,
      count: incomeByStream.get(stream)?.count ?? 0,
    })).filter((r) => r.count > 0),
    expenseByCategory: sortRows(expenseByCategory),
    expenseByProject: sortRows(expenseByProject),
    spendByBudget: [...byBudget.entries()]
      .map(([label, b]) => ({ label, ...b }))
      .sort((a, b) => b.spentCents - a.spentCents),
    reconstructedCount,
    reconstructedCents,
    undocumentedCount,
    undocumentedCents,
    uncodedCount,
    uncodedCents,
    unexplainedCount,
    unexplainedCents,
    entryCount,
    giftCount,
    giverCount: giverKeys.size,
    backerCount: backerKeys.size,
    entriesTruncated,
    books: books.sort(
      (a, b) =>
        a.periodKey.localeCompare(b.periodKey) ||
        a.bookLabel.localeCompare(b.bookLabel),
    ),
    entries,
    gifts,
  };
}

/**
 * THE PUBLIC STATEMENT — one month, every published book, merged.
 *
 * Returns `null` when nothing is published for the month, which the page
 * renders as an honest "not published yet" rather than as zeros.
 */
export const publicStatement = query({
  args: { periodKey: v.string(), entryLimit: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({
      periodKey: v.string(),
      label: v.string(),
      ...statementShape,
    }),
  ),
  handler: async (ctx, args) => {
    assertPeriodKey(args.periodKey);
    const pubs = (
      await ctx.db
        .query("financePublications")
        .withIndex("by_period", (q) => q.eq("periodKey", args.periodKey))
        .take(ROLLUP_SCAN_LIMIT)
    ).filter((p) => p.isLive && p.liveRevision != null);
    if (pubs.length === 0) return null;

    const merged = await mergeLive(ctx, pubs, {
      entryLimit: Math.max(
        1,
        Math.min(args.entryLimit ?? PUBLIC_PAGE_ENTRY_LIMIT, 5000),
      ),
    });
    if (merged.books.length === 0) return null;
    return { periodKey: args.periodKey, label: periodLabel(args.periodKey), ...merged };
  },
});

/**
 * THE YEAR ROLLUP — every published month of one year, added together.
 *
 * A year is NOT its own publication and never becomes one. It is the months
 * that have been published, summed, and the response says exactly which those
 * were (`books`) so a partial year can never read as a whole one. Nothing
 * here can report a figure the months behind it don't support.
 *
 * ── WHY THE LINES ARE NOT INCLUDED BY DEFAULT ────────────────────────────────
 * A year is thousands of rows. Rendering them into one server-rendered page
 * would make the most-shared URL on the site the slowest, for a table nobody
 * scrolls to the bottom of. So the rollup is summary-level — the big numbers,
 * where it came from, where it went, budgets — and the lines stay one click
 * away in each month, or in the year CSV, which is complete. `entryLimit`
 * exists for that CSV.
 */
export const publicYearStatement = query({
  args: { year: v.string(), entryLimit: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({
      year: v.string(),
      label: v.string(),
      /** The `YYYY-MM` keys that contributed, oldest first — what the page
       *  lists so "8 of 12 months" is visible rather than inferred. */
      months: v.array(v.string()),
      ...statementShape,
    }),
  ),
  handler: async (ctx, args) => {
    const year = parseYearKey(args.year);
    if (year == null) {
      throw new ConvexError({
        code: "BAD_PERIOD",
        message: `"${args.year}" is not a year. Expected YYYY, e.g. 2026.`,
      });
    }
    const pubs: Doc<"financePublications">[] = [];
    for (const key of monthsOfYear(year)) {
      const rows = await ctx.db
        .query("financePublications")
        .withIndex("by_period", (q) => q.eq("periodKey", key))
        .take(ROLLUP_SCAN_LIMIT);
      pubs.push(...rows.filter((p) => p.isLive && p.liveRevision != null));
    }
    if (pubs.length === 0) return null;

    const merged = await mergeLive(ctx, pubs, {
      entryLimit: Math.max(0, Math.min(args.entryLimit ?? 0, 20_000)),
    });
    if (merged.books.length === 0) return null;
    return {
      year: args.year,
      label: String(year),
      months: [...new Set(merged.books.map((b) => b.periodKey))].sort(),
      ...merged,
    };
  },
});

/** Which YEARS have at least one published month, newest first. Drives the
 *  year dropdown. */
export const publishedYears = query({
  args: {},
  returns: v.array(v.object({ year: v.string(), monthCount: v.number() })),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("financePublications")
      .withIndex("by_live_and_period", (q) => q.eq("isLive", true))
      .take(ROLLUP_SCAN_LIMIT);
    const byYear = new Map<string, Set<string>>();
    for (const row of rows) {
      const year = row.periodKey.slice(0, 4);
      const set = byYear.get(year) ?? new Set<string>();
      set.add(row.periodKey);
      byYear.set(year, set);
    }
    return [...byYear.entries()]
      .map(([year, months]) => ({ year, monthCount: months.size }))
      .sort((a, b) => b.year.localeCompare(a.year));
  },
});

/** Every active book, so the page can say how many of them have published a
 *  given month. A count, no names beyond what is already public. */
export const publicBookCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
    return chapters.length + 1; // + central
  },
});
