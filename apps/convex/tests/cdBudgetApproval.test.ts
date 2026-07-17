import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * Chapter Director seat -> chapter budget approval (owner-mandated fix).
 *
 * Empirically proven gap: `approveBudget`/`requestBudgetChanges` for a
 * CHAPTER budget required chapter finance MANAGER rank
 * (`requireFinanceManager`) — but a Chapter Director's seat
 * (`chapter_director` in `@events-os/shared`'s `SEAT_DEFS`) carries
 * `finance.approve`, not `finance.manager`, and its `legacyTitle`
 * ("president", a leadership-kind title) never bridges a stored
 * `financeRoles` manager grant the way a finance-kind title does. So a CD
 * seat holder with NO other grant could never approve a chapter budget.
 *
 * Owner decision (verbatim): "Chapter Director does have financial powers,
 * they approve budgets... a budget shouldn't get approved without the
 * chapter director."
 *
 * The fix: `finances.ts#loadBudgetForApprovalDecision` now accepts EITHER
 * the existing manager-rank path (Treasurer et al, unchanged) OR the caller
 * holding a seat with `finance.approve` at the budget's chapter
 * (`lib/seats.ts#holdsApprovalSeatAt`, additive — NOT folded into
 * `getSeatDerivedCapabilities`, whose module doc explicitly scoped
 * `finance.approve` out of the B10 graded-role union). CENTRAL budgets are
 * untouched (`requireCentralEdOrFm`, title-based).
 *
 * RECONCILIATION NOTE: PR #208 (unmerged as of this branch) pins a NEGATIVE
 * test in `financeGatesSeatUnion.test.ts` asserting a chapter_director
 * seat CANNOT approve a chapter budget — the exact gap this PR closes.
 * Whichever of the two PRs merges SECOND must update/remove that negative
 * pin (it will start failing once this fix lands) — flagging loudly here so
 * it isn't missed.
 */

async function seatSetup(
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
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

/** A chapter-scoped manager (person + manager grant) — the pre-existing
 *  Treasurer-shaped path, used here only to CREATE/submit fixture budgets. */
async function asChapterManager(s: ChapterSetup, name = "Manager"): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, name);
  await grantRole(s, personId, "manager", "chapter");
  return personId;
}

/** Add a SECOND authenticated member to the same chapter as `s`, with their
 *  own `users`/`userChapters`/`people` rows — mirrors
 *  `financeBudgetApproval.test.ts`'s helper of the same shape. */
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
 *  by inserting the row directly — mirrors `financeBudgetApproval.test.ts`. */
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

/** The seatDef row seeded for a template `slug` — mirrors
 *  `financeGatesSeatUnion.test.ts`. */
async function defBySlug(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

/** Insert a `seatAssignments` row directly (bypassing `assignSeat`'s
 *  write-through) — isolates "what the seat alone implies" from any bridged
 *  stored grant, exactly like `financeGatesSeatUnion.test.ts`. */
async function assignSeatDirect(
  s: ChapterSetup,
  personId: Id<"people">,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
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

describe("Chapter Director seat approves chapter budgets — the positive fix", () => {
  test("a CD-seat-only holder (no manager rank, no other grant) approves a chapter budget", async () => {
    const s = await seatSetup();
    await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 80000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "Chapter Director" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);
    // Deliberately NO financeRoles grant of any kind — the seat alone.

    await cd.as.mutation(api.finances.approveBudget, {
      budgetId,
      note: "Approved by CD",
    });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(cd.personId);
    expect(doc?.reviewNote).toBe("Approved by CD");
  });

  test("a CD-seat-only holder can also requestBudgetChanges on a chapter budget", async () => {
    const s = await seatSetup();
    await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 55000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "Chapter Director" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    await cd.as.mutation(api.finances.requestBudgetChanges, {
      budgetId,
      note: "Break out the line items first",
    });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("changes_requested");
    expect(doc?.approvedByPersonId).toBe(cd.personId);
    expect(doc?.reviewNote).toBe("Break out the line items first");
  });
});

describe("CD approval seat stays chapter-scoped and SoD-bound", () => {
  test("a CD seat does NOT reach a CENTRAL budget — chapter-scoped finance.approve never widens central approval", async () => {
    const s = await seatSetup();
    const centralSubmitter = await seedSelfPerson(s, "Central Submitter");
    await grantRole(s, centralSubmitter, "bookkeeper", "central");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 300000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Central Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    // A DIFFERENT person holds ONLY a chapter_director seat — no ED/FM
    // title, no central financeRoles grant.
    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    await expect(
      cd.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a CD-seat holder who ALSO submitted cannot approve their own submission — SoD unchanged", async () => {
    const s = await seatSetup();
    await asChapterManager(s, "Creator"); // creates the budget (manager-only create, unrelated identity)
    const budgetId = await createChapterBudget(s, 60000);

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);
    // Bookkeeper rank is what lets the CD submit (approve-gate is separate).
    await grantRole(s, cd.personId, "bookkeeper", "chapter");
    await cd.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    await expect(
      cd.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      cd.as.mutation(api.finances.requestBudgetChanges, { budgetId, note: "no" }),
    ).rejects.toBeInstanceOf(ConvexError);

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
  });

  test("cross-chapter CD rejected — chapter A's director can't approve chapter B's budget", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const chapterB = await setupChapter(t, {
      email: "b-manager@publicworship.life",
      chapterName: "Chapter B",
    });
    await asChapterManager(chapterB, "B Manager");
    const budgetId = await createChapterBudget(chapterB, 50000);
    await chapterB.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const chapterA = await setupChapter(t, {
      email: "a-director@publicworship.life",
      chapterName: "Chapter A",
    });
    const cdPersonId = await seedSelfPerson(chapterA, "CD-A");
    await assignSeatDirect(chapterA, cdPersonId, "chapter_director", chapterA.chapterId);

    // Chapter A's director's ACTIVE chapter (`requireChapterId`) is chapter
    // A, not chapter B — the budget isn't even visible to them.
    await expect(
      chapterA.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("regression — the manager-rank path is unchanged", () => {
  test("manager rank still works with NO seat at all (the Treasurer path)", async () => {
    const s = await seatSetup();
    await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 45000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const treasurer = await addMember(s, { email: "treasurer@publicworship.life", name: "Treasurer" });
    await grantRole(s, treasurer.personId, "manager", "chapter"); // stored grant, NO seat
    await treasurer.as.mutation(api.finances.approveBudget, { budgetId });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(treasurer.personId);
  });

  test("a plain member with no seat and no grant still cannot approve", async () => {
    const s = await seatSetup();
    await asChapterManager(s, "Submitter");
    const budgetId = await createChapterBudget(s, 30000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const plain = await addMember(s, { email: "plain@publicworship.life", name: "Plain" });
    await expect(
      plain.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("central approval still requires the ED/FM title, unchanged — an ED still can't self-approve, a titled FM can", async () => {
    const s = await seatSetup();
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

    await expect(
      s.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);

    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await grantCentralTitle(s, fm.personId, "finance_manager");
    await fm.as.mutation(api.finances.approveBudget, { budgetId });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(fm.personId);
  });
});
