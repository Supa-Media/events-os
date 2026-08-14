/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  CONTRACTOR_LEDGER_COUNTERPARTY,
  CONTRACTOR_PAYMENT_MAX_CENTS,
  publicTextProblems,
  contractorDescriptionProblems,
  CONTRACTOR_SERVICE_DESCRIPTION_MIN,
  MIN_PURPOSE_LENGTH,
  taxDocPurgeAfter,
  displayMerchantName,
} from "@events-os/shared";
import type { Id } from "../_generated/dataModel";

/**
 * Contractor payments — the two entry points, the state machine, and the four
 * invariants this feature would be blamed for breaking.
 *
 * The tests are deliberately weighted toward things that are IRREVERSIBLE or
 * UNOBSERVABLE, rather than toward coverage:
 *
 *  1. THE PAYEE'S NAME MUST NOT PUBLISH. A published month can only be amended
 *     in public, so a regression here cannot be quietly fixed. The mechanism is
 *     indirect (`displayMerchantName` falls through to `description` when
 *     `merchantName` is unset), so it is asserted against the real resolver
 *     rather than against our own field.
 *  2. THE W-9's STORAGE ID MUST NOT LEAK. `storage.getUrl` is gated only by
 *     `requireUserId`, so any query returning the id puts every member one hop
 *     from an SSN. Asserted by inspecting whole query payloads, not named
 *     fields — a future field added carelessly should fail this.
 *  3. EDITING AGREED TERMS VOIDS AN ACCEPTANCE. Otherwise the record claims
 *     somebody agreed to terms they never saw.
 *  4. SEPARATION OF DUTIES, including the third party reimbursements lack:
 *     whoever WROTE the agreement may not approve it.
 *
 * The Increase mock plumbing mirrors `reimbursements.test.ts` — every
 * submission needs `/external_accounts` to resolve.
 */

// ── Increase mock plumbing ──────────────────────────────────────────────────
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let seq = 0;

function mockIncreaseSuccess(): void {
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
}

beforeEach(() => {
  mockIncreaseSuccess();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_INCREASE_KEY === undefined) delete process.env.INCREASE_API_KEY;
  else process.env.INCREASE_API_KEY = ORIGINAL_INCREASE_KEY;
});

// ── Fixtures ────────────────────────────────────────────────────────────────
async function setSlug(s: ChapterSetup, slug: string): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { slug }));
}

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

async function grantManager(
  s: ChapterSetup,
  personId: Id<"people">,
): Promise<void> {
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

/** A chapter with a slug, a budget to code against, and the seeded user as a
 *  finance manager — the standing setup nearly every test here needs. */
async function setup(): Promise<{
  s: ChapterSetup;
  composerPersonId: Id<"people">;
  budgetId: Id<"budgets">;
}> {
  const t = newT();
  const s = await setupChapter(t);
  await setSlug(s, "new-york");
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

/** A second authenticated person who can approve — the counterparty to the
 *  composer, since the composer is forbidden from approving their own work. */
async function seedApprover(
  s: ChapterSetup,
): Promise<{ as: ReturnType<ChapterSetup["t"]["withIdentity"]>; personId: Id<"people"> }> {
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

const AGREEMENT = {
  payeeName: "Jane Contractor",
  payeeEmail: "jane@example.com",
  serviceDescription: "Sound engineering for the spring concert",
  agreedAmountCents: 75_000,
};

/** Drive a pre-filled agreement all the way to `submitted`. */
async function sendAndComplete(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
): Promise<Id<"contractorPayments">> {
  const { contractorPaymentId } = await s.as.mutation(
    api.contractorPayments.createAgreement,
    { ...AGREEMENT, budgetId },
  );
  await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
  const token = await run(s.t, async (ctx) => {
    const row = await ctx.db.get(contractorPaymentId);
    return row!.token;
  });
  const storageId = await storeBlob(s.t);
  await s.t.mutation(api.contractorPayments.completeAgreement, {
    token,
    payeeName: AGREEMENT.payeeName,
    payeeEmail: AGREEMENT.payeeEmail,
    taxDocStorageId: storageId,
    taxDocKind: "w9",
    externalAccountId: "extacct_test",
    bankAccountLast4: "6789",
    signature: "Jane Contractor",
  });
  return contractorPaymentId;
}

// ── 1. The public ledger must not name the payee ────────────────────────────
describe("the public ledger never names the contractor", () => {
  test("the ledger row's counterparty is the generic label, not the payee", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });

    const txn = await run(s.t, async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .first(),
    );
    expect(txn).toBeTruthy();

    // Asserted through the REAL resolver the publication pipeline uses
    // (`lib/publicLedgerSnapshot.ts` freezes `displayMerchantName(txn)` into
    // `counterparty`), not through our own field — the whole failure mode is
    // that the resolver falls through to a field we forgot about.
    expect(displayMerchantName(txn!)).toBe(CONTRACTOR_LEDGER_COUNTERPARTY);

    // And no part of the payee's name appears in anything that publishes.
    expect(displayMerchantName(txn!)).not.toContain("Jane");
    expect(displayMerchantName(txn!)).not.toContain("Contractor Jane");
  });

  test("the service description survives verbatim as the coding's business purpose", async () => {
    // The published `purpose` column reads `publicPurpose ?? businessPurpose`,
    // so this is what makes the public row say what the money bought.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });

    const coding = await run(s.t, async (ctx) => {
      const txn = await ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .first();
      return await ctx.db
        .query("transactionCodings")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn!._id))
        .first();
    });
    expect(coding?.businessPurpose).toBe(AGREEMENT.serviceDescription);
    expect(coding?.portedFromContractorPaymentId).toBe(id);
  });

  test("a description carrying obvious PII is refused server-side", async () => {
    const { s, budgetId } = await setup();
    await expect(
      s.as.mutation(api.contractorPayments.createAgreement, {
        ...AGREEMENT,
        serviceDescription: "Sound work, call me at 555-123-4567",
        budgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("publicTextProblems still survives being serialised to the browser", () => {
    // `lib/contractPage.ts` ships this function to the contractor's browser via
    // `Function.prototype.toString()` rather than re-implementing it, so the
    // page and the server cannot drift. That only works while the function
    // closes over NOTHING — one reference to an imported constant, or a
    // TypeScript downlevel helper like `__spreadArray`, and the emitted source
    // carries a free identifier that is undefined in the browser.
    //
    // The page wraps its call sites in try/catch, so the failure is silent: the
    // inline warning just stops appearing, and the first person to notice is a
    // contractor who gets a 400 after uploading their W-9. This test is the
    // thing that notices instead.
    const src = publicTextProblems.toString();
    const standalone = new Function(
      `"use strict"; var f = ${src}; return f;`,
    )() as (t: string) => string[];

    expect(standalone("Sound engineering for the spring concert")).toEqual([]);
    expect(standalone("mail me at a@b.com")).toHaveLength(1);
    expect(standalone("SSN 123-45-6789")).toHaveLength(1);
    expect(standalone("call 555-123-4567")).toHaveLength(1);
    // And it agrees with the server's own copy on every one of them.
    for (const sample of [
      "Sound engineering",
      "a@b.com",
      "123-45-6789",
      "call 555-123-4567",
      "42 Elm Street",
    ]) {
      expect(standalone(sample)).toEqual(publicTextProblems(sample));
    }
  });


  test("a description too short for the coding validator is refused at the door", () => {
    // THE LANDMINE THIS CLOSES: the description is ported verbatim into the
    // payout transaction's coding as `businessPurpose`, where the shared
    // validator demands MIN_PURPOSE_LENGTH. Creation used to accept 3
    // characters, so a short one passed composition, contractor completion and
    // approval — then threw at the moment the treasurer pressed Pay, with a
    // message about "which org work it served" that means nothing on a payout
    // screen and money that didn't move for a reason nobody could act on.
    expect(contractorDescriptionProblems("sound")).toHaveLength(1);
    expect(contractorDescriptionProblems("Sound engineering")).toHaveLength(1);
    expect(
      contractorDescriptionProblems("Sound engineering for the spring concert"),
    ).toEqual([]);
    // The bar is the coding rule's own, not a number restated here.
    expect(CONTRACTOR_SERVICE_DESCRIPTION_MIN).toBe(MIN_PURPOSE_LENGTH);
  });

  test("publicTextProblems catches the shapes people actually paste", () => {
    expect(publicTextProblems("Sound engineering")).toEqual([]);
    expect(publicTextProblems("email me at a@b.com").length).toBe(1);
    expect(publicTextProblems("SSN 123-45-6789").length).toBe(1);
    expect(publicTextProblems("call 555-123-4567").length).toBe(1);
    expect(publicTextProblems("at 42 Elm Street").length).toBe(1);
    // A bare long digit run reads as an account/tax number.
    expect(publicTextProblems("acct 123456789012").length).toBe(1);
  });
});

// ── 2. The tax document must never leak ─────────────────────────────────────
describe("the tax document's storage id never leaves the server", () => {
  test("neither get() nor list() nor the public view carries a storage id", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const storageId = await run(s.t, async (ctx) => {
      const doc = await ctx.db
        .query("contractorTaxDocuments")
        .withIndex("by_payment", (q) => q.eq("contractorPaymentId", id))
        .first();
      return doc!.storageId;
    });

    const detail = await s.as.query(api.contractorPayments.get, {
      contractorPaymentId: id,
    });
    const list = await s.as.query(api.contractorPayments.list, {});
    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);
    const publicView = await s.t.query(api.contractorPayments.publicByToken, {
      token,
    });

    // Whole-payload assertions on purpose: a future field that carelessly
    // includes the id should fail here even though no test names it.
    for (const payload of [detail, list, publicView]) {
      expect(JSON.stringify(payload)).not.toContain(storageId);
    }

    // The metadata a reviewer legitimately needs IS present.
    expect(detail.taxDocument?.kind).toBe("w9");
    expect(detail.canViewTaxDoc).toBe(true);
  });

  test("the public view never carries the payee's bank reference or the token echo", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);
    const publicView = await s.t.query(api.contractorPayments.publicByToken, {
      token,
    });
    expect(JSON.stringify(publicView)).not.toContain("extacct_test");
    // Only the last four, which they typed themselves.
    expect(publicView?.bankAccountLast4).toBe("6789");
  });

  test("viewing the document writes an audit row", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    await s.as.mutation(api.contractorPayments.viewTaxDocument, {
      contractorPaymentId: id,
    });
    const trail = await run(s.t, (ctx) =>
      ctx.db
        .query("approvals")
        .withIndex("by_subject", (q) =>
          q.eq("subjectType", "contractor_payment").eq("subjectId", String(id)),
        )
        .collect(),
    );
    expect(trail.some((a) => a.note?.includes("W9"))).toBe(true);
  });

  test("retention is four years past the service year", () => {
    // A 2026 document survives all of 2030 and becomes purgeable on 1 Jan 2031.
    expect(taxDocPurgeAfter(2026)).toBe(Date.UTC(2031, 0, 1));
  });

  test("the purge sweep deletes the file and the row", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    await run(s.t, async (ctx) => {
      const doc = await ctx.db
        .query("contractorTaxDocuments")
        .withIndex("by_payment", (q) => q.eq("contractorPaymentId", id))
        .first();
      await ctx.db.patch(doc!._id, { purgeAfter: Date.now() - 1000 });
    });
    await s.t.mutation(internal.contractorPayments.purgeExpiredTaxDocuments, {});
    const remaining = await run(s.t, (ctx) =>
      ctx.db
        .query("contractorTaxDocuments")
        .withIndex("by_payment", (q) => q.eq("contractorPaymentId", id))
        .collect(),
    );
    expect(remaining).toHaveLength(0);
  });
});

// ── 3. Editing agreed terms voids the acceptance ────────────────────────────
describe("an acceptance only ever covers the terms that were accepted", () => {
  test("changing the amount voids the acceptance and reopens the link", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);

    const before = await run(s.t, (ctx) => ctx.db.get(id));
    expect(before!.acceptedAt).toBeTruthy();
    expect(before!.status).toBe("submitted");

    const result = await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      agreedAmountCents: 90_000,
    });
    expect(result.acceptanceVoided).toBe(true);

    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.acceptedAt).toBeUndefined();
    expect(after!.acceptedSignature).toBeUndefined();
    expect(after!.status).toBe("sent");
    expect(after!.agreementTermsVersion).toBe(2);
  });

  test("changing only the coding does NOT void the acceptance", async () => {
    // The contractor never agreed to which budget line pays them, and
    // re-asking for a signature over a bookkeeping move would teach people to
    // click through acceptance without reading.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const result = await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      clearAttribution: true,
    });
    expect(result.acceptanceVoided).toBe(false);
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.acceptedAt).toBeTruthy();
    expect(after!.status).toBe("submitted");
  });

  test("a no-op re-save of the same terms voids nothing", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const result = await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      agreedAmountCents: AGREEMENT.agreedAmountCents,
      serviceDescription: AGREEMENT.serviceDescription,
    });
    expect(result.acceptanceVoided).toBe(false);
  });

  test("the accepted version is recorded, so a stale signature is detectable", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);

    let view = await s.t.query(api.contractorPayments.publicByToken, { token });
    expect(view?.acceptedCurrentTerms).toBe(true);

    await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      agreedAmountCents: 90_000,
    });
    view = await s.t.query(api.contractorPayments.publicByToken, { token });
    expect(view?.acceptedCurrentTerms).toBe(false);
  });
});

// ── 3b. What a contractor is told about money ───────────────────────────────
describe("a partially-approved contractor is told the real number", () => {
  test("publicByToken carries approvedCents once a reviewer sets one", async () => {
    // The status page quotes this. Without it the page could only show the
    // AGREED figure, telling someone whose $750 was approved at $500 that
    // $750.00 reached their bank — a false statement about their own money,
    // made by us, in writing.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);

    let view = await s.t.query(api.contractorPayments.publicByToken, { token });
    expect(view?.approvedCents ?? null).toBeNull();

    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
      approvedCents: 50_000,
    });
    view = await s.t.query(api.contractorPayments.publicByToken, { token });
    expect(view?.approvedCents).toBe(50_000);
    expect(view?.agreedAmountCents).toBe(AGREEMENT.agreedAmountCents);
  });
});

// ── 3c. Clearing a field actually clears it ─────────────────────────────────
describe("emptying a field is not silently ignored", () => {
  test("clearServiceDate removes the date and voids the acceptance", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId, serviceDate: Date.UTC(2026, 4, 1, 12) },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: AGREEMENT.payeeName,
      payeeEmail: AGREEMENT.payeeEmail,
      taxDocStorageId: storageId,
      taxDocKind: "w9",
      externalAccountId: "extacct_test",
      bankAccountLast4: "6789",
      signature: "Jane",
    });

    const result = await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId,
      clearServiceDate: true,
    });
    const after = await run(s.t, (ctx) => ctx.db.get(contractorPaymentId));
    expect(after!.serviceDate).toBeUndefined();
    // Removing the date the work was done IS a change to the agreed terms.
    expect(result.acceptanceVoided).toBe(true);
  });

  test("clearCategory removes the category and voids nothing", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    // An ORG-WIDE category — no chapter, no fund (2026-08-14). Seeded in that
    // shape deliberately: `updateTerms` used to run this id through
    // `requireInChapter`, which would reject every category once the column is
    // cleared. Its check is existence now.
    const categoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        name: "Production",
        kind: "lineItem",
        isActive: true,
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      categoryId,
    });
    expect(
      (await run(s.t, (ctx) => ctx.db.get(id)))!.categoryId,
    ).toBe(categoryId);

    const result = await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      clearCategory: true,
    });
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.categoryId).toBeUndefined();
    // Coding is not something the contractor agreed to.
    expect(result.acceptanceVoided).toBe(false);
  });
});

// ── 3d. The treasurer nudge keeps working after a send-back ─────────────────
describe("the review sweep does not go permanently silent", () => {
  test("a resubmission clears the nudge stamps", async () => {
    // The stamps mean "we already chased somebody about THIS submission". A
    // resubmission is a new wait; leaving them set meant any payment that went
    // round the send-back loop was never chased again — the payment most
    // likely to need it.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    await run(s.t, (ctx) =>
      ctx.db.patch(id, {
        reviewNudgeSentAt: Date.now(),
        reviewEscalatedAt: Date.now(),
      }),
    );
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.requestChanges, {
      contractorPaymentId: id,
      note: "Wrong tax year on the W-9.",
    });

    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);
    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: AGREEMENT.payeeName,
      payeeEmail: AGREEMENT.payeeEmail,
      taxDocStorageId: storageId,
      taxDocKind: "w9",
      externalAccountId: "extacct_test",
      bankAccountLast4: "6789",
      signature: "Jane",
    });
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.reviewNudgeSentAt).toBeUndefined();
    expect(after!.reviewEscalatedAt).toBeUndefined();
  });
});

// ── 3e. The two rails stay out of each other's way ──────────────────────────
describe("the rails do not pollute each other", () => {
  test("listPayouts returns reimbursement payouts only", async () => {
    // It backs the reimbursements screen, which keys a Map on
    // `reimbursementId`. A contractor payout leaking in both breaks that type
    // and competes for the query's 200-row cap, pushing real reimbursement
    // payouts out of a view that claims to be complete.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });

    // The contractor payout exists...
    const all = await run(s.t, (ctx) =>
      ctx.db
        .query("payouts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(all.length).toBeGreaterThan(0);

    // ...and the reimbursement screen's query does not show it.
    const listed = await s.as.query(api.increasePayouts.listPayouts, {});
    expect(listed.every((p) => p.reimbursementId != null)).toBe(true);
    expect(listed.some((p) => String(p.id) === String(all[0]._id))).toBe(false);
  });

  test("a hand-marked payment records the disbursement and reads as manual", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });

    const payout = await run(s.t, (ctx) =>
      ctx.db
        .query("payouts")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .first(),
    );
    expect(payout!.provider).toBe("manual");

    const trail = await run(s.t, (ctx) =>
      ctx.db
        .query("approvals")
        .withIndex("by_subject", (q) =>
          q.eq("subjectType", "contractor_payment").eq("subjectId", String(id)),
        )
        .collect(),
    );
    // Releasing money is the act SoD exists to constrain, so it has to be
    // answerable from the record.
    expect(trail.some((a) => a.action === "pay")).toBe(true);
  });

  test("the contractor ledger row names its own rail", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });
    const txn = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .first(),
    );
    // Not "reimbursement" — that literal renders "Reimbursement payout" in the
    // rail column, which is the confusion this feature's naming exists to
    // avoid.
    expect(txn!.source).toBe("contractor_payment");
  });
});

// ── 4. Separation of duties ─────────────────────────────────────────────────
describe("separation of duties", () => {
  test("the person who wrote the agreement cannot approve it", async () => {
    // The addition over reimbursements: a staffer can pre-fill an agreement
    // naming someone else and then approve it themselves, which is exactly the
    // shape this control exists to stop.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    await expect(
      s.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId: id,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a different manager can approve it", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.status).toBe("approved");
    expect(after!.approvedCents).toBe(AGREEMENT.agreedAmountCents);
  });

  test("an approver whose own email is the payee's is refused", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, payeeEmail: "treasurer@publicworship.life", budgetId },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: "Jane",
      payeeEmail: "treasurer@publicworship.life",
      taxDocStorageId: storageId,
      taxDocKind: "w9",
      externalAccountId: "extacct_test",
      bankAccountLast4: "1111",
      signature: "Jane",
    });
    const approver = await seedApprover(s);
    await expect(
      approver.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId,
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 5. The approval gates ───────────────────────────────────────────────────
describe("approval refuses what it should", () => {
  test("an uncoded self-serve request cannot be approved", async () => {
    const { s } = await setup();
    const storageId = await storeBlob(s.t);
    const { token } = await s.t.mutation(
      api.contractorPayments.submitPublicRequest,
      {
        chapterSlug: "new-york",
        payeeName: "Sam Freelancer",
        payeeEmail: "sam@example.com",
        serviceDescription: "Photography for the outreach event",
        requestedAmountCents: 40_000,
        taxDocStorageId: storageId,
        taxDocKind: "w9",
        externalAccountId: "extacct_test",
        bankAccountLast4: "2222",
        signature: "Sam Freelancer",
      },
    );
    const id = await run(s.t, async (ctx) => {
      const row = await ctx.db
        .query("contractorPayments")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      return row!._id;
    });

    const approver = await seedApprover(s);
    await expect(
      approver.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId: id,
      }),
    ).rejects.toThrow(ConvexError);

    // Code it, and the same call succeeds.
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_000,
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        label: "Outreach",
        createdAt: Date.now(),
      }),
    );
    await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      budgetId,
    });
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.status).toBe("approved");
  });

  test("a W-8 on file blocks approval", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(
      s.t,
      async (ctx) => (await ctx.db.get(contractorPaymentId))!.token,
    );
    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: AGREEMENT.payeeName,
      payeeEmail: AGREEMENT.payeeEmail,
      taxDocStorageId: storageId,
      taxDocKind: "w8ben",
      // A W-8 must carry its signing date — it expires three years after, and
      // an undated one reads as already expired.
      taxDocSignedAt: Date.now() - 24 * 60 * 60 * 1000,
      externalAccountId: "extacct_test",
      bankAccountLast4: "3333",
      signature: "Jane",
    });
    const approver = await seedApprover(s);
    await expect(
      approver.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("approving MORE than was agreed is refused", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await expect(
      approver.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId: id,
        approvedCents: AGREEMENT.agreedAmountCents + 1,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("approving LESS is allowed (partial approval)", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
      approvedCents: 50_000,
    });
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.approvedCents).toBe(50_000);
  });

  test("an absurd amount is refused at creation", async () => {
    const { s, budgetId } = await setup();
    await expect(
      s.as.mutation(api.contractorPayments.createAgreement, {
        ...AGREEMENT,
        agreedAmountCents: CONTRACTOR_PAYMENT_MAX_CENTS + 1,
        budgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 6. The payout rail, shared with reimbursements ──────────────────────────
describe("the payout rail carries both subjects without confusing them", () => {
  test("paying twice does not double-pay", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });

    const payouts = await run(s.t, (ctx) =>
      ctx.db
        .query("payouts")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .collect(),
    );
    expect(payouts).toHaveLength(1);

    const txns = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .collect(),
    );
    expect(txns).toHaveLength(1);
  });

  test("the ledger row is an outflow that counts as spend", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });
    const txn = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .first(),
    );
    expect(txn!.flow).toBe("outflow");
    expect(txn!.amountCents).toBe(AGREEMENT.agreedAmountCents);
    // The "For" tag is ported so the row isn't an uncoded orphan in Reconcile.
    expect(txn!.budgetId).toBe(budgetId);
  });

  test("a reimbursement payout is untouched by the contractor branch", async () => {
    // The generalization made `payouts.reimbursementId` optional. This asserts
    // the reimbursement rail still resolves its own subject — the regression a
    // careless dispatch would cause.
    const { s } = await setup();
    const payoutId = await run(s.t, async (ctx) => {
      const reqId = await ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: "tok_reimb",
        status: "approved",
        payeeName: "Member",
        totalCents: 1000,
        approvedCents: 1000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      return await ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId: reqId,
        amountCents: 1000,
        provider: "manual",
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const payout = await run(s.t, (ctx) => ctx.db.get(payoutId));
    expect(payout!.reimbursementId).toBeTruthy();
    expect(payout!.contractorPaymentId).toBeUndefined();
  });
});

// ── 7. The state machine ────────────────────────────────────────────────────
describe("the state machine refuses illegal moves", () => {
  test("a draft cannot be approved", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    const approver = await seedApprover(s);
    await expect(
      approver.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a paid payment cannot be cancelled", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
    });
    await expect(
      approver.as.mutation(api.contractorPayments.cancel, {
        contractorPaymentId: id,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("send-back reopens the contractor's link and clears on resubmit", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.requestChanges, {
      contractorPaymentId: id,
      note: "Your W-9 is from the wrong year.",
    });
    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);
    const view = await s.t.query(api.contractorPayments.publicByToken, {
      token,
    });
    expect(view?.canEdit).toBe(true);
    expect(view?.reviewNote).toContain("wrong year");

    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: AGREEMENT.payeeName,
      payeeEmail: AGREEMENT.payeeEmail,
      taxDocStorageId: storageId,
      taxDocKind: "w9",
      externalAccountId: "extacct_test",
      bankAccountLast4: "6789",
      signature: "Jane Contractor",
    });
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.status).toBe("submitted");
    expect(after!.reviewNote).toBeUndefined();
  });

  test("sending refuses when the chapter has no public slug", async () => {
    // `chapters.slug` is optional. Without one the contractor's URL builds as
    // `/contract/?token=…`, which the route 404s — so `send` would succeed,
    // staff would copy a dead link into a text message, and the contractor
    // would never get paid with nothing reporting a failure anywhere.
    const t = newT();
    const s = await setupChapter(t); // deliberately NO setSlug
    await disarmCodingPolicy(t);
    const personId = await seedPerson(s, {
      name: "Composer",
      email: s.email,
      userId: s.userId,
    });
    await grantManager(s, personId);
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
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    await expect(
      s.as.mutation(api.contractorPayments.send, { contractorPaymentId }),
    ).rejects.toThrow(ConvexError);

    // And it stays a draft, so nothing claims to have been sent.
    const after = await run(t, (ctx) => ctx.db.get(contractorPaymentId));
    expect(after!.status).toBe("draft");
    expect(after!.sentAt).toBeUndefined();
  });

  test("an unknown token is indistinguishable from a cancelled one", async () => {
    const { s } = await setup();
    expect(
      await s.t.query(api.contractorPayments.publicByToken, {
        token: "nope",
      }),
    ).toBeNull();
  });

  test("a completed payment's link stops accepting changes", async () => {
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const token = await run(s.t, async (ctx) => (await ctx.db.get(id))!.token);
    const storageId = await storeBlob(s.t);
    // Already `submitted` — the contractor no longer holds the ball.
    await expect(
      s.t.mutation(api.contractorPayments.completeAgreement, {
        token,
        payeeName: "Someone Else",
        payeeEmail: "other@example.com",
        taxDocStorageId: storageId,
        taxDocKind: "w9",
        externalAccountId: "extacct_evil",
        bankAccountLast4: "9999",
        signature: "Someone Else",
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 8. Access control ───────────────────────────────────────────────────────
describe("access gates", () => {
  test("a non-finance member cannot read or compose", async () => {
    const { s, budgetId } = await setup();
    await sendAndComplete(s, budgetId);

    const email = "member@publicworship.life";
    const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email }));
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "Member", email, userId });
    const asMember = s.t.withIdentity({
      subject: `${userId}|session`,
      issuer: "test",
    });

    await expect(
      asMember.query(api.contractorPayments.list, {}),
    ).rejects.toThrow(ConvexError);
    await expect(
      asMember.mutation(api.contractorPayments.createAgreement, {
        ...AGREEMENT,
        budgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the secret link is withheld from someone who may not send it", async () => {
    // `get` returns `token` only to a caller with compose rights — a list or a
    // viewer-level read must never hand out a link that lets anyone fill in
    // somebody's bank details.
    const { s, budgetId } = await setup();
    const id = await sendAndComplete(s, budgetId);
    const list = await s.as.query(api.contractorPayments.list, {});
    expect(JSON.stringify(list)).not.toContain(
      await run(s.t, async (ctx) => (await ctx.db.get(id))!.token),
    );
  });
});
