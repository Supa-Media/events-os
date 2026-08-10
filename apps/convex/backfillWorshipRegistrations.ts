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
 * ── WHAT THE DRY RUN SHOULD SAY, AND WHAT ACTUALLY WARRANTS STOPPING ────────
 * Run it with no `execute` first and check the numbers against these. They are
 * not all equally load-bearing, and an earlier draft of this header got that
 * backwards — it told the operator to stop unless `rosterMatches` was 2, a
 * number that was both wrong AND not a money signal, so following it would have
 * halted a completely correct run.
 *
 * STOP AND INVESTIGATE — these are the money invariants:
 *
 *   · `alreadyPresent` MUST be 0 on the first run. Anything else means these
 *     transactions are ALREADY recorded somewhere in `registrations`, and
 *     booking them again is the double-count this whole feature exists to
 *     avoid. (On a re-run it should be 6 and `toInsert` 0 — that is the
 *     idempotency check passing, not a problem.)
 *   · `revenueAddedCents` MUST be exactly 15000 and `grossCents` exactly 30000.
 *     Three paid at $50 and three refunded at $50 is the entire claim; any
 *     other pair of numbers means the fixture and the deployment disagree about
 *     what happened.
 *   · `gapMovementCents` MUST be −15000. A positive number here would mean the
 *     sign convention got inverted somewhere, which is the single easiest
 *     mistake to make in this file (see `lib/reconciliationGap.ts`).
 *   · `problems` MUST be empty.
 *
 * WORTH A LOOK, BUT NEVER A REASON TO STOP:
 *
 *   · `rosterMatches` is expected to be 6 — ALL SIX registrants already have a
 *     `people` row and a `personEmails` row in production (verified against a
 *     2026-08-10 snapshot: 589 people / 619 personEmails). A LOWER number means
 *     the emails didn't join — a typo, the wrong CSV column, a stale export —
 *     so the links would be missing, not wrong. Worth fixing before running,
 *     because backfilling a link afterwards is more work than getting it right
 *     once. But it moves NO money: `personId` is optional by design and an
 *     unlinked registration is a complete row. Never block the books on it.
 *
 * ── WHY ALL SIX ARE ALREADY ON THE ROSTER ───────────────────────────────────
 * Worth understanding, because the obvious reasoning gets it wrong. Reading the
 * committed fixtures alone predicts TWO: `lib/seed/historical/giving.ts` has
 * one of them as a `rowType:"ticket"` row and another as a `rowType:"gift"`
 * row, and both `historicalBackfill.ts` paths create a `people` row carrying
 * the email. The other four appear in the RSVP fixtures (`ltn.ts`, `nye.ts`,
 * `eden.ts`) with a NAME AND NO EMAIL, or not at all — so that story cannot
 * explain their `personEmails` rows.
 *
 * The roster is populated far more broadly than the historical backfill: EVERY
 * Givebutter touch write-throughs an address. `personEmails.source` is
 * `roster | pw | donor | rsvp | manual`, and three of those are automatic:
 *   · `lib/rsvpPeople.ts#linkRsvpToPerson` calls `recordPersonEmail` on EVERY
 *     link, matched or freshly created — and RSVP emails come from the
 *     Givebutter TICKET sync writing `rsvps.email`, not from the name-only seed
 *     fixtures. So anyone who ever bought a ticket to any Public Worship event
 *     through Givebutter has both rows.
 *   · `lib/givingDonors.ts#linkDonorToPerson` does the same for gift rows.
 *
 * These six are Public Worship REGULARS who had bought tickets or given before
 * — which is unsurprising for a class that filled with familiar faces, and is
 * the actual reason the count is 6 and not 2.
 *
 * Per-person attribution is one query away if anyone wants it: read
 * `personEmails.source` for those six addresses and it says which path each
 * arrived by. Not needed to run this, and not worth a production read on its
 * own.
 *
 * ── DRY RUN BY DEFAULT, AND IT SKIPS RATHER THAN GUESSES ────────────────────
 * Mirrors `gear2024Split.ts` (the closest surviving one-off — same shape: a
 * one-time runner beside a separate dataset module in `lib/`): `execute`
 * defaults to false, every precondition is asserted, and ANY mismatch returns a
 * `problems[]` entry with nothing written. The preconditions are the project's existence, its chapter,
 * and its name — a deployment where any of those reads differently is not the
 * deployment this fixture describes, and writing six money rows into it would
 * be worse than doing nothing.
 *
 * ── IDEMPOTENT, AND WHAT THAT DOES *NOT* COVER ──────────────────────────────
 * Each row is keyed on `externalRef = "gb:txn:<givebutter id>"` and looked up
 * through the `by_external_ref` index. A second execute inserts nothing and
 * reports all six under `alreadyPresent`.
 *
 * ⚠ THAT PREFIX IS NOT UNIQUE ACROSS TABLES, and there is a live double-count
 * path this backfill cannot close from here. NOTHING IN `givebutterSync.ts`
 * READS `registrations` (verified: zero hits in that file and its helpers).
 * `eventPages.givebutterCampaignId` is a single free-text box with no allowlist
 * and no date gate on the manual sync button — so attaching the Worship Beyond
 * The Walls campaign to any event re-imports these transactions. The sync drops
 * the three refunds itself (`isRefundedTransaction`), so the exposure is
 * precisely the three PAID rows: $150.00 counted twice, and the org-wide gap
 * swinging from balanced to −$150.00 (books claiming money that is nowhere).
 * Whether they land as `ticketOrders` or as `gifts` depends only on the
 * Givebutter line item's `subtype`; both are counted by
 * `reconciliation.ts#computeBookBalances`, so both double-count. The same move
 * cost $665 of duplicate giving on Pop The Balloon in 2026-08.
 *
 * DO NOT ATTACH THAT CAMPAIGN TO AN EVENT.
 *
 * ── WHY THE CODE GUARD IS DEFERRED, NOT FORGOTTEN ───────────────────────────
 * The obvious guard — "skip a transaction already in `registrations`" — cannot
 * be written correctly from here, and writing it anyway is the worse option.
 *
 * The ids in this fixture are 10 DIGITS: the Reference Number the Givebutter
 * EXPORT prints. The sync holds the API's own 16-character transaction id.
 * Those are different id spaces for the same transaction, which is EXACTLY the
 * mismatch that cost $665 — see `givebutterSync.ts`'s LEGACY-BACKFILL GUARD,
 * which exists because a lookup across those two spaces silently missed. A
 * guard keyed `registrations.by_external_ref.eq("gb:txn:" + apiTxnId)` would
 * therefore miss all six and produce nothing but false confidence.
 *
 * Doing it properly needs a fact I cannot get from here: whether these six ids
 * are API ids or export Reference Numbers, checked against the live API. Then
 * two guards, at seams already argued for in that file:
 *   - `applyGivebutterDonations`, after the `givebutterConvertedDonations`
 *     check and BEFORE `matchOrCreateDonor` — same reasoning that file already
 *     gives for converted donations: don't even manufacture a donor row for
 *     someone who didn't give.
 *   - `applyGivebutterTickets`, after the `existingOrder` dedup and BEFORE the
 *     ticket-type resolution. This one also needs `transaction_id` threaded
 *     through `normalizeTicket`, which currently discards it.
 * Until then, this comment and `schema/registrations.ts#externalRef` are the
 * guard, and they are honest about being only that.
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
     * WHO each transaction belongs to, keyed by Givebutter transaction id.
     * REQUIRED for a run that writes: `name` is required by the schema and
     * lives only in the export, so a missing one SKIPS rather than guesses.
     * `email` is optional — a registration with no address still records, just
     * unlinked, which is a complete row. Supplying an email is the ONLY way a
     * `personId` link is made; this backfill never matches a payment to a human
     * by name.
     *
     * WHERE TO GET THEM: the `Name` and `Email` columns of
     * `3-worship-beyond-the-walls-1786127710.csv` in the 2026-08-07 Givebutter
     * export, joined to the fixture on the transaction id. (`Email` and
     * `Contact Email` agree on every row, so there is no ambiguity to resolve.)
     *
     * NONE OF IT IS IN THIS REPO, ON PURPOSE. Addresses are obvious. NAMES are
     * here for the less obvious reason: three of these six are refunded
     * scholarships, and "this named person received a scholarship" is
     * financial-need information about a real individual — at least as
     * sensitive as an address, and a repo is forever while this module is not.
     * Paste them into the call, never into a file.
     */
    registrants: v.optional(
      v.array(
        v.object({
          givebutterTxnId: v.string(),
          name: v.string(),
          email: v.optional(v.string()),
        }),
      ),
    ),
  },
  returns: v.object({
    dryRun: v.boolean(),
    /** Rows this run WOULD write. Nonzero on a dry run — that is the point of
     *  a dry run — so read it with `dryRun`, never alone. */
    toInsert: v.number(),
    /** Rows this run ACTUALLY wrote. Always 0 when `dryRun` is true. Separate
     *  from `toInsert` because a single `inserted: 6` on a dry run reads as
     *  "wrote 6" to anyone skimming, and on a money backfill that is the worst
     *  possible thing to be unclear about. */
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
  handler: async (ctx, { execute, registrants }) => {
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
    const supplied = registrants ?? [];
    const personIdByEmail = new Map<string, string>();
    const registrantByTxnId = new Map<string, { name: string; email?: string }>();
    for (const { givebutterTxnId, name, email } of supplied) {
      const normalized = email?.trim().toLowerCase();
      registrantByTxnId.set(givebutterTxnId, {
        name,
        ...(normalized ? { email: normalized } : {}),
      });
      if (!normalized) continue;
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
    const suppliedEmails = [
      ...new Set(
        [...registrantByTxnId.values()]
          .map((r) => r.email)
          .filter((e): e is string => e != null),
      ),
    ];
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
      registrantByTxnId,
    });

    if (plan.problems.length > 0) {
      return {
        dryRun: !write,
        toInsert: 0,
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
      toInsert: plan.inserts.length,
      inserted: write ? plan.inserts.length : 0,
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
