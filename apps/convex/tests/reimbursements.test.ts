import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Phase 3 reimbursement tests:
 *  - the accountless PUBLIC submission path (secret token, status timeline),
 *  - the in-app manager queue never leaking the token,
 *  - separation of duties (a requester can't approve their own request),
 *  - partial approval math + flags,
 *  - illegal status transitions,
 *  - accountless receipt upload gated on editability,
 *  - the reminder sweep degrading without RESEND_API_KEY.
 */

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

/** Submit a two-line public reimbursement; returns { token, reference }. */
async function submitTwoLine(
  s: ChapterSetup,
  slug: string,
  extra: {
    payeeEmail?: string;
    payeePhone?: string;
    requestPreApproval?: boolean;
    clientIp?: string;
  } = {},
): Promise<{ token: string; reference: string }> {
  return await s.t.mutation(api.reimbursements.submitPublicReimbursement, {
    chapterSlug: slug,
    payeeName: "Dana Rivers",
    payeeEmail: "dana@example.com",
    ...extra,
    lines: [
      { description: "Gaffer tape", amountCents: 1200 },
      { description: "Snacks", amountCents: 800 },
    ],
  });
}

describe("public submission + status view", () => {
  test("creates a request + lines with a secret token", async () => {
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
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.order).sort()).toEqual([0, 1]);
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
    await expect(
      submitTwoLine(s, "does-not-exist"),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("non-integer cents is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    await expect(
      s.t.mutation(api.reimbursements.submitPublicReimbursement, {
        chapterSlug: "nyc",
        payeeName: "Dana",
        payeeEmail: "dana@example.com",
        lines: [{ description: "x", amountCents: 12.5 }],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("zero / negative and oversized line amounts are rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    for (const bad of [0, -100, 100_000_001]) {
      await expect(
        s.t.mutation(api.reimbursements.submitPublicReimbursement, {
          chapterSlug: "nyc",
          payeeName: "Dana",
          payeeEmail: "dana@example.com",
          lines: [{ description: "x", amountCents: bad }],
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
        s.t.mutation(api.reimbursements.submitPublicReimbursement, {
          chapterSlug: "nyc",
          payeeName: "Dana",
          payeeEmail: bad,
          lines: [{ description: "x", amountCents: 1200 }],
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
  });

  test("bankAccountLast4 keeps only the last 4 digits (never a full number)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token } = await s.t.mutation(
      api.reimbursements.submitPublicReimbursement,
      {
        chapterSlug: "nyc",
        payeeName: "Dana Rivers",
        payeeEmail: "dana@example.com",
        bankAccountLast4: "4111 1111 1111 1234",
        lines: [{ description: "x", amountCents: 1200 }],
      },
    );
    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    expect(req?.bankAccountLast4).toBe("1234");
  });

  test("long free-text fields are capped server-side", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setSlug(s, "nyc");
    const { token } = await s.t.mutation(
      api.reimbursements.submitPublicReimbursement,
      {
        chapterSlug: "nyc",
        payeeName: "N".repeat(500),
        payeeEmail: "dana@example.com",
        purpose: "P".repeat(5000),
        lines: [{ description: "D".repeat(2000), amountCents: 1200 }],
      },
    );
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
    // Submitted → "Submitted" done, "Under review" now.
    const steps = Object.fromEntries(
      view!.timeline.map((s) => [s.step, s.state]),
    );
    expect(steps.submitted).toBe("done");
    expect(steps.under_review).toBe("now");
    expect(steps.approved).toBe("todo");
    expect(steps.paid).toBe("todo");
  });

  test("getPublicReimbursement is null for an unknown token", async () => {
    const t = newT();
    await setupChapter(t);
    const view = await t.query(api.reimbursements.getPublicReimbursement, {
      token: "nope",
    });
    expect(view).toBeNull();
  });

  describe("linkPublicBankAccount (public ACH destination capture)", () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.INCREASE_API_KEY;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
      else process.env.INCREASE_API_KEY = originalKey;
    });

    test("links a real bank account by the secret token, never persisting the raw account number", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await setSlug(s, "nyc");
      const { token } = await submitTwoLine(s, "nyc");

      process.env.INCREASE_API_KEY = "test_key";
      const calls: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const path = String(input);
        if (path.includes("/external_accounts")) {
          calls.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ id: "extacct_public_1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${path}`);
      }) as unknown as typeof fetch;

      const result = await t.action(api.reimbursements.linkPublicBankAccount, {
        token,
        routingNumber: "011000015",
        accountNumber: "555000111",
        funding: "savings",
      });
      expect(result.linked).toBe(true);
      expect(calls[0].funding).toBe("savings");

      const req = await run(s.t, (ctx) =>
        ctx.db
          .query("reimbursementRequests")
          .withIndex("by_token", (q) => q.eq("token", token))
          .unique(),
      );
      expect(req?.externalAccountId).toBe("extacct_public_1");
      expect(req?.bankAccountLast4).toBe("0111");
      expect(JSON.stringify(req)).not.toContain("555000111");
    });

    test("an unknown token is rejected (never a silent no-op)", async () => {
      const t = newT();
      await setupChapter(t);
      process.env.INCREASE_API_KEY = "test_key";
      globalThis.fetch = (() => {
        throw new Error("fetch must not be called for an unknown token");
      }) as unknown as typeof fetch;

      await expect(
        t.action(api.reimbursements.linkPublicBankAccount, {
          token: "does-not-exist",
          routingNumber: "011000015",
          accountNumber: "555000111",
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    });
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
      await s.t.mutation(api.reimbursements.submitPublicReimbursement, {
        chapterSlug: "nyc",
        payeeName: "No IP",
        payeeEmail: "no-ip@example.com",
        lines: [{ description: "x", amountCents: 500 }],
      });
    }
    await expect(
      s.t.mutation(api.reimbursements.submitPublicReimbursement, {
        chapterSlug: "nyc",
        payeeName: "No IP",
        payeeEmail: "no-ip@example.com",
        lines: [{ description: "x", amountCents: 500 }],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
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
    expect(rows[0].receiptsState).toBe("none");

    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(JSON.stringify(detail)).not.toContain(token);
    expect(detail as Record<string, unknown>).not.toHaveProperty("token");
    expect(detail.lines.length).toBe(2);
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
    await requester.as.mutation(api.reimbursements.submitReimbursement, {
      payeeName: "D. Rivers Family Fund",
      lines: [{ description: "Gaffer tape", amountCents: 1200 }],
    });

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
    await expect(
      t.mutation(api.reimbursements.submitReimbursement, {
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("requires a roster person (NO_PERSON) when the caller has no roster row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.reimbursements.submitReimbursement, {
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
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

    const { reference, reimbursementId } = await s.as.mutation(
      api.reimbursements.submitReimbursement,
      {
        lines: [
          { description: "Gaffer tape", amountCents: 1200, fundId },
          { description: "Snacks", amountCents: 800, fundId },
        ],
      },
    );
    expect(reference).toMatch(/^RB-/);
    // No secret token is ever handed to an authenticated submitter.
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

    // No fund picker in the in-app form anymore — lines never carry a fundId.
    const { reimbursementId } = await s.as.mutation(
      api.reimbursements.submitReimbursement,
      {
        lines: [
          { description: "Gaffer tape", amountCents: 1200 },
          { description: "Snacks", amountCents: 800 },
        ],
      },
    );
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
    const { reimbursementId } = await s.as.mutation(
      api.reimbursements.submitReimbursement,
      {
        requestPreApproval: true,
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      },
    );
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).toBe("pending_preapproval");
  });

  test("rejects non-integer and negative line cents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    for (const bad of [12.5, 0, -100]) {
      await expect(
        s.as.mutation(api.reimbursements.submitReimbursement, {
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
    const { reimbursementId } = await s.as.mutation(
      api.reimbursements.submitReimbursement,
      {
        payeeName: "D. Rivers",
        payeeEmail: "dana+work@example.com",
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      },
    );
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
    await s.as.mutation(api.reimbursements.submitReimbursement, {
      lines: [{ description: "Gaffer tape", amountCents: 1200 }],
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
    await s.as.mutation(api.reimbursements.submitReimbursement, {
      lines: [{ description: "Gaffer tape", amountCents: 1200 }],
    });
    await s.as.mutation(api.reimbursements.submitReimbursement, {
      lines: [{ description: "Snacks", amountCents: 800 }],
    });
    // …Sam submits one of his own, in the SAME chapter.
    await other.as.mutation(api.reimbursements.submitReimbursement, {
      lines: [{ description: "Parking", amountCents: 500 }],
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

  describe("linkBankAccount (in-app ACH destination capture)", () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.INCREASE_API_KEY;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
      else process.env.INCREASE_API_KEY = originalKey;
    });

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

    test("creates an Increase External Account and links it, never persisting the raw account number", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "Gaffer tape", amountCents: 1200 }] },
      );
      process.env.INCREASE_API_KEY = "test_key";
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
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "x", amountCents: 1200 }] },
      );
      process.env.INCREASE_API_KEY = "test_key";
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
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "x", amountCents: 1200 }] },
      );
      delete process.env.INCREASE_API_KEY;
      globalThis.fetch = (() => {
        throw new Error("fetch must not be called when the key is unset");
      }) as unknown as typeof fetch;

      const result = await s.as.action(api.reimbursements.linkBankAccount, {
        reimbursementId,
        routingNumber: "011000015",
        accountNumber: "0987654321",
      });
      expect(result.linked).toBe(false);
      const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
      expect(req?.externalAccountId).toBeUndefined();
    });

    test("self-only: a different member cannot link a bank account to someone else's request", async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "x", amountCents: 1200 }] },
      );
      const other = await addMember(s, {
        email: "sam@publicworship.life",
        name: "Sam Lee",
      });
      process.env.INCREASE_API_KEY = "test_key";
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
      // IMPORTANT 4: `reverseSettledPayout` re-opens a bounced reimbursement to
      // `approved`; most returns are wrong-account (R03/R04), so the claimant must
      // be able to fix the destination. `approved` is a LINKABLE status.
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "x", amountCents: 1200 }] },
      );
      // A distinct manager approves it (can't approve their own request).
      const manager = await addMember(s, {
        email: "manny@publicworship.life",
        name: "Manny Manager",
      });
      await grantRole(s, manager.personId, "manager");
      await manager.as.mutation(api.reimbursements.approve, { reimbursementId });

      process.env.INCREASE_API_KEY = "test_key";
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
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "x", amountCents: 1200 }] },
      );
      // Force a past-linkable status directly (an in-flight payout).
      await run(s.t, (ctx) =>
        ctx.db.patch(reimbursementId, { status: "paying" }),
      );

      process.env.INCREASE_API_KEY = "test_key";
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
      // IMPORTANT 5: begin* saw a linkable request, then the slow Increase call
      // ran; if a concurrent pay advanced it to `paying`, the destination must NOT
      // be stamped. We simulate the race by flipping the status DURING the fetch.
      const t = newT();
      const s = await setupChapter(t);
      await seedPerson(s, {
        name: "Dana Rivers",
        email: "dana@example.com",
        userId: s.userId,
      });
      const { reimbursementId } = await s.as.mutation(
        api.reimbursements.submitReimbursement,
        { lines: [{ description: "x", amountCents: 1200 }] },
      );
      process.env.INCREASE_API_KEY = "test_key";
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
      // destination was NOT stamped onto the now-`paying` request.
      expect(result.linked).toBe(true);
      const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
      expect(req?.externalAccountId).toBeUndefined();
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
  });
});

describe("optional 'For' tag (eventId/projectId)", () => {
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

  test("newRequestOptions surfaces the chapter's events + projects", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const eventId = await seedEvent(s, "Fall Retreat");
    const projectId = await seedProject(s, "New Building Fund");

    const options = await s.as.query(api.reimbursements.newRequestOptions, {});
    expect(options.forOptions.events.map((e) => e.id)).toEqual([eventId]);
    expect(options.forOptions.events[0].label).toContain("Fall Retreat");
    expect(options.forOptions.projects.map((p) => p.id)).toEqual([projectId]);
    expect(options.forOptions.projects[0].label).toBe("New Building Fund");
  });

  test("submitReimbursement stores an eventId tag and surfaces its label via get()", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Fall Retreat");
    const manager = await seedPerson(s, { name: "Manager", userId: s.userId, isTeamMember: true });
    await grantRole(s, manager, "manager");
    const requester = await addMember(s, { email: "dana@publicworship.life", name: "Dana Rivers" });

    await requester.as.mutation(api.reimbursements.submitReimbursement, {
      eventId,
      lines: [{ description: "Gaffer tape", amountCents: 1200 }],
    });

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

    await requester.as.mutation(api.reimbursements.submitReimbursement, {
      projectId,
      lines: [{ description: "Lumber", amountCents: 5000 }],
    });

    const rows = await s.as.query(api.reimbursements.list, {});
    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: rows[0]._id,
    });
    expect(detail.forLabel).toBe("New Building Fund");
  });

  test("rejects both eventId and projectId on the same request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const eventId = await seedEvent(s);
    const projectId = await seedProject(s);

    await expect(
      s.as.mutation(api.reimbursements.submitReimbursement, {
        eventId,
        projectId,
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an eventId that belongs to another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Dana Rivers", userId: s.userId });
    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "Boston" });
    const otherEventId = await seedEvent(other, "Boston's Own Event");

    await expect(
      s.as.mutation(api.reimbursements.submitReimbursement, {
        eventId: otherEventId,
        lines: [{ description: "Gaffer tape", amountCents: 1200 }],
      }),
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

describe("accountless receipt upload", () => {
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
