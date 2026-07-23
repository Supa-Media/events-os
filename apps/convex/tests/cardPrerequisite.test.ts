/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Card-issuance Academy-course prerequisite gate (org-wide, OFF by default).
 *
 * Central finance can require a member to finish a designated finance Academy
 * course before a card is issued/activated. The single hard gate lives in
 * `beginIssueCard`, so it covers BOTH `issueCard` (direct) and
 * `decideCardRequest → issueCard` (approved request). This suite covers:
 *  - gate OFF when the slug is null (issuance works unchanged),
 *  - FAIL-OPEN when the slug names a course that isn't in the catalog
 *    (issuance works — an unknown course can never be completed, so gating on
 *    it would brick ALL issuance),
 *  - issuance BLOCKED when the prerequisite is set and the cardholder hasn't
 *    completed it, and ALLOWED once completed (earned badge OR live-derived),
 *  - the approved-request path (`decideCardRequest`) is gated identically,
 *  - `listCards` / `listCardRequests` report `prerequisiteMet` correctly (null
 *    when unset, true/false when set).
 *
 * The real finance COURSE slug (not a section slug) is `finances-for-everyone`;
 * its required modules are the three "Finances for Everyone" sections — see
 * `packages/shared/src/academy/streams/finances.ts`.
 */

const FINANCE_COURSE = "finances-for-everyone";
const FINANCE_COURSE_TITLE = "Finances for Everyone";
const FINANCE_MODULE_SLUGS = [
  "finance-stewardship",
  "finance-card-and-receipts",
  "finance-reimbursements-and-flags",
];

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users">; pwEmail?: string | null } = {
    name: "Person",
  },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      // Card-eligible by default — pass `pwEmail: null` to seed an ineligible.
      pwEmail:
        opts.pwEmail === null
          ? undefined
          : (opts.pwEmail ?? "person@publicworship.life"),
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

/** The seeded caller as a finance manager (person linked to the user + role). */
async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s, {
    name: "Manny Manager",
    userId: s.userId,
  });
  await grantRole(s, personId, "manager");
  return personId;
}

/** Set (or clear) the org-wide card-prerequisite course slug (upserts the
 *  finance-settings singleton, mirroring `financeSettings.setFinancePolicy`). */
async function setCardPrerequisite(
  s: ChapterSetup,
  slug: string | null,
): Promise<void> {
  await run(s.t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        cardPrerequisiteCourseSlug: slug ?? undefined,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        cardPrerequisiteCourseSlug: slug ?? undefined,
        updatedAt: Date.now(),
      });
    }
  });
}

/** Award a person the canonical earned course badge. */
async function seedCourseCompletion(
  s: ChapterSetup,
  personId: Id<"people">,
  courseSlug: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("courseCompletions", {
      chapterId: s.chapterId,
      personId,
      courseSlug,
      earnedAt: Date.now(),
    }),
  );
}

/** Stamp a module (quiz section) as passed for a person — the live-derived
 *  completion path (no badge row). */
async function seedModulePassed(
  s: ChapterSetup,
  personId: Id<"people">,
  sectionSlug: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("academyProgress", {
      chapterId: s.chapterId,
      personId,
      sectionSlug,
      quizBestScore: 5,
      quizTotal: 5,
      passedAt: Date.now(),
    }),
  );
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof ConvexError) {
      return (err as ConvexError<{ code?: string }>).data.code ?? "ConvexError";
    }
    throw err;
  }
}

async function cardCount(s: ChapterSetup, personId: Id<"people">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", personId))
      .collect(),
  );
}

// ── The gate ─────────────────────────────────────────────────────────────────

describe("card-issuance prerequisite gate", () => {
  test("OFF by default: no prerequisite slug → issuance works", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });

    // No financeSettings row at all — the slug reads null → no gate.
    const res = await s.as.mutation(internal.cards.beginIssueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(res.kind).toBe("created");
    expect((await cardCount(s, holder)).length).toBe(1);
  });

  test("FAIL-OPEN: slug set to a course NOT in the catalog → issuance works", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    // A slug that no `ACADEMY_COURSES` course matches — gating on it would brick
    // ALL issuance, so the gate skips it instead.
    await setCardPrerequisite(s, "not-a-real-course");

    const res = await s.as.mutation(internal.cards.beginIssueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(res.kind).toBe("created");
    expect((await cardCount(s, holder)).length).toBe(1);
  });

  test("BLOCKED: prerequisite set + cardholder hasn't completed it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);

    const code = await errorCode(
      s.as.mutation(internal.cards.beginIssueCard, {
        cardholderPersonId: holder,
        type: "virtual",
      }),
    );
    expect(code).toBe("CARD_PREREQUISITE_INCOMPLETE");
    // No card row was minted for the untrained holder.
    expect((await cardCount(s, holder)).length).toBe(0);
  });

  test("BLOCKED error names the real course title", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);

    let caught: unknown;
    try {
      await s.as.mutation(internal.cards.beginIssueCard, {
        cardholderPersonId: holder,
        type: "virtual",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect(
      (caught as ConvexError<{ message: string }>).data.message,
    ).toBe(`${FINANCE_COURSE_TITLE} must be completed before a card can be issued.`);
  });

  test("ALLOWED once completed (earned badge)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);
    await seedCourseCompletion(s, holder, FINANCE_COURSE);

    const res = await s.as.mutation(internal.cards.beginIssueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(res.kind).toBe("created");
    expect((await cardCount(s, holder)).length).toBe(1);
  });

  test("ALLOWED once completed (live-derived: every required module passed, no badge)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);
    // Pass every required module WITHOUT a courseCompletions badge — the gate
    // still counts the course as complete via the live derivation.
    for (const slug of FINANCE_MODULE_SLUGS) {
      await seedModulePassed(s, holder, slug);
    }

    const res = await s.as.mutation(internal.cards.beginIssueCard, {
      cardholderPersonId: holder,
      type: "virtual",
    });
    expect(res.kind).toBe("created");
  });

  test("still BLOCKED when only SOME required modules are passed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);
    // Only the first two of three required modules passed.
    await seedModulePassed(s, holder, FINANCE_MODULE_SLUGS[0]);
    await seedModulePassed(s, holder, FINANCE_MODULE_SLUGS[1]);

    const code = await errorCode(
      s.as.mutation(internal.cards.beginIssueCard, {
        cardholderPersonId: holder,
        type: "virtual",
      }),
    );
    expect(code).toBe("CARD_PREREQUISITE_INCOMPLETE");
  });
});

// ── The approved-request path is gated identically ──────────────────────────

describe("decideCardRequest respects the prerequisite gate", () => {
  test("approving an untrained requester's card request is BLOCKED", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);

    const requestId = await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: holder,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );

    const code = await errorCode(
      s.as.action(api.cards.decideCardRequest, {
        requestId,
        decision: "approve",
      }),
    );
    expect(code).toBe("CARD_PREREQUISITE_INCOMPLETE");
    // The throw happened before `finishDecideCardRequest`, so the request stays
    // open and no card was minted.
    const req = await run(s.t, (ctx) => ctx.db.get(requestId));
    expect(req?.status).toBe("requested");
    expect((await cardCount(s, holder)).length).toBe(0);
  });

  test("approving a trained requester's card request issues the card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);
    await seedCourseCompletion(s, holder, FINANCE_COURSE);

    const requestId = await run(s.t, (ctx) =>
      ctx.db.insert("cardRequests", {
        chapterId: s.chapterId,
        personId: holder,
        status: "requested",
        requestedAt: Date.now(),
      }),
    );

    const decided = await s.as.action(api.cards.decideCardRequest, {
      requestId,
      decision: "approve",
    });
    expect(decided.status).toBe("approved");
    expect(decided.cardId).not.toBeNull();
    expect((await cardCount(s, holder)).length).toBe(1);
  });
});

// ── The list queries report prerequisiteMet ─────────────────────────────────

describe("listCards / listCardRequests report prerequisiteMet", () => {
  test("listCards: null when unset, true/false per cardholder when set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const trained = await seedPerson(s, { name: "Trained Holder" });
    const untrained = await seedPerson(s, { name: "Untrained Holder" });
    await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: trained,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: untrained,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      }),
    );

    // No prerequisite configured → every row is null.
    const before = await s.as.query(api.cards.listCards, {});
    expect(before.length).toBe(2);
    expect(before.every((r) => r.prerequisiteMet === null)).toBe(true);

    // Configure the gate + train ONE holder.
    await setCardPrerequisite(s, FINANCE_COURSE);
    await seedCourseCompletion(s, trained, FINANCE_COURSE);

    const after = await s.as.query(api.cards.listCards, {});
    const byPerson = new Map(
      after.map((r) => [String(r.cardholderPersonId), r.prerequisiteMet]),
    );
    expect(byPerson.get(String(trained))).toBe(true);
    expect(byPerson.get(String(untrained))).toBe(false);
  });

  test("listCards: FAIL-OPEN slug → prerequisiteMet stays null (no effective gate)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: holder,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    await setCardPrerequisite(s, "not-a-real-course");

    const rows = await s.as.query(api.cards.listCards, {});
    expect(rows.length).toBe(1);
    expect(rows[0].prerequisiteMet).toBeNull();
  });

  test("listCardRequests: null when unset, true/false per requester when set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const trained = await seedPerson(s, { name: "Trained Req" });
    const untrained = await seedPerson(s, { name: "Untrained Req" });
    for (const personId of [trained, untrained]) {
      await run(s.t, (ctx) =>
        ctx.db.insert("cardRequests", {
          chapterId: s.chapterId,
          personId,
          status: "requested",
          requestedAt: Date.now(),
        }),
      );
    }

    const before = await s.as.query(api.cards.listCardRequests, {});
    expect(before.length).toBe(2);
    expect(before.every((r) => r.prerequisiteMet === null)).toBe(true);

    await setCardPrerequisite(s, FINANCE_COURSE);
    await seedCourseCompletion(s, trained, FINANCE_COURSE);

    const after = await s.as.query(api.cards.listCardRequests, {});
    const byPerson = new Map(
      after.map((r) => [String(r.personId), r.prerequisiteMet]),
    );
    expect(byPerson.get(String(trained))).toBe(true);
    expect(byPerson.get(String(untrained))).toBe(false);
  });
});

// ── cardPrerequisiteStatus (member + manager-picker read) ────────────────────

describe("cardPrerequisiteStatus", () => {
  test("null when no gate is configured", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    expect(await s.as.query(api.cards.cardPrerequisiteStatus, {})).toBeNull();
  });

  test("the caller's own status (no personId arg)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedManager(s);
    await setCardPrerequisite(s, FINANCE_COURSE);

    const unmet = await s.as.query(api.cards.cardPrerequisiteStatus, {});
    expect(unmet).toEqual({
      slug: FINANCE_COURSE,
      title: FINANCE_COURSE_TITLE,
      met: false,
    });

    await seedCourseCompletion(s, me, FINANCE_COURSE);
    const met = await s.as.query(api.cards.cardPrerequisiteStatus, {});
    expect(met?.met).toBe(true);
  });

  test("a manager reads another person's status by personId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const holder = await seedPerson(s, { name: "Holder" });
    await setCardPrerequisite(s, FINANCE_COURSE);

    const before = await s.as.query(api.cards.cardPrerequisiteStatus, {
      personId: holder,
    });
    expect(before?.met).toBe(false);

    await seedCourseCompletion(s, holder, FINANCE_COURSE);
    const after = await s.as.query(api.cards.cardPrerequisiteStatus, {
      personId: holder,
    });
    expect(after?.met).toBe(true);
  });
});
