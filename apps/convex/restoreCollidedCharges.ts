/**
 * Put back the six charges the books lost twice (2026-08-09).
 *
 * `lib/seed/historical/genesisRestore2026.ts` holds the six rows, the evidence
 * that each is real, and the two independent figures that both say $55.00. This
 * runs it. Read that module first — the reasoning is there, not here.
 *
 * The short version: `applyRelayImport`'s dedup key collapsed two identical
 * same-day charges into one, `financeGenesisBackfill.ts` correctly re-supplied
 * the missing copies, and `genesisDedupe2026.ts` deleted them again by matching
 * two curated rows against the one live-feed row they were both folded onto.
 *
 * ── THIS RUNNER ONLY INSERTS ────────────────────────────────────────────────
 * There is no `patch` and no `delete` below, and there should never be one. The
 * whole failure being corrected is a pass that reasoned its way into deleting
 * real money, so the correction is deliberately the least powerful operation
 * that can do the job: six inserts, or nothing. "No other row moves" is a
 * property of the code's shape here, not an assertion bolted onto it.
 *
 * ── ALL SIX OR NONE ─────────────────────────────────────────────────────────
 * Every gate below adds to `problems` and, if `problems` is non-empty, NOTHING
 * is written. A half-applied correction on a money path is worse than an
 * unapplied one: the books would be off by an amount nobody predicted, and the
 * $55.00 that makes this whole change checkable would no longer be the number to
 * look for. A dry run reports the same problems, so diagnosing costs nothing.
 *
 * Four things are re-verified per row, against the live ledger, before writing:
 *
 *   1. the source row still says what `genesisRestore2026.ts` says it says —
 *      `GENESIS_BANK_ROWS` is position-keyed, and an insertion into it would
 *      renumber every `genesis-bank:*` key after the insertion point;
 *   2. the key is ABSENT. If it is present the row is already back, and running
 *      again would manufacture the very duplicate the dedupe pass was trying to
 *      prevent — an absurd way to end this. Refuse, loudly;
 *   3. the ledger still holds EXACTLY ONE row at that amount and flow on that
 *      day — the surviving twin. Zero means the ledger is not the one this
 *      correction was written against; two means the pair is already complete
 *      and nothing is missing;
 *   4. that one row is the `collidedExternalId` named in the data module — so
 *      the pairing is the one that was reasoned about, not a coincidence.
 *
 * And the total: the six must move book value by exactly −$55.00
 * (`EXPECTED_RESTORE_CENTS`). Anything else and the set is not the set this was
 * verified for.
 *
 * `execute` omitted / false = a zero-write dry run reporting exactly what a real
 * run would do. Delete this module once run.
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=restoreCollidedCharges:runRestoreCollidedCharges -f args='{}'
 *   # then again with -f args='{"execute":true}'
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { GENESIS_BANK_ROWS } from "./lib/seed/historical/genesisBank";
import {
  EXPECTED_RESTORE_CENTS,
  GENESIS_RESTORE_ROWS,
  RESTORE_NOTE_SUFFIX,
} from "./lib/seed/historical/genesisRestore2026";
import { genesisBankFields } from "./financeGenesisBackfill";

/** The NY chapter's whole ledger is well under this; same ceiling the genesis
 *  backfill and the reconcile grid scan with. */
const SCAN_LIMIT = 5000;

function usd(cents: number): string {
  return `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** UTC calendar day — the genesis rows are all parsed to UTC midnight, so the
 *  surviving Relay-import twins they pair with sit on the same UTC day. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const rowReport = v.object({
  externalId: v.string(),
  day: v.string(),
  description: v.string(),
  /** Signed: negative for the outflows all six of these are. */
  signedCents: v.number(),
  /** The one surviving row at this amount on this day, when it resolved. */
  collidedWith: v.optional(v.string()),
  /** Rows at this amount + flow on this day BEFORE the run. Must be 1. */
  sameDayMatches: v.number(),
  /** False on a dry run, and false for every row when any row had a problem. */
  restored: v.boolean(),
});

export const runRestoreCollidedCharges = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    /** False when any gate failed — nothing was written. */
    proceeded: v.boolean(),
    rows: v.array(rowReport),
    /** Signed cents this run moves book value by: −5500 on a clean apply. */
    bookValueDeltaCents: v.number(),
    expectedDeltaCents: v.number(),
    /** Anything that disagreed with the data module — reported, never guessed past. */
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) {
      throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });
    }

    // One read of the book, reused by every gate. The genesis-era money is all
    // New York's (the backfill hardcoded it there, and these six are its rows),
    // so a single-chapter scan is the right scope — unlike the Cash App
    // withdrawals, which genuinely changed books when the banking did.
    const ledger = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
      .take(SCAN_LIMIT);

    const pending: {
      fields: NonNullable<ReturnType<typeof genesisBankFields>>;
      report: {
        externalId: string;
        day: string;
        description: string;
        signedCents: number;
        collidedWith?: string;
        sameDayMatches: number;
        restored: boolean;
      };
    }[] = [];

    for (const target of GENESIS_RESTORE_ROWS) {
      const source = GENESIS_BANK_ROWS[target.bankIndex];
      if (!source) {
        problems.push(
          `genesis-bank:${target.bankIndex}: no row at that index in GENESIS_BANK_ROWS ` +
            `(${GENESIS_BANK_ROWS.length} rows) — SKIPPED`,
        );
        continue;
      }

      // GATE 1 — the position still holds the charge this correction is about.
      if (
        source.date !== target.expect.date ||
        source.description !== target.expect.description ||
        source.amountCents !== target.expect.amountCents
      ) {
        problems.push(
          `genesis-bank:${target.bankIndex}: expected "${target.expect.description}" ` +
            `${usd(target.expect.amountCents)} on ${target.expect.date}, but GENESIS_BANK_ROWS ` +
            `holds "${source.description}" ${usd(source.amountCents)} on ${source.date} — ` +
            `the list has been renumbered. SKIPPED`,
        );
        continue;
      }

      const fields = genesisBankFields(source, target.bankIndex);
      if (!fields) {
        problems.push(
          `genesis-bank:${target.bankIndex}: source row is unusable (bad amount or date) — SKIPPED`,
        );
        continue;
      }
      const day = utcDay(fields.postedAt);
      const signedCents = fields.flow === "inflow" ? fields.amountCents : -fields.amountCents;

      // GATE 2 — absent. A second run must not put a second copy back.
      if (ledger.some((t) => t.externalId === fields.externalId)) {
        problems.push(
          `${fields.externalId} is ALREADY PRESENT — restoring it again would create the ` +
            `duplicate the dedupe pass was trying to prevent. REFUSING`,
        );
        continue;
      }

      // GATES 3 + 4 — exactly one surviving twin, and it is the named one.
      const sameDay = ledger.filter(
        (t) =>
          t.flow === fields.flow &&
          t.amountCents === fields.amountCents &&
          utcDay(t.postedAt) === day,
      );
      if (sameDay.length !== 1) {
        problems.push(
          `${fields.externalId}: expected exactly 1 surviving ${usd(signedCents)} ` +
            `${fields.flow} on ${day} (the twin both copies collapsed onto), found ` +
            `${sameDay.length}` +
            (sameDay.length === 0
              ? " — the ledger is not the one this correction was written against"
              : " — the pair is already complete, nothing is missing") +
            `. SKIPPED`,
        );
        continue;
      }
      const twin = sameDay[0];
      if (twin.externalId !== target.collidedExternalId) {
        problems.push(
          `${fields.externalId}: the surviving ${usd(signedCents)} row on ${day} is ` +
            `"${twin.externalId ?? "(no externalId)"}", not the "${target.collidedExternalId}" ` +
            `this correction reasoned about — SKIPPED`,
        );
        continue;
      }

      pending.push({
        fields,
        report: {
          externalId: fields.externalId,
          day,
          description: fields.description,
          signedCents,
          collidedWith: twin.externalId,
          sameDayMatches: sameDay.length,
          restored: false,
        },
      });
    }

    // The amount gate. Two sources agreed on $55.00 before this was written; if
    // the six rows resolved from the live source don't reproduce it, the set is
    // not the set that was verified and no part of it should be written.
    const bookValueDeltaCents = pending.reduce((a, p) => a + p.report.signedCents, 0);
    if (
      pending.length === GENESIS_RESTORE_ROWS.length &&
      bookValueDeltaCents !== EXPECTED_RESTORE_CENTS
    ) {
      problems.push(
        `the six rows total ${usd(bookValueDeltaCents)}, not the ${usd(EXPECTED_RESTORE_CENTS)} ` +
          `both the row amounts and the owner's Relay balance predict — REFUSING`,
      );
    }
    if (pending.length !== GENESIS_RESTORE_ROWS.length) {
      problems.push(
        `${pending.length}/${GENESIS_RESTORE_ROWS.length} rows passed their checks — refusing ` +
          `to half-apply a correction whose whole proof is that it comes to ` +
          `${usd(EXPECTED_RESTORE_CENTS)}. Nothing was written.`,
      );
    }

    const proceeded = problems.length === 0;
    if (!proceeded) {
      return {
        dryRun: !write,
        proceeded: false,
        rows: pending.map((p) => p.report),
        bookValueDeltaCents: 0,
        expectedDeltaCents: EXPECTED_RESTORE_CENTS,
        problems,
      };
    }

    for (const { fields, report } of pending) {
      if (write) {
        await ctx.db.insert("transactions", {
          chapterId: chapter._id,
          source: "relay_csv",
          flow: fields.flow,
          amountCents: fields.amountCents,
          currency: "usd",
          postedAt: fields.postedAt,
          description: fields.description,
          // The original note, extended — not replaced. The row has to read as
          // the one that was always supposed to be here (same category, same
          // method, same month, same wording as its unremoved siblings), while
          // still saying out loud why its `createdAt` is a year after its
          // `postedAt`. `historicalImportBatch` is deliberately NOT stamped:
          // no genesis row in production carries it (the field was added to the
          // backfill after that run), and `isReconstructedHistory` recognises
          // these by their `genesis-` prefix either way — so stamping it would
          // make the restored rows the only six that look different.
          note: `${fields.note} ${RESTORE_NOTE_SUFFIX}`,
          status: "unreviewed",
          externalId: fields.externalId,
          createdAt: Date.now(),
        });
      }
      report.restored = write;
    }

    return {
      dryRun: !write,
      proceeded: true,
      rows: pending.map((p) => p.report),
      bookValueDeltaCents,
      expectedDeltaCents: EXPECTED_RESTORE_CENTS,
      problems,
    };
  },
});
