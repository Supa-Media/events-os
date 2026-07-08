import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";

/**
 * `profiles.reconcileMyPerson` — the login-time roster reconciler.
 *
 * A person can end up with several `people` rows for one human (imported twice,
 * or imported after they'd already self-created a row). Their work then splits
 * across those rows, so when they sign in on the account-linked row they see
 * only part of "their tasks". Reconcile must collapse the rows into one and
 * carry every reference over so nothing is lost.
 */
describe("profiles.reconcileMyPerson", () => {
  test("merges duplicate roster rows and re-points their tasks onto one survivor", async () => {
    const t = newT();
    const { as, userId, chapterId, email } = await setupChapter(t);

    // Two UNLINKED rows for the same human (both carry the login pwEmail), plus
    // a report and tasks attached to the NEWER duplicate — the survivor is the
    // older row, so everything here must move onto it.
    const { dupOld, dupNew, projectId, dutyId, checkInId, reportId } = await run(
      t,
      async (ctx) => {
        const dupOld = await ctx.db.insert("people", {
          chapterId,
          name: "Jamie",
          pwEmail: email,
          createdAt: 1,
        });
        const dupNew = await ctx.db.insert("people", {
          chapterId,
          name: "Jamie R.",
          pwEmail: email,
          phone: "+15555551234", // only the newer row has a phone
          skills: ["audio"],
          createdAt: 2,
        });
        const projectId = await ctx.db.insert("projects", {
          chapterId,
          name: "Easter production",
          status: "in_progress",
          ownerPersonId: dupNew,
          createdBy: userId,
          createdAt: 1,
          updatedAt: 1,
        });
        const dutyId = await ctx.db.insert("responsibilities", {
          chapterId,
          title: "Run sound check",
          cadence: "weekly",
          assigneePersonIds: [dupNew],
          createdBy: userId,
          createdAt: 1,
          updatedAt: 1,
        });
        // Someone reports to the newer duplicate — their manager edge must move.
        const reportId = await ctx.db.insert("people", {
          chapterId,
          name: "Direct report",
          email: "report@example.com",
          managerId: dupNew,
          createdAt: 3,
        });
        const checkInId = await ctx.db.insert("checkIns", {
          chapterId,
          personId: reportId,
          managerPersonId: dupNew,
          type: "checkin",
          createdBy: userId,
          createdAt: 1,
        });
        return { dupOld, dupNew, projectId, dutyId, checkInId, reportId };
      },
    );

    const result = await as.mutation(api.profiles.reconcileMyPerson, {});
    expect(result.ok).toBe(true);
    // The survivor is the older row, now claimed for this account.
    expect(result.ok && result.personId).toBe(dupOld);

    const state = await run(t, async (ctx) => {
      const rows = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .collect();
      return {
        survivor: await ctx.db.get(dupOld),
        gone: await ctx.db.get(dupNew),
        matching: rows.filter((p) => p.pwEmail === email),
        project: await ctx.db.get(projectId),
        duty: await ctx.db.get(dutyId),
        checkIn: await ctx.db.get(checkInId),
        report: await ctx.db.get(reportId),
      };
    });

    // Exactly one roster row for the human, linked to the account.
    expect(state.gone).toBeNull();
    expect(state.matching).toHaveLength(1);
    expect(state.survivor!._id).toBe(dupOld);
    expect(state.survivor!.userId).toBe(userId);
    expect(state.survivor!.isTeamMember).toBe(true);
    // Missing fields were carried over from the merged duplicate.
    expect(state.survivor!.phone).toBe("+15555551234");
    expect(state.survivor!.skills).toEqual(["audio"]);

    // Every reference now points at the survivor — no orphaned tasks.
    expect(state.project!.ownerPersonId).toBe(dupOld);
    expect(state.duty!.assigneePersonIds).toEqual([dupOld]);
    expect(state.checkIn!.managerPersonId).toBe(dupOld);
    expect(state.report!.managerId).toBe(dupOld);
  });

  test("creates a linked roster row when the account has none yet", async () => {
    const t = newT();
    const { as, userId, chapterId, email } = await setupChapter(t);

    const result = await as.mutation(api.profiles.reconcileMyPerson, {});
    expect(result.ok).toBe(true);

    const rows = await run(t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].pwEmail).toBe(email);
    expect(rows[0].isTeamMember).toBe(true);
    expect(result.ok && result.personId).toBe(rows[0]._id);
  });

  test("claims a single pre-imported row without duplicating it", async () => {
    const t = newT();
    const { as, userId, chapterId, email } = await setupChapter(t);

    const { personId, projectId } = await run(t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId,
        name: "Imported core team",
        pwEmail: email,
        createdAt: 1,
      });
      const projectId = await ctx.db.insert("projects", {
        chapterId,
        name: "Onboarding revamp",
        status: "not_started",
        ownerPersonId: personId,
        createdBy: userId,
        createdAt: 1,
        updatedAt: 1,
      });
      return { personId, projectId };
    });

    await as.mutation(api.profiles.reconcileMyPerson, {});

    const state = await run(t, async (ctx) => ({
      rows: await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .collect(),
      person: await ctx.db.get(personId),
      project: await ctx.db.get(projectId),
    }));

    // Same row, now claimed — not a second row — and its task is untouched.
    expect(state.rows).toHaveLength(1);
    expect(state.person!._id).toBe(personId);
    expect(state.person!.userId).toBe(userId);
    expect(state.project!.ownerPersonId).toBe(personId);
  });

  test("does not merge a row linked to a different account", async () => {
    const t = newT();
    const { as, userId, chapterId, email } = await setupChapter(t);

    // A different human happens to share the pwEmail but is linked to their own
    // account — must be left completely alone.
    const otherUserId = await run(t, (ctx) =>
      ctx.db.insert("users", { email: "someone-else@publicworship.life" }),
    );
    const otherRow = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId,
        name: "Not me",
        pwEmail: email,
        userId: otherUserId as Id<"users">,
        createdAt: 1,
      }),
    );

    const result = await as.mutation(api.profiles.reconcileMyPerson, {});
    expect(result.ok).toBe(true);

    const state = await run(t, async (ctx) => ({
      other: await ctx.db.get(otherRow),
      mine: result.ok ? await ctx.db.get(result.personId) : null,
    }));

    // The other account's row is untouched; a fresh row was made for this user.
    expect(state.other!.userId).toBe(otherUserId);
    expect(state.mine!.userId).toBe(userId);
    expect(state.mine!._id).not.toBe(otherRow);
  });
});
