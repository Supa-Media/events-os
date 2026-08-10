/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * PICKING THE BUDGET WHILE CODING.
 *
 * Owner, 2026-08-09: *"When coding, I hope people can select budgets for
 * things… You should just show them all the budgets."* Until this, nobody
 * coding a charge could: `submitOwnCharge` is deliberately narrow (category
 * and note only) and `categorizeTransaction` is bookkeeper-gated, so the
 * budget on a cardholder's charge could only ever be set later, by somebody
 * who wasn't there when the money was spent.
 *
 * The two things worth pinning: a cardholder with NO finance seat can both
 * see the list and set the budget on their OWN charge — and the guards that
 * govern which budget may take a charge are unchanged by who is doing it.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  personId: Id<"people">;
}> {
  const userId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: opts.email }),
  );
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
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

async function seedBudget(
  s: ChapterSetup,
  opts: { label: string; approved?: boolean },
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 100_000,
      label: opts.label,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      ...(opts.approved === false
        ? { approvalStatus: "submitted" as const }
        : { approvalStatus: "approved" as const, approvedCents: 100_000 }),
      createdAt: Date.now(),
    }),
  );
}

/** A receipted charge belonging to `personId`, so its own person can code it
 *  with no finance grant at all. */
async function seedOwnCharge(
  s: ChapterSetup,
  personId: Id<"people">,
): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 5800,
      postedAt: POST_POLICY,
      merchantName: "Peter Pan Bus Lines",
      personId,
      status: "unreviewed",
      receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

describe("budgetOptions — show them all, to whoever is coding", () => {
  test("a cardholder with NO finance seat sees the chapter's approved budgets", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBudget(s, { label: "Operating" });
    await seedBudget(s, { label: "Equipment and upgrades" });
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });

    const options = await cardholder.as.query(
      api.transactionCodings.budgetOptions,
      {},
    );
    expect(options.recurring.map((r) => r.label).sort()).toEqual([
      "Equipment and upgrades",
      "Operating",
    ]);
    expect(options.recurring.every((r) => r.level === "chapter")).toBe(true);
  });

  test("an UNAPPROVED budget is never offered — only an approved budget can take a charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBudget(s, { label: "Operating" });
    await seedBudget(s, { label: "Not yet approved", approved: false });
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });

    const options = await cardholder.as.query(
      api.transactionCodings.budgetOptions,
      {},
    );
    expect(options.recurring.map((r) => r.label)).toEqual(["Operating"]);
  });

  test("a signed-in member with no chapter gets an empty list, not a throw — it's a picker, not a gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const userId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "nobody@publicworship.life" }),
    );
    const stranger = s.t.withIdentity({
      subject: `${userId}|session`,
      issuer: "test",
    });
    await expect(
      stranger.query(api.transactionCodings.budgetOptions, {}),
    ).resolves.toEqual({ events: [], projects: [], recurring: [] });
  });
});

describe("submitting a coding attributes the charge", () => {
  test("a cardholder with no finance seat sets the budget on their OWN charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, { label: "Operating" });
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedOwnCharge(s, cardholder.personId);

    await cardholder.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
      budgetId,
    });

    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId).toBe(
      budgetId,
    );
  });

  test("an UNAPPROVED budget is refused — the same rule the Reconcile picker enforces, unchanged by who's asking", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, {
      label: "Not yet approved",
      approved: false,
    });
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedOwnCharge(s, cardholder.personId);

    await expect(
      cardholder.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "general",
        businessPurpose: GOOD_PURPOSE,
        budgetId,
      }),
    ).rejects.toMatchObject({ data: { code: "BUDGET_NOT_APPROVED" } });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId).toBeUndefined();
  });

  test("ANOTHER CHAPTER'S budget is refused", async () => {
    const t = newT();
    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Other Chapter",
    });
    const foreignBudgetId = await seedBudget(other, { label: "Their ops" });

    const s = await setupChapter(t, {
      email: "home@publicworship.life",
      chapterName: "Home Chapter",
    });
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedOwnCharge(s, cardholder.personId);

    await expect(
      cardholder.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "general",
        businessPurpose: GOOD_PURPOSE,
        budgetId: foreignBudgetId,
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("omitting it leaves an existing attribution alone — resubmitting can't silently detach what a bookkeeper attached", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, { label: "Operating" });
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedOwnCharge(s, cardholder.personId);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { budgetId }));

    await cardholder.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId).toBe(
      budgetId,
    );
  });

  test("attributing clears the charge out of the Needs budget backlog", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, { label: "Operating" });
    const manager = await addMember(s, {
      email: "mgr@publicworship.life",
      name: "Manager",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: manager.personId,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const txnId = await seedOwnCharge(s, manager.personId);

    const before = await manager.as.query(api.finances.listReconcile, {
      filter: "all",
    });
    expect(before.counts.needs_budget).toBe(1);

    await manager.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
      budgetId,
    });

    const after = await manager.as.query(api.finances.listReconcile, {
      filter: "all",
    });
    expect(after.counts.needs_budget).toBe(0);
  });
});
