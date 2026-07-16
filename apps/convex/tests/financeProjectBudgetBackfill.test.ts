/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `backfillProjectBudgets` (internal, no-auth) + the `projects.create`
 * create-time hook (WP-3.4): give every PROJECT a one_time budget so it
 * appears in the finance dashboard's "Events & Projects" section and charges
 * can roll up per project. Mirrors `financeEventBudgetBackfill.test.ts`.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

/** A timestamp on a specific Eastern calendar day (17:00 UTC = early PM ET). */
function tsOnDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 17, 0, 0);
}

/**
 * Seed a project directly via `ctx.db.insert` (bypassing `projects.create` and
 * its create-time budget hook) — simulating a project that pre-dates WP-3.4,
 * exactly like `financeEventBudgetBackfill.test.ts`'s `seedEvent` bypasses
 * `events.createFromTemplate`.
 */
async function seedProject(
  s: ChapterSetup,
  opts: {
    name?: string;
    startDate?: number;
    budgetUsd?: number;
  } = {},
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name: opts.name ?? "Music Recording",
      status: "not_started",
      startDate: opts.startDate,
      budgetUsd: opts.budgetUsd,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** The budgets that exist for a chapter attached to `refId`, with linked tag kinds. */
async function budgetsFor(s: ChapterSetup, refId: string) {
  return await run(s.t, async (ctx) => {
    const rows = (
      await ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect()
    ).filter((b) => b.scopeRefId === refId);
    const withTags = [];
    for (const b of rows) {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .collect();
      const kinds: string[] = [];
      const names: string[] = [];
      for (const l of links) {
        const tag = await ctx.db.get(l.tagId);
        if (tag) {
          kinds.push(tag.kind ?? "");
          names.push(tag.name);
        }
      }
      withTags.push({ budget: b, tagKinds: kinds.sort(), tagNames: names.sort() });
    }
    return withTags;
  });
}

describe("backfillProjectBudgets (internal)", () => {
  test("creates a one_time project budget with the right refs, dating, and tags", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, {
      startDate: tsInMonth(2026, 5),
      budgetUsd: 400,
    });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.tagsLinked).toBe(1); // catch-all "Projects" tag only

    const [row] = await budgetsFor(s, projectId);
    expect(row.budget.type).toBe("one_time");
    expect(row.budget.refKind).toBe("project");
    expect(row.budget.scopeRefId).toBe(projectId);
    expect(row.budget.cadence).toBe("per_instance");
    expect(row.budget.chapterId).toBe(s.chapterId);
    // budgetUsd × 100 → integer cents; year/month from startDate (Eastern).
    expect(row.budget.amountCents).toBe(40000);
    expect(Number.isInteger(row.budget.amountCents)).toBe(true);
    expect(row.budget.year).toBe(2026);
    expect(row.budget.month).toBe(5);
    // Auto-tagged with the catch-all "Projects" tag (kind:"custom" — no
    // dedicated tag kind, per WP-3.4's "no new tag investment").
    expect(row.tagKinds).toEqual(["custom"]);
    expect(row.tagNames).toEqual(["Projects"]);
  });

  test("owner rule: skips a project with no budgetUsd — no budget object at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, { budgetUsd: undefined });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);

    expect(await budgetsFor(s, projectId)).toEqual([]);
  });

  test("owner rule: skips a project with budgetUsd 0 or negative — no budget object", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const zeroId = await seedProject(s, { name: "Zero Budget", budgetUsd: 0 });
    const negId = await seedProject(s, { name: "Negative Budget", budgetUsd: -50 });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);

    expect(await budgetsFor(s, zeroId)).toEqual([]);
    expect(await budgetsFor(s, negId)).toEqual([]);
  });

  test("falls back to createdAt for year/month when startDate is unset", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "No Start Date",
        status: "not_started",
        budgetUsd: 150,
        createdBy: s.userId,
        createdAt: tsInMonth(2026, 9),
        updatedAt: tsInMonth(2026, 9),
      }),
    );

    await t.mutation(internal.finances.backfillProjectBudgets, {});
    const [row] = await budgetsFor(s, projectId);
    expect(row.budget.year).toBe(2026);
    expect(row.budget.month).toBe(9);
  });

  test("is idempotent — a second run creates nothing and skips the project", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedProject(s, { budgetUsd: 100 });

    const first = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(first.created).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.tagsLinked).toBe(0);

    // Exactly one budget for the project — no duplicate.
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(1);
  });

  test("skips a project that already has a budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, { budgetUsd: 250 });

    // A pre-existing budget attached to the project (simulating one created
    // via `createBudget` or a previous hook run).
    await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 25000,
        type: "one_time",
        refKind: "project",
        scopeRefId: projectId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.filter((b) => b.scopeRefId === projectId).length).toBe(1);
  });

  test("scopes to a single chapter when chapterId is passed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, { budgetUsd: 100 });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {
      chapterId: s.chapterId,
    });
    expect(result.created).toBe(1);
    expect((await budgetsFor(s, projectId)).length).toBe(1);
  });

  test("names a created project budget after its project (unique name → bare name)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, { name: "Summer Merch", budgetUsd: 100 });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(1);
    expect(result.relabeled).toBe(0);

    const [row] = await budgetsFor(s, projectId);
    expect(row.budget.label).toBe("Summer Merch");
  });

  test("same name in DIFFERENT months → each budget's label is suffixed with month + year", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const marId = await seedProject(s, {
      name: "Field Recording",
      startDate: tsInMonth(2026, 3),
      budgetUsd: 100,
    });
    const aprId = await seedProject(s, {
      name: "Field Recording",
      startDate: tsInMonth(2026, 4),
      budgetUsd: 100,
    });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(2);

    const [marRow] = await budgetsFor(s, marId);
    const [aprRow] = await budgetsFor(s, aprId);
    expect(marRow.budget.label).toBe("Field Recording · March 2026");
    expect(aprRow.budget.label).toBe("Field Recording · April 2026");
  });

  test("same name in the SAME month → each budget's label is suffixed with the full date", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const firstId = await seedProject(s, {
      name: "Field Recording",
      startDate: tsOnDay(2026, 3, 15),
      budgetUsd: 100,
    });
    const secondId = await seedProject(s, {
      name: "Field Recording",
      startDate: tsOnDay(2026, 3, 22),
      budgetUsd: 100,
    });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(2);

    const [firstRow] = await budgetsFor(s, firstId);
    const [secondRow] = await budgetsFor(s, secondId);
    expect(firstRow.budget.label).toBe("Field Recording · Mar 15, 2026");
    expect(secondRow.budget.label).toBe("Field Recording · Mar 22, 2026");
  });

  test("re-run relabels an existing UNLABELED project budget; a labeled one is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const unlabeledProjectId = await seedProject(s, {
      name: "Fall Campaign",
      budgetUsd: 100,
    });
    const labeledProjectId = await seedProject(s, {
      name: "Winter Campaign",
      budgetUsd: 200,
    });

    // Simulate pre-fix budgets: one created WITHOUT a label, one already
    // carrying a custom label.
    const { unlabeledBudgetId, labeledBudgetId } = await run(s.t, async (ctx) => {
      const unlabeledBudgetId = await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10000,
        type: "one_time",
        refKind: "project",
        scopeRefId: unlabeledProjectId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      });
      const labeledBudgetId = await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 20000,
        label: "Hand-picked name",
        type: "one_time",
        refKind: "project",
        scopeRefId: labeledProjectId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      });
      return { unlabeledBudgetId, labeledBudgetId };
    });

    const result = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.relabeled).toBe(1);

    const { unlabeled, labeled } = await run(s.t, async (ctx) => ({
      unlabeled: await ctx.db.get(unlabeledBudgetId),
      labeled: await ctx.db.get(labeledBudgetId),
    }));
    expect(unlabeled?.label).toBe("Fall Campaign");
    expect(labeled?.label).toBe("Hand-picked name");

    // A settled re-run relabels nothing.
    const second = await t.mutation(internal.finances.backfillProjectBudgets, {});
    expect(second.relabeled).toBe(0);
  });
});

describe("projects.create: auto-creates a one_time budget (WP-3.4 create-time hook)", () => {
  test("creating a project immediately gives it a matching one_time budget", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Merch Drop",
      budgetUsd: 500,
    })) as Id<"projects">;

    const [row] = await budgetsFor(s, projectId);
    expect(row).toBeDefined();
    expect(row.budget.type).toBe("one_time");
    expect(row.budget.refKind).toBe("project");
    expect(row.budget.scopeRefId).toBe(projectId);
    expect(row.budget.cadence).toBe("per_instance");
    expect(row.budget.chapterId).toBe(s.chapterId);
    expect(row.budget.amountCents).toBe(50000);
    expect(row.budget.label).toBe("Merch Drop");
    expect(row.tagKinds).toEqual(["custom"]);
    expect(row.tagNames).toEqual(["Projects"]);
  });

  test("owner rule: no budgetUsd given → no budget object at all (work-tracking-only project)", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "TBD Project",
    })) as Id<"projects">;

    expect(await budgetsFor(s, projectId)).toEqual([]);
  });

  test("owner rule: budgetUsd 0 or negative → no budget object", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const zeroId = (await s.as.mutation(api.projects.create, {
      name: "Zero Dollar",
      budgetUsd: 0,
    })) as Id<"projects">;
    const negId = (await s.as.mutation(api.projects.create, {
      name: "Negative Dollar",
      budgetUsd: -100,
    })) as Id<"projects">;

    expect(await budgetsFor(s, zeroId)).toEqual([]);
    expect(await budgetsFor(s, negId)).toEqual([]);
  });

  test("a plain member (no admin, no finance role) creates a project: positive budget summons a budget, $0 does not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A non-admin roster member, linked to a `people` row so `requireProjectEditor`
    // accepts them without falling back to admin rights.
    const memberUserId = await run(s.t, async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "member@publicworship.life" });
      await ctx.db.insert("userChapters", {
        userId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      });
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        userId,
        name: "Plain Member",
        status: "active",
        isTeamMember: true,
        createdAt: Date.now(),
      });
      return userId;
    });
    const asMember = s.t.withIdentity({ subject: `${memberUserId}|session`, issuer: "test" });

    const fundedId = (await asMember.mutation(api.projects.create, {
      name: "Member-Funded Project",
      budgetUsd: 300,
    })) as Id<"projects">;
    const [row] = await budgetsFor(s, fundedId);
    expect(row).toBeDefined();
    expect(row.budget.amountCents).toBe(30000);

    const freeId = (await asMember.mutation(api.projects.create, {
      name: "Member Work-Tracking Project",
      budgetUsd: 0,
    })) as Id<"projects">;
    expect(await budgetsFor(s, freeId)).toEqual([]);
  });

  test("rounds a fractional budgetUsd to the nearest integer cent", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Rounded Budget",
      budgetUsd: 12.345,
    })) as Id<"projects">;

    const [row] = await budgetsFor(s, projectId);
    expect(row.budget.amountCents).toBe(1235); // 1234.5 rounded
    expect(Number.isInteger(row.budget.amountCents)).toBe(true);
  });

  test("the project's own budgetUsd is left untouched (Estimated-vs-Actual invariant)", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Untouched Estimate",
      budgetUsd: 777,
    })) as Id<"projects">;

    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(777);
  });

  test("a later same-named sibling gets disambiguated (the earlier one isn't retroactively relabeled)", async () => {
    // Like `createBudget`'s single-item label defaulting for events, the
    // create-time hook only sees siblings that exist AT THAT MOMENT — it
    // doesn't retroactively relabel an earlier budget when a new same-named
    // sibling shows up later. (The backfill, which batches over every
    // project at once, is what makes both ends symmetric — see the
    // "same name in DIFFERENT months" backfill test above.)
    const t = newT();
    const s = await setupChapter(t);

    const marId = (await s.as.mutation(api.projects.create, {
      name: "Recurring Effort",
      startDate: tsInMonth(2026, 3),
      budgetUsd: 100,
    })) as Id<"projects">;
    const aprId = (await s.as.mutation(api.projects.create, {
      name: "Recurring Effort",
      startDate: tsInMonth(2026, 4),
      budgetUsd: 100,
    })) as Id<"projects">;

    const [marRow] = await budgetsFor(s, marId);
    const [aprRow] = await budgetsFor(s, aprId);
    expect(marRow.budget.label).toBe("Recurring Effort"); // unique at its own creation time
    expect(aprRow.budget.label).toBe("Recurring Effort · April 2026"); // sees the March sibling
  });

  test("a sub-project (parentProjectId set) gets its own budget independent of its parent", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Parent is work-tracking-only (no budgetUsd) — owner rule: no budget.
    const parentId = (await s.as.mutation(api.projects.create, {
      name: "Parent Effort",
    })) as Id<"projects">;
    const childId = (await s.as.mutation(api.projects.create, {
      name: "Child Effort",
      parentProjectId: parentId,
      budgetUsd: 50,
    })) as Id<"projects">;

    expect(await budgetsFor(s, parentId)).toEqual([]);
    const [childRow] = await budgetsFor(s, childId);
    expect(childRow.budget.amountCents).toBe(5000);
  });
});

describe("projects.update: edit-path trigger summons a budget on 0 → positive budgetUsd", () => {
  test("editing a work-tracking-only project to a positive budgetUsd summons its budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Starts Free",
    })) as Id<"projects">;
    expect(await budgetsFor(s, projectId)).toEqual([]);

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 400 });

    const [row] = await budgetsFor(s, projectId);
    expect(row).toBeDefined();
    expect(row.budget.type).toBe("one_time");
    expect(row.budget.refKind).toBe("project");
    expect(row.budget.amountCents).toBe(40000);
    expect(row.budget.label).toBe("Starts Free");
    expect(row.tagNames).toEqual(["Projects"]);
  });

  test("raising budgetUsd from 0 to positive also summons the budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Starts At Zero",
      budgetUsd: 0,
    })) as Id<"projects">;
    expect(await budgetsFor(s, projectId)).toEqual([]);

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 250 });

    const [row] = await budgetsFor(s, projectId);
    expect(row.budget.amountCents).toBe(25000);
  });

  test("clearing budgetUsd back to null never deletes an existing budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Funded Then Cleared",
      budgetUsd: 100,
    })) as Id<"projects">;
    expect((await budgetsFor(s, projectId)).length).toBe(1);

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: null });

    // The budget object stays (money already tracked against it doesn't
    // vanish); only the project's own `budgetUsd` estimate is cleared.
    expect((await budgetsFor(s, projectId)).length).toBe(1);
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBeUndefined();
  });

  test("does not create a duplicate budget when one already exists (by_ref check) — WP-U2: the edit writes THROUGH to the existing row instead", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Pre-existing Budget",
    })) as Id<"projects">;
    // Simulate a project that pre-dates the owner rule: a zero-amount budget
    // already attached, seeded directly (bypassing the create hook).
    await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 0,
        type: "one_time",
        refKind: "project",
        scopeRefId: projectId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 500 });

    const rows = await budgetsFor(s, projectId);
    expect(rows.length).toBe(1); // no duplicate created
    // WP-U2: the budgets row is the single source of truth — the edit writes
    // THROUGH to the pre-existing row instead of leaving it untouched.
    expect(rows[0].budget.amountCents).toBe(50000);
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(500); // mirrored back onto the entity field
  });

  test("editing an already-funded project's amount writes through to the row (WP-U2) instead of re-triggering the create hook", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Already Funded",
      budgetUsd: 100,
    })) as Id<"projects">;
    expect((await budgetsFor(s, projectId)).length).toBe(1);

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 200 });

    // Still exactly one budget — the original from the create hook, not
    // re-summoned or duplicated (the transition guard is old ≤ 0 → new > 0) —
    // but WP-U2 now writes the new amount THROUGH to that row (the row is
    // the single source of truth), and mirrors it back onto the entity field.
    const rows = await budgetsFor(s, projectId);
    expect(rows.length).toBe(1);
    expect(rows[0].budget.amountCents).toBe(20000);
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(200);
  });
});
