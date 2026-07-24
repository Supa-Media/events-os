import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { linkRsvpPeoplePage } from "../migrations/0037_link_rsvp_people";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0037 — the rsvp↔people backfill (person-centric audiences Phase 1
 * item 3). Dry-run vs execute, idempotence, cross-event dedupe (same email on
 * N events → ONE person, N linked rsvps), and the divergent-name safety guard
 * (a shared/household email with more than one distinct attendee name links
 * only the majority name, leaving the rest unlinked).
 *
 * hotfix 0037-single-paginate (prod incident, 2026-07-24): the original
 * implementation drained `rsvps` with a `for(;;)` loop of `.paginate()` calls
 * (bounded by `SCAN_CAP`) all inside ONE execution — Convex hard-fails a
 * function that calls `.paginate()` more than once per invocation, but
 * `convex-test` (this suite's harness) does NOT enforce that runtime rule, so
 * this passed here and then broke `npx convex run
 * migrations/0037_link_rsvp_people:backfillLinkRsvpPeople` in production. The
 * migration now processes exactly one page per call, returning `{ isDone,
 * continueCursor }` for the caller to thread — see the "runner invocation
 * pattern" and "cross-page" tests below, which exercise this the ONLY way
 * that actually catches a regression: separate `run()` calls (each its own
 * execution), never more than one `.paginate()` per call. Most tests here use
 * a tiny `pageSize` override (a test-only param on `linkRsvpPeoplePage`, not
 * exposed on the public mutation) to force page boundaries with a handful of
 * seeded rows instead of seeding thousands of rsvps.
 */

/**
 * Drives the migration to completion the way a human re-invoking the
 * run-convex-function workflow does: repeated SEPARATE invocations (one
 * `run()` — one execution — per call), threading `continueCursor` back in
 * until `isDone`. Returns the totals summed across every page.
 */
async function runFullBackfillPages(
  s: ChapterSetup,
  opts: { execute: boolean; pageSize?: number },
) {
  let cursor: string | null = null;
  const totals = {
    scanned: 0,
    linked: 0,
    skippedDivergentName: 0,
    skippedNoIdentifier: 0,
    divergentGroups: 0,
    pages: 0,
  };
  // Safety cap so a design bug (e.g. an infinite cursor loop) fails the test
  // with a clear error instead of hanging.
  for (let i = 0; i < 50; i++) {
    const page = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: opts.execute, cursor, pageSize: opts.pageSize }),
    );
    totals.pages++;
    totals.scanned += page.scanned;
    totals.linked += page.linked;
    totals.skippedDivergentName += page.skippedDivergentName;
    totals.skippedNoIdentifier += page.skippedNoIdentifier;
    totals.divergentGroups += page.divergentGroups;
    if (page.isDone) return totals;
    cursor = page.continueCursor;
  }
  throw new Error("runFullBackfillPages: exceeded safety cap without completing");
}

async function seedEvent(s: ChapterSetup, name: string): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${now}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Insert a bare rsvp row directly (bypassing the live insert sites, which
 *  already link at write time) — simulates a PRE-EXISTING, pre-Phase-1 row. */
async function seedRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  fields: {
    name: string;
    email?: string;
    phone?: string;
    createdAt?: number;
  },
): Promise<Id<"rsvps">> {
  const now = fields.createdAt ?? Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: fields.name,
      email: fields.email,
      phone: fields.phone,
      status: "going",
      token: `tok-${Math.random()}`,
      source: "rsvp",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

function allPeople(s: ChapterSetup): Promise<Doc<"people">[]> {
  return run(s.t, (ctx) => ctx.db.query("people").collect());
}

function getRsvp(s: ChapterSetup, id: Id<"rsvps">): Promise<Doc<"rsvps"> | null> {
  return run(s.t, (ctx) => ctx.db.get(id));
}

describe("migration 0037 — link rsvp people backfill", () => {
  test("dry run writes nothing; execute links and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Solo Night");
    const rsvpId = await seedRsvp(s, eventId, {
      name: "Solo Guest",
      email: "solo@example.com",
    });

    const dry = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: false, cursor: null }),
    );
    expect(dry.linked).toBeGreaterThanOrEqual(1);
    // Dry run writes NOTHING.
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
    expect(await allPeople(s)).toHaveLength(0);

    const first = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(first.linked).toBeGreaterThanOrEqual(1);
    const linkedRsvp = await getRsvp(s, rsvpId);
    expect(linkedRsvp?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(linkedRsvp!.personId!));
    expect(person).toMatchObject({ name: "Solo Guest", isContactOnly: true });

    // Idempotent: a second execute run touches nothing new (already-linked
    // rows are skipped outright).
    const second = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(second.linked).toBe(0);
    expect(await allPeople(s)).toHaveLength(1); // no duplicate
  });

  test("cross-event dedupe: the same email on 3 events maps to ONE person, 3 linked rsvps", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const e1 = await seedEvent(s, "Event One");
    const e2 = await seedEvent(s, "Event Two");
    const e3 = await seedEvent(s, "Event Three");
    const r1 = await seedRsvp(s, e1, { name: "Repeat Attendee", email: "repeat@example.com", createdAt: 1000 });
    const r2 = await seedRsvp(s, e2, { name: "Repeat Attendee", email: "repeat@example.com", createdAt: 2000 });
    const r3 = await seedRsvp(s, e3, { name: "Repeat Attendee", email: "repeat@example.com", createdAt: 3000 });

    await run(s.t, (ctx) => linkRsvpPeoplePage(ctx, { execute: true, cursor: null }));

    const [rsvp1, rsvp2, rsvp3] = await Promise.all([
      getRsvp(s, r1),
      getRsvp(s, r2),
      getRsvp(s, r3),
    ]);
    expect(rsvp1?.personId).toBeTruthy();
    expect(rsvp2?.personId).toBe(rsvp1?.personId);
    expect(rsvp3?.personId).toBe(rsvp1?.personId);

    const everyone = await allPeople(s);
    expect(everyone.filter((p) => p.email === "repeat@example.com")).toHaveLength(1);
  });

  test("divergent names on a shared email: only the majority name links, the rest stay unlinked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const e1 = await seedEvent(s, "House A");
    const e2 = await seedEvent(s, "House B");
    const e3 = await seedEvent(s, "House C");
    // "Jane" appears twice, "John" once, on the SAME shared inbox.
    const jane1 = await seedRsvp(s, e1, { name: "Jane Doe", email: "family@example.com", createdAt: 1000 });
    const jane2 = await seedRsvp(s, e2, { name: "Jane Doe", email: "family@example.com", createdAt: 2000 });
    const john = await seedRsvp(s, e3, { name: "John Doe", email: "family@example.com", createdAt: 1500 });

    const res = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(res.divergentGroups).toBeGreaterThanOrEqual(1);
    expect(res.skippedDivergentName).toBeGreaterThanOrEqual(1);

    const [jane1Row, jane2Row, johnRow] = await Promise.all([
      getRsvp(s, jane1),
      getRsvp(s, jane2),
      getRsvp(s, john),
    ]);
    // The majority name (Jane, 2 rows) is linked to ONE person.
    expect(jane1Row?.personId).toBeTruthy();
    expect(jane2Row?.personId).toBe(jane1Row?.personId);
    // The minority name (John) is left unlinked — never merged, never guessed.
    expect(johnRow?.personId).toBeUndefined();

    const person = await run(s.t, (ctx) => ctx.db.get(jane1Row!.personId!));
    expect(person?.name).toBe("Jane Doe");

    // Re-running doesn't spontaneously resolve John — an intentional skip,
    // not a transient one; a human resolves it from the People tab.
    const rerun = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(rerun.skippedDivergentName).toBeGreaterThanOrEqual(1);
    expect((await getRsvp(s, john))?.personId).toBeUndefined();
  });

  test("never overwrites an existing person's fields from rsvp data", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Overwrite Guard");
    const existingId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Canonical Name",
        email: "canon@example.com",
        role: "Usher",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    // The rsvp carries a DIFFERENT (e.g. informally typed) name for the same
    // email — matching must link, never rewrite the roster row's own name/role.
    await seedRsvp(s, eventId, { name: "canon nickname", email: "canon@example.com" });

    await run(s.t, (ctx) => linkRsvpPeoplePage(ctx, { execute: true, cursor: null }));

    const person = await run(s.t, (ctx) => ctx.db.get(existingId));
    expect(person).toMatchObject({
      name: "Canonical Name",
      role: "Usher",
      isTeamMember: true,
    });
  });

  test("rows with no email and no phone are skipped (nothing to match or create from)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Name Only Event");
    const rsvpId = await seedRsvp(s, eventId, { name: "Name Only" });

    const res = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(res.skippedNoIdentifier).toBeGreaterThanOrEqual(1);
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
    expect(await allPeople(s)).toHaveLength(0);
  });

  /**
   * hotfix 0037-single-paginate: the runner (a human re-invoking the
   * run-convex-function workflow) never calls `linkRsvpPeoplePage` more than
   * once per execution. This test drives it the same way — separate
   * invocations threading `continueCursor`, forced across THREE pages via a
   * `pageSize: 1` override — and asserts every row is eventually processed,
   * that intermediate pages correctly report `isDone: false`, and that a
   * second full pass over the completed state is idempotent (links/creates
   * nothing new).
   */
  test("runner invocation pattern: single paginate per call, full completeness, idempotent re-run", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const e1 = await seedEvent(s, "Page One");
    const e2 = await seedEvent(s, "Page Two");
    const e3 = await seedEvent(s, "Page Three");
    const r1 = await seedRsvp(s, e1, { name: "Guest One", email: "guest1@example.com" });
    const r2 = await seedRsvp(s, e2, { name: "Guest Two", email: "guest2@example.com" });
    const r3 = await seedRsvp(s, e3, { name: "Guest Three", email: "guest3@example.com" });

    // Call 1: exactly one `.paginate()`, exactly one row, more remaining.
    const call1 = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null, pageSize: 1 }),
    );
    expect(call1.scanned).toBe(1);
    expect(call1.isDone).toBe(false);
    expect(call1.continueCursor).toBeTruthy();

    // Call 2: a SEPARATE execution, resuming from call 1's cursor.
    const call2 = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: call1.continueCursor, pageSize: 1 }),
    );
    expect(call2.scanned).toBe(1);
    expect(call2.isDone).toBe(false);

    // Call 3: final page.
    const call3 = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: call2.continueCursor, pageSize: 1 }),
    );
    expect(call3.scanned).toBe(1);
    expect(call3.isDone).toBe(true);
    expect(call3.continueCursor).toBeNull();

    const totalLinked = call1.linked + call2.linked + call3.linked;
    expect(totalLinked).toBe(3);

    const [rsvp1, rsvp2, rsvp3] = await Promise.all([getRsvp(s, r1), getRsvp(s, r2), getRsvp(s, r3)]);
    expect(rsvp1?.personId).toBeTruthy();
    expect(rsvp2?.personId).toBeTruthy();
    expect(rsvp3?.personId).toBeTruthy();
    expect(await allPeople(s)).toHaveLength(3);

    // Idempotent re-run from the fully-completed state: driving the whole
    // thing again changes nothing.
    const rerun = await runFullBackfillPages(s, { execute: true, pageSize: 1 });
    expect(rerun.linked).toBe(0);
    expect(await allPeople(s)).toHaveLength(3);
  });

  /**
   * The cross-page convergence case (module doc's "CROSS-PAGE CONVERGENCE"):
   * Alice's row lands on page 1 and links first, creating the anchor person.
   * Bob's row — a DIFFERENT name on the SAME shared email — lands on page 2,
   * where there's no sibling Alice row to out-vote it locally; the anchor
   * (found via `findPersonMatch` against the now-existing person) still wins,
   * so Bob's row is correctly recognized as divergent and stays unlinked,
   * rather than a naive per-page majority vote wrongly linking him as his
   * page's only (and therefore "winning") name.
   */
  test("cross-page anchor case: Alice links on page N, Bob's divergent row on page N+1 stays unlinked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const e1 = await seedEvent(s, "Household Event A");
    const e2 = await seedEvent(s, "Household Event B");
    const aliceId = await seedRsvp(s, e1, {
      name: "Alice Doe",
      email: "family@example.com",
      createdAt: 1000,
    });
    const bobId = await seedRsvp(s, e2, {
      name: "Bob Doe",
      email: "family@example.com",
      createdAt: 2000,
    });

    // Page 1 (pageSize: 1): only Alice's row — links and creates the anchor.
    const page1 = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null, pageSize: 1 }),
    );
    expect(page1.linked).toBe(1);
    expect(page1.isDone).toBe(false);
    const aliceRow = await getRsvp(s, aliceId);
    expect(aliceRow?.personId).toBeTruthy();

    // Page 2: only Bob's row. No sibling on this page, so a naive per-page
    // majority vote would treat "Bob Doe" as the trivial winner — the anchor
    // (Alice's now-existing person) must override that and reject him.
    const page2 = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: page1.continueCursor, pageSize: 1 }),
    );
    expect(page2.isDone).toBe(true);
    expect(page2.divergentGroups).toBe(1);
    expect(page2.skippedDivergentName).toBe(1);
    expect(page2.linked).toBe(0);

    const bobRow = await getRsvp(s, bobId);
    expect(bobRow?.personId).toBeUndefined();

    // Exactly one person exists — Alice's — and it was never renamed/merged.
    const everyone = await allPeople(s);
    expect(everyone).toHaveLength(1);
    expect(everyone[0]).toMatchObject({ name: "Alice Doe", email: "family@example.com" });
  });
});
