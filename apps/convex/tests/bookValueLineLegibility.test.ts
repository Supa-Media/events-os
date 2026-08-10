/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  disarmCodingPolicy,
  newT,
  run,
  setupChapter,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { signedBookCents } from "../lib/bookBalance";

/**
 * WHAT A LINE OF BOOK VALUE SAYS ABOUT ITSELF.
 *
 * The owner, 2026-08-10, on CENTRAL — EVERY LINE: "it doesn't even give me
 * like exacts of the transactions posted to it or sort of like the coded rows
 * and stuff like that… I just see like stripe rows and stuff like that. Also,
 * to understand why there's a huge $2,000 charge on it, are we including
 * transfers in this? I'm confused."
 *
 * Two of those three were server-side omissions and are pinned here:
 *
 *  1. Seven of thirteen rows read "(no description)". Every Relay-feed
 *     (`stripe_fc`) and Increase-card row in production lands with
 *     `description` unset and the merchant string in `merchantName` — the
 *     query returned `description` alone, so the identifier that was on the
 *     document never reached the screen.
 *
 *  2. Every zero got one sentence: "Transfer with no recorded direction."
 *     `lib/bookBalance.ts` has five different reasons for returning zero, and
 *     four of them are deliberate and complete. Telling the treasurer they
 *     need a direction sent him after work that doesn't exist.
 *
 * THE ARITHMETIC IS UNTOUCHED, and the last test in each block is what says
 * so: `signedBookCents` decides, this query reports, and reclassifying a
 * reason must never move a total by a cent.
 */

async function asCentralEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, async (ctx) => {
    await ctx.db.insert("specializedRoles", {
      personId,
      title: "executive_director",
      roleKind: "leadership",
      scope: "central",
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    });
  });
  return personId;
}

/** One ledger row, with only the fields a case cares about spelled out.
 *  `Doc<"transactions">` is wide and every field here is optional on it, so
 *  the overlay is cast once rather than typed per call site. */
async function insertTxn(
  s: ChapterSetup,
  book: Id<"chapters"> | "central",
  fields: Record<string, unknown>,
): Promise<Id<"transactions">> {
  await disarmCodingPolicy(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: book,
      source: "manual",
      flow: "outflow",
      amountCents: 1000,
      postedAt: Date.now(),
      status: "unreviewed",
      createdAt: Date.now(),
      ...fields,
    } as Parameters<typeof ctx.db.insert<"transactions">>[1]),
  );
}

const lines = (s: ChapterSetup) =>
  s.as.query(api.reconciliation.bookValueLines, { scope: "central" });

describe("a row says which charge it was, even with no description", () => {
  test("a Relay-feed row's merchant string reaches the ledger — the shape that read '(no description)'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    // Verbatim production shape: description unset, merchant string present.
    await insertTxn(s, "central", {
      source: "stripe_fc",
      amountCents: 5541,
      merchantName:
        "Purchase from AMAZON.COM*569YQ  |  Address: SEATTLE, WA, US  |  **8728",
      cardLast4: "8728",
      status: "categorized",
    });

    const row = (await lines(s)).ledger[0];
    expect(row.description).toBe("");
    expect(row.merchantName).toContain("AMAZON.COM");
    expect(row.cardLast4).toBe("8728");
    expect(row.source).toBe("stripe_fc");
  });

  test("the bookkeeper's rename, the note and the cardholder all travel with the row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asCentralEd(s);
    await insertTxn(s, "central", {
      source: "relay_csv",
      merchantName: "IC* COSTCO BY IN CAR",
      merchantNameOverride: "Costco",
      note: "Snacks for the volunteer green room",
      personId,
    });

    const row = (await lines(s)).ledger[0];
    expect(row.merchantNameOverride).toBe("Costco");
    // The provider's own string is NOT overwritten by a rename — provenance
    // survives, and the screen resolves which to show.
    expect(row.merchantName).toBe("IC* COSTCO BY IN CAR");
    expect(row.note).toBe("Snacks for the volunteer green room");
    expect(row.personName).toBe("Caller");
  });

  test("the coding shows the AUTHOR's words, not the approver's public redaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asCentralEd(s);
    const transactionId = await insertTxn(s, "central", {
      source: "increase_card",
      merchantName: "AMTRAK",
      codingState: "approved",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("transactionCodings", {
        transactionId,
        chapterId: "central",
        expenseType: "travel",
        businessPurpose:
          "Travel with Michael Reid from all team meeting in Manhattan",
        publicPurpose: "Travel from the all-team meeting in Manhattan",
        status: "approved",
        codedByPersonId: personId,
        codedByUserId: s.userId,
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // `publishedPurpose` is the PUBLIC ledger's rule and is deliberately not
    // used here: this page is gated on `requireReconciliationAudit` (ED / FM),
    // and its whole job is explaining a charge. Handing those two roles the
    // redaction would hide detail from the only people entitled to all of it.
    const row = (await lines(s)).ledger[0];
    expect(row.codedPurpose).toBe(
      "Travel with Michael Reid from all team meeting in Manhattan",
    );
  });

  test("a row counted as ZERO is just as identifiable as one that counted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await insertTxn(s, "central", {
      source: "stripe_fc",
      status: "excluded",
      merchantName: "Purchase from DUPLICATE MERCHANT",
    });

    const ignored = (await lines(s)).ignored[0];
    expect(ignored.reason).toBe("excluded");
    expect(ignored.merchantName).toBe("Purchase from DUPLICATE MERCHANT");
    expect(ignored.source).toBe("stripe_fc");
  });
});

describe("each zero is given its OWN reason", () => {
  test("a hand-marked bank transfer is not reported as a missing direction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    // `preMarkFlow` is written by `finances.markAsTransfer` and nothing else:
    // a human declared these two rows one movement between our own accounts.
    await insertTxn(s, "central", {
      source: "stripe_fc",
      flow: "transfer",
      preMarkFlow: "outflow",
      amountCents: 100_000,
    });

    const result = await lines(s);
    expect(result.ledger).toHaveLength(0);
    expect(result.ignored[0].reason).toBe("marked_transfer");
  });

  test("a balance settlement leg is named as one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await insertTxn(s, "central", {
      source: "transfer",
      flow: "transfer",
      transferOrigin: "balance_settlement",
      transferDirection: "central_to_chapter",
      transferGroupId: "balsettle-test-2026-08-10",
      amountCents: 461_690,
    });

    expect((await lines(s)).ignored[0].reason).toBe("balance_settlement");
  });

  test("only a genuinely unrecognized transfer shape is reported as one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await insertTxn(s, "central", {
      source: "transfer",
      flow: "transfer",
      amountCents: 25_000,
    });

    expect((await lines(s)).ignored[0].reason).toBe("unknown_transfer_shape");
  });

  test("a payout deposit and a linked-gift credit keep their own reasons", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await insertTxn(s, "central", {
      source: "increase_ach",
      flow: "inflow",
      amountCents: 50_000,
      payoutProcessor: "stripe",
    });

    expect((await lines(s)).ignored[0].reason).toBe("payout_deposit");
  });

  test("reclassifying the reasons moved no total — the arithmetic is `signedBookCents`'s alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    await insertTxn(s, "central", { amountCents: 8085 });
    await insertTxn(s, "central", {
      source: "stripe_fc",
      flow: "transfer",
      preMarkFlow: "outflow",
      amountCents: 100_000,
    });
    await insertTxn(s, "central", {
      source: "transfer",
      flow: "transfer",
      transferOrigin: "balance_settlement",
      amountCents: 461_690,
    });
    await insertTxn(s, "central", {
      source: "transfer",
      flow: "transfer",
      amountCents: 25_000,
    });
    await insertTxn(s, "central", {
      source: "increase_ach",
      flow: "inflow",
      amountCents: 3_000,
    });

    const result = await lines(s);

    // NOT A HARDCODED PIN. The expected total is derived from the AUTHORITY,
    // over the same documents, in the test — so this fails if the query's
    // reclassification ever changes which rows reach the sum, and it cannot
    // be made to pass by editing a number to match a new answer.
    const authority = await run(s.t, async (ctx) => {
      const all = await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", "central" as const))
        .collect();
      return all.reduce((sum, tr) => sum + signedBookCents(tr), 0);
    });
    expect(result.ledgerNetCents).toBe(authority);

    // And the published total is exactly the rows the page shows, so a row
    // moving between the two tabs can never silently change the figure.
    expect(result.ledgerNetCents).toBe(
      result.ledger.reduce((sum, l) => sum + l.amountCents, 0),
    );
    expect(result.bookBalanceCents).toBe(
      result.revenueCents + result.ledgerNetCents,
    );

    // The grouped rung re-derives the same arithmetic on its own code path;
    // the two must never quietly disagree.
    const breakdown = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: "central",
    });
    expect(breakdown.ledgerNetCents).toBe(result.ledgerNetCents);
    expect(breakdown.bookBalanceCents).toBe(result.bookBalanceCents);
  });
});

describe("the 'same amount, same day' members are named too", () => {
  test("an unlabeled row names its rail there as well — not a bare 'ledger:'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const at = Date.now();
    // Two unlabeled Relay rows, same amount, same day — the shape the wide net
    // exists to surface, and the shape that has no merchant string to print.
    await insertTxn(s, "central", { source: "stripe_fc", amountCents: 5541, postedAt: at });
    await insertTxn(s, "central", { source: "stripe_fc", amountCents: 5541, postedAt: at });

    const group = (await lines(s)).sameAmountSameDay[0];
    expect(group.members).toHaveLength(2);
    // `displayMerchantName` chains on `??` and the projection normalizes
    // `description` to `""`, so it resolved to the empty string and printed
    // "ledger: " — the original complaint, one tab over.
    for (const member of group.members) {
      expect(member).toBe("ledger: Unlabeled relay bank feed row");
    }
  });

  test("an engine leg is named the same way here as on the ledger tab", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const at = Date.now();
    const fields = {
      source: "transfer",
      flow: "transfer",
      transferOrigin: "auto_settlement",
      transferDirection: "chapter_to_central",
      amountCents: 4_000,
      postedAt: at,
    };
    await insertTxn(s, "central", { ...fields, transferGroupId: "g1" });
    await insertTxn(s, "central", { ...fields, transferGroupId: "g2" });

    const group = (await lines(s)).sameAmountSameDay[0];
    // "Auto settlement", not the generic "Recorded transfer" its `source`
    // reads — the same rail name `railLabel` gives it on the ledger tab.
    for (const member of group.members) {
      expect(member).toBe("ledger: Unlabeled auto settlement row");
    }
  });
});

describe("a transfer that DOES count says who it crossed to", () => {
  test("an auto-settlement leg stays in the ledger and names the other book", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const groupId = "autosettle-test-2026-08-10";
    // The pair the owner was looking at: central's card bore New York's
    // spending, and the settlement moves the cost onto New York. Deliberately
    // SIGNED by `signedBookCents` — it corrects who bore a cost, which is not
    // the same as cash changing accounts.
    await insertTxn(s, "central", {
      source: "transfer",
      flow: "transfer",
      transferOrigin: "auto_settlement",
      transferDirection: "central_to_chapter",
      transferGroupId: groupId,
      amountCents: 200_395,
      status: "reconciled",
      description:
        "Auto: settlement of cross-book card spend through 2026-08-10.",
    });
    await insertTxn(s, s.chapterId, {
      source: "transfer",
      flow: "transfer",
      transferOrigin: "auto_settlement",
      transferDirection: "central_to_chapter",
      transferGroupId: groupId,
      amountCents: 200_395,
      status: "reconciled",
    });

    const result = await lines(s);
    expect(result.ignored).toHaveLength(0);
    const row = result.ledger[0];
    expect(row.flow).toBe("transfer");
    expect(row.transferOrigin).toBe("auto_settlement");
    // Central is the paying side, so its book gives up the amount.
    expect(row.amountCents).toBe(-200_395);
    // `setupChapter`'s default chapter — the very book the owner's row named.
    expect(row.counterpartyName).toBe("New York");
  });
});
