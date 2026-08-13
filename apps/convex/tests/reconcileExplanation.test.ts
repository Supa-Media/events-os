/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * "WHAT IT WAS FOR" ON THE RECONCILE ROW.
 *
 * The grid carried `codingState` — where an explanation sits in review — and
 * never the explanation itself, so a written coding and an empty one looked
 * identical from the one surface people actually scan. `reconcileRow.
 * explanation` closes that (founder ask, 2026-08-13).
 *
 * The rule these tests defend is the same one `codingRedaction.test.ts`
 * defends from the other side: **the grid shows what PUBLISHES, never the
 * author's original where a reviewer has redacted it.** A redaction exists
 * precisely because a name shouldn't reach the public page; a hundred-row
 * grid is the likeliest thing to end up in a screenshot, so it must not be
 * the place that puts the name back. If someone ever "simplifies"
 * `resolveExplanation` into reading `businessPurpose` directly, the third
 * test here is what should fail.
 */

const AUTHOR_WORDS =
  "Dinner with Michael Reid and the volunteers producing the album";
const REDACTED = "Dinner with the volunteers producing the album";

async function asManager(s: ChapterSetup): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Kansi",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/** A plain outflow. `codingState` mirrors the denorm the real write path
 *  maintains — `resolveExplanation` reads it as its no-read fast path, so a
 *  test that left it unset would be testing the wrong branch. */
async function txn(
  s: ChapterSetup,
  codingState: "submitted" | "approved" | null = null,
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 9620,
      postedAt: 1_700_000_000_000,
      merchantName: "Chick-fil-A",
      status: "unreviewed",
      ...(codingState ? { codingState } : {}),
      createdAt: Date.now(),
    }),
  );
}

async function seedCoding(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  publicPurpose?: string,
): Promise<void> {
  const userId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: `author-${transactionId}@test.local` }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: s.chapterId,
      expenseType: "meal",
      businessPurpose: AUTHOR_WORDS,
      headcount: 4,
      status: "submitted",
      codedByUserId: userId,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
      ...(publicPurpose !== undefined ? { publicPurpose } : {}),
    }),
  );
}

async function explanationFor(s: ChapterSetup, id: Id<"transactions">) {
  const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
  const row = res.rows.find((r) => r.id === id);
  expect(row, "the seeded row should be in the queue").toBeDefined();
  return row!.explanation;
}

describe("the reconcile row carries its own sentence", () => {
  test("a row nobody has coded explains nothing", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const id = await txn(s);

    expect(await explanationFor(s, id)).toBeNull();
  });

  test("a coded row shows the author's words", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const id = await txn(s, "submitted");
    await seedCoding(s, id);

    expect(await explanationFor(s, id)).toEqual({
      purpose: AUTHOR_WORDS,
      redacted: false,
    });
  });

  test("THE INVARIANT: a redacted coding shows the REDACTION, never the name", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const id = await txn(s, "approved");
    await seedCoding(s, id, REDACTED);

    const explanation = await explanationFor(s, id);
    expect(explanation).toEqual({ purpose: REDACTED, redacted: true });
    // The thing a redaction exists to keep off a public surface stays off it.
    expect(explanation?.purpose).not.toContain("Michael Reid");
  });

  test("a whitespace-only redaction is no redaction — the author's words stand", async () => {
    // The case a bare `publicPurpose ?? businessPurpose` gets wrong: `"   "`
    // is non-null, so a `??` would publish blank space to the grid.
    // `publishedPurpose` trims, and `redacted` is derived from ITS answer
    // rather than re-tested against the field, so the two cannot disagree.
    const s = await setupChapter(newT());
    await asManager(s);
    const id = await txn(s, "submitted");
    await seedCoding(s, id, "   ");

    expect(await explanationFor(s, id)).toEqual({
      purpose: AUTHOR_WORDS,
      redacted: false,
    });
  });

  test("a codingState with no coding behind it reads as unexplained, not as a crash", async () => {
    // The denorm can only ever LAG the table, never invent a row. If the two
    // disagree the row must read as unexplained — the safe direction, because
    // the alternative is a grid claiming an explanation that isn't there.
    const s = await setupChapter(newT());
    await asManager(s);
    const id = await txn(s, "submitted");

    expect(await explanationFor(s, id)).toBeNull();
  });
});
