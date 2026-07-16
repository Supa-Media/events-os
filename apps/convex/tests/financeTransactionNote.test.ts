/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * R1a — `finances.setTransactionNote`: a bookkeeper's freeform "who was this
 * for and why" justification, distinct from the provider-sourced
 * `description`. Same authz as `categorizeTransaction` (scope-aware
 * `requireReconcileTxn`, bookkeeper rank) — coding a charge and annotating it
 * are the same reconcile-grid privilege.
 *
 * Covers: set + clear + read-back (via `listReconcile`'s projection), the
 * bookkeeper-minimum gate (a viewer is rejected), and the length cap.
 */

async function seedPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
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
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(s: ChapterSetup): Promise<Id<"transactions">> {
  return await s.as.mutation(api.finances.createManualTransaction, {
    flow: "outflow",
    amountCents: 4200,
    postedAt: Date.now(),
    merchantName: "Coffee Shop",
  });
}

describe("setTransactionNote", () => {
  test("a bookkeeper sets a note; it reads back via the txn doc AND listReconcile's projection", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Coffee with a prospective donor after service",
    });

    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.note).toBe("Coffee with a prospective donor after service");

    const { rows } = await s.as.query(api.finances.listReconcile, {});
    const row = rows.find((r) => r.id === txnId);
    expect(row?.note).toBe("Coffee with a prospective donor after service");
  });

  test("a null note clears it; whitespace-only also clears rather than storing blank", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Initial note",
    });
    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "   ",
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.note).toBeUndefined();

    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Back again",
    });
    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: null,
    });
    const cleared = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(cleared?.note).toBeUndefined();
  });

  test("a viewer (below bookkeeper) is rejected (FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    // Seed the txn as a manager first (creating one is itself a bookkeeper+
    // write) — the FinanceRoles row is a single grant per person, so it's
    // downgraded to "viewer" only AFTER the txn exists.
    await grantRole(s, personId, "manager");
    const txnId = await seedTxn(s);
    await run(s.t, async (ctx) => {
      const grant = await ctx.db
        .query("financeRoles")
        .withIndex("by_person", (q) => q.eq("personId", personId))
        .first();
      await ctx.db.patch(grant!._id, { role: "viewer" });
    });

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.setTransactionNote, {
        transactionId: txnId,
        note: "Should not be allowed",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("a note over the length cap is rejected (NOTE_TOO_LONG)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    await grantRole(s, personId, "manager");
    const txnId = await seedTxn(s);

    const tooLong = "x".repeat(2001);
    let caught: unknown;
    try {
      await s.as.mutation(api.finances.setTransactionNote, {
        transactionId: txnId,
        note: tooLong,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "NOTE_TOO_LONG",
    );

    // Exactly at the cap is fine.
    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "x".repeat(2000),
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.note?.length).toBe(2000);
  });
});
