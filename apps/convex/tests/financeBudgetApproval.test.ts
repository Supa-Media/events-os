/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-3.2: budget approval workflow tests.
 *
 * Covers: the draft → submitted → approved | changes_requested state machine,
 * separation of duties at both scopes (chapter manager / central ED-FM), the
 * increase-retrigger rule (`setBudgetAmount`'s auto-resubmit + preserved
 * `approvedCents` cap), grandfathered legacy budgets staying inert, the
 * over-cap cap resolution (`budgetVsActual.approvedCapCents`), and the
 * chapter + central "awaiting approval" queue counts.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/** A chapter-scoped manager (person + manager grant). */
async function asChapterManager(s: ChapterSetup, name = "Manager"): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, name);
  await grantRole(s, personId, "manager", "chapter");
  return personId;
}

/** Add a SECOND authenticated member to the same chapter as `s`, with their
 *  own `users`/`userChapters`/`people` rows — mirrors `reimbursements.test.ts`'s
 *  helper of the same shape. */
async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  userId: Id<"users">;
  personId: Id<"people">;
}> {
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email: opts.email }));
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, personId };
}

/** Grant a specialized central title (executive_director | finance_manager)
 *  to a person by inserting the row directly — the mutation itself is
 *  superuser-gated and irrelevant to what's under test here. */
async function grantCentralTitle(
  s: ChapterSetup,
  personId: Id<"people">,
  title: "executive_director" | "finance_manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope: "central",
      title,
      roleKind: title === "executive_director" ? "leadership" : "finance",
      createdAt: Date.now(),
    }),
  );
}

/** Create a chapter budget as a manager, returning its id. */
async function createChapterBudget(
  s: ChapterSetup,
  amountCents: number,
  year = 2026,
): Promise<Id<"budgets">> {
  return s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "yearly",
    year,
    label: "Ops",
  });
}

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return run(s.t, (ctx) => ctx.db.get(budgetId));
}

describe("state machine: submit / approve / request changes", () => {
  test("draft → submitted → approved sets approvedCents + approvedBy/At", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitter = await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 100000);

    let doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("draft");

    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
    expect(doc?.submittedByPersonId).toBe(submitter);
    expect(doc?.submittedAt).toBeTypeOf("number");

    // A DIFFERENT manager approves (SoD — see the dedicated describe below).
    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId, note: "Looks good" });

    doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedCents).toBe(100000);
    expect(doc?.approvedByPersonId).toBe(approver.personId);
    expect(doc?.approvedAt).toBeTypeOf("number");
    expect(doc?.reviewNote).toBe("Looks good");
  });

  test("submitted → changes_requested, then resubmit → submitted again", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 50000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.requestBudgetChanges, {
      budgetId,
      note: "Break out the line items first",
    });

    let doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("changes_requested");
    expect(doc?.reviewNote).toBe("Break out the line items first");

    // The editor resubmits.
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
  });

  test("illegal transitions are rejected: submit an already-submitted budget, approve a draft", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await createChapterBudget(s, 50000);

    // Approving straight from draft is illegal (must be submitted first).
    await expect(
      s.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);

    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    // Submitting an already-submitted budget is illegal.
    await expect(
      s.as.mutation(api.finances.submitBudgetForApproval, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a bookkeeper (not manager) can submit, but cannot approve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s, "Manager"); // creates the budget (manager-only create)
    const budgetId = await createChapterBudget(s, 50000);

    const bookkeeper = await addMember(s, { email: "bk@publicworship.life", name: "BK" });
    await grantRole(s, bookkeeper.personId, "bookkeeper", "chapter");
    await bookkeeper.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");

    // The same bookkeeper cannot approve (needs manager rank).
    await expect(
      bookkeeper.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("separation of duties — both scopes", () => {
  test("chapter: the submitter cannot approve their own submission", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s, "Self");
    const budgetId = await createChapterBudget(s, 75000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    await expect(
      s.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.finances.requestBudgetChanges, { budgetId, note: "no" }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Still submitted — self-approval attempt didn't mutate state.
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
  });

  test("chapter: a DIFFERENT manager can approve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 75000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const other = await addMember(s, { email: "other@publicworship.life", name: "Other" });
    await grantRole(s, other.personId, "manager", "chapter");
    await other.as.mutation(api.finances.approveBudget, { budgetId });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
  });

  test("central: the ED cannot approve their own submission; the FM can", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // The caller (ED) needs central bookkeeper+ reach to SUBMIT, plus the
    // executive_director title to approve OTHER people's submissions.
    const edPerson = await seedSelfPerson(s, "ED");
    await grantRole(s, edPerson, "bookkeeper", "central");
    await grantCentralTitle(s, edPerson, "executive_director");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Central Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    // Self-approve as the ED (also the submitter) is forbidden.
    await expect(
      s.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);

    // A DIFFERENT person holding the finance_manager central title approves.
    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await grantCentralTitle(s, fm.personId, "finance_manager");
    await fm.as.mutation(api.finances.approveBudget, { budgetId });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(fm.personId);
  });

  test("central: a plain central finance manager WITHOUT the ED/FM title cannot approve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const edPerson = await seedSelfPerson(s, "ED");
    await grantRole(s, edPerson, "bookkeeper", "central");
    await grantCentralTitle(s, edPerson, "executive_director");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    // A central "manager" grant with NO specialized title is not enough.
    const plainCentral = await addMember(s, { email: "plain@publicworship.life", name: "Plain" });
    await grantRole(s, plainCentral.personId, "manager", "central");
    await expect(
      plainCentral.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("the increase-retrigger rule", () => {
  async function approvedChapterBudget(s: ChapterSetup, amountCents: number) {
    const submitter = await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, amountCents);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId });
    return { budgetId, submitter, approver };
  }

  test("an amount INCREASE past the approved cap auto-resubmits; approvedCents is preserved", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { budgetId, submitter } = await approvedChapterBudget(s, 100000);

    let doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedCents).toBe(100000);

    // `s.as` (the original submitter) is the one editing the amount here.
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 150000 },
    });
    doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
    expect(doc?.amountCents).toBe(150000);
    // The OLD cap survives untouched while the increase is pending.
    expect(doc?.approvedCents).toBe(100000);
    // The auto-resubmit stamps the EDITOR making this change as the submitter.
    expect(doc?.submittedByPersonId).toBe(submitter);
  });

  test("a DECREASE never retriggers — status + approvedCents stay put", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { budgetId } = await approvedChapterBudget(s, 100000);

    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 40000 },
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.amountCents).toBe(40000);
    expect(doc?.approvedCents).toBe(100000);
  });

  test("an increase that does NOT exceed approvedCents never retriggers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { budgetId } = await approvedChapterBudget(s, 100000);

    // Approve at 100000, then "increase" to exactly the same amount.
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 100000 },
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
  });

  test("increasing a DRAFT (never-approved) budget's amount does not touch approvalStatus", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await createChapterBudget(s, 50000);
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 90000 },
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("draft");
    expect(doc?.amountCents).toBe(90000);
  });
});

describe("grandfathered legacy budgets are unaffected", () => {
  /** Insert a budget row directly (bypassing `createBudget`) so it carries
   *  NO `approvalStatus` at all — a pre-feature legacy row. */
  async function insertLegacyBudget(s: ChapterSetup, amountCents: number): Promise<Id<"budgets">> {
    return run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents,
        label: "Legacy Ops",
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
  }

  test("reads as Approved (effective status), with no approvedCents recorded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertLegacyBudget(s, 60000);

    const budgets = await s.as.query(api.finances.listBudgets, {});
    const row = budgets.find((b) => b.id === budgetId);
    expect(row?.approvalStatus).toBe("approved");
    expect(row?.approvedCents).toBeNull();

    const raw = await getBudget(s, budgetId);
    expect(raw?.approvalStatus).toBeUndefined();
  });

  test("an amount increase does NOT retrigger — no approvalStatus is ever written", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertLegacyBudget(s, 60000);

    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 200000 },
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.amountCents).toBe(200000);
    expect(doc?.approvalStatus).toBeUndefined();
    expect(doc?.submittedByPersonId).toBeUndefined();
  });

  test("cannot be manually submitted (effective status is already \"approved\")", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertLegacyBudget(s, 60000);

    await expect(
      s.as.mutation(api.finances.submitBudgetForApproval, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("over-cap spend warning uses approvedCapCents while pending", () => {
  test("budgetVsActual reports the OLD approved cap, not the new (unapproved) amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitter = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitter, "manager", "chapter");
    const budgetId = await createChapterBudget(s, 100000, 2026);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId });

    // Bump the amount — retriggers, approvedCents stays 100000.
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 180000 },
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year: 2026 });
    const row = rows.find((r) => r.budgetId === budgetId);
    expect(row?.allocatedCents).toBe(180000);
    expect(row?.approvedCapCents).toBe(100000);
  });

  test("a plain approved budget's cap equals its current amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitter = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitter, "manager", "chapter");
    const budgetId = await createChapterBudget(s, 50000, 2026);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId });

    const rows = await s.as.query(api.finances.budgetVsActual, { year: 2026 });
    const row = rows.find((r) => r.budgetId === budgetId);
    expect(row?.approvedCapCents).toBe(50000);
  });
});

describe("queue counts", () => {
  test("chapter dashboard attention queue surfaces the pending count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s, "Manager");
    const b1 = await createChapterBudget(s, 50000);
    const b2 = await createChapterBudget(s, 60000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId: b1 });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId: b2 });
    // A third, still-draft budget must NOT be counted.
    await createChapterBudget(s, 10000);

    // The attention queue's budget-approval item is NOT year/month-scoped
    // (`by_chapter_and_approval_status` — see `chapterAttentionQueue`), so the
    // dashboard's own period argument is irrelevant to this count.
    const dash = await s.as.query(api.finances.dashboardChapter, {
      year: 2026,
      month: 6,
    });
    const item = dash.attention.find((a) => a.kind === "budget_approvals");
    expect(item?.badgeCount).toBe(2);
  });

  test("central dashboard aggregates pending counts across chapters + central", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" }); // superuser = central
    await asChapterManager(s, "Manager");
    const chapterBudget = await createChapterBudget(s, 30000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId: chapterBudget });

    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 400000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId: centralBudget });

    // Both budgets are year:2026 — `dashboardCentral`'s pending-count IS
    // year-scoped (built from the same `by_chapter_and_period` reads as the
    // rest of the dashboard), so the query year must match.
    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 6,
    });
    expect(dash.pendingBudgetApprovalsCount).toBe(2);
  });
});
