/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Reimbursement tests — the accountless PUBLIC submission path (secret token,
 * status timeline), its in-app member twin, and the in-app manager approval
 * queue.
 *
 * Owner-mandated overhaul covered here:
 *  - the public page's `chapterForReimburse` payload carries NO funds/budget
 *    categories (categorization is a finance manager's review-time job);
 *  - `purpose`, every line's `description`/`receiptStorageId`/
 *    `transactionDate` are REQUIRED (server-enforced, one invariant owner:
 *    `createReimbursement`);
 *  - a pre-submit, no-token, rate-limited receipt-upload endpoint
 *    (`preSubmitUploadUrl`) backs the public flow's "receipts before submit";
 *  - NO reimbursement request may be created without a real ACH destination:
 *    the client LINKS FIRST (`linkPublicBankAccount`/`linkBankAccount`, now
 *    both callable with no existing request — `token`/`reimbursementId`
 *    optional — to create a real Increase External Account), then passes the
 *    resulting `externalAccountId` into `submitPublicReimbursement`/
 *    `submitReimbursement` (plain mutations, which reject a missing one);
 *  - the "For" tag is now event XOR project XOR a RECURRING budget
 *    (`budgetId`), and `newRequestOptions`'s picker only offers a
 *    BUDGET-BACKED event/project or the chapter's own approved recurring
 *    budgets (never central).
 *
 * Also still covers: SoD, partial approval, illegal transitions, the
 * accountless receipt upload (token-scoped, kept for REPLACING a receipt),
 * and the reminder sweep degrading without RESEND_API_KEY.
 */

// ── Increase mock plumbing ───────────────────────────────────────────────────
// Every reimbursement submission now requires a real Increase External
// Account, so EVERY test in this file needs `/external_accounts` to resolve.
// Default to a succeeding mock before each test (a fresh id per call);
// individual tests that want to exercise a bank-link FAILURE override
// `globalThis.fetch`/unset `INCREASE_API_KEY` locally — `afterEach` always
// restores this default before the next test runs.
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let extAcctSeq = 0;

function mockIncreaseSuccess(): void {
  process.env.INCREASE_API_KEY = "test_key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/external_accounts")) {
      extAcctSeq += 1;
      return new Response(JSON.stringify({ id: `extacct_auto_${extAcctSeq}` }), {
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Give the seeded chapter a slug so the public submit can resolve it. */
async function setSlug(s: ChapterSetup, slug: string): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { slug }));
}

/** Insert a roster person, optionally linked to a user + typed as team. */
async function seedPerson(
  s: ChapterSetup,
  opts: {
    name: string;
    email?: string;
    phone?: string;
    userId?: Id<"users">;
    isTeamMember?: boolean;
  },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      email: opts.email,
      phone: opts.phone,
      userId: opts.userId,
      isTeamMember: opts.isTeamMember ?? false,
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

/** Add a SECOND authenticated member to the same chapter as `s`, with their
 *  own `users`/`userChapters`/`people` rows — returns an authenticated client
 *  scoped to them (mirrors what `setupChapter` does for the first member). */
async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  userId: Id<"users">;
  personId: Id<"people">;
}> {
  const userId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: opts.email }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await seedPerson(s, {
    name: opts.name,
    email: opts.email,
    userId,
  });
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, personId };
}

type ValidLine = {
  description: string;
  amountCents: number;
  receiptStorageId: Id<"_storage">;
  transactionDate: number;
};

/** One VALID line — description/amountCents overridable, a real stored
 *  receipt + a fresh `transactionDate` always present (both REQUIRED now). */
async function validLine(
  s: ChapterSetup,
  overrides: Partial<Pick<ValidLine, "description" | "amountCents" | "transactionDate">> = {},
): Promise<ValidLine> {
  const receiptStorageId = await storeBlob(s.t);
  return {
    description: "Gaffer tape",
    amountCents: 1200,
    transactionDate: Date.now(),
    ...overrides,
    receiptStorageId,
  };
}

/** `n` valid lines with the classic Gaffer-tape/Snacks amounts. */
async function validLines(s: ChapterSetup, n = 2): Promise<ValidLine[]> {
  const specs = [
    { description: "Gaffer tape", amountCents: 1200 },
    { description: "Snacks", amountCents: 800 },
  ];
  const out: ValidLine[] = [];
  for (let i = 0; i < n; i++) out.push(await validLine(s, specs[i % specs.length]));
  return out;
}

/** LINK FIRST (public, no token — the request doesn't exist yet), the way
 *  the real client (the public reimburse page's httpAction, and the mobile
 *  in-app form) both now resolve a bank destination before ever calling
 *  submit. Throws (mirroring a real client refusing to proceed) if the link
 *  doesn't succeed. */
async function resolvePublicBank(
  s: ChapterSetup,
  overrides: Partial<{
    routingNumber: string;
    accountNumber: string;
    accountHolderName: string;
    funding: "checking" | "savings";
    clientIp: string;
  }> = {},
): Promise<{ externalAccountId: string; last4?: string }> {
  const result = await s.t.action(api.reimbursements.linkPublicBankAccount, {
    ...overrides,
    routingNumber: overrides.routingNumber ?? "011000015",
    accountNumber: overrides.accountNumber ?? "555000111",
  });
  if (!result.linked || !result.externalAccountId) {
    throw new ConvexError({
      code: "BANK_LINK_FAILED",
      message: "We couldn't verify those bank details.",
    });
  }
  return { externalAccountId: result.externalAccountId, last4: result.last4 };
}

/** LINK FIRST (in-app, no `reimbursementId` — the request doesn't exist yet)
 *  — the authenticated twin of `resolvePublicBank`. */
async function resolveInAppBank(
  as: ReturnType<TestConvex["withIdentity"]>,
  overrides: Partial<{
    routingNumber: string;
    accountNumber: string;
    accountHolderName: string;
    funding: "checking" | "savings";
  }> = {},
): Promise<{ externalAccountId: string; last4?: string }> {
  const result = await as.action(api.reimbursements.linkBankAccount, {
    ...overrides,
    routingNumber: overrides.routingNumber ?? "011000015",
    accountNumber: overrides.accountNumber ?? "0987654321",
  });
  if (!result.linked || !result.externalAccountId) {
    throw new ConvexError({
      code: "BANK_LINK_FAILED",
      message: "We couldn't verify those bank details.",
    });
  }
  return { externalAccountId: result.externalAccountId, last4: result.last4 };
}

/** Link a bank account, then submit a public reimbursement (the real
 *  two-step flow) — override any field, including `lines` or the bank
 *  fields (forwarded to the link step, not the submit mutation). */
async function submitTwoLine(
  s: ChapterSetup,
  slug: string,
  extra: Partial<{
    payeeName: string;
    payeeEmail: string;
    payeePhone: string;
    purpose: string;
    requestPreApproval: boolean;
    clientIp: string;
    routingNumber: string;
    accountNumber: string;
    accountHolderName: string;
    funding: "checking" | "savings";
    lines: ValidLine[];
  }> = {},
): Promise<{ token: string; reference: string }> {
  const lines = extra.lines ?? (await validLines(s));
  const bank = await resolvePublicBank(s, {
    routingNumber: extra.routingNumber,
    accountNumber: extra.accountNumber,
    accountHolderName: extra.accountHolderName,
    funding: extra.funding,
    clientIp: extra.clientIp,
  });
  return await s.t.mutation(api.reimbursements.submitPublicReimbursement, {
    chapterSlug: slug,
    payeeName: extra.payeeName ?? "Dana Rivers",
    payeeEmail: extra.payeeEmail ?? "dana@example.com",
    payeePhone: extra.payeePhone,
    purpose: extra.purpose ?? "Event supplies",
    requestPreApproval: extra.requestPreApproval,
    clientIp: extra.clientIp,
    externalAccountId: bank.externalAccountId,
    bankAccountLast4: bank.last4,
    lines,
  });
}

/** Link a bank account, then submit an in-app reimbursement (the real
 *  two-step flow) — the authenticated twin of `submitTwoLine`. */
async function submitInApp(
  as: ReturnType<TestConvex["withIdentity"]>,
  s: ChapterSetup,
  extra: Partial<{
    payeeName: string;
    payeeEmail: string;
    payeePhone: string;
    purpose: string;
    requestPreApproval: boolean;
    eventId: Id<"events">;
    projectId: Id<"projects">;
    budgetId: Id<"budgets">;
    routingNumber: string;
    accountNumber: string;
    lines: Array<{
      description: string;
      amountCents: number;
      receiptStorageId?: Id<"_storage">;
      transactionDate?: number;
      fundId?: Id<"funds">;
    }>;
  }> = {},
): Promise<{ reimbursementId: Id<"reimbursementRequests">; reference: string }> {
  const lines = extra.lines ?? [await validLine(s)];
  const bank = await resolveInAppBank(as, {
    routingNumber: extra.routingNumber,
    accountNumber: extra.accountNumber,
  });
  return await as.mutation(api.reimbursements.submitReimbursement, {
    payeeName: extra.payeeName,
    payeeEmail: extra.payeeEmail,
    payeePhone: extra.payeePhone,
    purpose: extra.purpose ?? "Event supplies",
    requestPreApproval: extra.requestPreApproval,
    eventId: extra.eventId,
    projectId: extra.projectId,
    budgetId: extra.budgetId,
    externalAccountId: bank.externalAccountId,
    bankAccountLast4: bank.last4,
    lines,
  });
}

describe("public submission + status view", () => {
  test("creates a request + lines with a secret token, resolves a real bank destination", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token, reference } = await submitTwoLine(s, "nyc");
    expect(token).toBeTruthy();
    expect(reference).toMatch(/^RB-/);

    const { req, lines } = await run(s.t, async (ctx) => {
      const req = await ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      const lines = await ctx.db
        .query("reimbursementLineItems")
        .withIndex("by_reimbursement", (q) =>
          q.eq("reimbursementId", req!._id),
        )
        .collect();
      return { req, lines };
    });
    expect(req?.status).toBe("submitted");
    expect(req?.totalCents).toBe(2000);
    expect(req?.externalAccountId).toBeTruthy();
    expect(req?.bankAccountLast4).toBe("0111"); // last 4 of "555000111"
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.order).sort()).toEqual([0, 1]);
    expect(lines.every((l) => !!l.receiptStorageId)).toBe(true);
    expect(lines.every((l) => typeof l.transactionDate === "number")).toBe(true);
  });

  test("pre-approval request lands in pending_preapproval", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token } = await submitTwoLine(s, "nyc", {
      requestPreApproval: true,
    });
    const view = await t.query(api.reimbursements.getPublicReimbursement, {
      token,
    });
    expect(view?.status).toBe("pending_preapproval");
  });

  test("unknown slug is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(submitTwoLine(s, "does-not-exist")).rejects.toBeInstanceOf(
      ConvexError,
    );
  });

  test("non-integer cents is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await expect(
      submitTwoLine(s, "nyc", {
        lines: [{ description: "x", amountCents: 12.5 } as unknown as ValidLine],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("zero / negative and oversized line amounts are rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    for (const bad of [0, -100, 100_000_001]) {
      await expect(
        submitTwoLine(s, "nyc", {
          lines: [{ description: "x", amountCents: bad } as unknown as ValidLine],
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
  });

  test("a missing / malformed email is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    for (const bad of ["", "   ", "not-an-email"]) {
      await expect(
        submitTwoLine(s, "nyc", { payeeEmail: bad, lines: [await validLine(s)] }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
  });

  test("long free-text fields are capped server-side", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const receiptStorageId = await storeBlob(s.t);
    const { token } = await submitTwoLine(s, "nyc", {
      payeeName: "N".repeat(500),
      purpose: "P".repeat(5000),
      lines: [
        {
          description: "D".repeat(2000),
          amountCents: 1200,
          receiptStorageId,
          transactionDate: Date.now(),
        },
      ],
    });
    const { req, line } = await run(s.t, async (ctx) => {
      const req = await ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      const line = await ctx.db
        .query("reimbursementLineItems")
        .withIndex("by_reimbursement", (q) =>
          q.eq("reimbursementId", req!._id),
        )
        .first();
      return { req, line };
    });
    expect(req!.payeeName.length).toBeLessThanOrEqual(120);
    expect((req!.purpose ?? "").length).toBeLessThanOrEqual(2000);
    expect((line!.description ?? "").length).toBeLessThanOrEqual(500);
  });

  test("getPublicReimbursement returns the status view + timeline, no token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token, reference } = await submitTwoLine(s, "nyc");
    const view = await t.query(api.reimbursements.getPublicReimbursement, {
      token,
    });
    expect(view).not.toBeNull();
    expect(view!.reference).toBe(reference);
    expect(view!.status).toBe("submitted");
    expect(view!.totalCents).toBe(2000);
    expect(view!.lines.length).toBe(2);
    // No secrets leak through the status view.
    expect(JSON.stringify(view)).not.toContain(token);
    expect(view as Record<string, unknown>).not.toHaveProperty("token");
  });

  test("getPublicReimbursement is null for an unknown token", async () => {
    const t = newT();
    await setupChapter(t);
    const view = await t.query(api.reimbursements.getPublicReimbursement, {
      token: "nope",
    });
    expect(view).toBeNull();
  });
});

describe("public-page privacy: no funds/categories in the payload", () => {
  test("chapterForReimburse returns only slug + name — no funds or budget categories", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
    const view = await t.query(api.lib.reimburseApiRoutes.chapterForReimburse, {
      slug: "nyc",
    });
    expect(view).toEqual({ slug: "nyc", name: chapter!.name });
    expect(view as Record<string, unknown>).not.toHaveProperty("funds");
    expect(view as Record<string, unknown>).not.toHaveProperty("categories");
  });

  test("an unknown slug returns null", async () => {
    const t = newT();
    await setupChapter(t);
    const view = await t.query(api.lib.reimburseApiRoutes.chapterForReimburse, {
      slug: "nope",
    });
    expect(view).toBeNull();
  });
});

describe("required fields at submit (purpose, description, receipt, transactionDate)", () => {
  test("a blank purpose is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    for (const bad of ["", "   "]) {
      await expect(
        submitTwoLine(s, "nyc", { purpose: bad, lines: [await validLine(s)] }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
  });

  test("a blank line description is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const line = await validLine(s, { description: "   " });
    await expect(
      submitTwoLine(s, "nyc", { lines: [line] }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a missing receipt is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await expect(
      submitTwoLine(s, "nyc", {
        lines: [
          {
            description: "x",
            amountCents: 1200,
            transactionDate: Date.now(),
          } as unknown as ValidLine,
        ],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a missing transactionDate is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const receiptStorageId = await storeBlob(s.t);
    await expect(
      submitTwoLine(s, "nyc", {
        lines: [
          { description: "x", amountCents: 1200, receiptStorageId } as unknown as ValidLine,
        ],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a transactionDate more than 48h in the future is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const line = await validLine(s, {
      transactionDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
    });
    await expect(
      submitTwoLine(s, "nyc", { lines: [line] }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a transactionDate older than 3 years is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const line = await validLine(s, {
      transactionDate: Date.now() - 4 * 365 * 24 * 60 * 60 * 1000,
    });
    await expect(
      submitTwoLine(s, "nyc", { lines: [line] }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a transactionDate within the sanity window is accepted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const line = await validLine(s, {
      transactionDate: Date.now() - 30 * 24 * 60 * 60 * 1000, // a month ago
    });
    await expect(
      submitTwoLine(s, "nyc", { lines: [line] }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe("bank destination required at submit", () => {
  test("a malformed routing number is rejected before any Increase call", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called on invalid input");
    }) as unknown as typeof fetch;
    await expect(
      submitTwoLine(s, "nyc", { routingNumber: "123" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("Increase not configured for this environment rejects the submission (never a manual degrade at submit)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    delete process.env.INCREASE_API_KEY;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the key is unset");
    }) as unknown as typeof fetch;
    await expect(submitTwoLine(s, "nyc")).rejects.toBeInstanceOf(ConvexError);
  });

  test("a failed Increase call rejects the submission", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(submitTwoLine(s, "nyc")).rejects.toBeInstanceOf(ConvexError);
  });

  test("the in-app path also requires a resolved bank destination", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    delete process.env.INCREASE_API_KEY;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the key is unset");
    }) as unknown as typeof fetch;
    await expect(submitInApp(s.as, s)).rejects.toBeInstanceOf(ConvexError);
  });

  test("the resolved external account id + last4 are stored, never the raw account number", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/external_accounts")) {
        calls.push(init?.body ? JSON.parse(String(init.body)) : {});
        return new Response(JSON.stringify({ id: "extacct_captured_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    const { token } = await submitTwoLine(s, "nyc", {
      accountNumber: "999888777",
    });
    expect(calls[0].account_number).toBe("999888777");
    expect(calls[0].routing_number).toBe("011000015");

    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    expect(req?.externalAccountId).toBe("extacct_captured_1");
    expect(req?.bankAccountLast4).toBe("8777");
    expect(JSON.stringify(req)).not.toContain("999888777");
  });

  test("linkPublicBankAccount with no token resolves a destination with no request required — returns externalAccountId + last4", async () => {
    const t = newT();
    await setupChapter(t);
    const result = await t.action(api.reimbursements.linkPublicBankAccount, {
      routingNumber: "011000015",
      accountNumber: "555000111",
    });
    expect(result.linked).toBe(true);
    expect(result.externalAccountId).toBeTruthy();
    expect(result.last4).toBe("0111");
  });

  test("linkBankAccount with no reimbursementId resolves a destination with no request required — returns externalAccountId + last4", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const result = await s.as.action(api.reimbursements.linkBankAccount, {
      routingNumber: "011000015",
      accountNumber: "0987654321",
    });
    expect(result.linked).toBe(true);
    expect(result.externalAccountId).toBeTruthy();
    expect(result.last4).toBe("4321");
  });

  test("linkBankAccount with no reimbursementId still requires auth (a roster person)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No roster row for the caller.
    await expect(
      s.as.action(api.reimbursements.linkBankAccount, {
        routingNumber: "011000015",
        accountNumber: "0987654321",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("linkPublicBankAccount with no token is rate-limited per IP", async () => {
    const t = newT();
    await setupChapter(t);
    // The cap (20) is generous — exhaust it, then confirm the NEXT call trips.
    for (let i = 0; i < 20; i++) {
      await t.action(api.reimbursements.linkPublicBankAccount, {
        routingNumber: "011000015",
        accountNumber: "555000111",
        clientIp: "203.0.113.11",
      });
    }
    let caught: unknown;
    try {
      await t.action(api.reimbursements.linkPublicBankAccount, {
        routingNumber: "011000015",
        accountNumber: "555000111",
        clientIp: "203.0.113.11",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "RATE_LIMITED",
    );

    // A different IP is unaffected.
    await expect(
      t.action(api.reimbursements.linkPublicBankAccount, {
        routingNumber: "011000015",
        accountNumber: "555000111",
        clientIp: "198.51.100.21",
      }),
    ).resolves.toMatchObject({ linked: true });
  });
});

describe("submitPublicReimbursement rate limiting", () => {
  test("blocks the 6th submission within the window from the SAME ip, allows a different ip", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");

    // 5 submissions from the same ip + email succeed (the cap).
    for (let i = 0; i < 5; i++) {
      await submitTwoLine(s, "nyc", {
        payeeEmail: `dana+${i}@example.com`,
        clientIp: "203.0.113.1",
      });
    }
    // The 6th from the SAME ip (even with a fresh email) is rate-limited.
    let caught: unknown;
    try {
      await submitTwoLine(s, "nyc", {
        payeeEmail: "dana+6@example.com",
        clientIp: "203.0.113.1",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "RATE_LIMITED",
    );

    // A DIFFERENT ip is unaffected.
    await expect(
      submitTwoLine(s, "nyc", {
        payeeEmail: "dana+other@example.com",
        clientIp: "198.51.100.9",
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  test("blocks the 6th submission within the window from the SAME email, allows a different email", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");

    // 5 submissions from the same email (rotating ip) succeed.
    for (let i = 0; i < 5; i++) {
      await submitTwoLine(s, "nyc", {
        payeeEmail: "repeat@example.com",
        clientIp: `203.0.113.${i}`,
      });
    }
    // The 6th with the SAME (case/whitespace-insensitive) email is blocked,
    // even from a brand-new ip.
    let caught: unknown;
    try {
      await submitTwoLine(s, "nyc", {
        payeeEmail: "  Repeat@Example.com  ",
        clientIp: "203.0.113.99",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "RATE_LIMITED",
    );

    // A DIFFERENT email is unaffected.
    await expect(
      submitTwoLine(s, "nyc", {
        payeeEmail: "someone-else@example.com",
        clientIp: "203.0.113.99",
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  test("submissions older than the window don't count against the cap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");

    // 5 submissions, then manually age their rate-limit rows past the window.
    for (let i = 0; i < 5; i++) {
      await submitTwoLine(s, "nyc", {
        payeeEmail: `stale+${i}@example.com`,
        clientIp: "203.0.113.50",
      });
    }
    await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("reimbursementSubmitAttempts").collect();
      for (const row of rows) {
        await ctx.db.patch(row._id, {
          createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2h ago (window is 1h)
        });
      }
    });

    // A 6th submission from the same ip now succeeds — the prior 5 are stale.
    await expect(
      submitTwoLine(s, "nyc", {
        payeeEmail: "fresh@example.com",
        clientIp: "203.0.113.50",
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  test("with no clientIp, only the email key is enforced", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");

    for (let i = 0; i < 5; i++) {
      await submitTwoLine(s, "nyc", {
        payeeEmail: "no-ip@example.com",
        clientIp: undefined,
      });
    }
    await expect(
      submitTwoLine(s, "nyc", { payeeEmail: "no-ip@example.com", clientIp: undefined }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("pre-submit receipt upload (public, no token)", () => {
  test("returns an upload URL for a known chapter slug", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const url = await t.mutation(api.reimbursements.preSubmitUploadUrl, {
      chapterSlug: "nyc",
      clientIp: "203.0.113.5",
    });
    expect(typeof url).toBe("string");
  });

  test("rejects an unknown chapter slug", async () => {
    const t = newT();
    await setupChapter(t);
    await expect(
      t.mutation(api.reimbursements.preSubmitUploadUrl, {
        chapterSlug: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rate-limited per IP after the cap — a different IP is unaffected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    // The cap (40) is generous — exhaust it, then confirm the NEXT call trips.
    for (let i = 0; i < 40; i++) {
      await t.mutation(api.reimbursements.preSubmitUploadUrl, {
        chapterSlug: "nyc",
        clientIp: "203.0.113.7",
      });
    }
    let caught: unknown;
    try {
      await t.mutation(api.reimbursements.preSubmitUploadUrl, {
        chapterSlug: "nyc",
        clientIp: "203.0.113.7",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "RATE_LIMITED",
    );

    // A different IP is unaffected — and it's a SEPARATE counter from submit's.
    await expect(
      t.mutation(api.reimbursements.preSubmitUploadUrl, {
        chapterSlug: "nyc",
        clientIp: "198.51.100.20",
      }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe("in-app queue never leaks the token", () => {
  test("list + get omit the token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token } = await submitTwoLine(s, "nyc");
    const person = await seedPerson(s, {
      name: "Manager",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, person, "manager");

    const rows = await s.as.query(api.reimbursements.list, {});
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0] as Record<string, unknown>).not.toHaveProperty("token");
    expect(rows[0].totalCents).toBe(2000);
    expect(rows[0].lineItemCount).toBe(2);
    expect(rows[0].receiptsState).toBe("complete"); // receipts are now required

    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(JSON.stringify(detail)).not.toContain(token);
    expect(detail as Record<string, unknown>).not.toHaveProperty("token");
    expect(detail.lines.length).toBe(2);
    expect(detail.hasExternalAccount).toBe(true);
  });

  test("list status filter works", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await submitTwoLine(s, "nyc");
    await submitTwoLine(s, "nyc", { requestPreApproval: true });
    const person = await seedPerson(s, {
      name: "Manager",
      userId: s.userId,
    });
    await grantRole(s, person, "viewer");

    const submitted = await s.as.query(api.reimbursements.list, {
      status: "submitted",
    });
    expect(submitted.length).toBe(1);
    const pending = await s.as.query(api.reimbursements.list, {
      status: "pending_preapproval",
    });
    expect(pending.length).toBe(1);
  });

  test("a non-viewer cannot read the queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await submitTwoLine(s, "nyc");
    // Seed a roster row but grant no finance role.
    await seedPerson(s, { name: "Nobody", userId: s.userId });
    await expect(
      s.as.query(api.reimbursements.list, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("verified roster identity alongside a payee override", () => {
  test("list + get surface the real roster name for an authenticated in-app submission", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const requester = await addMember(s, {
      email: "dana@publicworship.life",
      name: "Dana Rivers",
    });
    const manager = await seedPerson(s, {
      name: "Manager",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");

    // Dana submits under a different display name — the override.
    await submitInApp(requester.as, s, { payeeName: "D. Rivers Family Fund" });

    const rows = await s.as.query(api.reimbursements.list, {});
    expect(rows.length).toBe(1);
    expect(rows[0].requesterName).toBe("D. Rivers Family Fund");
    expect(rows[0].verifiedRosterName).toBe("Dana Rivers");

    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(detail.payeeName).toBe("D. Rivers Family Fund");
    expect(detail.verifiedRosterName).toBe("Dana Rivers");
  });

  test("the public path never surfaces a verified roster name, even on a roster match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    // A public claimant whose email happens to match an existing roster row.
    await seedPerson(s, { name: "Dana Rivers", email: "dana@example.com" });
    await submitTwoLine(s, "nyc", { payeeEmail: "dana@example.com" });
    const manager = await seedPerson(s, {
      name: "Manager",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");

    const rows = await s.as.query(api.reimbursements.list, {});
    expect(rows.length).toBe(1);
    // matchPerson linked personId (best-effort), but it's NOT a verified
    // identity — the public path never sets `identityVerified`.
    expect(rows[0].verifiedRosterName).toBeNull();

    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(detail.verifiedRosterName).toBeNull();
  });
});

describe("in-app member self-service submission", () => {
  test("requires auth", async () => {
    const t = newT();
    await setupChapter(t);
    // Unauthenticated — the LINK step itself requires auth, so a real client
    // never even gets this far; here we call submit directly to pin that the
    // mutation ALSO gates on auth, independent of the caller's own linking.
    await expect(
      t.mutation(api.reimbursements.submitReimbursement, {
        purpose: "Event supplies",
        externalAccountId: "extacct_fake",
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("requires a roster person (NO_PERSON) when the caller has no roster row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(submitInApp(s.as, s)).rejects.toBeInstanceOf(ConvexError);
  });

  test("creates a request anchored to the caller's own roster person, with a fund + correct total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const fundId = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );

    const line1 = await validLine(s, { description: "Gaffer tape", amountCents: 1200 });
    const line2 = await validLine(s, { description: "Snacks", amountCents: 800 });
    const { reference, reimbursementId } = await submitInApp(s.as, s, {
      lines: [
        { ...line1, fundId },
        { ...line2, fundId },
      ],
    });
    expect(reference).toMatch(/^RB-/);
    expect(reimbursementId).toBeTruthy();

    const { req, lines } = await run(s.t, async (ctx) => {
      const req = await ctx.db.get(reimbursementId);
      const lines = await ctx.db
        .query("reimbursementLineItems")
        .withIndex("by_reimbursement", (q) =>
          q.eq("reimbursementId", reimbursementId),
        )
        .collect();
      return { req, lines };
    });
    expect(req?.status).toBe("submitted");
    expect(req?.totalCents).toBe(2000);
    // Identity is server-derived from the caller's roster row — never trusted
    // from the client — and prefilled from it (SoD anchors to this personId).
    expect(req?.personId).toBe(person);
    expect(req?.payeeName).toBe("Dana Rivers");
    expect(req?.payeeEmail).toBe("dana@example.com");
    expect(req?.externalAccountId).toBeTruthy();
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.fundId === fundId)).toBe(true);
  });

  test("omitting fundId on every line silently lands them on the chapter's General Fund (WP-1.4)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const generalFundId = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );

    const { reimbursementId } = await submitInApp(s.as, s, {
      lines: await validLines(s),
    });
    const lines = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementLineItems")
        .withIndex("by_reimbursement", (q) =>
          q.eq("reimbursementId", reimbursementId),
        )
        .collect(),
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.fundId === generalFundId)).toBe(true);
  });

  test("the ask-for-pre-approval flag lands in pending_preapproval", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const { reimbursementId } = await submitInApp(s.as, s, {
      requestPreApproval: true,
    });
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).toBe("pending_preapproval");
  });

  test("rejects non-integer and negative line cents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    for (const bad of [12.5, 0, -100]) {
      await expect(
        submitInApp(s.as, s, {
          lines: [{ description: "x", amountCents: bad }],
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
  });

  test("a client-supplied name/email override display only — never the requester's identity", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const { reimbursementId } = await submitInApp(s.as, s, {
      payeeName: "D. Rivers",
      payeeEmail: "dana+work@example.com",
    });
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    // Display overrides win…
    expect(req?.payeeName).toBe("D. Rivers");
    expect(req?.payeeEmail).toBe("dana+work@example.com");
    // …but the SoD-anchoring personId is always the caller's own roster row.
    expect(req?.personId).toBe(person);
  });

  test("myReimbursements returns only the caller's own requests, no token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    // Someone else's public submission shouldn't show up in Dana's list.
    await submitTwoLine(s, "nyc", { payeeEmail: "other@example.com" });
    await submitInApp(s.as, s, {
      lines: [await validLine(s, { description: "Gaffer tape", amountCents: 1200 })],
    });

    const mine = await s.as.query(api.reimbursements.myReimbursements, {});
    expect(mine.length).toBe(1);
    expect(mine[0].totalCents).toBe(1200);
    expect(JSON.stringify(mine)).not.toContain("token");
  });

  test("myReimbursements isolates two authenticated members in the same chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const other = await addMember(s, {
      email: "sam@publicworship.life",
      name: "Sam Lee",
    });

    // Dana submits two of her own requests…
    await submitInApp(s.as, s, {
      lines: [await validLine(s, { description: "Gaffer tape", amountCents: 1200 })],
    });
    await submitInApp(s.as, s, {
      lines: [await validLine(s, { description: "Snacks", amountCents: 800 })],
    });
    // …Sam submits one of his own, in the SAME chapter.
    await submitInApp(other.as, s, {
      lines: [await validLine(s, { description: "Parking", amountCents: 500 })],
    });

    const danas = await s.as.query(api.reimbursements.myReimbursements, {});
    expect(danas.length).toBe(2);
    expect(danas.map((r) => r.totalCents).sort((a, b) => a - b)).toEqual([
      800, 1200,
    ]);
    expect(JSON.stringify(danas)).not.toContain("token");

    const sams = await other.as.query(api.reimbursements.myReimbursements, {});
    expect(sams.length).toBe(1);
    expect(sams[0].totalCents).toBe(500);
    expect(JSON.stringify(sams)).not.toContain("token");
    // Neither list leaks into the other's.
    expect(danas.some((r) => r.totalCents === 500)).toBe(false);
    expect(sams.some((r) => r.totalCents === 1200 || r.totalCents === 800)).toBe(
      false,
    );
  });

  describe("linkBankAccount (in-app RELINK — fixing/replacing an already-submitted request's destination)", () => {
    /** Mock `POST /external_accounts`, recording the request body. */
    function mockExternalAccountFetch(id = "extacct_new_1") {
      const calls: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const path = String(input);
        if (path.includes("/external_accounts")) {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          calls.push(body);
          return new Response(JSON.stringify({ id }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${path}`);
      }) as unknown as typeof fetch;
      return calls;
    }

    test("relinks and never persists the raw account number", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await submitInApp(s.as, s);
      const calls = mockExternalAccountFetch("extacct_dana_1");

      const result = await s.as.action(api.reimbursements.linkBankAccount, {
        reimbursementId,
        routingNumber: "011000015",
        accountNumber: "0987654321",
        funding: "checking",
      });
      expect(result.linked).toBe(true);

      // The Increase call carried the routing + account number…
      expect(calls[0].routing_number).toBe("011000015");
      expect(calls[0].account_number).toBe("0987654321");
      expect(calls[0].funding).toBe("checking");

      // …but Convex stores only the returned reference id + a last-4, never
      // the full account number.
      const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
      expect(req?.externalAccountId).toBe("extacct_dana_1");
      expect(req?.bankAccountLast4).toBe("4321");
      expect(JSON.stringify(req)).not.toContain("0987654321");
    });

    test("rejects a malformed routing number before any network call", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        userId: s.userId,
      });
      const { reimbursementId } = await submitInApp(s.as, s);
      globalThis.fetch = (() => {
        throw new Error("fetch must not be called on invalid input");
      }) as unknown as typeof fetch;

      await expect(
        s.as.action(api.reimbursements.linkBankAccount, {
          reimbursementId,
          routingNumber: "123", // not 9 digits
          accountNumber: "0987654321",
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    });

    test("degrades to linked:false (never throws) when the Increase key is unset", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
      const { reimbursementId } = await submitInApp(s.as, s);
      delete process.env.INCREASE_API_KEY;
      globalThis.fetch = (() => {
        throw new Error("fetch must not be called when the key is unset");
      }) as unknown as typeof fetch;

      const result = await s.as.action(api.reimbursements.linkBankAccount, {
        reimbursementId,
        routingNumber: "011000015",
        accountNumber: "0987654322",
      });
      expect(result.linked).toBe(false);
      // The ORIGINAL bank destination (from submit) is untouched.
      const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
      expect(req?.externalAccountId).toBeTruthy();
      expect(req?.externalAccountId).not.toBe("");
    });

    test("self-only: a different member cannot link a bank account to someone else's request", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await submitInApp(s.as, s);
      const other = await addMember(s, {
        email: "sam@publicworship.life",
        name: "Sam Lee",
      });
      mockExternalAccountFetch();

      await expect(
        other.as.action(api.reimbursements.linkBankAccount, {
          reimbursementId,
          routingNumber: "011000015",
          accountNumber: "0987654321",
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    });

    test("ALLOWS relinking while `approved` (fix the bad bank details a bounce re-opened)", async () => {
      // IMPORTANT: `reverseSettledPayout` re-opens a bounced reimbursement to
      // `approved`; most returns are wrong-account — the claimant must be able
      // to fix the destination. `approved` is a LINKABLE status.
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await submitInApp(s.as, s);
      // A distinct manager approves it (can't approve their own request).
      const manager = await addMember(s, {
        email: "manny@publicworship.life",
        name: "Manny Manager",
      });
      await grantRole(s, manager.personId, "manager");
      await manager.as.mutation(api.reimbursements.approve, { reimbursementId });

      mockExternalAccountFetch("extacct_relink_1");

      const result = await s.as.action(api.reimbursements.linkBankAccount, {
        reimbursementId,
        routingNumber: "011000015",
        accountNumber: "0987654321",
      });
      expect(result.linked).toBe(true);
      const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
      expect(req?.status).toBe("approved"); // relinked without leaving approved
      expect(req?.externalAccountId).toBe("extacct_relink_1");
      expect(req?.bankAccountLast4).toBe("4321");
    });

    test("rejects once the request is past linkable (e.g. already `paying`)", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await submitInApp(s.as, s);
      // Force a past-linkable status directly (an in-flight payout).
      await run(s.t, (ctx) =>
        ctx.db.patch(reimbursementId, { status: "paying" }),
      );

      globalThis.fetch = (() => {
        throw new Error("fetch must not be called once past linkable");
      }) as unknown as typeof fetch;

      await expect(
        s.as.action(api.reimbursements.linkBankAccount, {
          reimbursementId,
          routingNumber: "011000015",
          accountNumber: "0987654321",
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    });

    test("TOCTOU: attachExternalAccount no-ops if the request advanced past linkable mid-link", async () => {
      // IMPORTANT: `begin*` saw a linkable request, then the slow Increase call
      // ran; if a concurrent pay advanced it to `paying`, the destination must
      // NOT be stamped. We simulate the race by flipping the status DURING the
      // fetch.
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await submitInApp(s.as, s);
      const originalExternalAccountId = (
        await run(s.t, (ctx) => ctx.db.get(reimbursementId))
      )?.externalAccountId;

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/external_accounts")) {
          // The concurrent pay lands while the External Account is being created.
          await run(s.t, (ctx) =>
            ctx.db.patch(reimbursementId, { status: "paying" }),
          );
          return new Response(JSON.stringify({ id: "extacct_race_1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${path}`);
      }) as unknown as typeof fetch;

      const result = await s.as.action(api.reimbursements.linkBankAccount, {
        reimbursementId,
        routingNumber: "011000015",
        accountNumber: "0987654321",
      });
      // The action still returns linked (Increase created the account), but the
      // destination was NOT restamped onto the now-`paying` request.
      expect(result.linked).toBe(true);
      const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
      expect(req?.externalAccountId).toBe(originalExternalAccountId);
      expect(req?.externalAccountId).not.toBe("extacct_race_1");
    });
  });

  test("newRequestOptions prefills from the caller's roster row and lists active funds", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const options = await s.as.query(api.reimbursements.newRequestOptions, {});
    expect(options.defaultPayeeName).toBe("Dana Rivers");
    expect(options.defaultPayeeEmail).toBe("dana@example.com");
    expect(options.funds.map((f) => f.name)).toEqual(["General"]);
    expect(options.forOptions.budgets).toEqual([]);
  });
});

describe("'For' tag: event / project (budget-backed only) / recurring budget — mutually exclusive", () => {
  /** Seed a minimal event in `s`'s chapter (needs an `eventTypes` row first —
   *  mirrors the fixture other finance test suites use). */
  async function seedEvent(s: ChapterSetup, name = "Fall Retreat"): Promise<Id<"events">> {
    return await run(s.t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Service",
        slug: "service",
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name,
        eventDate: now,
        status: "planning",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async function seedProject(s: ChapterSetup, name = "New Building Fund"): Promise<Id<"projects">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name,
        status: "in_progress",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  /** An APPROVED one_time budget for an event/project — grandfathered (no
   *  `approvalStatus`) counts as approved. */
  async function seedApprovedRefBudget(
    s: ChapterSetup,
    refKind: "event" | "project",
    refId: string,
  ): Promise<Id<"budgets">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 50000,
        type: "one_time",
        refKind,
        scopeRefId: refId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
  }

  /** An APPROVED recurring budget, chapter- or central-level. */
  async function seedRecurringBudget(
    s: ChapterSetup,
    opts: { level?: "chapter" | "central"; label?: string; cadence?: "monthly" | "quarterly" | "yearly"; approved?: boolean } = {},
  ): Promise<Id<"budgets">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: opts.level === "central" ? "central" : s.chapterId,
        amountCents: 100000,
        type: "recurring",
        cadence: opts.cadence ?? "yearly",
        year: 2026,
        label: opts.label ?? "Education",
        approvalStatus: opts.approved === false ? "draft" : undefined,
        createdAt: Date.now(),
      }),
    );
  }

  test("newRequestOptions omits an unbudgeted event/project entirely", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    await seedEvent(s, "Bare Event");
    await seedProject(s, "Bare Project");

    const options = await s.as.query(api.reimbursements.newRequestOptions, {});
    expect(options.forOptions.events).toEqual([]);
    expect(options.forOptions.projects).toEqual([]);
  });

  test("newRequestOptions surfaces only BUDGET-BACKED events/projects", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const eventId = await seedEvent(s, "Fall Retreat");
    await seedApprovedRefBudget(s, "event", eventId);
    const projectId = await seedProject(s, "New Building Fund");
    await seedApprovedRefBudget(s, "project", projectId);
    // An unbudgeted sibling stays hidden.
    await seedEvent(s, "Bare Event");

    const options = await s.as.query(api.reimbursements.newRequestOptions, {});
    expect(options.forOptions.events.map((e) => e.id)).toEqual([eventId]);
    expect(options.forOptions.events[0].label).toContain("Fall Retreat");
    expect(options.forOptions.projects.map((p) => p.id)).toEqual([projectId]);
    expect(options.forOptions.projects[0].label).toBe("New Building Fund");
  });

  test("newRequestOptions surfaces the chapter's OWN approved recurring budgets, never central or unapproved ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const chapterBudgetId = await seedRecurringBudget(s, {
      label: "Education",
      cadence: "yearly",
    });
    await seedRecurringBudget(s, { level: "central", label: "City Launch Fund" });
    await seedRecurringBudget(s, { label: "Draft Budget", approved: false });

    const options = await s.as.query(api.reimbursements.newRequestOptions, {});
    expect(options.forOptions.budgets).toEqual([
      { id: chapterBudgetId, label: "Education", cadence: "yearly" },
    ]);
  });

  test("submitReimbursement stores an eventId tag and surfaces its label via get()", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Fall Retreat");
    const manager = await seedPerson(s, { name: "Manager", userId: s.userId, isTeamMember: true });
    await grantRole(s, manager, "manager");
    const requester = await addMember(s, { email: "dana@publicworship.life", name: "Dana Rivers" });

    await submitInApp(requester.as, s, { eventId });

    const rows = await s.as.query(api.reimbursements.list, {});
    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(detail.forLabel).toBe("Fall Retreat");
  });

  test("submitReimbursement stores a projectId tag and surfaces its label via get()", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, "New Building Fund");
    const manager = await seedPerson(s, { name: "Manager", userId: s.userId, isTeamMember: true });
    await grantRole(s, manager, "manager");
    const requester = await addMember(s, { email: "dana@publicworship.life", name: "Dana Rivers" });

    await submitInApp(requester.as, s, { projectId });

    const rows = await s.as.query(api.reimbursements.list, {});
    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(detail.forLabel).toBe("New Building Fund");
  });

  test("submitReimbursement stores a recurring budgetId tag and surfaces its display name via get()", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedRecurringBudget(s, { label: "Education", cadence: "yearly" });
    const manager = await seedPerson(s, { name: "Manager", userId: s.userId, isTeamMember: true });
    await grantRole(s, manager, "manager");
    const requester = await addMember(s, { email: "dana@publicworship.life", name: "Dana Rivers" });

    await submitInApp(requester.as, s, { budgetId });

    const rows = await s.as.query(api.reimbursements.list, {});
    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(detail.forLabel).toBe("Education");
  });

  test("rejects more than one of eventId/projectId/budgetId on the same request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const eventId = await seedEvent(s);
    const projectId = await seedProject(s);
    const budgetId = await seedRecurringBudget(s);

    await expect(
      submitInApp(s.as, s, { eventId, projectId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      submitInApp(s.as, s, { eventId, budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      submitInApp(s.as, s, { projectId, budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an eventId that belongs to another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "Boston" });
    const otherEventId = await seedEvent(other, "Boston's Own Event");

    await expect(
      submitInApp(s.as, s, { eventId: otherEventId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a budgetId belonging to another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "Boston" });
    const otherBudgetId = await seedRecurringBudget(other, { label: "Boston's Budget" });

    await expect(
      submitInApp(s.as, s, { budgetId: otherBudgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a budgetId that isn't a recurring budget (a one_time event/project budget)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const eventId = await seedEvent(s);
    const oneTimeBudgetId = await seedApprovedRefBudget(s, "event", eventId);

    await expect(
      submitInApp(s.as, s, { budgetId: oneTimeBudgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("separation of duties", () => {
  test("the requester cannot approve their own request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    // The caller IS the requester: a manager whose email matches the payee.
    const requester = await seedPerson(s, {
      name: "Self Approver",
      email: "self@publicworship.life",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, requester, "manager");
    const { token } = await submitTwoLine(s, "nyc", {
      payeeEmail: "self@publicworship.life",
    });
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    // The public submit linked the request to the requester person.
    expect(req?.personId).toBe(requester);

    await expect(
      s.as.mutation(api.reimbursements.approve, {
        reimbursementId: req!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("email SoD blocks approve AND preApprove when the caller's own email is the payee (no roster link)", async () => {
    const t = newT();
    // The caller's AUTH email is boss@publicworship.life.
    const s = await setupChapter(t, { email: "boss@publicworship.life" });
    await setSlug(s, "nyc");
    // Manager person for the caller, deliberately WITHOUT an email so the
    // public submit's roster match can't link it — only the email check catches
    // the self-approval.
    const manager = await seedPerson(s, {
      name: "Boss",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");

    // A pre-approval request submitted under the caller's own email.
    const pre = await submitTwoLine(s, "nyc", {
      payeeEmail: "boss@publicworship.life",
      requestPreApproval: true,
    });
    const preReq = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", pre.token))
        .unique(),
    );
    // No roster person carries that email → the link is null; only email SoD.
    expect(preReq?.personId ?? null).toBeNull();
    await expect(
      s.as.mutation(api.reimbursements.preApprove, {
        reimbursementId: preReq!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // And a plain submitted request under the caller's email can't be approved.
    const sub = await submitTwoLine(s, "nyc", {
      payeeEmail: "boss@publicworship.life",
    });
    const subReq = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", sub.token))
        .unique(),
    );
    expect(subReq?.personId ?? null).toBeNull();
    await expect(
      s.as.mutation(api.reimbursements.approve, {
        reimbursementId: subReq!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a different manager can approve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    // Requester is a distinct roster person (not the caller).
    await seedPerson(s, {
      name: "Vera Volunteer",
      email: "vera@example.com",
    });
    const { token } = await submitTwoLine(s, "nyc", {
      payeeEmail: "vera@example.com",
    });
    // Caller is a separate manager.
    const manager = await seedPerson(s, {
      name: "Manny Manager",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );

    const result = await s.as.mutation(api.reimbursements.approve, {
      reimbursementId: req!._id,
    });
    expect(result.approvedCents).toBe(2000);
    const after = await s.as.query(api.reimbursements.get, {
      reimbursementId: req!._id,
    });
    expect(after.status).toBe("approved");
    expect(after.reviewedByPersonId).toBe(manager);
  });
});

describe("partial approval", () => {
  test("approving a subset sets approvedCents + flags those lines", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token } = await submitTwoLine(s, "nyc");
    const manager = await seedPerson(s, {
      name: "Manny",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");
    const { reqId, firstLineId } = await run(s.t, async (ctx) => {
      const req = await ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      const lines = await ctx.db
        .query("reimbursementLineItems")
        .withIndex("by_reimbursement", (q) =>
          q.eq("reimbursementId", req!._id),
        )
        .collect();
      const first = lines.sort((a, b) => a.order - b.order)[0];
      return { reqId: req!._id, firstLineId: first._id };
    });

    const result = await s.as.mutation(api.reimbursements.approve, {
      reimbursementId: reqId,
      approvedLineIds: [firstLineId], // only the $12 line
    });
    expect(result.approvedCents).toBe(1200);

    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: reqId,
    });
    expect(detail.approvedCents).toBe(1200);
    const byOrder = detail.lines.sort((a, b) => a.order - b.order);
    expect(byOrder[0].approved).toBe(true);
    expect(byOrder[1].approved).toBe(false);
  });
});

describe("illegal transitions", () => {
  test("approving an already-rejected request is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await seedPerson(s, { name: "Vera", email: "vera@example.com" });
    const { token } = await submitTwoLine(s, "nyc", {
      payeeEmail: "vera@example.com",
    });
    const manager = await seedPerson(s, {
      name: "Manny",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );

    await s.as.mutation(api.reimbursements.reject, {
      reimbursementId: req!._id,
      reason: "Out of policy",
    });
    await expect(
      s.as.mutation(api.reimbursements.approve, {
        reimbursementId: req!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    // And re-rejecting a terminal request is illegal too.
    await expect(
      s.as.mutation(api.reimbursements.reject, {
        reimbursementId: req!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("pre-approving a plain submitted request is illegal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token } = await submitTwoLine(s, "nyc"); // status: submitted
    const manager = await seedPerson(s, {
      name: "Manny",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await expect(
      s.as.mutation(api.reimbursements.preApprove, {
        reimbursementId: req!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejecting / canceling an already-approved request is illegal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await seedPerson(s, { name: "Vera", email: "vera@example.com" });
    const { token } = await submitTwoLine(s, "nyc", {
      payeeEmail: "vera@example.com",
    });
    const manager = await seedPerson(s, {
      name: "Manny",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );

    await s.as.mutation(api.reimbursements.approve, {
      reimbursementId: req!._id,
    });
    // Approved is past the pre-payout window — reject/cancel can't desync a
    // (Phase-4) payout.
    await expect(
      s.as.mutation(api.reimbursements.reject, {
        reimbursementId: req!._id,
        reason: "too late",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.reimbursements.cancel, {
        reimbursementId: req!._id,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("accountless receipt upload (token-scoped — replacing a receipt post-submit)", () => {
  test("works while editable, rejected once terminal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await seedPerson(s, { name: "Vera", email: "vera@example.com" });
    const { token } = await submitTwoLine(s, "nyc", {
      payeeEmail: "vera@example.com",
    });
    // Editable while submitted.
    const url = await t.mutation(api.reimbursements.publicUploadUrl, { token });
    expect(typeof url).toBe("string");

    // Cancel it → terminal → upload now rejected.
    const manager = await seedPerson(s, {
      name: "Manny",
      userId: s.userId,
      isTeamMember: true,
    });
    await grantRole(s, manager, "manager");
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await s.as.mutation(api.reimbursements.cancel, {
      reimbursementId: req!._id,
    });
    await expect(
      t.mutation(api.reimbursements.publicUploadUrl, { token }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("reminder sweep", () => {
  test("degrades without RESEND_API_KEY (no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await submitTwoLine(s, "nyc", { payeeEmail: "vera@example.com" });
    // No RESEND_API_KEY in the test env → sendEmail is a logged no-op.
    await expect(
      t.action(internal.reimbursements.sendReimbursementReminders, {}),
    ).resolves.toBeNull();
  });
});
