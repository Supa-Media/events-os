/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import { isSpend } from "../finances";
import { signedBookCents } from "../lib/bookBalance";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * `finances.markAsTransfer` / `unmarkTransfer` / `markAsPayout` /
 * `unmarkPayout` — reclassifying an ALREADY-INGESTED bank row.
 *
 * The founder-reported bug this exists for: a row reading
 * "PUBLIC WORSHIP | Transfer" landed in "Needs budget" as ordinary spend,
 * because every ingest path sets `flow` from the sign of the amount alone and
 * nothing has ever recognised a transfer — and there was no way to fix it
 * after the fact.
 *
 * The two cases are asymmetric ON PURPOSE, and most of what's asserted here is
 * that asymmetry holding:
 *  - a TRANSFER becomes `flow:"transfer"` (out of spend), requires BOTH legs,
 *    and round-trips losslessly back to the original per-leg flow;
 *  - a PAYOUT stays `flow:"inflow"` (it's real revenue — donations live in
 *    `gifts` and never reach this table, so excluding it would erase income)
 *    and is single-sided.
 * A marked TRANSFER keeps owing a receipt; a marked PAYOUT owes nothing
 * (founder, 2026-08-14 — see "a marked payout owes no documentation" below).
 * Both write `financeAuditLog`.
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

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents: number;
    flow?: Doc<"transactions">["flow"];
    source?: Doc<"transactions">["source"];
    status?: Doc<"transactions">["status"];
    merchantName?: string;
    isPersonal?: boolean;
    note?: string;
    currency?: string;
    /** Defaults to the chapter; pass `"central"` for the other side of a
     *  cross-book movement. */
    chapterId?: Id<"chapters"> | "central";
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: opts.chapterId ?? s.chapterId,
      // `stripe_fc` is the real-world path for the founder's row (the Relay
      // account synced via Stripe Financial Connections).
      source: opts.source ?? "stripe_fc",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      currency: opts.currency,
      postedAt: Date.now(),
      merchantName: opts.merchantName ?? "PUBLIC WORSHIP | Transfer",
      note: opts.note,
      isPersonal: opts.isPersonal,
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

/** A bookkeeper (the marking floor) who can act in this chapter. */
async function setupBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const me = await seedPerson(s, { name: "Book Keeper", userId: s.userId });
  await grantRole(s, me, "bookkeeper");
  return me;
}

/** Marking a cross-book pair authorizes EACH leg at its own scope, so the
 *  caller needs central rights as well as the chapter's. */
async function grantCentralRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: "central",
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    }),
  );
}

const txn = (s: ChapterSetup, id: Id<"transactions">) =>
  run(s.t, (ctx) => ctx.db.get(id));

const auditFor = (s: ChapterSetup, id: Id<"transactions">) =>
  run(s.t, async (ctx) =>
    (await ctx.db.query("financeAuditLog").collect()).filter(
      (e) => e.subjectId === (id as string),
    ),
  );

// ── Refunds ─────────────────────────────────────────────────────────────────
// A refund is a PAIR like a transfer, but it exists for a different reason: a
// transfer belongs to no budget, whereas a refund is marked precisely so the
// ORIGINAL CHARGE stops counting against one. `isSpend` is outflow-only, so no
// amount of coding the credit could ever reduce a category — a refunded charge
// consumed its budget forever.

describe("finances.markAsRefund", () => {
  test("stops the refunded charge counting as spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);

    const charge = await seedTxn(s, { amountCents: 67_640, flow: "outflow" });
    const credit = await seedTxn(s, { amountCents: 67_640, flow: "inflow" });
    // Before: the charge is spend and owes a budget.
    expect(isSpend((await txn(s, charge))!)).toBe(true);

    await s.as.mutation(api.finances.markAsRefund, {
      chargeTransactionId: charge,
      refundTransactionId: credit,
    });

    // After: it isn't. Every budget total, "needs budget" badge and dashboard
    // drill reads through this one predicate, so they all correct together.
    expect(isSpend((await txn(s, charge))!)).toBe(false);
    expect((await txn(s, charge))!.refundedByTransactionId).toBe(credit);
    expect((await txn(s, credit))!.refundsTransactionId).toBe(charge);
  });

  test("book value is unchanged — it always netted to zero", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const charge = await seedTxn(s, { amountCents: 67_640, flow: "outflow" });
    const credit = await seedTxn(s, { amountCents: 67_640, flow: "inflow" });
    await s.as.mutation(api.finances.markAsRefund, {
      chargeTransactionId: charge,
      refundTransactionId: credit,
    });
    const pair = [(await txn(s, charge))!, (await txn(s, credit))!];
    expect(pair.reduce((sum, r) => sum + signedBookCents(r), 0)).toBe(0);
  });

  test("refuses a partial refund rather than approximating it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const charge = await seedTxn(s, { amountCents: 67_640, flow: "outflow" });
    const credit = await seedTxn(s, { amountCents: 30_000, flow: "inflow" });
    // Dropping the charge whole when only part came back would UNDERSTATE
    // spend, and nothing on screen would say so.
    await expect(
      s.as.mutation(api.finances.markAsRefund, {
        chargeTransactionId: charge,
        refundTransactionId: credit,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("refuses two rows moving the same way", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const a = await seedTxn(s, { amountCents: 5_000, flow: "outflow" });
    const b = await seedTxn(s, { amountCents: 5_000, flow: "outflow" });
    await expect(
      s.as.mutation(api.finances.markAsRefund, {
        chargeTransactionId: a,
        refundTransactionId: b,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("un-marking puts the charge back into spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const charge = await seedTxn(s, { amountCents: 67_640, flow: "outflow" });
    const credit = await seedTxn(s, { amountCents: 67_640, flow: "inflow" });
    await s.as.mutation(api.finances.markAsRefund, {
      chargeTransactionId: charge,
      refundTransactionId: credit,
    });
    // Reversible from EITHER row — a bookkeeper shouldn't have to work out
    // which half of the pair they're allowed to click.
    await s.as.mutation(api.finances.unmarkRefund, { transactionId: credit });
    expect(isSpend((await txn(s, charge))!)).toBe(true);
    expect((await txn(s, charge))!.refundedByTransactionId).toBeUndefined();
    expect((await txn(s, credit))!.refundsTransactionId).toBeUndefined();
  });
});

describe("finances.markAsTransfer", () => {
  // ── Cross-book marking (owner report, 2026-08-07) ────────────────────────
  // A $2,873.21 central→New York move made by hand in Increase arrived as two
  // ordinary bank rows, and marking them was refused with "record it with the
  // Transfers tool instead" — a tool that INSERTS two fresh legs and would have
  // left four rows for one movement, booking it twice.

  test("marks a central↔chapter pair of existing rows and names the crossing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await setupBookkeeper(s);
    await grantCentralRole(s, me, "bookkeeper");

    const centralLeg = await seedTxn(s, {
      amountCents: 287_321,
      flow: "outflow",
      chapterId: "central",
    });
    const chapterLeg = await seedTxn(s, { amountCents: 287_321, flow: "inflow" });

    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: centralLeg,
      counterpartTransactionId: chapterLeg,
      note: "moved New York's balance to its own account",
    });

    const c = await txn(s, centralLeg);
    const ch = await txn(s, chapterLeg);
    expect(c!.flow).toBe("transfer");
    expect(ch!.flow).toBe("transfer");
    // Central paid out, so the money crossed central → chapter.
    expect(c!.transferDirection).toBe("central_to_chapter");
    expect(ch!.transferDirection).toBe("central_to_chapter");
    expect(c!.transferGroupId).toBe(ch!.transferGroupId);
    // `preMarkFlow` survives on both, which is what keeps book value still.
    expect(c!.preMarkFlow).toBe("outflow");
    expect(ch!.preMarkFlow).toBe("inflow");
  });

  test("a chapter→central pair names the crossing the other way", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await setupBookkeeper(s);
    await grantCentralRole(s, me, "bookkeeper");

    const chapterLeg = await seedTxn(s, { amountCents: 50_000, flow: "outflow" });
    const centralLeg = await seedTxn(s, {
      amountCents: 50_000,
      flow: "inflow",
      chapterId: "central",
    });

    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: chapterLeg,
      counterpartTransactionId: centralLeg,
    });

    expect((await txn(s, chapterLeg))!.transferDirection).toBe("chapter_to_central");
    expect((await txn(s, centralLeg))!.transferDirection).toBe("chapter_to_central");
  });

  test("un-marking a cross-book pair clears the direction with the rest", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await setupBookkeeper(s);
    await grantCentralRole(s, me, "bookkeeper");

    const centralLeg = await seedTxn(s, {
      amountCents: 10_000,
      flow: "outflow",
      chapterId: "central",
    });
    const chapterLeg = await seedTxn(s, { amountCents: 10_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: centralLeg,
      counterpartTransactionId: chapterLeg,
    });
    await s.as.mutation(api.finances.unmarkTransfer, { transactionId: centralLeg });

    const c = await txn(s, centralLeg);
    const ch = await txn(s, chapterLeg);
    // Left behind, `transferDirection` would have `signedBookCents` resolve a
    // crossing for a transfer that no longer exists.
    expect(c!.transferDirection).toBeUndefined();
    expect(ch!.transferDirection).toBeUndefined();
    expect(c!.flow).toBe("outflow");
    expect(ch!.flow).toBe("inflow");
  });

  test("a same-scope marking still names no crossing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);

    const out = await seedTxn(s, { amountCents: 4_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 4_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    // One account to another INSIDE one book — there is no central/chapter
    // direction to state, and inventing one would misreport the movement.
    expect((await txn(s, out))!.transferDirection).toBeUndefined();
    expect((await txn(s, inn))!.transferDirection).toBeUndefined();
  });

  test("marks both legs, drops them out of spend, and links them as one pair", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);

    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
      note: "moved to the operating account",
    });

    const outDoc = await txn(s, out);
    const innDoc = await txn(s, inn);
    expect(outDoc!.flow).toBe("transfer");
    expect(innDoc!.flow).toBe("transfer");
    // The original direction survives, so un-marking can restore it.
    expect(outDoc!.preMarkFlow).toBe("outflow");
    expect(innDoc!.preMarkFlow).toBe("inflow");
    // One shared group id ties the pair together.
    expect(outDoc!.transferGroupId).toBeTruthy();
    expect(outDoc!.transferGroupId).toBe(innDoc!.transferGroupId);
    // Same-scope marking invents no central<->chapter crossing.
    expect(outDoc!.transferDirection).toBeUndefined();
    // Provenance is not overwritten — the row really did come from the feed.
    expect(outDoc!.source).toBe("stripe_fc");
    expect(outDoc!.note).toBe("moved to the operating account");

    // The actual point: it leaves "Needs budget" / spend.
    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.spend).toBe(0);
    expect(counts.needs_budget).toBe(0);
    expect(counts.transfers).toBe(2);
  });

  test("both legs still owe a receipt after marking (founder constraint)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);

    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    // Before this feature the outflow leg would have vanished from the chase
    // the instant it stopped being spend, and the inflow leg was never in it.
    //
    // THE CHASE IS THE SURFACE THAT OWNS THIS CONSTRAINT, so it's what gets
    // asserted. Reconcile no longer lists transfer legs by default — nothing to
    // code, nothing to close — which means its `missing_receipt` FACET goes
    // quiet here (a facet count promises rows the queue would show, and it
    // would show none). That is a change of venue, not of obligation: both legs
    // still return true from `needsDocumentation`, both still appear on the
    // chase page, and `chaseCount` — what the "Chase receipts" button is gated
    // on — still counts them, so the route to them stays open.
    const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(res.counts.missing_receipt).toBe(0);
    expect(res.chaseCount).toBe(2);

    const chase = await s.as.query(api.finances.receiptChase, {});
    expect(chase.count).toBe(2);
    expect(chase.groups.flatMap((g) => g.transactions.map((c) => c.id)).sort()).toEqual(
      [out, inn].sort(),
    );
  });

  test("requires two DIFFERENT rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const only = await seedTxn(s, { amountCents: 500 });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: only,
        counterpartTransactionId: only,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("refuses two rows moving the same way", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const a = await seedTxn(s, { amountCents: 500, flow: "outflow" });
    const b = await seedTxn(s, { amountCents: 500, flow: "outflow" });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: a,
        counterpartTransactionId: b,
      }),
    ).rejects.toThrow(/one row leaving an account and one arriving/i);
  });

  test("refuses mismatched amounts", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 99_000, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(/amounts don't match/i);
  });

  test("refuses a row already marked as a payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 500, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 500, flow: "inflow" });
    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: inn,
      processor: "givebutter",
    });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(/processor payout/i);
  });

  test("a viewer can't mark", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s, { name: "Nosy Viewer", userId: s.userId });
    await grantRole(s, me, "viewer");
    const out = await seedTxn(s, { amountCents: 500, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 500, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.markAsTransfer, {
        transactionId: out,
        counterpartTransactionId: inn,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("writes an audit entry on BOTH legs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
      note: "sweep to savings",
    });

    for (const [id, before] of [
      [out, "outflow"],
      [inn, "inflow"],
    ] as const) {
      const entries = await auditFor(s, id);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("transfer_mark");
      expect(entries[0].field).toBe("flow");
      expect(entries[0].before).toBe(before);
      expect(entries[0].after).toBe("transfer");
      expect(entries[0].reason).toBe("sweep to savings");
      expect(entries[0].actorUserId).toBeTruthy();
    }
  });
});

describe("finances.unmarkTransfer", () => {
  test("restores BOTH legs to their original flow and clears the pair", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const out = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const inn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: out,
      counterpartTransactionId: inn,
    });

    // Un-marking from EITHER leg undoes the whole pair.
    await s.as.mutation(api.finances.unmarkTransfer, { transactionId: inn });

    const outDoc = await txn(s, out);
    const innDoc = await txn(s, inn);
    expect(outDoc!.flow).toBe("outflow");
    expect(innDoc!.flow).toBe("inflow");
    expect(outDoc!.preMarkFlow).toBeUndefined();
    expect(innDoc!.preMarkFlow).toBeUndefined();
    expect(outDoc!.transferGroupId).toBeUndefined();
    expect(innDoc!.transferGroupId).toBeUndefined();

    // Back in spend exactly as before — a lossless round trip.
    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.spend).toBe(1);
    expect(counts.transfers).toBe(0);
  });

  test("refuses a transfer leg the app CREATED, not one a human marked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    // `source:"transfer"` + no `preMarkFlow` — a `transfers.recordTransfer` leg.
    const created = await seedTxn(s, {
      amountCents: 500,
      flow: "transfer",
      source: "transfer",
    });

    await expect(
      s.as.mutation(api.finances.unmarkTransfer, { transactionId: created }),
    ).rejects.toThrow(/recorded transfer/i);
  });

  test("leaves HISTORICAL transfer legs alone — not markable, not chased", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    // Retired kinds still sitting on prod rows. None carry `preMarkFlow`, so
    // none may be un-marked (which would rewrite a booked leg to `outflow`)
    // and none may be dragged into the receipt chase.
    for (const source of ["skim", "launch_grant", "settlement", "reimbursement"] as const) {
      const legacy = await seedTxn(s, {
        amountCents: 500,
        flow: "transfer",
        source,
      });
      await expect(
        s.as.mutation(api.finances.unmarkTransfer, { transactionId: legacy }),
      ).rejects.toThrow(ConvexError);
    }

    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    // They DO fall under Kind → Transfers — that key means "an internal
    // transfer leg", not "a leg someone marked", and it's the only way back to
    // rows the default queue now hides. What "not markable, not chased" pins is
    // the two lines below it: `isMarkedTransfer` is still false for them (so
    // `unmarkTransfer` refuses, asserted above) and they owe no documentation.
    expect(counts.transfers).toBe(4);
    expect(counts.missing_receipt).toBe(0);
    // And they're out of the default queue entirely: nothing to code, nothing
    // to document, nothing to close.
    expect(counts.all).toBe(0);
  });
});

describe("finances.markAsPayout", () => {
  test("labels the deposit but leaves it as INCOME", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, {
      amountCents: 250_000,
      flow: "inflow",
      merchantName: "GIVEBUTTER PAYOUT",
    });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
    });

    const doc = await txn(s, deposit);
    expect(doc!.payoutProcessor).toBe("givebutter");
    // THE load-bearing assertion. Donations live in `gifts` and never reach
    // this table, so this row is the ledger's only record of that revenue —
    // flipping it to `flow:"transfer"` would erase the org's income.
    expect(doc!.flow).toBe("inflow");
    expect(doc!.preMarkFlow).toBeUndefined();
    expect(doc!.transferGroupId).toBeUndefined();

    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.payouts).toBe(1);
    expect(counts.transfers).toBe(0);
    // AND IT OWES NO DOCUMENTATION (founder, 2026-08-14). Marking a payout
    // briefly put it into the receipt chase — "an `inflow` was NEVER in this
    // bucket, so this is the first time a deposit can be chased for its
    // settlement report" — and the founder reversed that looking at a
    // not-publishable count made almost entirely of payouts: "Payouts
    // shouldn't need documentation." Nobody bought anything; the money was
    // already counted at the giving layer and this row is its arrival.
    expect(counts.missing_receipt).toBe(0);
  });

  test("refuses an outflow — a payout is money arriving", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const spend = await seedTxn(s, { amountCents: 500, flow: "outflow" });

    await expect(
      s.as.mutation(api.finances.markAsPayout, {
        transactionId: spend,
        processor: "stripe",
      }),
    ).rejects.toThrow(/only an inflow/i);
  });

  test("re-marking to a different processor logs the change; un-marking clears it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 250_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
    });
    // A true no-op writes nothing.
    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
    });
    expect(await auditFor(s, deposit)).toHaveLength(1);

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "stripe",
    });
    await s.as.mutation(api.finances.unmarkPayout, { transactionId: deposit });

    const doc = await txn(s, deposit);
    expect(doc!.payoutProcessor).toBeUndefined();
    expect(doc!.flow).toBe("inflow"); // never moved, in either direction

    const entries = await auditFor(s, deposit);
    expect(entries.map((e) => e.action)).toEqual([
      "payout_mark",
      "payout_mark",
      "payout_mark",
    ]);
    expect(entries[1].before).toBe("Givebutter");
    expect(entries[1].after).toBe("Stripe");
    expect(entries[2].before).toBe("Stripe");
    expect(entries[2].after).toBeUndefined();
  });

  test("un-marking a row that was never marked is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 500, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.unmarkPayout, { transactionId: deposit }),
    ).rejects.toThrow(/isn't marked/i);
  });
});

// ── markAsPayout — "whose money is this?" (whole-deposit book allocation) ────
// Founder, 2026-08-07: "some Givebutter payouts are for central, and some are
// for the New York chapter... right now they all go to central." Marking a
// payout can now also state which BOOK the money belongs to; a differing book
// gets ONE whole-amount transfer pair (`transferOrigin:"payout_allocation"`,
// deterministic `payoutalloc-manual-<txnId>` group id). Custody never moves —
// the deposit row stays on the bank account's own book.

describe("finances.markAsPayout — allocateToScope", () => {
  const allocationLegs = (s: ChapterSetup, id: Id<"transactions">) =>
    run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_transfer_group", (q) =>
          q.eq("transferGroupId", `payoutalloc-manual-${id}`),
        )
        .collect(),
    );

  test("allocating a chapter-book deposit to central books ONE chapter→central pair", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, {
      amountCents: 250_000,
      flow: "inflow",
      merchantName: "GIVEBUTTER PAYOUT",
    });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
      allocateToScope: "central",
    });

    // The deposit row itself: labeled, still inflow, still on the chapter book.
    const doc = await txn(s, deposit);
    expect(doc!.payoutProcessor).toBe("givebutter");
    expect(doc!.flow).toBe("inflow");
    expect(doc!.chapterId).toBe(s.chapterId);

    const legs = await allocationLegs(s, deposit);
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      expect(leg.amountCents).toBe(250_000);
      expect(leg.transferDirection).toBe("chapter_to_central");
      expect(leg.transferOrigin).toBe("payout_allocation");
      expect(leg.description).toMatch(/Givebutter payout allocated to Central/);
    }

    // Stating the book it ALREADY sits on is a label-only no-op.
    const deposit2 = await seedTxn(s, { amountCents: 100, flow: "inflow" });
    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit2,
      processor: "givebutter",
      allocateToScope: s.chapterId,
    });
    expect(await allocationLegs(s, deposit2)).toHaveLength(0);
  });

  test("one allocation per deposit, ever — a second differing attempt is refused loudly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 5_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
      allocateToScope: "central",
    });
    await expect(
      s.as.mutation(api.finances.markAsPayout, {
        transactionId: deposit,
        processor: "givebutter",
        allocateToScope: "central",
      }),
    ).rejects.toThrow(/already allocated/i);
    expect(await allocationLegs(s, deposit)).toHaveLength(2);
  });

  test("un-marking is BLOCKED while the allocation pair exists", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 5_000, flow: "inflow" });

    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: deposit,
      processor: "givebutter",
      allocateToScope: "central",
    });
    await expect(
      s.as.mutation(api.finances.unmarkPayout, { transactionId: deposit }),
    ).rejects.toThrow(/offsetting transfer/i);
    // Label survived the refused unmark.
    expect((await txn(s, deposit))!.payoutProcessor).toBe("givebutter");
  });

  test("a deposit the Stripe engine already matched is refused (no double-move)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const deposit = await seedTxn(s, { amountCents: 5_000, flow: "inflow" });
    await run(s.t, (ctx) => ctx.db.patch(deposit, { stripePayoutId: "po_x" }));

    await expect(
      s.as.mutation(api.finances.markAsPayout, {
        transactionId: deposit,
        processor: "stripe",
        allocateToScope: "central",
      }),
    ).rejects.toThrow(/item-by-item/i);
  });

  test("chapter→chapter allocation is unsupported and says so", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Columbus",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const deposit = await seedTxn(s, { amountCents: 5_000, flow: "inflow" });

    await expect(
      s.as.mutation(api.finances.markAsPayout, {
        transactionId: deposit,
        processor: "givebutter",
        allocateToScope: otherChapterId,
      }),
    ).rejects.toThrow(/central and a chapter/i);
  });
});

/**
 * A MARKED PAYOUT OWES NO DOCUMENTATION (founder, 2026-08-14).
 *
 * This REVERSES the rule the marking feature shipped with. Marking a payout
 * put it into the receipt chase for the first time — "an `inflow` was NEVER in
 * this bucket to begin with, so this is the first time a deposit can be chased
 * for its settlement report at all" — and the founder overruled it looking at
 * a dashboard: "it says nine rows not publishable yet, no documentation — but
 * when you click on it, most of the rows are quite literally payouts and stuff
 * like that. Payouts shouldn't need documentation."
 *
 * It follows the FEE precedent (`isNonDiscretionaryFee`): a cost or an arrival
 * nobody chose, with no purchase behind it and therefore no receipt that could
 * ever exist. What is asserted here, one test per surface, is that the
 * carve-out reaches EVERY reader of "owes documentation" — the grid's two
 * facets, the chase entry point, the chase list itself. A carve-out applied in
 * one place and not the others is the dead-number defect this file's own
 * `needsDocumentation` comment was written about, and it is why all of these
 * predicates now share `owesDocumentation`. (The publishing gate's copy of the
 * same assertion is in `publishability.test.ts`, which reads the other
 * predicate, `isUndocumented`.)
 *
 * A marked TRANSFER is asserted alongside in each case, unchanged: it still
 * owes its bank statement. The two markings were deliberately symmetric here
 * and are now deliberately not, so the tests say both halves out loud.
 */
describe("a marked payout owes no documentation", () => {
  async function markedPair(s: ChapterSetup): Promise<{
    payout: Id<"transactions">;
    transferOut: Id<"transactions">;
  }> {
    const payout = await seedTxn(s, {
      amountCents: 250_000,
      flow: "inflow",
      merchantName: "GIVEBUTTER PAYOUT",
    });
    await s.as.mutation(api.finances.markAsPayout, {
      transactionId: payout,
      processor: "givebutter",
    });
    const transferOut = await seedTxn(s, { amountCents: 100_000, flow: "outflow" });
    const transferIn = await seedTxn(s, { amountCents: 100_000, flow: "inflow" });
    await s.as.mutation(api.finances.markAsTransfer, {
      transactionId: transferOut,
      counterpartTransactionId: transferIn,
    });
    return { payout, transferOut };
  }

  test("the chase list and its entry-point count both leave it out", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const { payout } = await markedPair(s);

    // `chaseCount` is what gates the "Chase receipts" entry point and
    // `receiptChase` is the list behind it; both run `isChaseable`, so a
    // number that still counted the payout would open a list that didn't show
    // it. Only the two marked transfer legs are left.
    const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(res.chaseCount).toBe(2);
    const chase = await s.as.query(api.finances.receiptChase, {});
    expect(chase.count).toBe(2);
    expect(
      chase.groups.flatMap((g) => g.transactions.map((c) => c.id)),
    ).not.toContain(payout);
  });

  test("the CLOSED tail doesn't collect it either", async () => {
    // `undocumented` ("Closed without documentation") is the publishing
    // backlog's other half and reads `isUndocumented`, which ignores status.
    // If only the chase predicate had the carve-out, closing a payout would
    // move it from one pill to the other rather than out of both — and the
    // backlog that has to reach zero before a month publishes would still be
    // full of deposits.
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const { payout } = await markedPair(s);
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: payout,
      status: "reconciled",
    });

    const counts = (
      await s.as.query(api.finances.listReconcile, { filter: "all" })
    ).counts;
    expect(counts.missing_receipt).toBe(0);
    expect(counts.undocumented).toBe(0);
  });

  test("a payout can be CLOSED with nothing attached", async () => {
    // The documented-before-closed gate (`RECEIPT_REQUIRED`) reads the same
    // predicate, so the exemption has to reach it too — otherwise the row owes
    // no receipt and still can't be closed, which is the worst of both.
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const { payout } = await markedPair(s);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: payout,
      status: "reconciled",
    });
    expect((await txn(s, payout))!.status).toBe("reconciled");
  });

  test("a marked TRANSFER still owes one — the founder rule that did NOT change", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    const { transferOut } = await markedPair(s);

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: transferOut,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "RECEIPT_REQUIRED" } });
  });

  test("an UNMARKED deposit is unaffected — it never owed anything", async () => {
    // The exemption is by POSITIVE MARKER (`payoutProcessor`), same discipline
    // as the fee carve-out. A plain inflow was already outside the population,
    // so nothing about this row changed in either direction.
    const t = newT();
    const s = await setupChapter(t);
    await setupBookkeeper(s);
    await seedTxn(s, { amountCents: 5_000, flow: "inflow" });

    const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(res.counts.missing_receipt).toBe(0);
    expect(res.chaseCount).toBe(0);
  });
});
