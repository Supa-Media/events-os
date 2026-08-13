/// <reference types="vite/client" />
/**
 * Ported testimony (founder directive, 2026-08-13): a reimbursement payout
 * transaction should never ask a human to re-type testimony the claimant
 * already wrote AND a reviewer already approved. When
 * `postReimbursementSpend` books the payout, it MATERIALIZES a real
 * `transactionCodings` row from the request — ported words, not composed —
 * whenever the request has exactly one line item carrying a COMPLETE §274(d)
 * answer. See `lib/reimbursementTxnFields.ts
 * #deriveReimbursementCodingMaterialization` (the rule) and
 * `lib/transactionCoding.ts#materializePortedReimbursementCoding` (the
 * write).
 *
 * This suite pins:
 *  1. a single complete line materializes a coding — status `"approved"`,
 *     fields ported verbatim, authorship = the claimant, decision = the
 *     request's own approver, provenance recorded.
 *  2. a multi-line request is left alone (today's prefill-only flow) — a
 *     machine must never merge or summarize lines.
 *  3. a single INCOMPLETE line (missing travel route) is left alone too.
 *  4. the `0068` migration backfills existing historical payouts under the
 *     same rule, never touches an already-coded row (human or ported),
 *     never touches an unrelated transaction, and is idempotent.
 *  5. a materialized row counts as "explained" on the month coding worklist.
 */
import { describe, expect, test } from "vitest";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { runMaterializeReimbursementCodings } from "../migrations/0068_materialize_reimbursement_codings";

const PURPOSE = "Supplies for the Worship with Strangers shoot in July";

/** Eastern-noon timestamp on a given day — mirrors `reimbursementSpend.test.ts`. */
function tsOnDay(year: number, month: number, day: number): number {
  return Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T16:00:00Z`,
  );
}

/** The finance manager who reviews/pays — their OWN account, so
 *  `decidedByUserId` resolution has something real to find. */
async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manny Manager",
      email: "manny@publicworship.life",
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
  return personId;
}

/** The claimant. Accountless by default (`userId` unset) — the common case
 *  for a public reimbursement submitter. */
async function seedClaimant(
  s: ChapterSetup,
  opts: { withAccount?: boolean } = {},
): Promise<Id<"people">> {
  let userId: Id<"users"> | undefined;
  if (opts.withAccount) {
    userId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "vera@example.com" }),
    );
  }
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Vera Volunteer",
      email: "vera@example.com",
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

type LineArg = Partial<{
  description: string;
  amountCents: number;
  expenseType: "general" | "travel" | "meal" | "lodging";
  businessPurpose: string;
  travelFrom: string;
  travelTo: string;
  headcount: number;
  attendees: { personId?: Id<"people">; name: string; affiliation: string }[];
  groupDescription: string;
}>;

/** An APPROVED reimbursement request, inserted directly (mirroring
 *  `reimbursementSpend.test.ts#seedApprovedReimbursement`) — the object
 *  under test is what happens to its PAYOUT, not the review mutations
 *  themselves (those are `reimbursementCoding.test.ts`'s job). */
async function seedApprovedRequest(
  s: ChapterSetup,
  opts: {
    claimantPersonId?: Id<"people">;
    reviewerPersonId: Id<"people">;
    lines: LineArg[];
    submittedAt?: number;
    approvedAt?: number;
  },
): Promise<{ reimbursementId: Id<"reimbursementRequests">; totalCents: number }> {
  const submittedAt = opts.submittedAt ?? Date.now() - 86_400_000;
  const approvedAt = opts.approvedAt ?? Date.now();
  const totalCents = opts.lines.reduce(
    (sum, l) => sum + (l.amountCents ?? 1200),
    0,
  );
  const reimbursementId = await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: crypto.randomUUID(),
      status: "approved",
      payeeName: "Vera Volunteer",
      payeeEmail: "vera@example.com",
      personId: opts.claimantPersonId,
      totalCents,
      approvedCents: totalCents,
      reviewedByPersonId: opts.reviewerPersonId,
      bankAccountLast4: "1234",
      submittedAt,
      approvedAt,
      createdAt: submittedAt,
      updatedAt: approvedAt,
    }),
  );
  let order = 0;
  for (const l of opts.lines) {
    await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description: l.description ?? "Gaffer tape",
        amountCents: l.amountCents ?? 1200,
        expenseType: l.expenseType,
        businessPurpose: l.businessPurpose,
        travelFrom: l.travelFrom,
        travelTo: l.travelTo,
        headcount: l.headcount,
        attendees: l.attendees as never,
        groupDescription: l.groupDescription,
        order: order++,
        createdAt: submittedAt,
      }),
    );
  }
  return { reimbursementId, totalCents };
}

async function payoutTxn(
  s: ChapterSetup,
  reimbursementId: Id<"reimbursementRequests">,
): Promise<Doc<"transactions"> | null> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", reimbursementId))
      .first(),
  );
}

async function codingOf(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
): Promise<Doc<"transactionCodings"> | null> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .first(),
  );
}

// ── 1/2/3. The live path — postReimbursementSpend materializes (or doesn't) ──

describe("a single complete line materializes a coding on the payout", () => {
  test("ported fields, approved, correct authorship/decision/provenance", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);
    const submittedAt = Date.UTC(2026, 6, 1);
    const approvedAt = Date.UTC(2026, 6, 3);

    const { reimbursementId } = await seedApprovedRequest(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      submittedAt,
      approvedAt,
      lines: [
        {
          description: "Bus to NY",
          amountCents: 4_200,
          expenseType: "travel",
          businessPurpose: "Travel to NY to film the Eden event in July",
          travelFrom: "Boston",
          travelTo: "New York",
        },
      ],
    });

    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });

    const txn = await payoutTxn(s, reimbursementId);
    expect(txn).not.toBeNull();
    expect(txn?.codingState).toBe("approved");

    const coding = await codingOf(s, txn!._id);
    expect(coding).not.toBeNull();
    expect(coding?.status).toBe("approved");
    expect(coding?.expenseType).toBe("travel");
    expect(coding?.businessPurpose).toBe(
      "Travel to NY to film the Eden event in July",
    );
    expect(coding?.travelFrom).toBe("Boston");
    expect(coding?.travelTo).toBe("New York");

    // AUTHORSHIP: the claimant, never the approver.
    expect(coding?.codedByPersonId).toBe(claimantPersonId);
    // Accountless claimant — no `users` row to attribute to.
    expect(coding?.codedByUserId).toBeUndefined();

    // DECISION: the request's own approver, at the request's own approval time.
    expect(coding?.decidedByPersonId).toBe(managerPersonId);
    expect(coding?.decidedByUserId).toBe(s.userId);
    expect(coding?.decidedAt).toBe(approvedAt);
    expect(coding?.approvalParty).toBe("two_party");

    // The claimant's OWN first-submission time, not "now".
    expect(coding?.submittedAt).toBe(submittedAt);
    expect(coding?.updatedAt).toBe(approvedAt);

    // PROVENANCE.
    expect(coding?.portedFromReimbursementId).toBe(reimbursementId);
  });

  test("a claimant WITH a linked account gets `codedByUserId` too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s, { withAccount: true });
    const claimant = await run(s.t, (ctx) => ctx.db.get(claimantPersonId));

    const { reimbursementId } = await seedApprovedRequest(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [{ expenseType: "general", businessPurpose: PURPOSE }],
    });
    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });
    const txn = await payoutTxn(s, reimbursementId);
    const coding = await codingOf(s, txn!._id);
    expect(coding?.codedByUserId).toBe(claimant?.userId);
  });

  test("the coding surface projects it, provenance included", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);
    const { reimbursementId } = await seedApprovedRequest(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [{ expenseType: "general", businessPurpose: PURPOSE }],
    });
    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });
    const txn = await payoutTxn(s, reimbursementId);

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txn!._id,
    });
    expect(data.coding?.status).toBe("approved");
    expect(data.coding?.portedFromReimbursementId).toBe(reimbursementId);
  });
});

describe("a multi-line request keeps today's flow — no coding is materialized", () => {
  test("two complete lines: no machine merging or summarizing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);
    const { reimbursementId } = await seedApprovedRequest(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [
        {
          description: "Gaffer tape",
          amountCents: 1_200,
          expenseType: "general",
          businessPurpose: PURPOSE,
        },
        {
          description: "Crew dinner",
          amountCents: 3_000,
          expenseType: "meal",
          businessPurpose: "Dinner with the crew after the shoot in July",
          headcount: 2,
          attendees: [
            { name: "Vera", affiliation: "volunteer" },
            { name: "Manny", affiliation: "team" },
          ],
        },
      ],
    });

    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });
    const txn = await payoutTxn(s, reimbursementId);
    expect(txn).not.toBeNull();
    expect(txn?.codingState).toBeUndefined();
    expect(await codingOf(s, txn!._id)).toBeNull();
  });
});

describe("a single INCOMPLETE line keeps today's flow too", () => {
  test("travel missing its route: no coding is materialized", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);
    const { reimbursementId } = await seedApprovedRequest(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [
        {
          expenseType: "travel",
          businessPurpose: "Travel to NY to film the Eden event in July",
          travelFrom: "Boston",
          // travelTo missing — TRAVEL_ROUTE_REQUIRED.
        },
      ],
    });

    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });
    const txn = await payoutTxn(s, reimbursementId);
    expect(txn).not.toBeNull();
    expect(txn?.codingState).toBeUndefined();
    expect(await codingOf(s, txn!._id)).toBeNull();
  });
});

// ── 4. The 0068 migration — historical backfill ──────────────────────────────

describe("migration 0068: materializes codings for existing payouts", () => {
  /** Seed a HISTORICAL payout exactly as `postReimbursementSpend` would have
   *  left it before this feature existed — a `source:"reimbursement"` outflow
   *  row with NO coding. */
  async function seedHistoricalPayout(
    s: ChapterSetup,
    opts: {
      claimantPersonId?: Id<"people">;
      reviewerPersonId: Id<"people">;
      lines: LineArg[];
    },
  ): Promise<{ reimbursementId: Id<"reimbursementRequests">; txnId: Id<"transactions"> }> {
    const { reimbursementId, totalCents } = await seedApprovedRequest(s, opts);
    await run(s.t, (ctx) => ctx.db.patch(reimbursementId, { status: "paid" }));
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "reimbursement",
        flow: "outflow",
        amountCents: totalCents,
        postedAt: Date.now(),
        reimbursementId,
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );
    return { reimbursementId, txnId };
  }

  test("an existing payout without a coding gets one; a human-coded one is untouched; a non-reimbursement row is untouched; re-running is a no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);

    // Eligible: single complete line, no coding yet.
    const eligible = await seedHistoricalPayout(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [{ expenseType: "general", businessPurpose: PURPOSE }],
    });

    // Already human-coded — must never be touched.
    const alreadyCoded = await seedHistoricalPayout(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [{ expenseType: "general", businessPurpose: PURPOSE }],
    });
    const humanUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "bookkeeper@publicworship.life" }),
    );
    const now = Date.now();
    await run(s.t, (ctx) =>
      ctx.db.insert("transactionCodings", {
        transactionId: alreadyCoded.txnId,
        chapterId: s.chapterId,
        expenseType: "general",
        businessPurpose: "Human-written coding, do not touch",
        status: "approved",
        codedByUserId: humanUserId,
        submittedAt: now,
        updatedAt: now,
        decidedByUserId: humanUserId,
        decidedAt: now,
        approvalParty: "two_party",
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(alreadyCoded.txnId, { codingState: "approved" }),
    );

    // A wholly unrelated manual transaction — never reachable via
    // `reimbursementRequests`, so it must stay untouched.
    const unrelatedTxnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 500,
        postedAt: Date.now(),
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );

    const first = await run(s.t, (ctx) => runMaterializeReimbursementCodings(ctx));
    expect(first.materialized).toBe(1);
    expect(first.skippedAlreadyCoded).toBe(1);
    expect(first.truncated).toBe(false);

    const eligibleCoding = await codingOf(s, eligible.txnId);
    expect(eligibleCoding?.status).toBe("approved");
    expect(eligibleCoding?.portedFromReimbursementId).toBe(eligible.reimbursementId);
    expect(eligibleCoding?.businessPurpose).toBe(PURPOSE);
    const eligibleTxn = await run(s.t, (ctx) => ctx.db.get(eligible.txnId));
    expect(eligibleTxn?.codingState).toBe("approved");

    // Untouched: the human coding's own words survive verbatim.
    const humanCoding = await codingOf(s, alreadyCoded.txnId);
    expect(humanCoding?.businessPurpose).toBe(
      "Human-written coding, do not touch",
    );
    expect(humanCoding?.portedFromReimbursementId).toBeUndefined();
    expect(humanCoding?.codedByUserId).toBe(humanUserId);

    // Untouched: no reimbursement behind it at all.
    expect(await codingOf(s, unrelatedTxnId)).toBeNull();
    const unrelatedTxn = await run(s.t, (ctx) => ctx.db.get(unrelatedTxnId));
    expect(unrelatedTxn?.codingState).toBeUndefined();

    // IDEMPOTENT: nothing left to materialize the second time around.
    const second = await run(s.t, (ctx) => runMaterializeReimbursementCodings(ctx));
    expect(second.materialized).toBe(0);
    expect(second.skippedAlreadyCoded).toBe(2);
  });

  test("a multi-line or incomplete historical request is skipped as ineligible", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);

    const multiLine = await seedHistoricalPayout(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [
        { expenseType: "general", businessPurpose: PURPOSE, amountCents: 1000 },
        { expenseType: "general", businessPurpose: PURPOSE, amountCents: 2000 },
      ],
    });
    const incomplete = await seedHistoricalPayout(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [{ expenseType: "meal", businessPurpose: PURPOSE }], // no headcount
    });

    const result = await run(s.t, (ctx) => runMaterializeReimbursementCodings(ctx));
    expect(result.materialized).toBe(0);
    expect(result.skippedIneligible).toBe(2);
    expect(await codingOf(s, multiLine.txnId)).toBeNull();
    expect(await codingOf(s, incomplete.txnId)).toBeNull();
  });
});

// ── 5. The Explain worklist picks a materialized row up automatically ────────

describe("a materialized payout counts as explained on the month worklist", () => {
  test("monthCodingWorklist counts it in explainedCount, not in the pending rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerPersonId = await seedManager(s);
    const claimantPersonId = await seedClaimant(s);
    const { reimbursementId } = await seedApprovedRequest(s, {
      claimantPersonId,
      reviewerPersonId: managerPersonId,
      lines: [
        {
          expenseType: "general",
          businessPurpose: PURPOSE,
          amountCents: 30_386,
        },
      ],
    });

    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });
    const txn = await payoutTxn(s, reimbursementId);
    await run(s.t, (ctx) =>
      ctx.db.patch(txn!._id, { postedAt: tsOnDay(2026, 7, 22) }),
    );

    const list = await s.as.query(api.finances.monthCodingWorklist, {
      periodKey: "2026-07",
    });
    expect(list).not.toBeNull();
    expect(list?.explainedCount).toBe(1);
    expect(list?.explainedCents).toBe(30_386);
    expect(list?.rows.find((r) => r.id === txn!._id)).toBeUndefined();
  });
});
