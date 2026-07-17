/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Project scope attribution — the money-adjacent overlay on top of Projects:
 *
 *  - CREATION DEFAULT ("creator's highest hat", owner spec): a creator with
 *    central (org-wide) finance reach gets a new project's money attributed to
 *    Central by default; a chapter-only creator gets their own chapter. An
 *    explicit `scope` argument (the creation UI's picker) always wins over the
 *    default, in either direction.
 *  - The project ROW never moves off its home chapter — `projects.chapterId`
 *    has no central union (WP-2.2 finding, see `finances.transferProjectScope`'s
 *    doc comment) — so "central" attribution is realized by moving the
 *    project's BUDGET, through the pre-existing `finances.transferProjectScope`
 *    (no second scope-move path was written for this feature).
 *  - RETROACTIVE: `projects.get` exposes the project's current money scope
 *    (`scope`/`scopeChapterName`) plus whether the CALLER may change it
 *    (`canChangeScope`), gated the same way `transferProjectScope` itself is —
 *    central reach, checked through the caller's OWN chapter, both directions.
 */

const SUPER = "seyi@publicworship.life";

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

/** The project's linked one_time budget row, if any (by_ref lookup). */
async function projectBudget(s: ChapterSetup, projectId: Id<"projects">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", "project").eq("scopeRefId", projectId))
      .first(),
  );
}

describe("projects.create — money-attribution default", () => {
  test("a central-seat creator's new (money-bearing) project defaults to Central", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Music Recording",
      budgetUsd: 500,
    })) as Id<"projects">;

    // The project ROW stays in the caller's own chapter (WP-2.2) ...
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.chapterId).toBe(s.chapterId);
    // ... but its budget landed at Central.
    const budget = await projectBudget(s, projectId);
    expect(budget?.chapterId).toBe("central");

    const detail = await s.as.query(api.projects.get, { projectId });
    expect(detail?.scope).toBe("central");
    expect(detail?.scopeChapterName).toBeNull();
  });

  test("a central-seat creator's $0 (work-tracking) project still gets a Central budget row, so a LATER dollar entry stays Central", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Central initiative",
    })) as Id<"projects">;

    const budget = await projectBudget(s, projectId);
    expect(budget).not.toBeNull();
    expect(budget?.chapterId).toBe("central");
    expect(budget?.amountCents).toBe(0);

    // A later dollar entry writes THROUGH to the existing (already-central)
    // row (`setBudgetAmount` only patches `amountCents`) — never re-lands the
    // budget at the chapter.
    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 250 });
    const after = await projectBudget(s, projectId);
    expect(after?._id).toBe(budget?._id);
    expect(after?.chapterId).toBe("central");
    expect(after?.amountCents).toBe(25000);
  });

  test("a chapter-only creator's new project defaults to their chapter (unchanged behavior)", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Local project",
      budgetUsd: 100,
    })) as Id<"projects">;

    const budget = await projectBudget(s, projectId);
    expect(budget?.chapterId).toBe(s.chapterId);

    const detail = await s.as.query(api.projects.get, { projectId });
    expect(detail?.scope).toBe(s.chapterId);
    expect(detail?.scopeChapterName).toBe("New York");
  });

  test("a caller with NO finance role at all defaults to their chapter", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Plain project",
      budgetUsd: 50,
    })) as Id<"projects">;

    const budget = await projectBudget(s, projectId);
    expect(budget?.chapterId).toBe(s.chapterId);
  });

  test("explicit picker override: a central-seat creator can still choose their own chapter", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Chapter-scoped even though I'm central",
      budgetUsd: 500,
      scope: "chapter",
    })) as Id<"projects">;

    const budget = await projectBudget(s, projectId);
    expect(budget?.chapterId).toBe(s.chapterId);
  });

  test("explicit picker override: a chapter-only creator CANNOT force Central (FORBIDDEN, project never created)", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");

    let caught: unknown;
    try {
      await s.as.mutation(api.projects.create, {
        name: "Should not exist",
        budgetUsd: 500,
        scope: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");

    // The whole mutation rolled back — no half-created project left behind.
    const all = await run(s.t, (ctx) => ctx.db.query("projects").collect());
    expect(all.length).toBe(0);
  });

  test("a superuser (implicit central manager) defaults new projects to Central", async () => {
    const s = await setupChapter(newT(), { email: SUPER });
    await seedSelfPerson(s);

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Superuser project",
      budgetUsd: 500,
    })) as Id<"projects">;

    const budget = await projectBudget(s, projectId);
    expect(budget?.chapterId).toBe("central");
  });
});

describe("projects.get — retroactive attribution + canChangeScope permission matrix", () => {
  test("central reach (bookkeeper+) can change scope in either direction", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "P",
    })) as Id<"projects">;

    const detail = await s.as.query(api.projects.get, { projectId });
    expect(detail?.canChangeScope).toBe(true);
  });

  test("a chapter manager (no central grant) sees the row but cannot change it", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "P",
    })) as Id<"projects">;

    const detail = await s.as.query(api.projects.get, { projectId });
    expect(detail?.canChangeScope).toBe(false);
    expect(detail?.scope).toBe(s.chapterId); // still readable/visible

    // And the mutation itself refuses a chapter manager, same gate.
    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferProjectScope, {
        projectId,
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
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "P",
    })) as Id<"projects">;

    const detail = await s.as.query(api.projects.get, { projectId });
    expect(detail?.canChangeScope).toBe(false);

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferProjectScope, {
        projectId,
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
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "P",
    })) as Id<"projects">;

    // Reach alone (central, but viewer rank) still fails the WRITE gate.
    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferProjectScope, {
        projectId,
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("retroactive: transferProjectScope works on an EXISTING project (created long before this feature, no scope arg ever passed) and projects.get reflects the move", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "central");

    // Simulate a pre-existing project + budget, created before attribution
    // mattered (chapter-scoped, like every legacy row).
    const projectId = await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Legacy project",
        status: "in_progress",
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
        refKind: "project",
        scopeRefId: projectId,
        cadence: "per_instance",
        year: 2025,
        month: 1,
        createdAt: Date.now(),
      }),
    );

    const before = await s.as.query(api.projects.get, { projectId });
    expect(before?.scope).toBe(s.chapterId);

    const res = await s.as.mutation(api.finances.transferProjectScope, {
      projectId,
      target: "central",
    });
    expect(res.budgetsMoved).toBe(1);

    const after = await s.as.query(api.projects.get, { projectId });
    expect(after?.scope).toBe("central");
    expect(after?.scopeChapterName).toBeNull();
    // The project row itself is untouched — still home-chapter-scoped.
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.chapterId).toBe(s.chapterId);
  });
});
