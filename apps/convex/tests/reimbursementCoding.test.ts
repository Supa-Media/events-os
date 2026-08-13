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
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Reimbursement PARITY with transaction coding (phase 3 of
 * `docs/plans/transaction-coding.md`):
 *
 *  1. EVERY LINE carries its own §274(d) substantiation — expense type, a real
 *     business purpose, a travel route, who ate — required at submit on BOTH
 *     surfaces (public token page + in-app), validated by the SHARED
 *     `codingFieldProblems` so no surface can hold a claimant to a different
 *     standard than another or than the server. Per LINE, not per request,
 *     because one request routinely mixes kinds.
 *  2. Receipts stay HARD-required per line with NO exception path (open
 *     question 2, default kept: a reimbursement is a voluntary submission).
 *  3. THE REVISION LOOP: `requestChanges` sends a request back with a required
 *     note (`changes_requested`), the claimant revises their lines and
 *     resubmits (`resubmitPublicReimbursement` / `resubmitMyReimbursement`),
 *     and it lands in front of the reviewer again. A sent-back request is NOT
 *     payable but IS still cancelable.
 *  4. Legacy lines (created before this shipped, carrying no `expenseType`)
 *     keep validating — the same posture `receiptStorageId`/`transactionDate`
 *     already take, so a send-back can't become a trap a pre-existing request
 *     can never escape.
 */

// ── Increase mock plumbing (every submission resolves a real ACH destination) ─
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let extAcctSeq = 0;

beforeEach(() => {
  process.env.INCREASE_API_KEY = "test_key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/external_accounts")) {
      extAcctSeq += 1;
      return new Response(JSON.stringify({ id: `extacct_coding_${extAcctSeq}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_INCREASE_KEY === undefined) delete process.env.INCREASE_API_KEY;
  else process.env.INCREASE_API_KEY = ORIGINAL_INCREASE_KEY;
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PURPOSE = "Supplies for the Worship with Strangers shoot in July";

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

/** A second authenticated member in the same chapter (their own user/person). */
async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
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
  const personId = await seedPerson(s, { ...opts, userId });
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

type LineArg = Record<string, unknown>;

/** One complete line — every REQUIRED field present, overridable per test. */
async function line(s: ChapterSetup, overrides: LineArg = {}): Promise<LineArg> {
  return {
    description: "Gaffer tape",
    amountCents: 1200,
    transactionDate: Date.now(),
    expenseType: "general",
    businessPurpose: PURPOSE,
    receiptStorageId: await storeBlob(s.t),
    ...overrides,
  };
}

async function publicBank(s: ChapterSetup): Promise<{
  externalAccountId: string;
  last4?: string;
}> {
  const result = await s.t.action(api.reimbursements.linkPublicBankAccount, {
    routingNumber: "011000015",
    accountNumber: "555000111",
  });
  if (!result.linked || !result.externalAccountId) {
    throw new Error("bank link failed in fixture");
  }
  return { externalAccountId: result.externalAccountId, last4: result.last4 };
}

/** Public submission (link first, then submit — the real two-step flow). */
async function submitPublic(
  s: ChapterSetup,
  opts: { lines?: LineArg[]; payeeEmail?: string; requestPreApproval?: boolean } = {},
): Promise<{ token: string }> {
  const bank = await publicBank(s);
  return await s.t.mutation(api.reimbursements.submitPublicReimbursement, {
    chapterSlug: "nyc",
    payeeName: "Vera Volunteer",
    payeeEmail: opts.payeeEmail ?? "vera@example.com",
    purpose: "Event supplies",
    requestPreApproval: opts.requestPreApproval,
    externalAccountId: bank.externalAccountId,
    bankAccountLast4: bank.last4,
    lines: (opts.lines ?? [await line(s)]) as never,
  });
}

async function reqByToken(
  s: ChapterSetup,
  token: string,
): Promise<Doc<"reimbursementRequests">> {
  const req = await run(s.t, (ctx) =>
    ctx.db
      .query("reimbursementRequests")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique(),
  );
  if (!req) throw new Error("request not found");
  return req;
}

async function linesOf(
  s: ChapterSetup,
  reimbursementId: Id<"reimbursementRequests">,
): Promise<Doc<"reimbursementLineItems">[]> {
  const rows = await run(s.t, (ctx) =>
    ctx.db
      .query("reimbursementLineItems")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .collect(),
  );
  return rows.sort((a, b) => a.order - b.order);
}

/** A chapter with a slug, a distinct claimant, and an authenticated MANAGER
 *  who is not that claimant (so separation of duties is satisfiable). */
async function chapterWithManager(): Promise<{
  s: ChapterSetup;
  managerPersonId: Id<"people">;
}> {
  const s = await setupChapter(newT());
  await setSlug(s, "nyc");
  await seedPerson(s, { name: "Vera Volunteer", email: "vera@example.com" });
  const managerPersonId = await seedPerson(s, {
    name: "Manny Manager",
    email: "manny@publicworship.life",
    userId: s.userId,
  });
  await grantManager(s, managerPersonId);
  return { s, managerPersonId };
}

/** Throw-and-capture: the ConvexError `code` a call rejects with. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConvexError);
    return (err as ConvexError<{ code: string }>).data.code;
  }
  throw new Error("expected a rejection");
}

// ── 1. Per-line substantiation, required at submit ───────────────────────────

describe("per-line substantiation is required at submit (public path)", () => {
  test("a line with no expense type is rejected", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const bad = await line(s, { expenseType: undefined });
    expect(await codeOf(() => submitPublic(s, { lines: [bad] }))).toBe(
      "EXPENSE_TYPE_REQUIRED",
    );
  });

  test("a shrug of a business purpose is rejected (the shared length floor)", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    for (const bad of ["", "   ", "bus to NY"]) {
      const l = await line(s, { businessPurpose: bad });
      expect(await codeOf(() => submitPublic(s, { lines: [l] }))).toBe(
        "PURPOSE_REQUIRED",
      );
    }
  });

  test("travel needs a route", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const l = await line(s, { expenseType: "travel", travelFrom: "Boston" });
    expect(await codeOf(() => submitPublic(s, { lines: [l] }))).toBe(
      "TRAVEL_ROUTE_REQUIRED",
    );
  });

  // FINDING 2 (UX audit, 2026-08-12, founder-flagged): lodging now needs ONE
  // place (persisted in `travelTo`), not a route — deliberately updated
  // rather than pinning the old "route" requirement.
  test("lodging needs one place, not a route", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const noPlace = await line(s, { expenseType: "lodging" });
    expect(await codeOf(() => submitPublic(s, { lines: [noPlace] }))).toBe(
      "LODGING_PLACE_REQUIRED",
    );
    const withPlace = await line(s, {
      expenseType: "lodging",
      travelTo: "Chicago",
    });
    // No LODGING_PLACE_REQUIRED problem once `travelTo` is set alone (no
    // `travelFrom` at all) — the public submit succeeds outright.
    await expect(submitPublic(s, { lines: [withPlace] })).resolves.toBeDefined();
  });

  test("a meal needs a headcount, and names that match it at/below the threshold", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");

    const noHeadcount = await line(s, { expenseType: "meal" });
    expect(await codeOf(() => submitPublic(s, { lines: [noHeadcount] }))).toBe(
      "HEADCOUNT_REQUIRED",
    );

    const noNames = await line(s, { expenseType: "meal", headcount: 3 });
    expect(await codeOf(() => submitPublic(s, { lines: [noNames] }))).toBe(
      "ATTENDEES_REQUIRED",
    );

    const mismatch = await line(s, {
      expenseType: "meal",
      headcount: 3,
      attendees: [{ name: "Vera", affiliation: "volunteer" }],
    });
    expect(await codeOf(() => submitPublic(s, { lines: [mismatch] }))).toBe(
      "ATTENDEE_COUNT_MISMATCH",
    );
  });

  test("a meal over the threshold needs a group description, not names", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");

    const noGroup = await line(s, { expenseType: "meal", headcount: 40 });
    expect(await codeOf(() => submitPublic(s, { lines: [noGroup] }))).toBe(
      "GROUP_DESCRIPTION_REQUIRED",
    );

    const named = await line(s, {
      expenseType: "meal",
      headcount: 40,
      groupDescription: "volunteers writing and producing the album",
      attendees: [{ name: "Vera", affiliation: "volunteer" }],
    });
    expect(await codeOf(() => submitPublic(s, { lines: [named] }))).toBe(
      "ATTENDEES_OVER_THRESHOLD",
    );
  });

  test("the error names the LINE it's about — a request can carry a hundred", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const ok = await line(s, { description: "Gaffer tape" });
    const bad = await line(s, {
      description: "Crew dinner",
      expenseType: "meal",
    });
    try {
      await submitPublic(s, { lines: [ok, bad] });
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(ConvexError);
      expect(
        (err as ConvexError<{ message: string }>).data.message,
      ).toContain('"Crew dinner"');
    }
  });

  test("complete travel + meal lines persist their elements, normalized", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const { token } = await submitPublic(s, {
      lines: [
        await line(s, {
          description: "Bus to NY",
          expenseType: "travel",
          travelFrom: "  Boston  ",
          travelTo: "New York",
          businessPurpose: "Travel to NY to film the Eden event in July",
        }),
        await line(s, {
          description: "Crew dinner",
          expenseType: "meal",
          headcount: 2,
          attendees: [
            { name: " Vera ", affiliation: "volunteer" },
            { name: "Manny", affiliation: "team" },
          ],
        }),
      ],
    });
    const req = await reqByToken(s, token);
    const [travel, meal] = await linesOf(s, req._id);

    expect(travel.expenseType).toBe("travel");
    expect(travel.travelFrom).toBe("Boston"); // trimmed
    expect(travel.travelTo).toBe("New York");
    // Meal-only fields never leak onto a travel line.
    expect(travel.headcount).toBeUndefined();
    expect(travel.attendees).toBeUndefined();

    expect(meal.expenseType).toBe("meal");
    expect(meal.headcount).toBe(2);
    expect(meal.attendees?.map((a) => a.name)).toEqual(["Vera", "Manny"]);
    expect(meal.attendees?.[0].affiliation).toBe("volunteer");
    // Travel-only fields never leak onto a meal line.
    expect(meal.travelFrom).toBeUndefined();
  });

  test("fields the expense type doesn't ask for are dropped, not stored", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const { token } = await submitPublic(s, {
      lines: [
        await line(s, {
          expenseType: "general",
          travelFrom: "Boston",
          travelTo: "New York",
          headcount: 4,
          groupDescription: "the crew",
        }),
      ],
    });
    const req = await reqByToken(s, token);
    const [only] = await linesOf(s, req._id);
    expect(only.expenseType).toBe("general");
    expect(only.travelFrom).toBeUndefined();
    expect(only.travelTo).toBeUndefined();
    expect(only.headcount).toBeUndefined();
    expect(only.groupDescription).toBeUndefined();
  });
});

describe("per-line substantiation is required at submit (in-app path)", () => {
  test("the in-app twin enforces exactly the same rules", async () => {
    const s = await setupChapter(newT());
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const bank = await s.as.action(api.reimbursements.linkBankAccount, {
      routingNumber: "011000015",
      accountNumber: "0987654321",
    });
    const submit = (lines: LineArg[]) =>
      s.as.mutation(api.reimbursements.submitReimbursement, {
        purpose: "Event supplies",
        externalAccountId: bank.externalAccountId!,
        lines: lines as never,
      });

    const blankPurpose = await line(s, { businessPurpose: "" });
    expect(await codeOf(() => submit([blankPurpose]))).toBe("PURPOSE_REQUIRED");
    const mealNoHeadcount = await line(s, { expenseType: "meal" });
    expect(await codeOf(() => submit([mealNoHeadcount]))).toBe(
      "HEADCOUNT_REQUIRED",
    );

    // …and a complete line goes through.
    const { reimbursementId } = await submit([
      await line(s, { expenseType: "travel", travelFrom: "Boston", travelTo: "NY" }),
    ]);
    const [stored] = await linesOf(s, reimbursementId);
    expect(stored.expenseType).toBe("travel");
    expect(stored.businessPurpose).toBe(PURPOSE);
  });
});

describe("reimbursements keep the HARD per-line receipt requirement", () => {
  test("a complete coding does not buy a line out of its receipt", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const noReceipt = await line(s, { receiptStorageId: undefined });
    await expect(
      submitPublic(s, { lines: [noReceipt] }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── 2. The revision loop ─────────────────────────────────────────────────────

describe("requestChanges — the third door between approve and reject", () => {
  test("sends the request back with the note, audited, and emails the claimant", async () => {
    const { s, managerPersonId } = await chapterWithManager();
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);

    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "The receipt has to show the exact amount charged.",
    });

    const after = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(after?.status).toBe("changes_requested");
    expect(after?.reviewNote).toBe(
      "The receipt has to show the exact amount charged.",
    );

    // The decision is on the append-only approvals trail, with its note.
    const approvals = await run(s.t, (ctx) =>
      ctx.db
        .query("approvals")
        .withIndex("by_subject", (q) =>
          q.eq("subjectType", "reimbursement").eq("subjectId", String(req._id)),
        )
        .collect(),
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].action).toBe("edit");
    expect(approvals[0].actorPersonId).toBe(managerPersonId);
    expect(approvals[0].note).toContain("exact amount");

    // The claimant's email payload — the note is its whole content, and an
    // accountless payee gets their own token status page as the CTA.
    const payload = await run(s.t, async () =>
      s.t.query(
        internal.reimbursements.getReimbursementChangesRequestedEmailPayload,
        { reimbursementId: req._id },
      ),
    );
    expect(payload?.payeeEmail).toBe("vera@example.com");
    expect(payload?.reviewNote).toContain("exact amount");
    expect(payload?.identityVerified).toBe(false);
    expect(payload?.token).toBe(token);
    expect(payload?.chapterSlug).toBe("nyc");

    // Sending degrades silently without RESEND_API_KEY (dev/CI).
    await expect(
      s.t.action(internal.reimbursements.sendReimbursementChangesRequestedEmail, {
        reimbursementId: req._id,
      }),
    ).resolves.toBeNull();
  });

  test("a blank note is refused — 'sent back, no explanation' is how a policy dies", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);
    for (const bad of ["", "   "]) {
      expect(
        await codeOf(() =>
          s.as.mutation(api.reimbursements.requestChanges, {
            reimbursementId: req._id,
            note: bad,
          }),
        ),
      ).toBe("REASON_REQUIRED");
    }
  });

  test("same authorization bar as approve: a viewer can't send anything back", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const viewer = await seedPerson(s, {
      name: "Val Viewer",
      email: "val@publicworship.life",
      userId: s.userId,
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: viewer,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);
    await expect(
      s.as.mutation(api.reimbursements.requestChanges, {
        reimbursementId: req._id,
        note: "Please attach the itemized receipt.",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("separation of duties: nobody sends back their own request", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const selfManager = await seedPerson(s, {
      name: "Self Reviewer",
      email: "self@publicworship.life",
      userId: s.userId,
    });
    await grantManager(s, selfManager);
    const { token } = await submitPublic(s, {
      payeeEmail: "self@publicworship.life",
    });
    const req = await reqByToken(s, token);
    expect(
      await codeOf(() =>
        s.as.mutation(api.reimbursements.requestChanges, {
          reimbursementId: req._id,
          note: "Needs the itemized receipt.",
        }),
      ),
    ).toBe("SOD_VIOLATION");
  });

  test("a sent-back request is NOT payable but IS still cancelable", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Say which event this served.",
    });

    // Approval (the only path to a payout) refuses while it sits with the
    // claimant — approving a record its author is mid-revision would approve
    // something nobody has read.
    expect(
      await codeOf(() =>
        s.as.mutation(api.reimbursements.approve, { reimbursementId: req._id }),
      ),
    ).toBe("ILLEGAL_TRANSITION");
    // Sending it back twice is likewise refused.
    expect(
      await codeOf(() =>
        s.as.mutation(api.reimbursements.requestChanges, {
          reimbursementId: req._id,
          note: "Again",
        }),
      ),
    ).toBe("ILLEGAL_TRANSITION");

    // But it can always be walked back — a state you can neither finish nor
    // abandon is a leak.
    await s.as.mutation(api.reimbursements.cancel, { reimbursementId: req._id });
    const after = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(after?.status).toBe("canceled");
  });

  test("it can be rejected outright too (the harder door stays open)", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Say which event this served.",
    });
    await s.as.mutation(api.reimbursements.reject, {
      reimbursementId: req._id,
      reason: "Not an org expense after all.",
    });
    const after = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(after?.status).toBe("rejected");
  });
});

describe("resubmission — the claimant's answer", () => {
  /** Send a fresh public request back, ready to be revised. `buildLines` gets
   *  the chapter it will submit into (line fixtures need it to store a real
   *  receipt blob). */
  async function sentBack(
    buildLines?: (s: ChapterSetup) => Promise<LineArg[]>,
  ): Promise<{
    s: ChapterSetup;
    token: string;
    req: Doc<"reimbursementRequests">;
  }> {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s, {
      lines: buildLines ? await buildLines(s) : undefined,
    });
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Say which event this served.",
    });
    return { s, token, req };
  }

  test("the accountless claimant revises their line and lands back in review", async () => {
    const { s, token, req } = await sentBack();
    const [only] = await linesOf(s, req._id);

    // The status view carries the note, the policy numbers and the line's
    // current answers — it IS the revise form for a payee with no account.
    const view = await s.t.query(api.reimbursements.getPublicReimbursement, {
      token,
    });
    expect(view?.status).toBe("changes_requested");
    expect(view?.reviewNote).toContain("which event");
    expect(view?.namesMaxHeadcount).toBe(15);
    expect(view?.lines[0].lineId).toBe(only._id);
    expect(view?.lines[0].expenseType).toBe("general");

    const result = await s.t.mutation(
      api.reimbursements.resubmitPublicReimbursement,
      {
        token,
        lines: [
          {
            lineId: only._id,
            expenseType: "travel",
            travelFrom: "Boston",
            travelTo: "New York",
            businessPurpose: "Travel to NY to film the Eden event in July",
          },
        ],
      },
    );
    expect(result.status).toBe("submitted");

    const after = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(after?.status).toBe("submitted");
    // The note answered is a note gone — history lives on the approvals trail.
    expect(after?.reviewNote).toBeUndefined();
    // The original submission date is untouched (it's when they first asked).
    expect(after?.submittedAt).toBe(req.submittedAt);

    const [revised] = await linesOf(s, req._id);
    expect(revised.expenseType).toBe("travel");
    expect(revised.travelFrom).toBe("Boston");
    expect(revised.businessPurpose).toContain("Eden event");
  });

  test("a revision that's still incomplete is refused", async () => {
    const { s, token, req } = await sentBack();
    const [only] = await linesOf(s, req._id);
    expect(
      await codeOf(() =>
        s.t.mutation(api.reimbursements.resubmitPublicReimbursement, {
          token,
          lines: [
            {
              lineId: only._id,
              expenseType: "meal",
              headcount: 2,
              businessPurpose: PURPOSE,
            },
          ],
        }),
      ),
    ).toBe("ATTENDEES_REQUIRED");
    // …and the request stays back with the claimant.
    const after = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(after?.status).toBe("changes_requested");
  });

  test("an untouched line still has to be complete — not just the edited one", async () => {
    const { s, token, req } = await sentBack(async (chapter) => [
      await line(chapter, { description: "Gaffer tape" }),
      await line(chapter, { description: "Snacks" }),
    ]);
    const [first, second] = await linesOf(s, req._id);
    // Break the second line directly (as if it had always been half-filled),
    // then revise only the first: the resubmission must still refuse.
    await run(s.t, (ctx) =>
      ctx.db.patch(second._id, { expenseType: "meal", headcount: undefined }),
    );
    expect(
      await codeOf(() =>
        s.t.mutation(api.reimbursements.resubmitPublicReimbursement, {
          token,
          lines: [
            {
              lineId: first._id,
              expenseType: "general",
              businessPurpose: PURPOSE,
            },
          ],
        }),
      ),
    ).toBe("HEADCOUNT_REQUIRED");
  });

  test("a LEGACY line (no expense type at all) can still be resubmitted", async () => {
    const { s, token, req } = await sentBack();
    const [only] = await linesOf(s, req._id);
    // Strip the substantiation entirely — a row created before phase 3.
    await run(s.t, (ctx) =>
      ctx.db.patch(only._id, {
        expenseType: undefined,
        businessPurpose: undefined,
      }),
    );
    // No edits supplied at all: the loop must not become a trap a pre-existing
    // request can never escape (the same posture receipts/dates already take).
    const result = await s.t.mutation(
      api.reimbursements.resubmitPublicReimbursement,
      { token, lines: [] },
    );
    expect(result.status).toBe("submitted");
  });

  test("only a sent-back request can be resubmitted", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const { token } = await submitPublic(s);
    expect(
      await codeOf(() =>
        s.t.mutation(api.reimbursements.resubmitPublicReimbursement, {
          token,
          lines: [],
        }),
      ),
    ).toBe("ILLEGAL_TRANSITION");
  });

  test("a line from another request can't be smuggled into a revision", async () => {
    const { s, token } = await sentBack();
    const other = await submitPublic(s, { payeeEmail: "other@example.com" });
    const otherReq = await reqByToken(s, other.token);
    const [otherLine] = await linesOf(s, otherReq._id);
    expect(
      await codeOf(() =>
        s.t.mutation(api.reimbursements.resubmitPublicReimbursement, {
          token,
          lines: [
            {
              lineId: otherLine._id,
              expenseType: "general",
              businessPurpose: PURPOSE,
            },
          ],
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a pre-approved request goes back to preapproved, not submitted", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s, { requestPreApproval: true });
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.preApprove, {
      reimbursementId: req._id,
    });
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Add the itemized receipt.",
    });
    const result = await s.t.mutation(
      api.reimbursements.resubmitPublicReimbursement,
      { token, lines: [] },
    );
    // A pre-approval decision already made isn't undone by a fix to the
    // substantiation.
    expect(result.status).toBe("preapproved");
  });

  test("in-app: a member resubmits their own, and only their own", async () => {
    const s = await setupChapter(newT());
    await seedPerson(s, {
      name: "Dana Rivers",
      email: "dana@example.com",
      userId: s.userId,
    });
    const manager = await addMember(s, {
      email: "manny@publicworship.life",
      name: "Manny Manager",
    });
    await grantManager(s, manager.personId);

    const bank = await s.as.action(api.reimbursements.linkBankAccount, {
      routingNumber: "011000015",
      accountNumber: "0987654321",
    });
    const { reimbursementId } = await s.as.mutation(
      api.reimbursements.submitReimbursement,
      {
        purpose: "Event supplies",
        externalAccountId: bank.externalAccountId!,
        lines: [await line(s)] as never,
      },
    );
    await manager.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId,
      note: "Say which event this served.",
    });

    // The claimant's own list carries the note + their lines — the in-app
    // revise surface.
    const mine = await s.as.query(api.reimbursements.myReimbursements, {});
    expect(mine[0].status).toBe("changes_requested");
    expect(mine[0].reviewNote).toContain("which event");
    expect(mine[0].lines[0].expenseType).toBe("general");

    // Somebody else's request is not theirs to resubmit.
    expect(
      await codeOf(() =>
        manager.as.mutation(api.reimbursements.resubmitMyReimbursement, {
          reimbursementId,
          lines: [],
        }),
      ),
    ).toBe("FORBIDDEN");

    const [only] = await linesOf(s, reimbursementId);
    const result = await s.as.mutation(
      api.reimbursements.resubmitMyReimbursement,
      {
        reimbursementId,
        lines: [
          {
            lineId: only._id,
            expenseType: "meal",
            headcount: 2,
            attendees: [
              { name: "Dana", affiliation: "team" },
              { name: "Vera", affiliation: "volunteer" },
            ],
            businessPurpose: "Dinner with the crew after the Eden shoot",
          },
        ],
      },
    );
    expect(result.status).toBe("submitted");
    const [revised] = await linesOf(s, reimbursementId);
    expect(revised.headcount).toBe(2);
    expect(revised.attendees).toHaveLength(2);

    // And now a reviewer who isn't the claimant can approve it.
    await manager.as.mutation(api.reimbursements.approve, { reimbursementId });
    const after = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(after?.status).toBe("approved");
  });
});

// ── 3. The public page's own HTTP surface ────────────────────────────────────

describe("the public token page carries the same questions", () => {
  test("POST /api/reimburse/submit carries a line's substantiation through", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const receiptStorageId = await storeBlob(s.t);
    const body = {
      chapterSlug: "nyc",
      payeeName: "Vera Volunteer",
      payeeEmail: "vera@example.com",
      purpose: "Event supplies",
      routingNumber: "011000015",
      accountNumber: "555000111",
      lines: [
        {
          description: "Crew dinner",
          amountCents: 4200,
          transactionDate: Date.now(),
          receiptStorageId,
          expenseType: "meal",
          businessPurpose: "Dinner with the crew after the Eden shoot in July",
          headcount: 2,
          attendees: [
            { name: "Vera", affiliation: "volunteer" },
            { name: "Sam", affiliation: "contractor" },
          ],
        },
      ],
    };
    const res = await s.t.fetch("/api/reimburse/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const req = await reqByToken(s, token);
    const [only] = await linesOf(s, req._id);
    expect(only.expenseType).toBe("meal");
    expect(only.headcount).toBe(2);
    expect(only.attendees?.map((a) => a.affiliation)).toEqual([
      "volunteer",
      "contractor",
    ]);

    // An unrecognized enum is a friendly 400, not an opaque validator blowup.
    const bad = await s.t.fetch("/api/reimburse/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        lines: [{ ...body.lines[0], expenseType: "vibes" }],
      }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain(
      "expense type",
    );
  });

  test("the sent-back page renders the note + a revise form, and resubmit is a POST", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Say which event this served.",
    });

    const page = await s.t.fetch(
      `/reimburse/nyc?token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Say which event this served.");
    expect(html).toContain("Update and resubmit");
    // A GET must never move the request — mail scanners prefetch links.
    const stillBack = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(stillBack?.status).toBe("changes_requested");

    const [only] = await linesOf(s, req._id);
    const res = await s.t.fetch("/api/reimburse/resubmit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        lines: [
          {
            lineId: only._id,
            expenseType: "travel",
            businessPurpose: "Travel to NY to film the Eden event in July",
            travelFrom: "Boston",
            travelTo: "New York",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const after = await run(s.t, (ctx) => ctx.db.get(req._id));
    expect(after?.status).toBe("submitted");
    expect(after?.reviewNote).toBeUndefined();
  });
});

// ── 4. The reviewer's read + the claimant's nudge ────────────────────────────

describe("the substantiation reaches the surfaces that need it", () => {
  test("the manager detail read carries each line's elements + the send-back note", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s, {
      lines: [
        await line(s, {
          description: "Crew dinner",
          expenseType: "meal",
          headcount: 2,
          attendees: [
            { name: "Vera", affiliation: "volunteer" },
            { name: "Sam", affiliation: "contractor" },
          ],
        }),
      ],
    });
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Add the itemized receipt.",
    });

    const detail = await s.as.query(api.reimbursements.get, {
      reimbursementId: req._id,
    });
    expect(detail.reviewNote).toBe("Add the itemized receipt.");
    expect(detail.lines[0].expenseTypeLabel).toBe("Meal");
    expect(detail.lines[0].headcount).toBe(2);
    expect(detail.lines[0].attendees?.map((a) => a.affiliation)).toEqual([
      "volunteer",
      "contractor",
    ]);
  });

  test("the stale-request sweep chases a sent-back request with its note", async () => {
    const { s } = await chapterWithManager();
    const { token } = await submitPublic(s);
    const req = await reqByToken(s, token);
    await s.as.mutation(api.reimbursements.requestChanges, {
      reimbursementId: req._id,
      note: "Say which event this served.",
    });

    const stale = await run(s.t, async () =>
      s.t.query(internal.reimbursements.listStaleReimbursements, {
        chapterId: s.chapterId,
        now: Date.now(),
        // Sent-back requests join the sweep on the SAME staleness window as
        // everything else (0 here = "everything is old enough").
        olderThanMs: 0,
      }),
    );
    const sentBackRow = stale.find((r) => r.status === "changes_requested");
    expect(sentBackRow?.reviewNote).toContain("which event");

    // The sweep itself degrades silently without RESEND_API_KEY.
    await expect(
      s.t.action(internal.reimbursements.sendReimbursementReminders, {}),
    ).resolves.toBeNull();
  });
});

// ── reimbursementContext.lines[].attendeesRedacted (review finding, 2026-08-13) ─
/**
 * `ReimbursementContextBlock` used to decide "names not shown to you" from
 * `line.attendees === null` alone — but a GROUP-DESCRIPTION line (>15 heads,
 * `codingFieldProblems`'s own carve-out) also has `attendees === null`, for a
 * reason that has nothing to do with the viewer's permissions. A caller who
 * genuinely holds full names-view saw a false redaction claim on that line.
 *
 * `transactionCodings.reimbursementCodingContext` now stamps each line with
 * `attendeesRedacted: l.attendees != null && !canSeeNames` — true ONLY when
 * there was something to redact.
 *
 * NOTE on what this suite can and can't pin: on THIS surface, `canSeeNames`
 * is `hasCodingNamesView(ctx, args.transactionId)` — the SAME transaction id
 * `getForTransaction` already ran `requireViewCoding` against a moment
 * earlier, with the same caller and no intervening write. That re-check is
 * therefore deterministically `true` whenever the read succeeds at all, so a
 * genuine "viewer lacks names-view" case is not reachable through THIS
 * query (unlike `priorCoding`, whose names check runs against a DIFFERENT,
 * PRIOR transaction — see `transactionCodings.test.ts`'s
 * "attendee names are redacted..." test for that live case). What IS
 * reachable, and is the actual bug this fixes, is the group-mode false
 * positive pinned below.
 */
describe("reimbursementContext.lines[].attendeesRedacted", () => {
  test("a group-description line (no attendees by design) never claims redaction; a names-mode line does not either, once the viewer can actually see them", async () => {
    const { s } = await chapterWithManager();

    const { txnId } = await run(s.t, async (ctx) => {
      const reimbursementId = await ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: "tok-attendees-redacted",
        status: "paid",
        payeeName: "Vera Volunteer",
        purpose: PURPOSE,
        totalCents: 9000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description: "All-chapter cookout",
        amountCents: 6000,
        expenseType: "meal",
        businessPurpose: "Fed the whole chapter after the outreach event",
        headcount: 40,
        groupDescription: "The whole chapter, open invite",
        order: 0,
        createdAt: Date.now(),
      });
      await ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description: "Leadership dinner",
        amountCents: 3000,
        expenseType: "meal",
        businessPurpose: "Dinner with the visiting leadership team",
        headcount: 2,
        attendees: [{ name: "Real Name", affiliation: "team" }],
        order: 1,
        createdAt: Date.now(),
      });
      const txnId = await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "reimbursement",
        flow: "outflow",
        amountCents: 9000,
        postedAt: Date.now(),
        reimbursementId,
        status: "reconciled",
        createdAt: Date.now(),
      });
      return { reimbursementId, txnId };
    });

    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    const lines = data.reimbursementContext?.lines ?? [];
    const groupLine = lines.find((l) => l.description === "All-chapter cookout");
    const namesLine = lines.find((l) => l.description === "Leadership dinner");

    // Group-description line: attendees is null because there were never
    // structured names on it, NOT because they were hidden.
    expect(groupLine?.attendees).toBeNull();
    expect(groupLine?.attendeesRedacted).toBe(false);

    // Names-mode line: this viewer (the manager) actually holds names-view,
    // so the real names come through and nothing was redacted either.
    expect(namesLine?.attendees).not.toBeNull();
    expect(namesLine?.attendees?.[0]?.name).toBe("Real Name");
    expect(namesLine?.attendeesRedacted).toBe(false);
  });
});
