/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  disarmCodingPolicy,
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { logFinanceAudit } from "../lib/financeAuditLog";
import { TRANSACTION_STATUS_LABELS } from "@events-os/shared";

/**
 * THE AUDIT TRAIL STORES STATE KEYS AND WORDS THEM AT READ TIME.
 *
 * `financeAuditLog.before`/`.after` used to be display labels frozen at write
 * time, so #717's rename of `reconciled` ("Reconciled" → "Closed", the stored
 * value untouched) split the history in half: old rows said one word about the
 * same state new rows called another. Rows now carry `beforeKey`/`afterKey` and
 * `finances.financeAuditTrail` renders today's label from them.
 *
 * Three things are held here, and the middle one is the important one:
 *  1. the trail reads consistently across a rename, without rewriting a word;
 *  2. THE "EXCLUDING NEEDS A REASON" GUARD IS KEYED, not string-matched — it
 *     fires on the stored `"excluded"` status and would survive that status
 *     being relabelled tomorrow;
 *  3. the backfill is idempotent, dry by default, and additive.
 */

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
  role: "viewer" | "bookkeeper" | "manager" = "bookkeeper",
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

/** A chapter bookkeeper with one hand-entered charge — the whole cast every
 *  test here needs. Grants the role BEFORE the charge because
 *  `createManualTransaction` is itself bookkeeper-gated. */
async function seedTxn(s: ChapterSetup, amountCents = 4200): Promise<Id<"transactions">> {
  await grantRole(s, await seedSelfPerson(s));
  await disarmCodingPolicy(s.t);
  return await s.as.mutation(api.finances.createManualTransaction, {
    flow: "outflow",
    amountCents,
    postedAt: Date.now(),
    merchantName: "Coffee Shop",
  });
}

/** Documentation without going through `attachReceipt`, so a test can close a
 *  row without triggering attach's own audit row (mirrors
 *  `financeAuditLog.test.ts`'s helper of the same name). */
async function giveReceipt(s: ChapterSetup, txnId: Id<"transactions">): Promise<void> {
  const storageId = await storeBlob(s.t);
  await run(s.t, (ctx) => ctx.db.patch(txnId, { receiptStorageId: storageId }));
}

async function trailFor(s: ChapterSetup, subjectId: string) {
  return await s.as.query(api.finances.financeAuditTrail, {
    subjectType: "transaction",
    subjectId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("status_change rows carry the STORED status, not the word for it", () => {
  test("closing a row logs `reconciled` and renders whatever that status is called today", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);
    await giveReceipt(s, txnId);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });

    const [row] = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "status_change"))
        .collect(),
    );
    // THE POINT: what's on disk is the status, not the label.
    expect(row.beforeKey).toBe("unreviewed");
    expect(row.afterKey).toBe("reconciled");

    const trail = await trailFor(s, txnId);
    const statusRow = trail.find((r) => r.action === "status_change")!;
    expect(statusRow.after).toBe(TRANSACTION_STATUS_LABELS.reconciled);
    expect(statusRow.valueKind).toBe("transaction_status");
    expect(statusRow.afterKey).toBe("reconciled");
  });

  test("a legacy row that still says \"Reconciled\" reads the same as a fresh one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);

    // Exactly what production holds: written before the rename, keyed by the
    // backfill, its original wording never touched.
    await run(s.t, (ctx) =>
      ctx.db.insert("financeAuditLog", {
        chapterId: s.chapterId,
        subjectType: "transaction",
        subjectId: txnId,
        action: "status_change",
        actorUserId: s.userId,
        field: "status",
        before: "Categorized",
        after: "Reconciled",
        beforeKey: "categorized",
        afterKey: "reconciled",
        amountCents: 4200,
        createdAt: Date.now(),
      }),
    );

    const trail = await trailFor(s, txnId);
    const row = trail.find((r) => r.action === "status_change")!;
    expect(row.after).toBe("Closed");
    // …and the words somebody actually saw are still on the document.
    const stored = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "status_change"))
        .collect(),
    );
    expect(stored[0].after).toBe("Reconciled");
  });
});

describe("REGRESSION — \"excluding needs a reason\" fires on the KEY, not the label", () => {
  test("excluding with no reason is refused, and refused by the stored status", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "excluded",
      }),
    ).rejects.toThrow(ConvexError);

    // Nothing was written — not the status, not an audit row.
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe("unreviewed");
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "status_change"))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("the guard cannot be defeated by renaming the label", async () => {
    // The landmine this suite exists for. A rule written as
    // `after === "Excluded"` would stop firing the moment somebody renamed the
    // status the way #717 renamed `reconciled` — and excluding a charge out of
    // every budget, category and actuals total would quietly stop needing an
    // explanation. So: the guard's input is `args.status`, and the ONLY thing
    // tying the label to the rule is this assertion, which fails loudly if the
    // two are ever coupled again.
    //
    // Stated as a property rather than a mock: whatever
    // `TRANSACTION_STATUS_LABELS.excluded` says, the refusal is the same.
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        // The KEY. The mutation's arg validator does not accept a label at all
        // — "Excluded" is not a `TransactionStatus` — which is the structural
        // half of the same guarantee.
        status: "excluded",
        reason: "   ", // blank after trimming: still refused
      }),
    ).rejects.toThrow(ConvexError);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "excluded",
      reason: "Duplicate of the card charge",
    });
    const [row] = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "status_change"))
        .collect(),
    );
    expect(row.afterKey).toBe("excluded");
    expect(row.reason).toBe("Duplicate of the card charge");
  });
});

describe("logFinanceAudit refuses a keyed action that forgot its key", () => {
  test("a status_change with words but no key throws rather than freezing a label", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);

    await expect(
      run(s.as as never, (ctx) =>
        logFinanceAudit(ctx, {
          chapterId: s.chapterId,
          subjectType: "transaction",
          subjectId: txnId,
          action: "status_change",
          field: "status",
          before: "Unreviewed",
          after: "Closed",
        }),
      ),
    ).rejects.toThrow(/beforeKey/);

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "status_change"))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("a free-text action needs no key at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);

    await run(s.as as never, (ctx) =>
      logFinanceAudit(ctx, {
        chapterId: s.chapterId,
        subjectType: "transaction",
        subjectId: txnId,
        action: "note_edit",
        field: "note",
        before: "Old note",
        after: "New note",
      }),
    );
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("action"), "note_edit"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeKey).toBeUndefined();
  });
});

describe("financeAuditKeyBackfill — dry by default, additive, idempotent", () => {
  /** Three legacy rows exactly as production holds them: words, no keys. Two
   *  are keyable (a status change written before the rename, a receipt attach);
   *  one is free text and must be left entirely alone. */
  async function seedLegacy(s: ChapterSetup, txnId: Id<"transactions">) {
    const base = {
      chapterId: s.chapterId,
      subjectType: "transaction" as const,
      subjectId: txnId as string,
      actorUserId: s.userId,
      createdAt: Date.now(),
    };
    await run(s.t, async (ctx) => {
      await ctx.db.insert("financeAuditLog", {
        ...base,
        action: "status_change",
        field: "status",
        before: "Categorized",
        after: "Reconciled", // the pre-#717 word
      });
      await ctx.db.insert("financeAuditLog", {
        ...base,
        action: "receipt_attach",
        field: "receipt",
        before: "None",
        after: "Attached",
      });
      await ctx.db.insert("financeAuditLog", {
        ...base,
        action: "note_edit",
        field: "note",
        before: "Old note",
        after: "Coffee with a donor",
      });
    });
  }

  async function auditRows(s: ChapterSetup) {
    return await run(s.t, (ctx) => ctx.db.query("financeAuditLog").collect());
  }

  test("a dry run reports the backlog and writes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);
    await run(s.t, (ctx) => ctx.db.query("financeAuditLog").collect());
    await seedLegacy(s, txnId);

    const before = await auditRows(s);
    const result = await t.action(
      internal.financeAuditKeyBackfill.backfillAuditKeys,
      {},
    );

    expect(result.keyed).toBe(2); // status_change + receipt_attach
    expect(result.freeText).toBeGreaterThanOrEqual(1); // note_edit (+ manual_create)
    expect(result.unmapped).toBe(0);
    expect(result.isDone).toBe(true);

    const after = await auditRows(s);
    expect(after.map((r) => r.beforeKey)).toEqual(before.map((r) => r.beforeKey));
    expect(after.every((r) => r.afterKey === undefined)).toBe(true);
  });

  test("executing keys the keyable rows and leaves every written word alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);
    await seedLegacy(s, txnId);

    const before = await auditRows(s);
    await t.action(internal.financeAuditKeyBackfill.backfillAuditKeys, {
      execute: true,
    });
    const after = await auditRows(s);

    const status = after.find((r) => r.action === "status_change")!;
    expect(status.beforeKey).toBe("categorized");
    expect(status.afterKey).toBe("reconciled");
    const receipt = after.find((r) => r.action === "receipt_attach")!;
    expect(receipt.beforeKey).toBe("none");
    expect(receipt.afterKey).toBe("attached");
    const note = after.find((r) => r.action === "note_edit")!;
    expect(note.beforeKey).toBeUndefined();
    expect(note.afterKey).toBeUndefined();

    // APPEND-ONLY HELD: not one word of what anybody saw was rewritten.
    for (const row of after) {
      const original = before.find((b) => b._id === row._id)!;
      expect(row.before).toBe(original.before);
      expect(row.after).toBe(original.after);
      expect(row.reason).toBe(original.reason);
      expect(row.createdAt).toBe(original.createdAt);
    }

    // …and the reader now words the legacy row today's way.
    const trail = await trailFor(s, txnId);
    expect(trail.find((r) => r.action === "status_change")!.after).toBe("Closed");
  });

  test("a second execute claims nothing — the sweep is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);
    await seedLegacy(s, txnId);

    await t.action(internal.financeAuditKeyBackfill.backfillAuditKeys, {
      execute: true,
    });
    const afterFirst = await auditRows(s);

    const second = await t.action(
      internal.financeAuditKeyBackfill.backfillAuditKeys,
      { execute: true },
    );
    expect(second.keyed).toBe(0);
    expect(second.skipped).toBe(2);

    // Byte for byte identical — a re-run is a no-op, not a rewrite.
    const afterSecond = await auditRows(s);
    expect(afterSecond).toEqual(afterFirst);
  });

  test("a word no vocabulary ever showed is counted and left as it is", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeAuditLog", {
        chapterId: s.chapterId,
        subjectType: "transaction",
        subjectId: txnId,
        action: "status_change",
        actorUserId: s.userId,
        field: "status",
        before: "Half-done", // a status this app has never had
        after: "Closed",
        createdAt: Date.now(),
      }),
    );

    const result = await t.action(
      internal.financeAuditKeyBackfill.backfillAuditKeys,
      { execute: true },
    );
    expect(result.unmapped).toBe(1);

    const row = (await auditRows(s)).find((r) => r.action === "status_change")!;
    expect(row.beforeKey).toBeUndefined(); // never guessed
    expect(row.afterKey).toBe("reconciled");
    expect(row.before).toBe("Half-done"); // still rendered from its own words

    const trail = await trailFor(s, txnId);
    expect(trail.find((r) => r.action === "status_change")!.before).toBe(
      "Half-done",
    );
  });
});
