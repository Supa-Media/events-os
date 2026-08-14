/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * BULK EXPLANATION — `transactionCodings.submitBulk`.
 *
 * The founder's backlog case: forty identical MTA fares are one fact about one
 * person's month, and typing that fact forty times makes the record no truer.
 * One sentence a human wrote, applied to rows that human selected, is not
 * machine authorship — so this suite pins the guarantees that keep it honest:
 *
 *  - it goes through the SAME `submitCoding` a typed row does, so the
 *    `DOCUMENTATION_REQUIRED` gate and the `CODING_APPROVED` immutability
 *    refusal both still bite;
 *  - rows that fail are REPORTED per row with their own code, never silently
 *    skipped, and the successful rows in the same call still land;
 *  - the bulk marker rides in the AUDIT REASON and never in the published
 *    `businessPurpose`;
 *  - a caller-wide mistake (short purpose, missing route, `meal`, over the
 *    cap) throws for the whole batch rather than returning N identical
 *    failures.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const GOOD_PURPOSE =
  "Subway fares travelling between outreach sites in Queens for the Eden project";

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manager Mo",
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

/** A post-policy outflow charge. Receipted by default — an undocumented one
 *  is refused by `submitCoding`'s gate, which is the failure path several of
 *  these tests deliberately exercise via `documented: false`. */
async function seedTxn(
  s: ChapterSetup,
  opts: { documented?: boolean; merchantName?: string } = {},
): Promise<Id<"transactions">> {
  const receiptStorageId =
    opts.documented === false ? undefined : await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 290,
      postedAt: POST_POLICY,
      merchantName: opts.merchantName ?? "MTA*NYCT PAYGO",
      status: "unreviewed",
      receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

describe("one sentence, many rows", () => {
  test("applies the same coding to every selected row, each with its own author and audit entry", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const ids = [await seedTxn(s), await seedTxn(s), await seedTxn(s)];

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: ids,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    expect(res.applied).toBe(3);
    expect(res.failed).toBe(0);
    expect(res.rows.map((r) => r.outcome)).toEqual([
      "submitted",
      "submitted",
      "submitted",
    ]);

    const codings = await run(s.t, (ctx) =>
      ctx.db.query("transactionCodings").collect(),
    );
    expect(codings).toHaveLength(3);
    for (const c of codings) {
      expect(c.status).toBe("submitted");
      expect(c.businessPurpose).toBe(GOOD_PURPOSE);
      // A REAL HUMAN AUTHOR on every row — the thing that makes this the
      // person's own testimony rather than an anonymous bulk write.
      expect(c.codedByPersonId).toBe(personId);
      expect(c.codedByUserId).toBe(s.userId);
    }
    for (const id of ids) {
      expect((await run(s.t, (ctx) => ctx.db.get(id)))?.codingState).toBe(
        "submitted",
      );
    }

    // ONE `coding_submit` AUDIT ROW PER TRANSACTION, indistinguishable in
    // shape from a typed one — same action, same field, its own amount.
    const audit = await run(s.t, (ctx) =>
      ctx.db.query("financeAuditLog").collect(),
    );
    const submits = audit.filter((a) => a.action === "coding_submit");
    expect(submits).toHaveLength(3);
    expect(new Set(submits.map((a) => a.subjectId))).toEqual(new Set(ids));
    for (const a of submits) {
      expect(a.after).toBe("Awaiting review");
      expect(a.actorPersonId).toBe(personId);
      expect(a.amountCents).toBe(290);
    }
  });

  test("the bulk marker lives in the audit reason and NEVER in the published purpose", async () => {
    // A stranger reading the ledger is owed the explanation, not the clerical
    // detail of how it was entered.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const ids = [await seedTxn(s), await seedTxn(s)];

    await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: ids,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    const codings = await run(s.t, (ctx) =>
      ctx.db.query("transactionCodings").collect(),
    );
    for (const c of codings) {
      expect(c.businessPurpose).toBe(GOOD_PURPOSE);
      expect(c.businessPurpose).not.toContain("selection");
    }
    const submits = (
      await run(s.t, (ctx) => ctx.db.query("financeAuditLog").collect())
    ).filter((a) => a.action === "coding_submit");
    for (const a of submits) {
      expect(a.reason).toContain(GOOD_PURPOSE);
      expect(a.reason).toContain("applied across a 2-charge selection");
    }
  });

  test("a travel route is supplied once and applied to all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const ids = [await seedTxn(s), await seedTxn(s)];

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: ids,
      expenseType: "travel",
      businessPurpose: GOOD_PURPOSE,
      travelFrom: "Rosedale",
      travelTo: "Midtown Manhattan",
    });
    expect(res.applied).toBe(2);
    const codings = await run(s.t, (ctx) =>
      ctx.db.query("transactionCodings").collect(),
    );
    for (const c of codings) {
      expect(c.expenseType).toBe("travel");
      expect(c.travelFrom).toBe("Rosedale");
      expect(c.travelTo).toBe("Midtown Manhattan");
    }
  });

  test("a repeated id is deduped — never submitted twice", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const id = await seedTxn(s);

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: [id, id, id],
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.applied).toBe(1);
    expect(res.rows[0].outcome).toBe("submitted");
  });
});

describe("rows that fail, fail individually and are REPORTED", () => {
  test("a selection where some rows lack documentation: the rest land, the undocumented ones come back named", async () => {
    // The headline requirement. "28 applied, 12 need a receipt first" — and
    // the UI can say WHICH twelve, because every row's own refusal comes back
    // with its own code.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const ok1 = await seedTxn(s);
    const bare1 = await seedTxn(s, { documented: false });
    const ok2 = await seedTxn(s);
    const bare2 = await seedTxn(s, { documented: false });

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: [ok1, bare1, ok2, bare2],
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    expect(res.applied).toBe(2);
    expect(res.failed).toBe(2);
    const byId = new Map(res.rows.map((r) => [r.transactionId, r]));
    expect(byId.get(ok1)?.outcome).toBe("submitted");
    expect(byId.get(ok2)?.outcome).toBe("submitted");
    for (const bare of [bare1, bare2]) {
      expect(byId.get(bare)?.outcome).toBe("failed");
      expect(byId.get(bare)?.code).toBe("DOCUMENTATION_REQUIRED");
      expect(byId.get(bare)?.message).toContain("receipt");
    }

    // The successful rows really did land — a partial batch is not rolled back.
    expect((await run(s.t, (ctx) => ctx.db.get(ok1)))?.codingState).toBe(
      "submitted",
    );
    // …and the failed ones wrote nothing at all.
    expect(
      (await run(s.t, (ctx) => ctx.db.get(bare1)))?.codingState,
    ).toBeUndefined();
    const codings = await run(s.t, (ctx) =>
      ctx.db.query("transactionCodings").collect(),
    );
    expect(codings).toHaveLength(2);
  });

  test("an APPROVED row is refused, counted, and named — never silently overwritten", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Cardholder Cass",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const locked = await seedTxn(s);
    const open = await seedTxn(s);

    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: locked,
      expenseType: "general",
      businessPurpose: "Original testimony written by the cardholder themselves",
    });
    // Re-author so the manager is a second name — approval is separation of
    // duties, not the subject of this test.
    const coding = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactionCodings").collect())[0],
    );
    await run(s.t, (ctx) => ctx.db.patch(coding._id, { codedByPersonId: other }));
    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: locked,
    });

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: [locked, open],
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });

    expect(res.applied).toBe(1);
    expect(res.failed).toBe(1);
    const byId = new Map(res.rows.map((r) => [r.transactionId, r]));
    expect(byId.get(locked)?.outcome).toBe("failed");
    expect(byId.get(locked)?.code).toBe("CODING_APPROVED");
    expect(byId.get(open)?.outcome).toBe("submitted");

    // The approved record is untouched — still approved, still its own words.
    const after = await run(s.t, (ctx) => ctx.db.get(coding._id));
    expect(after?.status).toBe("approved");
    expect(after?.businessPurpose).toBe(
      "Original testimony written by the cardholder themselves",
    );
  });

  test("a row already carrying an open coding is a RESUBMISSION, reported as such", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const existing = await seedTxn(s);
    const fresh = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: existing,
      expenseType: "general",
      businessPurpose: "An earlier sentence that is about to be replaced here",
    });

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: [existing, fresh],
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    const byId = new Map(res.rows.map((r) => [r.transactionId, r]));
    expect(byId.get(existing)?.outcome).toBe("resubmitted");
    expect(byId.get(fresh)?.outcome).toBe("submitted");
    expect(res.applied).toBe(2);
  });

  test("a row outside the caller's reach fails alone, and the rest still land", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const mine = await seedTxn(s);
    // Another chapter's charge — `requireSubmitCoding` refuses it without
    // confirming it exists.
    const foreignChapter = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Elsewhere",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const theirs = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: foreignChapter,
        source: "manual",
        flow: "outflow",
        amountCents: 500,
        postedAt: POST_POLICY,
        merchantName: "Somewhere Else",
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.transactionCodings.submitBulk, {
      transactionIds: [mine, theirs],
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
    });
    expect(res.applied).toBe(1);
    const byId = new Map(res.rows.map((r) => [r.transactionId, r]));
    expect(byId.get(mine)?.outcome).toBe("submitted");
    expect(byId.get(theirs)?.outcome).toBe("failed");
    expect(byId.get(theirs)?.code).toBe("NOT_FOUND");
  });
});

describe("caller-wide mistakes throw for the whole batch", () => {
  test("a purpose under the floor is one typo, not N failures", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const ids = [await seedTxn(s), await seedTxn(s)];

    await expect(
      s.as.mutation(api.transactionCodings.submitBulk, {
        transactionIds: ids,
        expenseType: "general",
        businessPurpose: "subway",
      }),
    ).rejects.toMatchObject({ data: { code: "PURPOSE_REQUIRED" } });
    // Nothing was written before it threw.
    expect(
      await run(s.t, (ctx) => ctx.db.query("transactionCodings").collect()),
    ).toHaveLength(0);
  });

  test("travel with no route is refused up front, not forty times", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await expect(
      s.as.mutation(api.transactionCodings.submitBulk, {
        transactionIds: [await seedTxn(s)],
        expenseType: "travel",
        businessPurpose: GOOD_PURPOSE,
      }),
    ).rejects.toMatchObject({ data: { code: "TRAVEL_ROUTE_REQUIRED" } });
  });

  test("MEAL is refused outright — who was there is a per-occasion fact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await expect(
      s.as.mutation(api.transactionCodings.submitBulk, {
        transactionIds: [await seedTxn(s)],
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
      }),
    ).rejects.toMatchObject({ data: { code: "BULK_MEAL_UNSUPPORTED" } });
  });

  test("over the cap is refused with the number, never truncated", async () => {
    // Doing the first 100 of 140 and staying quiet about the rest is the exact
    // failure the per-row reporting exists to prevent, moved one level up.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // 101 REAL, DISTINCT ids — the cap is checked after deduping, so a list
    // of repeats would (correctly) collapse to one and never trip it.
    const tooMany: Id<"transactions">[] = [];
    for (let i = 0; i < 101; i += 1) {
      tooMany.push(await seedTxn(s, { documented: false }));
    }
    await expect(
      s.as.mutation(api.transactionCodings.submitBulk, {
        transactionIds: tooMany,
        expenseType: "general",
        businessPurpose: GOOD_PURPOSE,
      }),
    ).rejects.toMatchObject({ data: { code: "BULK_LIMIT" } });
  });
});
