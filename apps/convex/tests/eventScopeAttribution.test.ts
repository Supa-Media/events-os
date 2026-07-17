/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Event scope attribution — the event twin of `projectScopeAttribution.test.ts`
 * (PR #194). Mirrors it field-for-field, s/project/event/, on top of the
 * pre-existing `finances.transferEventScope` (the event twin of
 * `transferProjectScope`, sharing its `transferRefScope` engine):
 *
 *  - CREATION DEFAULT ("creator's highest hat", owner spec): a creator with
 *    central (org-wide) finance reach gets a new event's money attributed to
 *    Central by default; a chapter-only creator gets their own chapter. An
 *    explicit `scope` argument (the creation UI's picker) always wins over the
 *    default, in either direction.
 *  - The event ROW never moves off its home chapter — `events.chapterId` has
 *    no central union (mirrors WP-2.2's project finding) — so "central"
 *    attribution is realized by moving the event's BUDGET, through the
 *    pre-existing `finances.transferEventScope` (no second scope-move path).
 *  - RETROACTIVE: `events.get` exposes the event's current money scope
 *    (`scope`/`scopeChapterName`/`homeChapterName`) plus whether the CALLER
 *    may change it (`canChangeScope`), gated the same way `transferEventScope`
 *    itself is — central reach, checked through the caller's OWN chapter,
 *    both directions.
 *  - Training events never carry a budget row (the #172 invariant); a
 *    `transferEventScope` call against one (or any budget-less event) no-ops
 *    sanely (0 budgets/txns moved, one audit row still written) rather than
 *    erroring.
 */

const SUPER = "seyi@publicworship.life";

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantFinanceRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: scope === "central" ? "central" : s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/** Create a non-platform template belonging to the caller's chapter. */
async function seedTemplate(s: ChapterSetup, name = "Template"): Promise<Id<"eventTypes">> {
  return (await s.as.mutation(api.eventTypes.create, { name })) as Id<"eventTypes">;
}

/** The event's linked one_time budget row, if any (by_ref lookup). */
async function eventBudget(s: ChapterSetup, eventId: Id<"events">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
      .first(),
  );
}

describe("events.createFromTemplate — money-attribution default", () => {
  test("a central-seat creator's new (money-bearing) event defaults to Central", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Music Recording Night",
      eventDate: tsInMonth(2026, 8),
      budget: 500,
    })) as Id<"events">;

    // The event ROW stays in the caller's own chapter ...
    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(event?.chapterId).toBe(s.chapterId);
    // ... but its budget landed at Central.
    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe("central");

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.scope).toBe("central");
    expect(detail?.scopeChapterName).toBeNull();
    // `homeChapterName`, unlike `scopeChapterName`, stays concrete even while
    // the event sits at Central — the UI's toggle/confirm-dialog needs a real
    // label for the "move back" option.
    expect(detail?.homeChapterName).toBe("New York");
  });

  test("a central-seat creator's $0 (work-tracking) event still gets a Central budget row, so a LATER dollar entry stays Central", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Central initiative",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget).not.toBeNull();
    expect(budget?.chapterId).toBe("central");
    expect(budget?.amountCents).toBe(0);

    // A later dollar entry writes THROUGH to the existing (already-central)
    // row (`setBudgetAmount` only patches `amountCents`) — never re-lands the
    // budget at the chapter.
    await s.as.mutation(api.events.updateDetails, { eventId, budget: 250 });
    const after = await eventBudget(s, eventId);
    expect(after?._id).toBe(budget?._id);
    expect(after?.chapterId).toBe("central");
    expect(after?.amountCents).toBe(25000);
  });

  test("a chapter-only creator's new event defaults to their chapter (unchanged behavior)", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Local event",
      eventDate: tsInMonth(2026, 8),
      budget: 100,
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe(s.chapterId);

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.scope).toBe(s.chapterId);
    expect(detail?.scopeChapterName).toBe("New York");
  });

  test("a caller with NO finance role at all defaults to their chapter", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Plain event",
      eventDate: tsInMonth(2026, 8),
      budget: 50,
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe(s.chapterId);
  });

  test("explicit picker override: a central-seat creator can still choose their own chapter", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Chapter-scoped even though I'm central",
      eventDate: tsInMonth(2026, 8),
      budget: 500,
      scope: "chapter",
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe(s.chapterId);
  });

  test("explicit picker override: a chapter-only creator CANNOT force Central (FORBIDDEN, event never created)", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");
    const eventTypeId = await seedTemplate(s);

    let caught: unknown;
    try {
      await s.as.mutation(api.events.createFromTemplate, {
        eventTypeId,
        name: "Should not exist",
        eventDate: tsInMonth(2026, 8),
        budget: 500,
        scope: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");

    // The whole mutation rolled back — no half-created event left behind.
    const all = await run(s.t, (ctx) => ctx.db.query("events").collect());
    expect(all.length).toBe(0);
  });

  test("a superuser (implicit central manager) defaults new events to Central", async () => {
    const s = await setupChapter(newT(), { email: SUPER });
    await seedSelfPerson(s);
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Superuser event",
      eventDate: tsInMonth(2026, 8),
      budget: 500,
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe("central");
  });
});

describe("events.get — retroactive attribution + canChangeScope permission matrix", () => {
  test("central reach (bookkeeper+) can change scope in either direction", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");
    const eventTypeId = await seedTemplate(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "E",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.canChangeScope).toBe(true);
  });

  test("a chapter manager (no central grant) sees the row but cannot change it", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");
    const eventTypeId = await seedTemplate(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "E",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.canChangeScope).toBe(false);
    expect(detail?.scope).toBe(s.chapterId); // still readable/visible

    // And the mutation itself refuses a chapter manager, same gate.
    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferEventScope, {
        eventId,
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("a plain roster member (no finance role at all) cannot change it", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const eventTypeId = await seedTemplate(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "E",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.canChangeScope).toBe(false);

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferEventScope, {
        eventId,
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
  });

  test("a central VIEWER (reach without write rank) cannot change it — mirrors the money-write gate", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "viewer", "central");
    const eventTypeId = await seedTemplate(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "E",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferEventScope, {
        eventId,
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("retroactive: transferEventScope works on an EXISTING event (created long before this feature, no scope arg ever passed) and events.get reflects the move", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "central");

    // Simulate a pre-existing event + budget, created before attribution
    // mattered (chapter-scoped, like every legacy row).
    const eventTypeId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Legacy Template",
        slug: `legacy-${Date.now()}`,
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const eventId = await run(s.t, (ctx) =>
      ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Legacy event",
        eventDate: tsInMonth(2025, 1),
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 40000,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "per_instance",
        year: 2025,
        month: 1,
        createdAt: Date.now(),
      }),
    );

    const before = await s.as.query(api.events.get, { eventId });
    expect(before?.scope).toBe(s.chapterId);

    const res = await s.as.mutation(api.finances.transferEventScope, {
      eventId,
      target: "central",
    });
    expect(res.budgetsMoved).toBe(1);
    expect(res.eventScopeDeferred).toBe(true);

    const after = await s.as.query(api.events.get, { eventId });
    expect(after?.scope).toBe("central");
    expect(after?.scopeChapterName).toBeNull();
    // The event row itself is untouched — still home-chapter-scoped.
    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(event?.chapterId).toBe(s.chapterId);
  });

  test("no-budget edge case: transferEventScope no-ops sanely on an event with no budget row (0 moved, one audit row still written)", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "central");
    const eventTypeId = await seedTemplate(s);
    // No `budget` arg + chapter-default scope (no central reach signalled via
    // `scope`) — no budget row gets created at all.
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Bare event",
      eventDate: tsInMonth(2026, 8),
      scope: "chapter",
    })) as Id<"events">;
    expect(await eventBudget(s, eventId)).toBeNull();

    const res = await s.as.mutation(api.finances.transferEventScope, {
      eventId,
      target: "central",
    });
    expect(res.budgetsMoved).toBe(0);
    expect(res.txnsMoved).toBe(0);
    expect(res.eventScopeDeferred).toBe(true);
    expect(res.auditId).toBeDefined();

    // Still reads as "central" going forward — the NEXT budget entered lands
    // there, per `events.get`'s "no budget yet" fallback semantics... except
    // there's genuinely nothing to move, so `scope` still falls back to the
    // event's own chapter (no budget row exists to carry the new scope) —
    // exactly why the creation-time picker path pre-summons a $0 row instead
    // of relying on a bare `transferEventScope` call.
    const after = await s.as.query(api.events.get, { eventId });
    expect(after?.scope).toBe(s.chapterId);
  });

  test("training events never carry a budget row, so transferEventScope no-ops the same way", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "central");
    const eventTypeId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Academy Template",
        slug: `academy-${Date.now()}`,
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const eventId = await run(s.t, (ctx) =>
      ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Training run",
        eventDate: tsInMonth(2026, 8),
        isTraining: true,
        budget: 300,
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.finances.transferEventScope, {
      eventId,
      target: "central",
    });
    expect(res.budgetsMoved).toBe(0);
    expect(res.txnsMoved).toBe(0);
  });
});

describe("end-to-end: Central attribution feeds moneyViews.refMoney (mirrors the #194 review finding for events)", () => {
  test("central bookkeeper, $500 event -> Central, $300 central spend: Money view shows totalActualCents 30000, transactions present, planned 50000", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");
    const eventTypeId = await seedTemplate(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Music Recording Night",
      eventDate: tsInMonth(2026, 8),
      budget: 500,
      scope: "central",
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe("central");
    expect(budget?.amountCents).toBe(50000);

    // $300 of central spend posted against that same budget.
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: "central",
        budgetId: budget!._id,
        source: "manual",
        flow: "outflow",
        amountCents: 30000,
        postedAt: Date.now(),
        status: "categorized",
        createdAt: Date.now(),
      }),
    );

    const money = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(money.totalPlannedCents).toBe(50000);
    expect(money.totalActualCents).toBe(30000);
    expect(money.transactions).toHaveLength(1);
    expect(money.transactions[0].amountCents).toBe(30000);
  });
});
