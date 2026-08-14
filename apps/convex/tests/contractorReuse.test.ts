/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  disarmCodingPolicy,
  type ChapterSetup,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import {
  taxDocPurgeAfter,
  extendedTaxDocPurgeAfter,
  unpaidTaxDocPurgeAfter,
  taxDocIsCurrent,
  w8ExpiresAt,
} from "@events-os/shared";
import { repointPersonReferences } from "../lib/people";
import type { Id } from "../_generated/dataModel";

/**
 * Remembering a contractor between payments — and the two things that quietly
 * go wrong when you do.
 *
 * THE RETENTION RULE IS THE POINT OF THIS FILE. When one document belonged to
 * one payment, a purge clock started at that payment's service year was
 * correct. Reuse makes one document answer for several payments, and a clock
 * still started at the FIRST destroys the substantiation behind later ones
 * while they are inside their own window — silently, four years later, with
 * nothing to notice at the time and no way to get it back. There is no
 * plausible manual test for that, which is exactly why it is asserted here.
 *
 * THE SECOND is that reuse must not become a way to pay someone against a form
 * that no longer establishes anything. A W-9 never expires; a W-8 does, and
 * reuse is what makes a lapsed one reachable at all.
 */

// ── Increase mock plumbing (mirrors contractorPayments.test.ts) ─────────────
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let seq = 0;

beforeEach(() => {
  // `finishAllScheduledFunctions` drives the scheduler through the timer API.
  vi.useFakeTimers();
  process.env.INCREASE_API_KEY = "test_key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/external_accounts")) {
      seq += 1;
      return new Response(JSON.stringify({ id: `extacct_${seq}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_INCREASE_KEY === undefined) delete process.env.INCREASE_API_KEY;
  else process.env.INCREASE_API_KEY = ORIGINAL_INCREASE_KEY;
});

// ── Fixtures ────────────────────────────────────────────────────────────────
async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; email?: string; userId?: Id<"users"> },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      email: opts.email,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantManager(s: ChapterSetup, personId: Id<"people">) {
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

async function setup() {
  const t = newT();
  const s = await setupChapter(t);
  await run(t, (ctx) => ctx.db.patch(s.chapterId, { slug: "new-york" }));
  await disarmCodingPolicy(t);
  const composerPersonId = await seedPerson(s, {
    name: "Composer",
    email: s.email,
    userId: s.userId,
  });
  await grantManager(s, composerPersonId);
  const budgetId = await run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 500_000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Production",
      createdAt: Date.now(),
    }),
  );
  return { s, composerPersonId, budgetId };
}

async function seedApprover(s: ChapterSetup) {
  const email = "treasurer@publicworship.life";
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email }));
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "admin",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await seedPerson(s, { name: "Treasurer", email, userId });
  await grantManager(s, personId);
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

const DEC_2026 = Date.UTC(2026, 11, 10, 12);
const JAN_2027 = Date.UTC(2027, 0, 15, 12);

/** Create → send → contractor completes (fresh form) → approve → pay. */
async function payOnce(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  approver: { as: ReturnType<ChapterSetup["t"]["withIdentity"]> },
  opts: { personId: Id<"people">; serviceDate: number; amountCents?: number },
): Promise<Id<"contractorPayments">> {
  const { contractorPaymentId } = await s.as.mutation(
    api.contractorPayments.createAgreement,
    {
      payeeName: "Jane Contractor",
      payeeEmail: "jane@example.com",
      personId: opts.personId,
      serviceDescription: "Sound engineering for the spring concert",
      serviceDate: opts.serviceDate,
      agreedAmountCents: opts.amountCents ?? 50_000,
      budgetId,
    },
  );
  await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
  const token = await run(
    s.t,
    async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
  );
  const storageId = await storeBlob(s.t);
  await s.t.mutation(api.contractorPayments.completeAgreement, {
    token,
    payeeName: "Jane Contractor",
    payeeEmail: "jane@example.com",
    taxDocStorageId: storageId,
    taxDocKind: "w9",
    externalAccountId: "extacct_first",
    bankAccountLast4: "6789",
    signature: "Jane Contractor",
  });
  await approver.as.mutation(api.contractorPayments.approve, {
    contractorPaymentId,
  });
  await approver.as.mutation(api.contractorPayouts.markPaidManually, {
    contractorPaymentId,
  });
  // `rememberPaidContractor` is SCHEDULED off the settle path (a payee becomes
  // a returning contractor when money actually moves), so the profile does not
  // exist until scheduled work has run.
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  return contractorPaymentId;
}

// ── 1. The retention rule ───────────────────────────────────────────────────
describe("a reused form is kept for the LAST year it answers for", () => {
  test("citing a document for a later year pushes its purge date out", async () => {
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });

    // December 2026 work, paid — the document now substantiates 2026.
    const first = await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });
    const docId = await run(
      s.t,
      async (ctx) => (await ctx.db.get(first))!.taxDocumentId!,
    );
    expect(docId).toBeTruthy();
    await run(s.t, (ctx) =>
      ctx.db.patch(docId, {
        lastTaxYear: 2026,
        purgeAfter: taxDocPurgeAfter(2026),
      }),
    );

    // January 2027: same contractor, new job, REUSES the form on file.
    const { contractorPaymentId: second } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        personId: jane,
        serviceDescription: "Sound engineering, winter series",
        serviceDate: JAN_2027,
        agreedAmountCents: 60_000,
        budgetId,
      },
    );
    await s.as.mutation(api.contractorPayments.send, {
      contractorPaymentId: second,
    });
    const token2 = await run(
      s.t,
      async (ctx) => (await ctx.db.get(second))!.token,
    );
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token: token2,
      payeeName: "Jane Contractor",
      payeeEmail: "jane@example.com",
      reuseTaxDoc: true,
      reuseBankDetails: true,
      signature: "Jane Contractor",
    });

    const doc = await run(s.t, (ctx) => ctx.db.get(docId));
    // THE ASSERTION THIS FILE EXISTS FOR. Kept for 2027, not 2026 — otherwise
    // the January payment loses its substantiation a year early.
    expect(doc!.lastTaxYear).toBe(2027);
    expect(doc!.purgeAfter).toBe(taxDocPurgeAfter(2027));
    expect(doc!.purgeAfter).toBeGreaterThan(taxDocPurgeAfter(2026));

    // And the second payment cites the same document rather than a new one.
    const secondRow = await run(s.t, (ctx) => ctx.db.get(second));
    expect(secondRow!.taxDocumentId).toBe(docId);
    expect(secondRow!.reusedFromProfile).toBe(true);
  });

  test("the purge clock never moves EARLIER", () => {
    // A January payment for December's work, or a backdated correction, must
    // not shorten a window a later payment already earned.
    const late = taxDocPurgeAfter(2027);
    expect(extendedTaxDocPurgeAfter(late, 2024)).toBe(late);
    expect(extendedTaxDocPurgeAfter(late, 2028)).toBe(taxDocPurgeAfter(2028));
  });

  test("a form nobody was paid against gets the SHORT window", async () => {
    // Collected for a job that fell through: nothing was reported, no return
    // depends on it, and it is the SSN we have least right to keep.
    const { s, budgetId } = await setup();
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        personId: jane,
        serviceDescription: "Sound engineering for the spring concert",
        serviceDate: DEC_2026,
        agreedAmountCents: 50_000,
        budgetId,
      },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: "Jane Contractor",
      payeeEmail: "jane@example.com",
      taxDocStorageId: storageId,
      taxDocKind: "w9",
      externalAccountId: "extacct_x",
      bankAccountLast4: "1111",
      signature: "Jane",
    });

    const doc = await run(s.t, async (ctx) => {
      const row = await ctx.db.get(contractorPaymentId);
      return await ctx.db.get(row!.taxDocumentId!);
    });
    expect(doc!.lastTaxYear).toBeUndefined();
    // Months, not years.
    expect(doc!.purgeAfter).toBeLessThan(taxDocPurgeAfter(2026));
    expect(doc!.purgeAfter).toBeCloseTo(
      unpaidTaxDocPurgeAfter(doc!.uploadedAt),
      -4,
    );
  });

  test("the purge stamps the payments that cited the destroyed form", async () => {
    // "We kept it four years and destroyed it as promised" and "we never had
    // one" must not read identically on the payment afterwards.
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    const paymentId = await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });
    const docId = await run(
      s.t,
      async (ctx) => (await ctx.db.get(paymentId))!.taxDocumentId!,
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(docId, { purgeAfter: Date.now() - 1000 }),
    );

    await s.t.mutation(internal.contractorPayments.purgeExpiredTaxDocuments, {});

    const after = await run(s.t, (ctx) => ctx.db.get(paymentId));
    expect(after!.taxDocumentId).toBeUndefined();
    expect(after!.taxDocPurgedAt).toBeTruthy();
    expect(await run(s.t, (ctx) => ctx.db.get(docId))).toBeNull();
  });
});

// ── 2. W-8 expiry ───────────────────────────────────────────────────────────
describe("a W-9 never expires and a W-8 does", () => {
  test("the validity window is the third succeeding calendar year", () => {
    const signed = Date.UTC(2026, 5, 1);
    // Signed mid-2026 → good through the end of 2029.
    expect(w8ExpiresAt(signed)).toBe(Date.UTC(2030, 0, 1));
    expect(taxDocIsCurrent({ kind: "w8ben", signedAt: signed }, Date.UTC(2029, 11, 31))).toBe(true);
    expect(taxDocIsCurrent({ kind: "w8ben", signedAt: signed }, Date.UTC(2030, 0, 2))).toBe(false);
  });

  test("a W-9 is current regardless of age", () => {
    expect(
      taxDocIsCurrent({ kind: "w9", signedAt: Date.UTC(2010, 0, 1) }, Date.now()),
    ).toBe(true);
    expect(taxDocIsCurrent({ kind: "w9" }, Date.now())).toBe(true);
  });

  test("a W-8 with no signing date reads as expired, not valid", () => {
    // An unknown signing date is not evidence of a current form, and deriving
    // one from the upload date would silently over-grant validity.
    expect(taxDocIsCurrent({ kind: "w8ben" }, Date.now())).toBe(false);
  });

  test("an expired form cannot be reused", async () => {
    const { s, budgetId } = await setup();
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    // A W-8 signed long ago, on file.
    const storageId = await storeBlob(s.t);
    // A prior payment to hang the historic document off — `contractorPaymentId`
    // is a real reference and cannot be faked.
    const { contractorPaymentId: priorId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        personId: jane,
        serviceDescription: "An earlier engagement, long since paid",
        serviceDate: DEC_2026,
        agreedAmountCents: 10_000,
        budgetId,
      },
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("contractorTaxDocuments", {
        chapterId: s.chapterId,
        contractorPaymentId: priorId,
        personId: jane,
        payeeName: "Jane Contractor",
        kind: "w8ben",
        signedAt: Date.UTC(2015, 0, 1),
        storageId,
        taxYear: 2015,
        purgeAfter: Date.now() + 1_000_000,
        uploadedAt: Date.UTC(2015, 0, 2),
      }),
    );

    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        personId: jane,
        serviceDescription: "Sound engineering for the spring concert",
        serviceDate: DEC_2026,
        agreedAmountCents: 50_000,
        budgetId,
      },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    await expect(
      s.t.mutation(api.contractorPayments.completeAgreement, {
        token,
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        reuseTaxDoc: true,
        externalAccountId: "extacct_new",
        bankAccountLast4: "2222",
        signature: "Jane",
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 3. Reuse is confirmed, never assumed ────────────────────────────────────
describe("reuse requires the contractor to say yes", () => {
  test("reusing bank details without confirming is refused", async () => {
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });

    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        personId: jane,
        serviceDescription: "More sound engineering for the winter run",
        serviceDate: JAN_2027,
        agreedAmountCents: 60_000,
        budgetId,
      },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    // No bank details AND no confirmation — a blank section is not consent.
    await expect(
      s.t.mutation(api.contractorPayments.completeAgreement, {
        token,
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        reuseTaxDoc: true,
        signature: "Jane",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("claiming reuse with nothing on file is refused", async () => {
    const { s, budgetId } = await setup();
    const stranger = await seedPerson(s, {
      name: "New Person",
      email: "new@example.com",
    });
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "New Person",
        payeeEmail: "new@example.com",
        personId: stranger,
        serviceDescription: "Photography for the outreach evening",
        serviceDate: DEC_2026,
        agreedAmountCents: 10_000,
        budgetId,
      },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    await expect(
      s.t.mutation(api.contractorPayments.completeAgreement, {
        token,
        payeeName: "New Person",
        payeeEmail: "new@example.com",
        reuseTaxDoc: true,
        reuseBankDetails: true,
        signature: "New Person",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("acceptance never carries — every payment is signed fresh", async () => {
    // The load-bearing defence against autofill making it too easy to pay
    // without anyone re-reading the terms.
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });

    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      {
        payeeName: "Jane Contractor",
        payeeEmail: "jane@example.com",
        personId: jane,
        serviceDescription: "A different job entirely",
        serviceDate: JAN_2027,
        agreedAmountCents: 90_000,
        budgetId,
      },
    );
    const fresh = await run(s.t, (ctx) => ctx.db.get(contractorPaymentId));
    expect(fresh!.acceptedAt).toBeUndefined();
    expect(fresh!.acceptedSignature).toBeUndefined();
    expect(fresh!.agreementTermsVersion).toBe(1);
    expect(fresh!.status).toBe("draft");
  });
});

// ── 4. The roster, and what it refuses to hand out ──────────────────────────
describe("the roster", () => {
  test("remembers a contractor only once money has actually moved", async () => {
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });

    // Composed but unpaid → not a returning contractor yet.
    await s.as.mutation(api.contractorPayments.createAgreement, {
      payeeName: "Jane Contractor",
      payeeEmail: "jane@example.com",
      personId: jane,
      serviceDescription: "Sound engineering for the spring concert",
      serviceDate: DEC_2026,
      agreedAmountCents: 50_000,
      budgetId,
    });
    let roster = await s.as.query(api.contractorProfiles.list, {});
    expect(roster.contractors).toHaveLength(0);

    await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });
    roster = await s.as.query(api.contractorProfiles.list, {});
    expect(roster.contractors).toHaveLength(1);
    expect(roster.contractors[0].name).toBe("Jane Contractor");
    expect(roster.contractors[0].lastPaidAt).toBeTruthy();
  });

  test("never hands out a tax document's storage id", async () => {
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    const paymentId = await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });
    const storageId = await run(s.t, async (ctx) => {
      const row = await ctx.db.get(paymentId);
      const doc = await ctx.db.get(row!.taxDocumentId!);
      return doc!.storageId;
    });

    const roster = await s.as.query(api.contractorProfiles.list, {});
    const onFile = await s.as.query(api.contractorProfiles.onFileFor, {
      personId: jane,
    });
    for (const payload of [roster, onFile]) {
      expect(JSON.stringify(payload)).not.toContain(storageId);
    }
    // The metadata a composer legitimately needs IS there.
    expect(onFile.taxDocument?.kind).toBe("w9");
    expect(onFile.hasBankOnFile).toBe(true);
  });

  test("forget clears the bank details but keeps evidence still owed", async () => {
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const jane = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    const paymentId = await payOnce(s, budgetId, approver, {
      personId: jane,
      serviceDate: DEC_2026,
    });
    // Put the document firmly inside its retention window.
    const docId = await run(
      s.t,
      async (ctx) => (await ctx.db.get(paymentId))!.taxDocumentId!,
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(docId, {
        lastTaxYear: 2026,
        purgeAfter: taxDocPurgeAfter(2026),
      }),
    );

    const result = await s.as.mutation(api.contractorProfiles.forget, {
      personId: jane,
    });
    expect(result.bankDetailsCleared).toBe(true);
    // Still owed to the IRS — deleting it on request would trade a real
    // obligation for a preference.
    expect(result.documentsKept).toBe(1);
    expect(result.documentsDeleted).toBe(0);
    expect(await run(s.t, (ctx) => ctx.db.get(docId))).not.toBeNull();

    const onFile = await s.as.query(api.contractorProfiles.onFileFor, {
      personId: jane,
    });
    expect(onFile.hasBankOnFile).toBe(false);
  });
});

// ── 5. The person-merge orphan ──────────────────────────────────────────────
describe("merging two duplicate people keeps their money attached", () => {
  test("contractor payments, tax documents and profiles all repoint", async () => {
    // Before 2026-08-15 the merge repointed twelve tables and not one held
    // money, so a merge left payments pointing at a person nobody could reach.
    const { s, budgetId } = await setup();
    const approver = await seedApprover(s);
    const duplicate = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane@example.com",
    });
    const survivor = await seedPerson(s, {
      name: "Jane Contractor",
      email: "jane.contractor@example.com",
    });
    const paymentId = await payOnce(s, budgetId, approver, {
      personId: duplicate,
      serviceDate: DEC_2026,
    });

    await run(s.t, (ctx) =>
      repointPersonReferences(ctx, s.chapterId, duplicate, survivor),
    );

    const payment = await run(s.t, (ctx) => ctx.db.get(paymentId));
    expect(payment!.personId).toBe(survivor);

    const doc = await run(s.t, (ctx) => ctx.db.get(payment!.taxDocumentId!));
    expect(doc!.personId).toBe(survivor);

    const profiles = await run(s.t, (ctx) =>
      ctx.db
        .query("contractorProfiles")
        .withIndex("by_person", (q) => q.eq("personId", survivor))
        .collect(),
    );
    expect(profiles).toHaveLength(1);
    // The remembered account is CLEARED rather than guessed — two accounts is
    // exactly where guessing sends money to the wrong place.
    expect(profiles[0].externalAccountId).toBeUndefined();
    expect(profiles[0].lastPaidAt).toBeTruthy();

    const orphans = await run(s.t, (ctx) =>
      ctx.db
        .query("contractorProfiles")
        .withIndex("by_person", (q) => q.eq("personId", duplicate))
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });

  test("reimbursements repoint too", async () => {
    const { s } = await setup();
    const duplicate = await seedPerson(s, { name: "Dup" });
    const survivor = await seedPerson(s, { name: "Survivor" });
    const reqId = await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: "tok_r",
        status: "approved",
        payeeName: "Dup",
        personId: duplicate,
        totalCents: 1000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never),
    );
    await run(s.t, (ctx) =>
      repointPersonReferences(ctx, s.chapterId, duplicate, survivor),
    );
    expect((await run(s.t, (ctx) => ctx.db.get(reqId)))!.personId).toBe(
      survivor,
    );
  });
});
