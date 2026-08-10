/**
 * One-time: record the six Worship Beyond The Walls student registrations that
 * were collected and never got onto the books.
 *
 * DELETE THIS MODULE (and `lib/projectRegistrationBackfill.ts`) ONCE RUN.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * The class was a `projects` row — a multi-session course with a $50
 * registration fee — and until `schema/registrations.ts` there was no
 * person↔project link anywhere in the schema to record a registration against.
 * `ticketOrders` requires an `eventId` and this was never an event;
 * `engagements` requires one too and is volunteer/paid crew besides. So six
 * people paid Givebutter $300.00, three were refunded $150.00 as scholarships,
 * $150.00 was remitted in payout `KKJ3TQ` — and our side recorded none of it.
 *
 * That $150.00 is the last unexplained slice of the org-wide reconciliation
 * gap. `differenceCents = located − books` (`lib/reconciliationGap.ts`), the
 * cash arrived months ago, so booking the revenue moves the signed gap DOWN by
 * exactly $150.00 — from `cash_exceeds_books +$150.00` to balanced.
 *
 * ── ⚠ THIS MOVES REAL CASH THE NEXT MORNING ─────────────────────────────────
 * READ THIS BEFORE PASSING `execute: true`.
 *
 * Recording $150.00 of revenue raises New York's BOOK VALUE by $150.00. The
 * morning reconciliation engine settles chapter books against the cash central
 * is holding for them — `settleChapterBalances` runs the SAME
 * `computeBookBalances` this backfill feeds — so on the next run central will
 * transfer New York **$150.00 more** than it otherwise would have, as a real
 * `balance_settlement` pair.
 *
 * That is CORRECT: New York earned the money, its payout landed in central's
 * account, and the settlement is how it gets delivered. But it is not obvious
 * from "record six registrations", and it is the difference between a
 * bookkeeping entry and a bank transfer. Two consequences worth knowing:
 *
 *   - the movement clears `MIN_SETTLEMENT_CENTS` ($5.00), so it WILL be booked
 *     rather than rounded away;
 *   - it is a `balance_settlement`, which contributes ZERO to book value
 *     (`lib/bookBalance.ts`), so it moves cash without moving the number that
 *     produced it. The engine converges; it does not chase itself.
 *
 * If that transfer should not happen on the following morning, run this
 * immediately AFTER a settlement run rather than before, or coordinate with
 * whoever watches the engine. Don't discover it from a bank alert.
 *
 * ── DRY RUN BY DEFAULT, AND IT SKIPS RATHER THAN GUESSES ────────────────────
 * Mirrors `reverseBadSettlement.ts`: `execute` defaults to false, every
 * precondition is asserted, and ANY mismatch returns a `problems[]` entry with
 * nothing written. The preconditions are the project's existence, its chapter,
 * and its name — a deployment where any of those reads differently is not the
 * deployment this fixture describes, and writing six money rows into it would
 * be worse than doing nothing.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 * Each row is keyed on `externalRef = "gb:txn:<givebutter id>"` and looked up
 * through the `by_external_ref` index. A second execute inserts nothing and
 * reports all six under `alreadyPresent`.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No donors, no gifts. These are registrations — a fee for a place in a class —
 * not charitable gifts, and `lib/givingDonors.ts` owns that path with its own
 * lifetime totals, donor status and scope rollups. Routing a course fee through
 * it would inflate every giving report and give six people a donor record they
 * never earned.
 *
 * No `people` rows either. `personId` is linked only where an operator-supplied
 * EMAIL matches an existing roster row — never a name (see
 * `lib/projectRegistrationBackfill.ts`).
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  WBTW_CHAPTER_ID,
  WBTW_PROJECT_ID,
  planRegistrationBackfill,
  externalRefFor,
  WBTW_REGISTRATIONS,
} from "./lib/projectRegistrationBackfill";

export const backfillWorshipRegistrations = internalMutation({
  args: {
    execute: v.optional(v.boolean()),
    /**
     * Registrant emails, keyed by Givebutter transaction id, so a row can be
     * linked to the `people` row it belongs to. Optional: a run with none
     * supplied still records all six registrations, just unlinked — which is a
     * complete row, not a broken one. Supplying them is the ONLY way a link is
     * made; this backfill never matches a payment to a human by name.
     *
     * WHERE TO GET THEM: the `Email` column of
     * `3-worship-beyond-the-walls-1786127710.csv` in the 2026-08-07 Givebutter
     * export, joined to these rows on the transaction id. (`Email` and
     * `Contact Email` agree on every row, so there is no ambiguity to resolve.)
     *
     * THEY ARE NOT IN THIS REPO, ON PURPOSE. Six real people's addresses do not
     * belong in source control, a test fixture, or a comment — which is the
     * whole reason this is a run-time argument rather than a constant. Paste
     * them into the call, not into this file.
     */
    emails: v.optional(
      v.array(v.object({ givebutterTxnId: v.string(), email: v.string() })),
    ),
  },
  returns: v.object({
    dryRun: v.boolean(),
    inserted: v.number(),
    alreadyPresent: v.number(),
    linkedPeople: v.number(),
    /** The revenue this adds to New York's book — `paid` rows only. */
    revenueAddedCents: v.number(),
    /** All six rows' face value, paid + refunded. Not revenue; here so the
     *  $300.00 Givebutter collected is visible in the output. */
    grossCents: v.number(),
    /** Signed movement of the org-wide gap (`located − books`). Negative:
     *  recording revenue raises books, which lowers the gap. */
    gapMovementCents: v.number(),
    /** How many DISTINCT supplied emails resolved to an existing `people` row.
     *  Reported even when the run SKIPs — see where it's computed. */
    rosterMatches: v.number(),
    /** The supplied addresses matching nobody. NOT a problem — a registrant who
     *  isn't a person yet is the normal case and the row stands on its own —
     *  but worth saying out loud so a typo'd address doesn't look like "not on
     *  the roster". */
    emailsWithNoRosterMatch: v.array(v.string()),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute, emails }) => {
    const write = execute ?? false;

    const projectId = ctx.db.normalizeId("projects", WBTW_PROJECT_ID);
    const project = projectId ? await ctx.db.get(projectId) : null;

    // Existing rows, one indexed lookup per fixture row — the dedup key.
    const existingExternalRefs = new Set<string>();
    for (const row of WBTW_REGISTRATIONS) {
      const ref = externalRefFor(row.givebutterTxnId);
      const hit = await ctx.db
        .query("registrations")
        .withIndex("by_external_ref", (q) => q.eq("externalRef", ref))
        .first();
      if (hit) existingExternalRefs.add(ref);
    }

    // Roster lookup by EMAIL, through the two places an address can live: the
    // person's own contact field and the `personEmails` ledger of every address
    // known for them (`schema/people.ts`). Only the addresses the operator
    // actually supplied are looked up — no roster scan.
    const supplied = emails ?? [];
    const personIdByEmail = new Map<string, string>();
    const emailByTxnId = new Map<string, string>();
    for (const { givebutterTxnId, email } of supplied) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) continue;
      emailByTxnId.set(givebutterTxnId, normalized);
      if (personIdByEmail.has(normalized)) continue;
      const known = await ctx.db
        .query("personEmails")
        .withIndex("by_email", (q) => q.eq("email", normalized))
        .first();
      if (known) {
        personIdByEmail.set(normalized, known.personId as string);
        continue;
      }
      const person = await ctx.db
        .query("people")
        .withIndex("by_email", (q) => q.eq("email", normalized))
        .first();
      if (person) personIdByEmail.set(normalized, person._id as string);
    }

    // THE ROSTER ANSWER, computed from the lookup above rather than from the
    // plan, so it survives a SKIP. "How many of these six are already people?"
    // is a fact worth having BEFORE this deploys, and it is independent of
    // whether the project preconditions matched — a dry run that refuses to
    // write should still report everything it managed to learn. Reported on
    // every path below.
    const suppliedEmails = [...new Set([...emailByTxnId.values()])];
    const rosterMatches = suppliedEmails.filter((e) =>
      personIdByEmail.has(e),
    ).length;
    const emailsWithNoRosterMatch = suppliedEmails.filter(
      (e) => !personIdByEmail.has(e),
    );

    const plan = planRegistrationBackfill({
      project: project
        ? {
            id: project._id as string,
            chapterId: project.chapterId as string,
            name: project.name,
          }
        : null,
      existingExternalRefs,
      personIdByEmail,
      emailByTxnId,
    });

    if (plan.problems.length > 0) {
      return {
        dryRun: !write,
        inserted: 0,
        alreadyPresent: plan.alreadyPresent.length,
        linkedPeople: 0,
        revenueAddedCents: 0,
        grossCents: 0,
        gapMovementCents: 0,
        rosterMatches,
        emailsWithNoRosterMatch,
        problems: plan.problems,
      };
    }

    if (write) {
      const now = Date.now();
      for (const row of plan.inserts) {
        await ctx.db.insert("registrations", {
          chapterId: WBTW_CHAPTER_ID as Id<"chapters">,
          projectId: projectId as Id<"projects">,
          ...(row.personId ? { personId: row.personId as Id<"people"> } : {}),
          name: row.name,
          ...(row.email ? { email: row.email } : {}),
          amountCents: row.amountCents,
          status: row.status,
          ...(row.refundReason ? { refundReason: row.refundReason } : {}),
          externalRef: row.externalRef,
          registeredAt: row.registeredAt,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Only the rows actually going in move the books — a re-run that inserts
    // nothing must report a zero movement, not the full $150.00 again.
    const revenueAddedCents = plan.inserts
      .filter((r) => r.status === "paid")
      .reduce((sum, r) => sum + r.amountCents, 0);

    return {
      dryRun: !write,
      inserted: plan.inserts.length,
      alreadyPresent: plan.alreadyPresent.length,
      linkedPeople: plan.linkedPeople,
      revenueAddedCents,
      grossCents: plan.grossCents,
      // `gap = located − books`. Revenue raises books, so the gap falls.
      gapMovementCents: -revenueAddedCents,
      rosterMatches,
      emailsWithNoRosterMatch,
      problems: plan.problems,
    };
  },
});
