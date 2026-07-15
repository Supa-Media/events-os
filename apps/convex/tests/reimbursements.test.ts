import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
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

/** Submit a two-line public reimbursement; returns { token, reference }. */
async function submitTwoLine(
  s: ChapterSetup,
  slug: string,
  extra: {
    payeeEmail?: string;
    payeePhone?: string;
    requestPreApproval?: boolean;
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
