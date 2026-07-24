/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  runBackfillPersonEmails,
  runBackfillPersonEmailsPage,
  type PersonEmailsCursor,
  type PersonEmailsStage,
} from "../migrations/0039_backfill_person_emails";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0039 — backfills `personEmails` from `people.email`/`pwEmail`,
 * linked donors' emails, and linked rsvps' emails (person-centric audiences
 * Phase 2 item 1). Deterministic, auto-registered, idempotent.
 *
 * hotfix 0039-single-paginate (prod incident, 2026-07-24): the original
 * implementation drained `people`, `donors`, and `rsvps` with a `for(;;)`
 * loop of `.paginate()` calls PER TABLE, all inside one execution — Convex
 * hard-fails a function that calls `.paginate()` more than once in a single
 * invocation, but `convex-test` (this suite's harness) does NOT enforce that
 * runtime rule, so this passed here and then broke
 * `npx convex run migrations:runPending` in production. The migration is now
 * `{ stage, cursor }`-threaded across invocations (one `.paginate()` call per
 * invocation, mirroring `0035_backfill_receipt_documents.ts`'s scheduler
 * continuation) — `runFullBackfill` below drives it the same way the real
 * scheduler continuation (`migrations.continuePersonEmailsBackfill`) does:
 * separate `run()` calls (each its own execution, exactly like separate
 * mutation invocations), threading the returned cursor. This is deliberately
 * NOT a loop over one `ctx` — that would silently reintroduce the exact bug
 * this hotfix fixes, since `convex-test` wouldn't catch it either.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: `worship-night-${now}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: `Event ${now}`,
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function personEmailsFor(s: ChapterSetup, personId: Id<"people">): Promise<Doc<"personEmails">[]> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect(),
  );
}

/**
 * Drives the migration to completion the way `migrations.continuePersonEmailsBackfill`
 * does in production: repeated SEPARATE invocations (one `run()` — one
 * execution — per call), threading `result.next` back in until `isDone`.
 * Returns the totals across every page plus the sequence of stages visited,
 * so callers can assert on both.
 */
async function runFullBackfill(s: ChapterSetup) {
  let at: PersonEmailsCursor | null = null;
  const stages: PersonEmailsStage[] = [];
  let scanned = 0;
  let inserted = 0;
  let upgraded = 0;
  let unchanged = 0;
  // Safety cap so a design bug (e.g. an infinite stage cycle) fails the test
  // with a clear error instead of hanging.
  for (let i = 0; i < 50; i++) {
    const page = await run(s.t, (ctx) => runBackfillPersonEmailsPage(ctx, at));
    stages.push(page.stage);
    scanned += page.scanned;
    inserted += page.inserted;
    upgraded += page.upgraded;
    unchanged += page.unchanged;
    if (page.isDone) {
      return { scanned, inserted, upgraded, unchanged, stages };
    }
    at = page.next;
  }
  throw new Error("runFullBackfill: exceeded safety cap without completing");
}

describe("migration 0039 — backfill person emails", () => {
  test("populates roster/pw/donor/rsvp rows and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Full House",
        email: "Full@Example.com",
        pwEmail: "full@publicworship.life",
        createdAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Full House",
        email: "full-donor@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Full House",
        email: "full-rsvp@example.com",
        status: "going",
        token: "tok-full",
        emailVerified: true,
        personId,
        createdAt: 3000,
        updatedAt: 3000,
      }),
    );

    const first = await runFullBackfill(s);
    expect(first.stages).toEqual(["people", "donors", "rsvps"]);
    expect(first.inserted).toBe(4); // roster + pw + donor + rsvp — four distinct addresses
    expect(first.upgraded).toBe(0);
    expect(first.unchanged).toBe(0);

    const rows = await personEmailsFor(s, personId);
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(bySource.roster).toMatchObject({ email: "full@example.com", verified: true });
    expect(bySource.pw).toMatchObject({ email: "full@publicworship.life", verified: true });
    expect(bySource.donor).toMatchObject({ email: "full-donor@example.com", verified: true });
    expect(bySource.rsvp).toMatchObject({ email: "full-rsvp@example.com", verified: true });

    // Idempotent: a second full run inserts/upgrades nothing new.
    const second = await runFullBackfill(s);
    expect(second.inserted).toBe(0);
    expect(second.upgraded).toBe(0);
    expect(second.unchanged).toBe(4);
    expect(await personEmailsFor(s, personId)).toHaveLength(4);
  });

  test("dedupe: the SAME normalized email from two sources keeps only the highest-trust row", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Roster email and donor email are the SAME address (case/whitespace
    // differs) — roster (rank 3) must beat donor (rank 2).
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Shared Address",
        email: "shared@example.com",
        createdAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Shared Address",
        email: "Shared@Example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );

    const result = await runFullBackfill(s);
    expect(result.inserted).toBe(1); // one row, not two
    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("roster");
  });

  test("trust order: an unverified rsvp email loses to a verified donor email at the same address", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Verify Trust", createdAt: 1000 }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Verify Trust",
        email: "trust@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );
    const eventId = await seedEvent(s);
    // rsvp source normally OUTRANKS nothing, but here it's UNVERIFIED — even
    // though rsvp's rank is already the lowest, this proves verified is
    // checked FIRST (a verified low-rank source doesn't matter here since
    // donor already wins on rank too; the real assertion is the opposite
    // case below). The DONOR stage runs BEFORE the rsvp stage, so this also
    // exercises the cross-stage "later stage can never beat an earlier
    // stage's stored row" upgrade path (here: never even attempted, since
    // rsvp loses on `verified` regardless of order).
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verify Trust",
        email: "trust@example.com",
        status: "going",
        token: "tok-trust",
        emailVerified: false,
        personId,
        createdAt: 3000,
        updatedAt: 3000,
      }),
    );

    const result = await runFullBackfill(s);
    expect(result.inserted).toBe(1);
    expect(result.upgraded).toBe(0);
    const rows = await personEmailsFor(s, personId);
    expect(rows[0]).toMatchObject({ source: "donor", verified: true });
  });

  test("verified is checked BEFORE source rank: two same-source rsvp rows at one address keep the verified one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Verified Wins", createdAt: 1000 }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verified Wins",
        email: "verified-wins@example.com",
        status: "going",
        token: "tok-a",
        emailVerified: true,
        personId,
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verified Wins",
        email: "verified-wins@example.com",
        status: "going",
        token: "tok-b",
        emailVerified: false,
        personId,
        createdAt: 2000,
        updatedAt: 2000,
      }),
    );

    const result = await runFullBackfill(s);
    expect(result.inserted).toBe(1);
    const rows = await personEmailsFor(s, personId);
    expect(rows[0]).toMatchObject({ verified: true, addedAt: 1000 });
  });

  test("donors/rsvps with no personId are skipped entirely", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Unlinked Donor",
        email: "unlinked-donor@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: 1000,
      }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Unlinked Guest",
        email: "unlinked-guest@example.com",
        status: "going",
        token: "tok-unlinked",
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );

    const result = await runFullBackfill(s);
    expect(result.inserted).toBe(0);
    const all = await run(s.t, (ctx) => ctx.db.query("personEmails").collect());
    expect(all).toHaveLength(0);
  });

  test("a pre-existing write-through row is left untouched, not duplicated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Pre Seeded",
        email: "pre-seeded@example.com",
        createdAt: 1000,
      }),
    );
    // Simulate a live write-through row already present (e.g. from
    // `people.update` running before this migration executes), with an
    // EARLIER `addedAt` than what the backfill's own roster candidate would
    // carry (`people.createdAt` = 1000) — the stored row must win the
    // earliest-`addedAt` tie-break and stay untouched.
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId,
        email: "pre-seeded@example.com",
        source: "roster",
        verified: true,
        addedAt: 999,
      }),
    );

    const result = await runFullBackfill(s);
    expect(result.inserted).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(result.unchanged).toBe(1);
    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].addedAt).toBe(999); // untouched, not re-inserted with a new addedAt
  });

  /**
   * hotfix 0039-single-paginate: the runner (`migrations.runPending` →
   * `runBackfillPersonEmails`, then `migrations.continuePersonEmailsBackfill`
   * repeatedly) never calls this migration's page function more than once
   * per execution. This test drives `runBackfillPersonEmailsPage` the same
   * way — separate invocations threading `{ stage, cursor }` — and asserts
   * the stage progression, that intermediate pages correctly report
   * `isDone: false`, and that the final page is both complete and stable
   * under a second full pass (idempotent re-run from the terminal state).
   */
  test("runner invocation pattern: stage progression, single paginate per call, idempotent re-run", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Runner Pattern",
        email: "runner@example.com",
        createdAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Runner Pattern",
        email: "runner-donor@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Runner Pattern",
        email: "runner-rsvp@example.com",
        status: "going",
        token: "tok-runner",
        emailVerified: true,
        personId,
        createdAt: 3000,
        updatedAt: 3000,
      }),
    );

    // Call 1: registry entry point, exactly like `runPending` calling
    // `migration.run(ctx)` — must perform exactly one `.paginate()` and
    // report it isn't done yet (there are two more stages).
    const call1 = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(call1.stage).toBe("people");
    expect(call1.isDone).toBe(false);
    expect(call1.next).toEqual({ stage: "donors", cursor: null });

    // Call 2: the scheduler continuation's first fire, resuming from call 1's
    // cursor — a SEPARATE execution, exactly like a real scheduled mutation.
    const call2 = await run(s.t, (ctx) => runBackfillPersonEmailsPage(ctx, call1.next));
    expect(call2.stage).toBe("donors");
    expect(call2.isDone).toBe(false);
    expect(call2.next).toEqual({ stage: "rsvps", cursor: null });

    // Call 3: final stage, final page.
    const call3 = await run(s.t, (ctx) => runBackfillPersonEmailsPage(ctx, call2.next));
    expect(call3.stage).toBe("rsvps");
    expect(call3.isDone).toBe(true);
    expect(call3.next).toBeNull();

    expect([call1.inserted, call2.inserted, call3.inserted].reduce((a, b) => a + b, 0)).toBe(3);

    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["roster", "donor", "rsvp"]));

    // Idempotent re-run from the fully-completed state: driving the whole
    // thing again (fresh `at: null` start, same as a brand-new deploy's
    // `runPending` would do) changes nothing.
    const rerun = await runFullBackfill(s);
    expect(rerun.stages).toEqual(["people", "donors", "rsvps"]);
    expect(rerun.inserted).toBe(0);
    expect(rerun.upgraded).toBe(0);
    expect(rerun.unchanged).toBe(3);
    expect(await personEmailsFor(s, personId)).toHaveLength(3);
  });

  /**
   * The prod incident scenario: an earlier run committed the `people` stage
   * (partial state) before failing. A fresh run from the top must converge
   * to the same correct end state — including UPGRADING a row the partial
   * run left at a lower trust level than a later-observed candidate, which
   * is exactly what the pairwise-max-against-the-stored-row design (see the
   * migration's module doc) buys over the old "insert once, never touch
   * again" semantics.
   */
  test("resumes correctly from a partial prior run, upgrading a lower-trust stored row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Partial Resume",
        createdAt: 5000, // LATER than the donor row below
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Partial Resume",
        email: "partial@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 1000,
      }),
    );
    // Simulate a PRIOR partial run that only got as far as inserting the
    // donor-sourced row (e.g. it crashed before reaching a later stage that
    // would have found a higher-trust candidate at the same address — here
    // manufactured directly instead of via `rsvp`/`roster`, since both of
    // those either can't collide with `donor` at higher trust or are covered
    // by other tests; this isolates the upgrade path itself).
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId,
        email: "partial@example.com",
        source: "donor",
        verified: true,
        addedAt: 1000,
      }),
    );
    // Now the roster field gets set at the SAME address (e.g. a human copied
    // the donor's email into the roster field after the partial run).
    await run(s.t, (ctx) => ctx.db.patch(personId, { email: "partial@example.com" }));

    const result = await runFullBackfill(s);
    expect(result.upgraded).toBe(1); // donor(rank 2) → roster(rank 3)
    expect(result.inserted).toBe(0);
    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "roster", verified: true });
  });
});
