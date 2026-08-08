/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `finances.renameMerchant` / `clearMerchantRename` — giving a bank-feed row a
 * name a human recognizes.
 *
 * The invariant this whole feature rests on is that the PROVIDER'S VALUE IS
 * NEVER TOUCHED: a rename writes a separate `merchantNameOverride`, so the
 * statement's own string is always one field away and a rename can never
 * launder a row into looking like a different charge. Every test below is
 * ultimately about that — the override renders, the original survives it, the
 * trail names who did it, and clearing brings the provider's name back without
 * anything having been "restored" (nothing was ever overwritten).
 *
 * Fixtures use the real production shapes the owner complained about
 * (`IC* COSTCO BY IN CAR`, `AMAZON MKTPL*…`) rather than tidy placeholders, so
 * a regression that only shows up on ugly input still fails here.
 */

const BANK_MERCHANT = "IC* COSTCO BY IN CAR";
const ENGINE_DESCRIPTION =
  "Auto: settlement of cross-book card spend through 2026-08-07. Net $224.53 central → New York.";

async function seedSelfPerson(s: ChapterSetup, name = "Book Keeper"): Promise<Id<"people">> {
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

async function asBookkeeper(s: ChapterSetup, name = "Book Keeper"): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, name);
  await grantRole(s, personId, "bookkeeper");
  return personId;
}

/** A bank-fed row — the population this feature exists for, and the one
 *  `correctTransaction` deliberately refuses to touch. */
async function seedBankTxn(
  s: ChapterSetup,
  opts: { merchantName?: string; description?: string } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_card",
      flow: "outflow",
      amountCents: 12994,
      postedAt: Date.parse("2026-03-01T12:00:00-05:00"),
      merchantName: opts.merchantName,
      description: opts.description,
      status: "unreviewed",
      externalId: `ext_${Math.random()}`,
      createdAt: Date.now(),
    }),
  );
}

async function trailFor(s: ChapterSetup, txnId: Id<"transactions">) {
  const rows = await s.as.query(api.finances.financeAuditTrail, {
    subjectType: "transaction",
    subjectId: txnId,
  });
  return rows.filter((r) => r.action === "merchant_rename");
}

async function reconcileRow(s: ChapterSetup, txnId: Id<"transactions">) {
  const { rows } = await s.as.query(api.finances.listReconcile, { filter: "all" });
  return rows.find((r) => r.id === txnId);
}

describe("renaming shows the new name and keeps the old one", () => {
  test("the override lands on the row and the reconcile projection carries both names", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco",
    });

    const row = await reconcileRow(s, txnId);
    expect(row?.merchantNameOverride).toBe("Costco");
    // THE POINT: the provider's own string is still right there, unmodified,
    // shipped to the client alongside the rename rather than replaced by it.
    expect(row?.merchantName).toBe(BANK_MERCHANT);
    expect(row?.hasMerchantRenameHistory).toBe(true);
  });

  test("the stored document never loses the provider's merchant or description", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, {
      merchantName: "AMAZON MKTPL*56OXD2TB2",
      description: "Purchase from AMAZON.COM*569A3 | Address: SEATTLE, WA, US | **8728",
    });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Amazon",
    });
    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Amazon — sound cables",
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.merchantName).toBe("AMAZON MKTPL*56OXD2TB2");
    expect(txn?.description).toBe(
      "Purchase from AMAZON.COM*569A3 | Address: SEATTLE, WA, US | **8728",
    );
    expect(txn?.merchantNameOverride).toBe("Amazon — sound cables");
  });

  test("a rename is trimmed, and renaming to the same name writes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "  Costco  ",
    });
    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco",
    });

    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.merchantNameOverride).toBe("Costco");
    // A no-op rename must not add a row — a trail of "renamed X to X" buries
    // the real renames.
    expect(await trailFor(s, txnId)).toHaveLength(1);
  });

  test("a blank name is refused — clearing is its own explicit act", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await expect(
      s.as.mutation(api.finances.renameMerchant, {
        transactionId: txnId,
        merchantName: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "MERCHANT_NAME_REQUIRED" } });
  });

  test("an over-long name is refused rather than silently truncated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await expect(
      s.as.mutation(api.finances.renameMerchant, {
        transactionId: txnId,
        merchantName: "x".repeat(121),
      }),
    ).rejects.toMatchObject({ data: { code: "MERCHANT_NAME_TOO_LONG" } });
  });
});

describe("the trail", () => {
  test("the first rename records the PROVIDER's name as `before`, with the actor", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asBookkeeper(s, "Ada Bookkeeper");
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco",
    });

    const trail = await trailFor(s, txnId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      field: "merchant",
      // Not "—". The row WAS called something before anyone renamed it: the
      // bank called it this, and that is the trail's opening line.
      before: BANK_MERCHANT,
      after: "Costco",
      actorName: "Ada Bookkeeper",
    });

    // The audit row names the acting PERSON, not just the user — the
    // displayable half of `financeAuditLog`'s two identities.
    const raw = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .withIndex("by_subject", (q) =>
          q.eq("subjectType", "transaction").eq("subjectId", txnId),
        )
        .first(),
    );
    expect(raw?.actorPersonId).toBe(personId);
    expect(raw?.actorUserId).toBe(s.userId);
  });

  test("successive renames chain — each `before` is the previous name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco",
    });
    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco — Sunday coffee",
    });

    // `financeAuditTrail` reads newest-first.
    const trail = await trailFor(s, txnId);
    expect(trail.map((r) => [r.before, r.after])).toEqual([
      ["Costco", "Costco — Sunday coffee"],
      [BANK_MERCHANT, "Costco"],
    ]);
  });
});

describe("clearing a rename", () => {
  test("drops the override so the provider's name shows again", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco",
    });
    await s.as.mutation(api.finances.clearMerchantRename, { transactionId: txnId });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.merchantNameOverride).toBeUndefined();
    expect(txn?.merchantName).toBe(BANK_MERCHANT);

    const row = await reconcileRow(s, txnId);
    expect(row?.merchantNameOverride).toBeNull();
    expect(row?.merchantName).toBe(BANK_MERCHANT);
    // The trail outlives the override: this row still has a story worth
    // reading, so it keeps its history affordance.
    expect(row?.hasMerchantRenameHistory).toBe(true);
  });

  test("logs the clear as a rename back to the provider's name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Costco",
    });
    await s.as.mutation(api.finances.clearMerchantRename, { transactionId: txnId });

    const trail = await trailFor(s, txnId);
    expect(trail[0]).toMatchObject({ before: "Costco", after: BANK_MERCHANT });
  });

  test("clearing a row that was never renamed is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await expect(
      s.as.mutation(api.finances.clearMerchantRename, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "NOT_RENAMED" } });
  });
});

describe("who may rename", () => {
  // Read-only peek users and viewers are the population this guards against —
  // naming a charge is bookkeeping, and it uses the same gate every other
  // reclassification on the reconcile grid does.
  test("a viewer-role caller is refused and the row is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s, "Vera Viewer");
    await grantRole(s, personId, "viewer");
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await expect(
      s.as.mutation(api.finances.renameMerchant, {
        transactionId: txnId,
        merchantName: "Costco",
      }),
    ).rejects.toThrow();
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.merchantNameOverride,
    ).toBeUndefined();
  });

  test("a caller with no finance role at all is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s, "Nobody");
    const txnId = await seedBankTxn(s, { merchantName: BANK_MERCHANT });

    await expect(
      s.as.mutation(api.finances.renameMerchant, {
        transactionId: txnId,
        merchantName: "Costco",
      }),
    ).rejects.toThrow();
  });

  test("another chapter's row is not renameable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Chicago",
    });
    const foreignTxnId = await seedBankTxn(other, { merchantName: BANK_MERCHANT });

    await expect(
      s.as.mutation(api.finances.renameMerchant, {
        transactionId: foreignTxnId,
        merchantName: "Costco",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});

describe("engine-written rows", () => {
  // Some rows in this column are not merchants at all — they're sentences the
  // reconciliation engine wrote into `description`. Renaming one is ALLOWED
  // (see `renameMerchant`'s doc comment): the override fills an empty merchant
  // slot rather than replacing the sentence, so a treasurer gets a scannable
  // label in the grid and the arithmetic stays exactly where it was.
  test("a transfer leg can be renamed without losing the engine's own sentence", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "transfer",
        flow: "transfer",
        amountCents: 22453,
        postedAt: Date.parse("2026-08-07T12:00:00-04:00"),
        description: ENGINE_DESCRIPTION,
        note: ENGINE_DESCRIPTION,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.finances.renameMerchant, {
      transactionId: txnId,
      merchantName: "Aug settlement — NY",
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.merchantNameOverride).toBe("Aug settlement — NY");
    // The engine's explanation — for a transfer leg this IS the whole audit
    // trail of how the number was computed — is untouched in both fields.
    expect(txn?.description).toBe(ENGINE_DESCRIPTION);
    expect(txn?.note).toBe(ENGINE_DESCRIPTION);

    // And the trail's opening line names what the row was called before,
    // which for a merchant-less row is that description.
    const trail = await trailFor(s, txnId);
    expect(trail[0]).toMatchObject({
      before: ENGINE_DESCRIPTION,
      after: "Aug settlement — NY",
    });
  });
});
