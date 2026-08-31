/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import { createReceipt } from "../lib/receiptLinks";
import { CENTRAL } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";

/**
 * THE CARDHOLDER WHOSE CARD DRAWS ON CENTRAL'S ACCOUNT.
 *
 * Reported 2026-08-31 by a Chapter 08 member on `/code`: *"i don't know if i
 * have the ability to code this transaction from my side, I cant select
 * anything except for uploading the receipt."*
 *
 * `increaseCardSync.ts` scopes a card to the Increase ACCOUNT it draws on,
 * never its holder's chapter ("your card determines whose account paid;
 * reconcile determines whose budget it was"), so a member on a central-account
 * card spends into the CENTRAL book with their `personId` on the row. That row
 * is listed to them as their own (`finances.personTransactions` says so in its
 * own comment) and chased from them by name (`lib/codingReminders.ts`) — and
 * every gate then refused them, because three of them shared one premise that
 * had gone stale: "central issues no cards, so a central row has no cardholder
 * to be".
 *
 * These tests pin BOTH halves: the spender can now finish their own central
 * charge with no finance grant at all, and nothing else about central widened —
 * a stranger is still refused, and deciding is still somebody else's job.
 */

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users"> },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A card drawn on CENTRAL's Increase account, held by a chapter member —
 *  `increaseCardSync.ts`'s "Kansi" case, verbatim. */
async function seedCentralCard(
  s: ChapterSetup,
  cardholderPersonId: Id<"people">,
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: CENTRAL,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** What `increaseLedger.ts` writes for a swipe on that card: a central-book
 *  row carrying the cardholder's `personId`. */
async function seedCentralCardTxn(
  s: ChapterSetup,
  opts: { cardId: Id<"cards">; personId: Id<"people"> },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: CENTRAL,
      source: "increase_card",
      flow: "outflow",
      amountCents: 1797,
      postedAt: Date.UTC(2026, 7, 30),
      merchantName: "TAPSTITCH INC.",
      cardId: opts.cardId,
      personId: opts.personId,
      cardLast4: "7303",
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(s: ChapterSetup): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      name: "Supplies",
      kind: "lineItem",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

describe("a central-account card charge, coded by its own cardholder", () => {
  test("the whole /code flow works with NO finance role", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    const me = await seedPerson(s, { name: "Michaela", userId: s.userId });
    const card = await seedCentralCard(s, me);
    const txnId = await seedCentralCardTxn(s, { cardId: card, personId: me });
    const categoryId = await seedCategory(s);

    // The page lists it as hers — this part always worked, and is what made
    // the refusals below read as a broken page rather than a locked door.
    const listed = await s.as.query(api.finances.personTransactions, {});
    expect(listed.map((r) => r.id)).toContain(txnId);

    // Opening the sheet. This is the one that mattered most: a refusal here
    // THROWS as the component mounts, so it took the whole page down with it
    // rather than disabling a button.
    const detail = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(detail.requiresCoding).toBe(true);
    expect(detail.coding).toBeNull();
    // Reading is not deciding: the spender gets the author's view, and the
    // review flags stay false on their own charge.
    expect(detail.canReview).toBe(false);
    expect(detail.canSelfApprove).toBe(false);

    // The category picker's own write path (already own-scoped — this is the
    // rule the other three gates were missing).
    await s.as.mutation(api.finances.submitOwnCharge, {
      transactionId: txnId,
      categoryId,
    });

    // The receipt.
    const storageId = await storeBlob(t);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId });

    // The words.
    const codingId = await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: "Thread and fabric for the chapter banner build day",
    });
    expect(codingId).toBeTruthy();

    // And the roster suggestions the meal branch of that form reads.
    const suggestions = await s.as.query(api.transactionCodings.attendeeSuggestions, {
      transactionId: txnId,
    });
    expect(suggestions.map((p) => p.name)).toContain("Michaela");
  });

  test("the no-receipt attestation is open to the spender too", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    const me = await seedPerson(s, { name: "Michaela", userId: s.userId });
    const card = await seedCentralCard(s, me);
    const txnId = await seedCentralCardTxn(s, { cardId: card, personId: me });

    // "If there genuinely is no receipt, say so right here and that counts" —
    // `/code`'s own promise, which the central branch refused to honor.
    const exceptionId = await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "no_receipt_issued",
      note: "Cash tip at the load-out; the vendor issues no receipt for tips.",
    });
    expect(exceptionId).toBeTruthy();

    // Filing it means being able to read what came of it (the rejection note
    // is how a send-back explains itself).
    const filed = await s.as.query(api.receiptExceptions.listForTransaction, {
      transactionId: txnId,
    });
    expect(filed).toHaveLength(1);
  });


  test("their own emailed receipt is still suggested on a central row", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    const me = await seedPerson(s, { name: "Michaela", userId: s.userId });
    const card = await seedCentralCard(s, me);
    const txnId = await seedCentralCardTxn(s, { cardId: card, personId: me });

    // What the inbound pipeline leaves behind: her own receipt, unlinked,
    // waiting for her to say "yes, that's the one" (`receiptInbox.ts` stopped
    // auto-attaching). She is the ONLY person who can say it.
    const storageId = await storeBlob(t);
    const receiptId = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: CENTRAL,
        storageId,
        source: "email",
        uploadedByPersonId: me,
        ocrAmountCents: 1797,
        ocrDate: Date.UTC(2026, 7, 30),
        ocrMerchant: "TAPSTITCH INC.",
      }),
    );

    const suggested = await s.as.query(api.receipts.suggestedForTransaction, {
      transactionId: txnId,
    });
    expect(suggested.map((r) => r.receiptId)).toContain(receiptId);

    await s.as.mutation(api.receipts.confirmSuggestedReceipt, {
      receiptId,
      transactionId: txnId,
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.receiptStorageId).toBe(storageId);
  });

  test("deciding is still somebody else's job — the spender cannot approve their own", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    const me = await seedPerson(s, { name: "Michaela", userId: s.userId });
    const card = await seedCentralCard(s, me);
    const txnId = await seedCentralCardTxn(s, { cardId: card, personId: me });

    const storageId = await storeBlob(t);
    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId });
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: "Thread and fabric for the chapter banner build day",
    });

    await expect(
      s.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toThrow(ConvexError);
  });

  test("a member who is NOT the cardholder is still refused on a central row", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "michaela@publicworship.life" });
    // The caller has a roster row, but the card is somebody else's.
    await seedPerson(s, { name: "Michaela", userId: s.userId });
    const someoneElse = await seedPerson(s, { name: "Kansi" });
    const card = await seedCentralCard(s, someoneElse);
    const txnId = await seedCentralCardTxn(s, {
      cardId: card,
      personId: someoneElse,
    });

    await expect(
      s.as.query(api.transactionCodings.getForTransaction, { transactionId: txnId }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "no_receipt_issued",
        note: "Not my charge, and not my place to say what it was.",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.query(api.receipts.suggestedForTransaction, { transactionId: txnId }),
    ).rejects.toThrow(ConvexError);
    const storageId = await storeBlob(t);
    await expect(
      s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId }),
    ).rejects.toThrow(ConvexError);
  });
});
