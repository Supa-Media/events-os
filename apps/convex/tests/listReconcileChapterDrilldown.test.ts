/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `listReconcile`'s central → chapter drill-down (`chapterId` arg) —
 * mirrors `dashboardChapter`'s own `chapterId` drill-down gate exactly
 * (see `financeCentralDrilldown.test.ts`). Independent of the existing
 * `scope:"central"` arg: that views the CENTRAL-owned txns bucket; this
 * lets a central viewer deep-link into one SPECIFIC chapter's queue.
 */

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

async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A genuine central-scope finance manager (not the hardcoded superuser). */
async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  opts: { description?: string } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId,
      source: "manual",
      amountCents: 5000,
      flow: "outflow",
      status: "unreviewed",
      description: opts.description ?? "Test charge",
      postedAt: Date.now(),
      createdAt: Date.now(),
    }),
  );
}

describe("listReconcile: central → chapter drill-down (chapterId arg)", () => {
  test("a central manager CAN list a different chapter's reconcile queue via chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    await seedTxn(s, boston, { description: "Boston charge" });

    const res = await s.as.query(api.finances.listReconcile, { chapterId: boston });
    expect(res.rows.some((r) => r.description === "Boston charge")).toBe(true);
    expect(res.counts.all).toBe(1);
  });

  test("a chapter-scoped manager CANNOT list a different chapter's reconcile queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");
    await seedTxn(s, boston, { description: "Boston charge" });

    await expect(
      s.as.query(api.finances.listReconcile, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("passing the caller's OWN chapterId is unchanged (viewer gate, not central)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await seedTxn(s, s.chapterId, { description: "Home charge" });

    const res = await s.as.query(api.finances.listReconcile, { chapterId: s.chapterId });
    expect(res.rows.some((r) => r.description === "Home charge")).toBe(true);
  });

  test("omitting chapterId still resolves the caller's own chapter (byte-for-byte unchanged)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await seedTxn(s, s.chapterId, { description: "Home charge" });

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.rows.some((r) => r.description === "Home charge")).toBe(true);
  });

  test("scope:\"central\" still wins over chapterId when both are somehow supplied — the two axes never conflict", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    await seedTxn(s, boston, { description: "Boston charge" });
    const centralTxnId = await seedTxn(s, "central", { description: "Central charge" });

    const res = await s.as.query(api.finances.listReconcile, {
      scope: "central",
      chapterId: boston,
    });
    expect(res.rows.some((r) => r.id === centralTxnId)).toBe(true);
    expect(res.rows.some((r) => r.description === "Boston charge")).toBe(false);
  });
});
