import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { ReimbursementStatus } from "@events-os/shared";

/**
 * Deleting an event/project settles its reimbursements first.
 *
 * `reimbursementRequests.eventId` was the last dangling FK on the money side
 * after the budget cascade landed. The harm was quiet rather than loud:
 * `forLabel` resolves the ref LIVE and returns `null` the moment it's gone —
 * returning EARLY, so it doesn't even fall through to `budgetId` — so deleting
 * an old event blanked the "For" column on every reimbursement that named it,
 * with nothing left to say it ever had one.
 *
 * Two different answers for two different situations, which is the whole point:
 * money still in flight BLOCKS the deletion, because an approver would
 * otherwise be handed a blank reason on money they have to decide about.
 * Settled money doesn't block — that would let the ledger pin the calendar
 * forever — but its "For" is preserved in words instead of a dead pointer.
 */

/** `reimbursements.get` gates on at least viewer rank. */
async function grantFinanceViewer(s: ChapterSetup): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "viewer",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedEvent(s: ChapterSetup, name: string): Promise<Id<"events">> {
  const eventTypeId = await run(s.t, (ctx) =>
    ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "T",
      slug: "t",
      version: 1,
      isArchived: false,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return await run(s.t, (ctx) =>
    ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedReimbursement(
  s: ChapterSetup,
  opts: {
    status: ReimbursementStatus;
    totalCents: number;
    payeeName?: string;
    eventId?: Id<"events">;
    projectId?: Id<"projects">;
  },
): Promise<Id<"reimbursementRequests">> {
  const requestId = await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: `tok-${opts.status}-${opts.totalCents}`,
      status: opts.status,
      payeeName: opts.payeeName ?? "Josh Adriano",
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      totalCents: opts.totalCents,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementLineItems", {
      chapterId: s.chapterId,
      reimbursementId: requestId,
      description: "Recap video",
      amountCents: opts.totalCents,
      order: 0,
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      createdAt: Date.now(),
    }),
  );
  return requestId;
}

describe("money still in flight blocks the deletion", () => {
  // `failed` is deliberately in here: a failed payout can be retried, so it is
  // NOT in REIMBURSEMENT_TERMINAL_STATUSES and that money is still live.
  const LIVE: ReimbursementStatus[] = [
    "pending_preapproval",
    "preapproved",
    "submitted",
    "changes_requested",
    "approved",
    "paying",
    "failed",
  ];

  for (const status of LIVE) {
    test(`a "${status}" reimbursement refuses the event delete`, async () => {
      const s = await setupChapter(newT());
      const eventId = await seedEvent(s, "Love Thy Neighbor 2025");
      await seedReimbursement(s, { status, totalCents: 4064, eventId });

      const err = await s.as
        .mutation(api.events.remove, { eventId })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConvexError);
      const data = (err as ConvexError<{ code: string; message: string }>).data;
      expect(data.code).toBe("REIMBURSEMENT_IN_FLIGHT");
      expect(data.message).toContain("Josh Adriano");
      expect(data.message).toContain("$40.64");
      // The event survives the refusal.
      expect(await run(s.t, (ctx) => ctx.db.get(eventId))).not.toBeNull();
    });
  }

  test("the refusal names the count and total when several are in flight", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Love Thy Neighbor 2025");
    await seedReimbursement(s, { status: "submitted", totalCents: 4064, eventId });
    await seedReimbursement(s, {
      status: "approved",
      totalCents: 11060,
      payeeName: "Idara",
      eventId,
    });

    const err = await s.as
      .mutation(api.events.remove, { eventId })
      .catch((e: unknown) => e);

    const msg = (err as ConvexError<{ message: string }>).data.message;
    expect(msg).toContain("2 reimbursements");
    expect(msg).toContain("$151.24");
  });
});

describe("settled money doesn't block, and keeps its answer", () => {
  for (const status of ["paid", "rejected", "canceled"] as ReimbursementStatus[]) {
    test(`a "${status}" reimbursement is unlinked, and "For" still reads the event name`, async () => {
      const s = await setupChapter(newT());
      const eventId = await seedEvent(s, "Love Thy Neighbor 2025");
      const requestId = await seedReimbursement(s, {
        status,
        totalCents: 11060,
        eventId,
      });

      await s.as.mutation(api.events.remove, { eventId });

      const request = await run(s.t, (ctx) => ctx.db.get(requestId));
      expect(request).not.toBeNull();
      // The dead pointer is gone…
      expect(request!.eventId).toBeUndefined();
      // …and the answer it used to resolve to is not.
      expect(request!.forLabelSnapshot).toBe("Love Thy Neighbor 2025");
    });
  }

  test("the line items are released too", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Love Thy Neighbor 2025");
    const requestId = await seedReimbursement(s, {
      status: "paid",
      totalCents: 11060,
      eventId,
    });

    await s.as.mutation(api.events.remove, { eventId });

    const lines = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementLineItems")
        .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", requestId))
        .collect(),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].eventId).toBeUndefined();
  });

  test("an existing snapshot is never clobbered — the older answer is the truer one", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Second Event");
    const requestId = await seedReimbursement(s, {
      status: "paid",
      totalCents: 11060,
      eventId,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(requestId, { forLabelSnapshot: "The Original Event" }),
    );

    await s.as.mutation(api.events.remove, { eventId });

    const request = await run(s.t, (ctx) => ctx.db.get(requestId));
    expect(request!.forLabelSnapshot).toBe("The Original Event");
  });

  test("a live ref still wins over the snapshot — a rename shows through", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Renamed Later");
    const requestId = await seedReimbursement(s, {
      status: "paid",
      totalCents: 11060,
      eventId,
    });
    // A stale snapshot sitting beside a LIVE ref must not shadow it.
    await run(s.t, (ctx) => ctx.db.patch(requestId, { forLabelSnapshot: "Stale" }));

    await grantFinanceViewer(s);
    const row = await s.as.query(api.reimbursements.get, {
      reimbursementId: requestId,
    });
    expect(row.forLabel).toBe("Renamed Later");
  });
});

describe("projects get the same treatment", () => {
  async function seedProject(s: ChapterSetup, name: string): Promise<Id<"projects">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name,
        status: "in_progress",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("an in-flight reimbursement refuses the project delete", async () => {
    const s = await setupChapter(newT());
    const projectId = await seedProject(s, "Sponsorship package");
    await seedReimbursement(s, { status: "submitted", totalCents: 4064, projectId });

    const err = await s.as
      .mutation(api.projects.remove, { projectId })
      .catch((e: unknown) => e);

    expect((err as ConvexError<{ code: string }>).data.code).toBe(
      "REIMBURSEMENT_IN_FLIGHT",
    );
    expect(await run(s.t, (ctx) => ctx.db.get(projectId))).not.toBeNull();
  });

  test("a settled one is unlinked and snapshotted", async () => {
    const s = await setupChapter(newT());
    const projectId = await seedProject(s, "Sponsorship package");
    const requestId = await seedReimbursement(s, {
      status: "paid",
      totalCents: 4064,
      projectId,
    });

    await s.as.mutation(api.projects.remove, { projectId });

    const request = await run(s.t, (ctx) => ctx.db.get(requestId));
    expect(request!.projectId).toBeUndefined();
    expect(request!.forLabelSnapshot).toBe("Sponsorship package");
  });
});

describe("the ordinary case is untouched", () => {
  test("an event with no reimbursements deletes as before", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Nothing owed");

    await s.as.mutation(api.events.remove, { eventId });

    expect(await run(s.t, (ctx) => ctx.db.get(eventId))).toBeNull();
  });

  test("a reimbursement pointing at a DIFFERENT event is left alone", async () => {
    const s = await setupChapter(newT());
    const doomed = await seedEvent(s, "Doomed");
    const other = await seedEvent(s, "Other");
    const requestId = await seedReimbursement(s, {
      status: "submitted",
      totalCents: 4064,
      eventId: other,
    });

    await s.as.mutation(api.events.remove, { eventId: doomed });

    const request = await run(s.t, (ctx) => ctx.db.get(requestId));
    expect(request!.eventId).toBe(other);
    expect(request!.forLabelSnapshot).toBeUndefined();
  });
});
