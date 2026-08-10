/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  LOST_RECEIPT_CHECKS,
  NOT_ISSUED_CHECKS,
  lostReceiptBlocker,
  type ExceptionAttestation,
} from "@events-os/shared";
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
 * REAL FRICTION BEFORE "THE RECEIPT IS LOST".
 *
 * Owner, 2026-08-09. Three things this suite has to hold:
 *
 *  1. **The reason branches first.** Only `lost` gets the gauntlet — *"if they
 *     say no receipt issued, then it's just no receipt issued"*. Chasing a
 *     receipt that cannot exist (a subway fare, a vending machine) is pure
 *     friction with no yield.
 *  2. **Any "no" genuinely blocks**, on the SERVER. A check that lives only in
 *     the form is a check anybody can skip.
 *  3. **Uniform at every amount.** *"I feel like you should keep your
 *     receipts, and it doesn't take much to take a picture of it."* The $75
 *     line governs who APPROVES and is not a friction dial.
 *
 * And the honest one: the answers are ATTESTED, not verified. Someone can
 * click yes three times and be wrong. What the record buys is that an approver
 * can read it and understand the situation — so the answers have to be stored,
 * with the questions, and readable back.
 */

const GOOD_NOTE = "Cash tip for the sound engineer at the Aug 2 outdoor service";

function answers(
  overrides: Partial<Record<string, boolean>> = {},
): ExceptionAttestation[] {
  return LOST_RECEIPT_CHECKS.map((c) => ({
    key: c.key,
    prompt: c.prompt,
    answer: overrides[c.key] ?? true,
  }));
}

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

/** An un-receipted charge belonging to `personId`. */
async function seedCharge(
  s: ChapterSetup,
  personId: Id<"people">,
  amountCents = 1551,
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      postedAt: Date.now(),
      merchantName: "MTA",
      personId,
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

describe("lostReceiptBlocker — the pure rule", () => {
  test("all three answered yes clears it", () => {
    expect(lostReceiptBlocker(answers())).toBeNull();
  });

  test("any single no blocks, and names the check that isn't done", () => {
    for (const check of LOST_RECEIPT_CHECKS) {
      const blocker = lostReceiptBlocker(answers({ [check.key]: false }));
      expect(blocker?.key).toBe(check.key);
    }
  });

  test("a MISSING answer blocks exactly like a no — silence isn't consent", () => {
    expect(lostReceiptBlocker([])?.key).toBe(LOST_RECEIPT_CHECKS[0].key);
    expect(lostReceiptBlocker(undefined)?.key).toBe(LOST_RECEIPT_CHECKS[0].key);
    expect(
      lostReceiptBlocker(answers().slice(0, 2))?.key,
    ).toBe(LOST_RECEIPT_CHECKS[2].key);
  });

  test("every check carries a prompt AND something to go and do — a block that only refuses is useless", () => {
    for (const c of LOST_RECEIPT_CHECKS) {
      expect(c.prompt.length).toBeGreaterThan(10);
      expect(c.blockedHint.length).toBeGreaterThan(10);
    }
    // The two paths people actually forget are named explicitly.
    const all = LOST_RECEIPT_CHECKS.map((c) => `${c.prompt} ${c.blockedHint}`).join(" ");
    expect(all.toLowerCase()).toContain("spam");
    expect(all.toLowerCase()).toContain("order history");
  });

  test("the not-issued questions classify rather than punish: 'no receipts at all' ends it, 'didn't ask' does not", () => {
    const byKey = Object.fromEntries(NOT_ISSUED_CHECKS.map((c) => [c.key, c]));
    expect(byKey["merchant_issues_receipts"].noEndsIt).toBe(true);
    expect(byKey["asked_for_receipt"].noEndsIt).toBe(false);
  });
});

describe("the server refuses a 'lost' exception that skipped the work", () => {
  test("no attestations at all is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);

    await expect(
      casey.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        note: GOOD_NOTE,
      }),
    ).rejects.toMatchObject({
      data: { code: "LOST_RECEIPT_CHECKS_REQUIRED" },
    });
    expect(
      await run(s.t, (ctx) => ctx.db.query("receiptExceptions").collect()),
    ).toHaveLength(0);
  });

  test("one 'no' is refused, and the message says what to go and do", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);

    await expect(
      casey.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        note: GOOD_NOTE,
        attestations: answers({ inboxes_searched: false }),
      }),
    ).rejects.toMatchObject({
      data: {
        code: "LOST_RECEIPT_CHECKS_REQUIRED",
        message: expect.stringContaining("spam"),
      },
    });
  });

  test("all three yes files it, and the answers are ON the record", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);

    await casey.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
      attestations: answers(),
    });

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("receiptExceptions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attestations).toHaveLength(3);
    // The QUESTION is stored beside the answer — a bare key stops being
    // legible the day the wording changes.
    expect(rows[0].attestations?.every((a) => a.prompt.length > 10)).toBe(true);
    expect(rows[0].attestations?.every((a) => a.answer === true)).toBe(true);
  });

  test("UNIFORM AT EVERY AMOUNT — a $4 charge faces the same gauntlet as a $400 one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    // Well under the $75 approval line, which is deliberately NOT a friction
    // dial — it governs who approves and nothing else.
    const small = await seedCharge(s, casey.personId, 400);
    await expect(
      casey.as.mutation(api.receiptExceptions.attest, {
        transactionId: small,
        reason: "lost",
        note: GOOD_NOTE,
      }),
    ).rejects.toMatchObject({
      data: { code: "LOST_RECEIPT_CHECKS_REQUIRED" },
    });

    const large = await seedCharge(s, casey.personId, 40_000);
    await expect(
      casey.as.mutation(api.receiptExceptions.attest, {
        transactionId: large,
        reason: "lost",
        note: GOOD_NOTE,
      }),
    ).rejects.toMatchObject({
      data: { code: "LOST_RECEIPT_CHECKS_REQUIRED" },
    });
  });
});

describe("the reason branches first — only 'lost' is gated", () => {
  test("'no receipt was issued' files on an explanation alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);

    await casey.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Subway fare — the turnstile issues nothing at all",
    });
    expect(
      await run(s.t, (ctx) => ctx.db.query("receiptExceptions").collect()),
    ).toHaveLength(1);
  });

  test("and its classifying answers are recorded when the form asked them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);

    await casey.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Subway fare — the turnstile issues nothing at all",
      attestations: [
        {
          key: "merchant_issues_receipts",
          prompt: NOT_ISSUED_CHECKS[0].prompt,
          answer: false,
        },
      ],
    });

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("receiptExceptions").collect(),
    );
    expect(rows[0].attestations).toEqual([
      {
        key: "merchant_issues_receipts",
        prompt: NOT_ISSUED_CHECKS[0].prompt,
        answer: false,
      },
    ]);
  });

  test("the other reasons are untouched — no gauntlet on predates_policy", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);

    await casey.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "predates_policy",
      note: "From 2024, before we ran cards and receipts this way",
    });
    expect(
      await run(s.t, (ctx) => ctx.db.query("receiptExceptions").collect()),
    ).toHaveLength(1);
  });
});

describe("what an approver can read back", () => {
  test("the answers ride on the read path, so a reviewer sees what was tried", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);
    await casey.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "lost",
      note: GOOD_NOTE,
      attestations: answers(),
    });

    const rows = await casey.as.query(
      api.receiptExceptions.listForTransaction,
      { transactionId: txnId },
    );
    expect(rows[0].attestations).toHaveLength(3);
    expect(rows[0].attestations[0].prompt).toBe(LOST_RECEIPT_CHECKS[0].prompt);
  });

  test("a row filed before any of this existed reads as nothing recorded, not as three unanswered questions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const casey = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    const txnId = await seedCharge(s, casey.personId);
    // Exactly the shape of the 36 historical rows: no `attestations` column.
    await run(s.t, (ctx) =>
      ctx.db.insert("receiptExceptions", {
        transactionId: txnId,
        chapterId: s.chapterId,
        amountCents: 1551,
        reason: "lost",
        note: "Receipt lost",
        status: "pending",
        attestedByUserId: s.userId,
        attestedAt: Date.now(),
      }),
    );

    const rows = await casey.as.query(
      api.receiptExceptions.listForTransaction,
      { transactionId: txnId },
    );
    expect(rows[0].attestations).toEqual([]);
    expect(rows[0].reason).toBe("lost");
  });
});
