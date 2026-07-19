import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { newT, run, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { GIVING_ROWS } from "../lib/seed/historical/giving";
import { LTN_ROWS } from "../lib/seed/historical/ltn";
import { NYE_ROWS } from "../lib/seed/historical/nye";
import { EDEN_ROWS } from "../lib/seed/historical/eden";
import { PTB_ROWS } from "../lib/seed/historical/ptb";
import { PTB_GB_TICKETS_ROWS } from "../lib/seed/historical/ptbGbTickets";
import { FIELD_DAY_TICKETS_ROWS } from "../lib/seed/historical/fieldDayTickets";

/**
 * Historical backfill (Attendance D): the one-time ops module that loads the
 * curated Partiful/Givebutter exports into the donor CRM + event guest lists.
 * Covers: dry-run writes nothing (both runners) and predicts execute; execute
 * creates the expected rows; idempotent re-runs; ticket giving-rows never
 * create donors/gifts; MAPPING_MISMATCH + NO_PAGE guards; mailing-address
 * plumbing (create + fill-if-blank, never overwrite); rollup spot checks; the
 * paging arithmetic; and that every embedded dataset parses to its documented
 * row count.
 */

const NY_SLUG = "new-york";

type Setup = { t: TestConvex; chapterId: Id<"chapters">; userId: Id<"users"> };

/** A NY chapter (slug the backfill resolves by) + a user, no auth needed since
 *  the runners are internal. */
async function setupNy(): Promise<Setup> {
  const t = newT();
  const { chapterId, userId } = await run(t, async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "leader@publicworship.life",
    });
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York",
      slug: NY_SLUG,
      isActive: true,
      createdAt: Date.now(),
    });
    return { chapterId, userId };
  });
  return { t, chapterId, userId };
}

async function createEvent(
  s: Setup,
  name: string,
  dateMs: number,
  opts: { withPage?: boolean } = {},
): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Type",
      slug: `type-${name.toLowerCase().replace(/\s+/g, "-")}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: dateMs,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    if (opts.withPage) {
      await ctx.db.insert("eventPages", {
        eventId,
        chapterId: s.chapterId,
        slug: `page-${name.toLowerCase().replace(/\s+/g, "-")}`,
        published: false,
        goingCount: 0,
        maybeCount: 0,
        notGoingCount: 0,
        ticketsSoldCount: 0,
        revenueCents: 0,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    return eventId;
  });
}

const utc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

function tableCounts(s: Setup, scope: Id<"chapters">) {
  return run(s.t, async (ctx) => {
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    const pledges = await ctx.db
      .query("pledges")
      .withIndex("by_scope_and_status", (q) => q.eq("scope", scope))
      .collect();
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
      .collect();
    return {
      donors: donors.length,
      gifts: gifts.length,
      pledges: pledges.length,
      people: people.length,
      giftCentsTotal: gifts.reduce((sum, g) => sum + g.amountCents, 0),
    };
  });
}

const zeroGiving = () => ({
  donorsCreated: 0,
  donorsMatched: 0,
  gifts: 0,
  giftsDuplicate: 0,
  pledges: 0,
  pledgesDuplicate: 0,
  contacts: 0,
  contactsSkippedNoIdentifier: 0,
  ticketHistoryLinked: 0,
  invalid: 0,
});

type GivingCounts = ReturnType<typeof zeroGiving>;
type GivingRun = {
  dryRun: boolean;
  offset: number;
  processed: number;
  nextOffset: number | null;
  counts: GivingCounts;
};

function addGiving(a: GivingCounts, b: GivingCounts): GivingCounts {
  const out = zeroGiving();
  for (const k of Object.keys(out) as (keyof GivingCounts)[]) out[k] = a[k] + b[k];
  return out;
}

/** Page the giving runner through every window, returning summed counts. `dry`
 *  runs each window as a dry run right before its execute so the two see the
 *  SAME starting DB (dry writes nothing) — letting us assert dry predicts
 *  execute per page for the DB-deterministic dispositions. */
async function runGivingAll(
  s: Setup,
  execute: boolean,
  opts: { assertDryMatches?: boolean } = {},
): Promise<GivingCounts> {
  let total = zeroGiving();
  let offset: number | null = 0;
  while (offset !== null) {
    if (execute && opts.assertDryMatches) {
      const dry: GivingRun = await s.t.mutation(
        internal.historicalBackfill.runGivingBackfill,
        { offset, execute: false },
      );
      const exec: GivingRun = await s.t.mutation(
        internal.historicalBackfill.runGivingBackfill,
        { offset, execute: true },
      );
      // Donor / gift / pledge dispositions are pure functions of the DB state
      // at page start, which the dry run does not mutate — so they must agree.
      expect(exec.counts.donorsCreated).toBe(dry.counts.donorsCreated);
      expect(exec.counts.gifts).toBe(dry.counts.gifts);
      expect(exec.counts.giftsDuplicate).toBe(dry.counts.giftsDuplicate);
      expect(exec.counts.pledges).toBe(dry.counts.pledges);
      expect(exec.counts.pledgesDuplicate).toBe(dry.counts.pledgesDuplicate);
      expect(exec.counts.invalid).toBe(dry.counts.invalid);
      total = addGiving(total, exec.counts);
      offset = exec.nextOffset;
    } else {
      const res: GivingRun = await s.t.mutation(
        internal.historicalBackfill.runGivingBackfill,
        { offset, execute },
      );
      total = addGiving(total, res.counts);
      offset = res.nextOffset;
    }
  }
  return total;
}

describe("giving backfill", () => {
  test("dry run writes nothing", async () => {
    const s = await setupNy();
    const counts = await runGivingAll(s, false);
    expect(counts.gifts).toBeGreaterThan(0); // it DID classify gifts
    const db = await tableCounts(s, s.chapterId);
    expect(db).toMatchObject({ donors: 0, gifts: 0, pledges: 0, people: 0 });
  });

  test("execute creates rows, dry run predicts it, and re-run is idempotent", async () => {
    const s = await setupNy();

    const exec = await runGivingAll(s, true, { assertDryMatches: true });
    // Sanity against the embedded data shape (109 gift + 3 recurring rows, all
    // with unique externalRefs → no gift duplicates on a first, clean run).
    const giftRowCount = GIVING_ROWS.filter((r) => r.rowType === "gift").length;
    const recurringRowCount = GIVING_ROWS.filter((r) => r.rowType === "recurring").length;
    expect(exec.gifts).toBe(giftRowCount + recurringRowCount);
    expect(exec.giftsDuplicate).toBe(0);
    expect(exec.pledges).toBe(recurringRowCount);
    expect(exec.pledgesDuplicate).toBe(0);
    expect(exec.contacts).toBeGreaterThan(0);

    // DB reflects exactly the executed counts.
    const db = await tableCounts(s, s.chapterId);
    expect(db.donors).toBe(exec.donorsCreated);
    expect(db.gifts).toBe(exec.gifts);
    expect(db.pledges).toBe(exec.pledges);

    // Rollup spot check: denormalized giving rollup agrees with the raw rows.
    const rollup = await run(s.t, (ctx) =>
      ctx.db
        .query("givingScopeRollups")
        .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
        .unique(),
    );
    expect(rollup?.donorCount).toBe(db.donors);
    expect(rollup?.giftCount).toBe(db.gifts);
    expect(rollup?.lifetimeCents).toBe(db.giftCentsTotal);

    // Re-run: nothing new. Every donor now matches, every gift/pledge dedups.
    const rerun = await runGivingAll(s, true);
    expect(rerun.donorsCreated).toBe(0);
    expect(rerun.gifts).toBe(0);
    expect(rerun.pledges).toBe(0);
    expect(rerun.contacts).toBe(0);
    expect(rerun.giftsDuplicate).toBe(giftRowCount + recurringRowCount);
    expect(rerun.pledgesDuplicate).toBe(recurringRowCount);
    const db2 = await tableCounts(s, s.chapterId);
    expect(db2).toMatchObject({
      donors: db.donors,
      gifts: db.gifts,
      pledges: db.pledges,
      people: db.people,
    });
  });

  test("ticket giving-rows never create a donor or gift", async () => {
    const s = await setupNy();
    await runGivingAll(s, true);

    // An email that appears ONLY on ticket rows must yield no donor.
    const moneyEmails = new Set(
      GIVING_ROWS.filter(
        (r) => r.rowType === "gift" || r.rowType === "recurring",
      ).map((r) => (r.email ?? "").toLowerCase()),
    );
    const ticketOnly = GIVING_ROWS.find(
      (r) =>
        r.rowType === "ticket" &&
        r.email &&
        !moneyEmails.has(r.email.toLowerCase()),
    );
    expect(ticketOnly).toBeDefined();
    const donor = await run(s.t, (ctx) =>
      ctx.db
        .query("donors")
        .withIndex("by_scope_and_email", (q) =>
          q.eq("scope", s.chapterId).eq("email", ticketOnly!.email!.toLowerCase()),
        )
        .first(),
    );
    expect(donor).toBeNull();

    // Total gifts equals the money rows only (no ticket ever recorded a gift).
    const db = await tableCounts(s, s.chapterId);
    const moneyRows = GIVING_ROWS.filter(
      (r) => r.rowType === "gift" || r.rowType === "recurring",
    ).length;
    expect(db.gifts).toBe(moneyRows);
  });
});

describe("giving mailing-address plumbing", () => {
  test("fills a donor's address on create + fill-if-blank, never overwrites", async () => {
    const s = await setupNy();

    // A gift row carrying an address — its donor should end up with it.
    const withAddr = GIVING_ROWS.find(
      (r) => r.rowType === "gift" && r.address?.line1 && r.email,
    )!;
    // A DIFFERENT money row we pre-seed a donor for: one blank (to be filled),
    // one already-addressed (must be preserved).
    const moneyRows = GIVING_ROWS.filter(
      (r) => (r.rowType === "gift" || r.rowType === "recurring") && r.email && r.address?.line1,
    );
    const blankRow = moneyRows.find((r) => r.email !== withAddr.email)!;
    const keepRow = moneyRows.find(
      (r) => r.email !== withAddr.email && r.email !== blankRow.email,
    )!;

    const { blankId, keepId } = await run(s.t, async (ctx) => {
      const blankId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: blankRow.name,
        email: blankRow.email!.toLowerCase(),
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      });
      const keepId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: keepRow.name,
        email: keepRow.email!.toLowerCase(),
        address: { line1: "KEEP THIS" },
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      });
      return { blankId, keepId };
    });

    await runGivingAll(s, true);

    const [created, blank, keep] = await run(s.t, async (ctx) => {
      const created = await ctx.db
        .query("donors")
        .withIndex("by_scope_and_email", (q) =>
          q.eq("scope", s.chapterId).eq("email", withAddr.email!.toLowerCase()),
        )
        .first();
      return [created, await ctx.db.get(blankId), await ctx.db.get(keepId)];
    });

    // Created donor got the row's address.
    expect(created?.address?.line1).toBe(withAddr.address!.line1);
    // Pre-existing blank donor was filled from its matching row.
    expect(blank?.address?.line1).toBe(blankRow.address!.line1);
    // Pre-existing addressed donor was NOT overwritten.
    expect(keep?.address?.line1).toBe("KEEP THIS");
  });
});

describe("attendance backfill", () => {
  test("dry run classifies without writing; execute commits; re-run idempotent", async () => {
    const s = await setupNy();
    const eventId = await createEvent(s, "Field Day", utc("2026-08-08"), {
      withPage: true,
    });

    const dry = await s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
      dataset: "fieldday_tickets",
      eventId,
      execute: false,
    });
    expect(dry.dryRun).toBe(true);
    // Every row is classified; the dataset has a few repeat buyers, so distinct
    // inserts are < the raw row count.
    expect(
      dry.counts.inserted +
        dry.counts.skippedDuplicates +
        dry.counts.skippedInvalid,
    ).toBe(FIELD_DAY_TICKETS_ROWS.length);
    expect(dry.counts.inserted).toBeGreaterThan(0);
    expect(dry.nextOffset).toBeNull();
    const rsvpsAfterDry = await run(s.t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(rsvpsAfterDry.length).toBe(0);

    const exec = await s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
      dataset: "fieldday_tickets",
      eventId,
      execute: true,
    });
    // Dry run predicted execute exactly (same starting DB).
    expect(exec.counts.inserted).toBe(dry.counts.inserted);
    const rsvps = await run(s.t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(rsvps.length).toBe(exec.counts.inserted);
    // Field Day rows are all "going" — the page counter reflects the inserts.
    const page = await run(s.t, (ctx) =>
      ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .unique(),
    );
    expect(page?.goingCount).toBe(exec.counts.inserted);
    // Ticket rows never touch donors.
    const donors = await run(s.t, (ctx) =>
      ctx.db
        .query("donors")
        .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
        .collect(),
    );
    expect(donors.length).toBe(0);

    const rerun = await s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
      dataset: "fieldday_tickets",
      eventId,
      execute: true,
    });
    expect(rerun.counts.inserted).toBe(0);
    expect(rerun.counts.skippedDuplicates).toBe(FIELD_DAY_TICKETS_ROWS.length);
    const rsvps2 = await run(s.t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(rsvps2.length).toBe(exec.counts.inserted); // no new rows on re-run
  });

  test("MAPPING_MISMATCH on a wrong-name or wrong-date event", async () => {
    const s = await setupNy();
    const wrongName = await createEvent(s, "Some Other Event", utc("2026-08-08"), {
      withPage: true,
    });
    await expect(
      s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
        dataset: "fieldday_tickets",
        eventId: wrongName,
        execute: true,
      }),
    ).rejects.toThrow(ConvexError);

    const wrongDate = await createEvent(s, "Field Day", utc("2025-01-01"), {
      withPage: true,
    });
    await expect(
      s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
        dataset: "fieldday_tickets",
        eventId: wrongDate,
        execute: true,
      }),
    ).rejects.toMatchObject({ data: { code: "MAPPING_MISMATCH" } });
  });

  test("missing page: dry run reports pageWillBeCreated; execute creates an unpublished page", async () => {
    const s = await setupNy();
    const noPage = await createEvent(s, "Field Day", utc("2026-08-08"));

    const dry = await s.t.mutation(
      internal.historicalBackfill.runAttendanceBackfill,
      { dataset: "fieldday_tickets", eventId: noPage, execute: false },
    );
    expect(dry.pageWillBeCreated).toBe(true);
    // Dry run must not have created anything.
    const dryPage = await run(s.t, (ctx) =>
      ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", noPage))
        .unique(),
    );
    expect(dryPage).toBeNull();

    const exec = await s.t.mutation(
      internal.historicalBackfill.runAttendanceBackfill,
      { dataset: "fieldday_tickets", eventId: noPage, execute: true },
    );
    expect(exec.pageCreated).toBe(true);
    const createdPage = await run(s.t, (ctx) =>
      ctx.db
        .query("eventPages")
        .withIndex("by_event", (q) => q.eq("eventId", noPage))
        .unique(),
    );
    expect(createdPage).not.toBeNull();
    expect(createdPage!.published).toBe(false);
    // Counters landed on the auto-created page.
    expect(createdPage!.goingCount).toBeGreaterThan(0);

    // Second execute run: page reused, not re-created.
    const again = await s.t.mutation(
      internal.historicalBackfill.runAttendanceBackfill,
      { dataset: "fieldday_tickets", eventId: noPage, execute: true },
    );
    expect(again.pageCreated).toBeUndefined();
  });

  test("pages a >window dataset via offset / nextOffset", async () => {
    const s = await setupNy();
    // Pop The Balloon (ptb, 311 rows) — larger than one 200-row window.
    const eventId = await createEvent(s, "Pop The Balloon", utc("2025-12-06"), {
      withPage: true,
    });
    const page0 = await s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
      dataset: "ptb",
      eventId,
      execute: false,
      offset: 0,
    });
    expect(page0.processed).toBe(200);
    expect(page0.nextOffset).toBe(200);
    const page1 = await s.t.mutation(internal.historicalBackfill.runAttendanceBackfill, {
      dataset: "ptb",
      eventId,
      execute: false,
      offset: 200,
    });
    expect(page1.processed).toBe(PTB_ROWS.length - 200);
    expect(page1.nextOffset).toBeNull();
  });

  test("listEventsForMapping reports the NY chapter's events + page flags", async () => {
    const s = await setupNy();
    await createEvent(s, "Field Day", utc("2026-08-08"), { withPage: true });
    await createEvent(s, "Eden", utc("2026-05-31")); // no page

    const res = await s.t.query(internal.historicalBackfill.listEventsForMapping, {});
    expect(res.chapterId).toBe(s.chapterId);
    expect(res.events.length).toBe(2);
    const byName = Object.fromEntries(res.events.map((e) => [e.name, e]));
    expect(byName["Field Day"].hasPage).toBe(true);
    expect(byName["Eden"].hasPage).toBe(false);
  });
});

describe("embedded datasets", () => {
  test("every dataset parses to its documented row count", () => {
    expect(GIVING_ROWS.length).toBe(252);
    expect(LTN_ROWS.length).toBe(389);
    expect(NYE_ROWS.length).toBe(191);
    expect(EDEN_ROWS.length).toBe(712);
    expect(PTB_ROWS.length).toBe(311);
    expect(PTB_GB_TICKETS_ROWS.length).toBe(152);
    expect(FIELD_DAY_TICKETS_ROWS.length).toBe(23);
  });

  test("every embedded row carries the fields its importer needs", () => {
    for (const r of GIVING_ROWS) {
      expect(typeof r.name).toBe("string");
      expect(["gift", "ticket", "contact", "recurring"]).toContain(r.rowType);
    }
    for (const rows of [
      LTN_ROWS,
      NYE_ROWS,
      EDEN_ROWS,
      PTB_ROWS,
      PTB_GB_TICKETS_ROWS,
      FIELD_DAY_TICKETS_ROWS,
    ]) {
      for (const r of rows) {
        expect(typeof r.name).toBe("string");
        expect(r.name.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("full backfill aggregator", () => {
  test("dry run resolves every dataset's event, aggregates, and writes nothing", async () => {
    const s = await setupNy();
    // One event per mapping entry (ptb + ptb_gb_tickets share Pop The Balloon).
    await createEvent(s, "Love Thy Neighbor 2025", utc("2025-09-20"));
    await createEvent(s, "Crossover Night 2026", utc("2025-12-31"));
    await createEvent(s, "Eden", utc("2026-05-31"));
    await createEvent(s, "Pop The Balloon", utc("2025-12-06"));
    await createEvent(s, "Field Day", utc("2026-08-08"));

    const res = await s.t.action(internal.historicalBackfill.runFullBackfill, {
      execute: false,
    });
    expect(res.dryRun).toBe(true);
    // Giving classified everything exactly once across windows.
    const giftRows = GIVING_ROWS.filter((r) => r.rowType === "gift").length;
    const recRows = GIVING_ROWS.filter((r) => r.rowType === "recurring").length;
    expect(res.giving.gifts).toBe(giftRows + recRows);
    // All six datasets resolved, in ATTENDANCE_DATASETS order, full coverage.
    expect(res.attendance.map((a) => a.dataset)).toEqual([
      "ltn",
      "nye",
      "eden",
      "ptb",
      "ptb_gb_tickets",
      "fieldday_tickets",
    ]);
    const ltn = res.attendance[0];
    expect(
      ltn.counts.inserted + ltn.counts.updated + ltn.counts.skippedDuplicates +
        ltn.counts.skippedInvalid,
    ).toBe(LTN_ROWS.length);
    // No pages existed → every dataset reports pageWillBeCreated on dry run.
    expect(res.attendance.every((a) => a.pageWillBeCreated === true)).toBe(true);
    // And nothing was written.
    const db = await tableCounts(s, s.chapterId);
    expect(db).toMatchObject({ donors: 0, gifts: 0, pledges: 0 });
    const rsvpCount = await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("rsvps").take(5);
      return rows.length;
    });
    expect(rsvpCount).toBe(0);
  });

  test("fails fast with MAPPING_MISMATCH when a dataset's event is missing", async () => {
    const s = await setupNy();
    await expect(
      s.t.action(internal.historicalBackfill.runFullBackfill, { execute: false }),
    ).rejects.toMatchObject({ data: { code: "MAPPING_MISMATCH" } });
  });
});
