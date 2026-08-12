import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WHO MAY APPROVE A CODING — the full role × scope matrix, one test per cell.
 *
 * Owner, 2026-08-09: four seats may approve a coding, never their own.
 *
 * | seat                  | chapter codings | central codings |
 * | --------------------- | --------------- | --------------- |
 * | `executive_director`  | ANY chapter     | yes             |
 * | `financial_manager`   | ANY chapter     | yes             |
 * | `chapter_director`    | THEIR OWN only  | no              |
 * | `treasurer`           | THEIR OWN only  | no              |
 *
 * Three of the four could approve NOTHING before this suite existed, for two
 * unrelated reasons — no derived graded role (ED, CD carry `finance.approve`
 * but not `finance.manager`) and no cross-book reach (the gate derived its
 * scope from the caller's ACTIVE chapter and refused everything else). See
 * `lib/transactionCodingAccess.ts#requireReviewCoding`.
 *
 * The four REFUSAL cells matter as much as the four grants. A Treasurer's
 * containment to their own chapter used to be a side effect of the blanket
 * `txn.chapterId !== homeChapterId → NOT_FOUND` that also (wrongly) contained
 * the FM; freeing the FM without stating the Treasurer's limit explicitly
 * would have handed every Treasurer the whole org. The negative tests below
 * are what prove the restriction is now the gate's own doing.
 *
 * Separation of duties is orthogonal and absolute — it applies to all four
 * seats and is pinned at the bottom of this file.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

/** A test instance with the seat defs seeded — every seat-derived arm below
 *  needs real `seatDefs` rows to resolve capabilities off. */
async function seatSetup(
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function seedPerson(
  s: ChapterSetup,
  name: string,
  opts: { self?: boolean } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      ...(opts.self ? { userId: s.userId } : {}),
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A second authenticated member in the same chapter — mirrors
 *  `cdBudgetApproval.test.ts`'s helper of the same shape. */
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
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: scope === "central" ? "central" : s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/** Insert a `seatAssignments` row directly, bypassing `assignSeat`'s
 *  write-through — isolates "what the seat ALONE implies" from any bridged
 *  stored grant, exactly like `cdBudgetApproval.test.ts`. */
async function assignSeatDirect(
  s: ChapterSetup,
  personId: Id<"people">,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

/** A receipted outflow charge in `book` — receipted because a coding can't be
 *  submitted on a charge that can't prove itself. */
async function seedTxn(
  s: ChapterSetup,
  book: Id<"chapters"> | "central",
): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: book,
      source: "manual",
      flow: "outflow",
      amountCents: 5800,
      postedAt: POST_POLICY,
      merchantName: "Peter Pan Bus Lines",
      status: "unreviewed",
      receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

/**
 * Put a SUBMITTED coding on `transactionId`, authored by `authorPersonId`.
 * Written straight to the table rather than through `api.transactionCodings
 * .submit`, so a test about who may REVIEW never depends on who may AUTHOR
 * (the two gates are deliberately different, and a cross-chapter reviewer
 * cannot author at all).
 */
async function seedSubmittedCoding(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  book: Id<"chapters"> | "central",
  authorPersonId: Id<"people">,
): Promise<void> {
  const now = Date.now();
  // `codedByUserId` is required by the schema. Reuse the author's own user row
  // when they have one (a real cardholder does); otherwise mint one, since
  // these tests only ever compare the author against the DECIDER by personId.
  const authorUserId =
    (await run(s.t, (ctx) => ctx.db.get(authorPersonId)))?.userId ??
    (await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: `author-${authorPersonId}@test.local` }),
    ));
  await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: book,
      expenseType: "general",
      businessPurpose: GOOD_PURPOSE,
      status: "submitted",
      codedByPersonId: authorPersonId,
      codedByUserId: authorUserId,
      submittedAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.patch(transactionId, { codingState: "submitted" }),
  );
}

async function codingStatus(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
): Promise<string | undefined> {
  const row = await run(s.t, (ctx) =>
    ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .unique(),
  );
  return row?.status;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTIVE DIRECTOR — any chapter, and central.
// The seat carries `finance.approve` + `finance.central` but deliberately NOT
// `finance.manager`, so it derives NO graded role. Before this change the
// rank test could never pass and an ED could approve nothing at all.
// ─────────────────────────────────────────────────────────────────────────────
describe("executive_director — any chapter, and central", () => {
  test("approves a coding in their OWN chapter (seat alone, no financeRoles grant)", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");
    // Deliberately NO financeRoles grant — the seat alone must carry it.

    await ed.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(s, txnId)).toBe("approved");
  });

  test("approves a coding in ANOTHER chapter — the org-wide arm", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "ed@publicworship.life",
      chapterName: "Chapter A",
    });
    const edPersonId = await seedPerson(chapterA, "ED", { self: true });
    await assignSeatDirect(chapterA, edPersonId, "executive_director", "central");

    await chapterA.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(chapterB, txnId)).toBe("approved");
  });

  test("approves a CENTRAL coding", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Central Author");
    const txnId = await seedTxn(s, "central");
    await seedSubmittedCoding(s, txnId, "central", author);

    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");

    await ed.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(s, txnId)).toBe("approved");
  });

  test("can also send one back with a note, in another chapter", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "ed@publicworship.life",
      chapterName: "Chapter A",
    });
    const edPersonId = await seedPerson(chapterA, "ED", { self: true });
    await assignSeatDirect(chapterA, edPersonId, "executive_director", "central");

    await chapterA.as.mutation(api.transactionCodings.requestChanges, {
      transactionId: txnId,
      reviewNote: "Receipt must show the exact amount",
    });
    expect(await codingStatus(chapterB, txnId)).toBe("changes_requested");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL MANAGER — any chapter, and central.
// Manager rank + central reach. Central always worked; ANOTHER CHAPTER is the
// cell that was broken (the gate refused any book but the caller's own).
// ─────────────────────────────────────────────────────────────────────────────
describe("financial_manager — any chapter, and central", () => {
  test("approves a coding in their OWN chapter", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await assignSeatDirect(s, fm.personId, "financial_manager", "central");

    await fm.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(s, txnId)).toBe("approved");
  });

  test("approves a coding in ANOTHER chapter — the cell that was broken", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    await chapterA.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(chapterB, txnId)).toBe("approved");
  });

  test("approves a CENTRAL coding", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Central Author");
    const txnId = await seedTxn(s, "central");
    await seedSubmittedCoding(s, txnId, "central", author);

    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await assignSeatDirect(s, fm.personId, "financial_manager", "central");

    await fm.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(s, txnId)).toBe("approved");
  });

  test("can READ a coding in another chapter — approving a record you can't open is not a review", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const data = await chapterA.as.query(
      api.transactionCodings.getForTransaction,
      { transactionId: txnId },
    );
    expect(data.coding?.businessPurpose).toBe(GOOD_PURPOSE);
    expect(data.canReview).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TREASURER — their own chapter only. The containment cell.
// ─────────────────────────────────────────────────────────────────────────────
describe("treasurer — their OWN chapter only", () => {
  test("approves a coding in their own chapter", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await tr.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(s, txnId)).toBe("approved");
  });

  test("CANNOT approve another chapter's coding — the restriction the FM's new reach would otherwise have removed", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "treasurer@publicworship.life",
      chapterName: "Chapter A",
    });
    const trPersonId = await seedPerson(chapterA, "Treasurer A", { self: true });
    await assignSeatDirect(chapterA, trPersonId, "treasurer", chapterA.chapterId);

    await expect(
      chapterA.as.mutation(api.transactionCodings.approve, {
        transactionId: txnId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(chapterB, txnId)).toBe("submitted");
  });

  test("CANNOT approve a CENTRAL coding — chapter finance.manager is not central reach", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Central Author");
    const txnId = await seedTxn(s, "central");
    await seedSubmittedCoding(s, txnId, "central", author);

    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await expect(
      tr.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(s, txnId)).toBe("submitted");
  });

  test("CANNOT send another chapter's coding back either — both decisions gate identically", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "treasurer@publicworship.life",
      chapterName: "Chapter A",
    });
    const trPersonId = await seedPerson(chapterA, "Treasurer A", { self: true });
    await assignSeatDirect(chapterA, trPersonId, "treasurer", chapterA.chapterId);

    await expect(
      chapterA.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "Not mine to judge",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(chapterB, txnId)).toBe("submitted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAPTER DIRECTOR — their own chapter only.
// Carries `finance.approve` at their chapter and derives rank "viewer", so
// like the ED it could approve nothing before this change.
// ─────────────────────────────────────────────────────────────────────────────
describe("chapter_director — their OWN chapter only", () => {
  test("approves a coding in their own chapter (seat alone, rank stays viewer)", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    await cd.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    expect(await codingStatus(s, txnId)).toBe("approved");
  });

  test("CANNOT approve another chapter's coding", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnId = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, txnId, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "cd@publicworship.life",
      chapterName: "Chapter A",
    });
    const cdPersonId = await seedPerson(chapterA, "CD A", { self: true });
    await assignSeatDirect(chapterA, cdPersonId, "chapter_director", chapterA.chapterId);

    await expect(
      chapterA.as.mutation(api.transactionCodings.approve, {
        transactionId: txnId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(chapterB, txnId)).toBe("submitted");
  });

  test("CANNOT approve a CENTRAL coding — a chapter-scoped finance.approve seat never widens central", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Central Author");
    const txnId = await seedTxn(s, "central");
    await seedSubmittedCoding(s, txnId, "central", author);

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    await expect(
      cd.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(s, txnId)).toBe("submitted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEPARATION OF DUTIES — absolute, and it outranks every seat above.
// ─────────────────────────────────────────────────────────────────────────────
describe("separation of duties outranks every one of the four seats", () => {
  test("an ED cannot approve a coding THEY wrote", async () => {
    const s = await seatSetup();
    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");

    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, ed.personId);

    await expect(
      ed.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
    expect(await codingStatus(s, txnId)).toBe("submitted");
  });

  test("an ED cannot SEND BACK a coding they wrote either — deciding is deciding, whichever way it goes", async () => {
    const s = await seatSetup();
    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");

    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, ed.personId);

    await expect(
      ed.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "Reopening my own record",
      }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
    expect(await codingStatus(s, txnId)).toBe("submitted");
  });

  test("a treasurer cannot approve their own, and `canReview` says so before they try", async () => {
    const s = await seatSetup();
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, tr.personId);

    const data = await tr.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(data.canReview).toBe(false);
    await expect(
      tr.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RELAXATION — the solo-operator bypass, and the trace it must leave.
// Mirrors `budgets.approvalParty` (owner, 2026-08-11: "as super admin, I need
// the ability to just approve my own coding things"). A SUPERUSER may decide
// their own coding; the approval is branded `approvalParty: "single"` so it
// stays re-reviewable when the org grows past one person. Nobody else gets it
// — the describe above stays true for every ordinary seat holder.
// ─────────────────────────────────────────────────────────────────────────────
describe("solo-operator self-approval — superuser only, and it leaves a trace", () => {
  async function selfCodingRow(s: ChapterSetup, txnId: Id<"transactions">) {
    return await run(s.t, (ctx) =>
      ctx.db
        .query("transactionCodings")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .unique(),
    );
  }

  test("a superuser approves their OWN coding, recorded as approvalParty 'single'", async () => {
    // The founder's exact shape: superuser email, their own roster row, their
    // own submitted coding — before this relaxation, SOD_VIOLATION.
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const selfPersonId = await seedPerson(s, "Owner", { self: true });
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, selfPersonId);

    // `canReview` must promise what the mutation allows — the queue's own
    // row shows a live Approve button, not "waiting on somebody else".
    const data = await s.as.query(api.transactionCodings.getForTransaction, {
      transactionId: txnId,
    });
    expect(data.canReview).toBe(true);

    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    const row = await selfCodingRow(s, txnId);
    expect(row?.status).toBe("approved");
    expect(row?.approvalParty).toBe("single");
    expect(row?.decidedByPersonId).toBe(selfPersonId);
  });

  test("a normal different-identity approval records 'two_party'", async () => {
    const s = await seatSetup();
    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    await ed.as.mutation(api.transactionCodings.approve, {
      transactionId: txnId,
    });
    const row = await selfCodingRow(s, txnId);
    expect(row?.status).toBe("approved");
    expect(row?.approvalParty).toBe("two_party");
  });

  test("a non-superuser ED still cannot self-approve — the relaxation is the superuser's alone", async () => {
    const s = await seatSetup();
    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, ed.personId);

    await expect(
      ed.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
    const row = await selfCodingRow(s, txnId);
    expect(row?.approvalParty).toBeUndefined();
  });

  test("the superuser can also redact their own coding's public wording first", async () => {
    // Redaction is part of the deciding power — a solo operator approving
    // their own coding must be able to strip a name from the public sentence
    // on the way (the mutation used to SOD-block them).
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const selfPersonId = await seedPerson(s, "Owner", { self: true });
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, selfPersonId);

    await s.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: "Travel to NY to film the event with the team",
    });
    const row = await selfCodingRow(s, txnId);
    expect(row?.publicPurpose).toBe(
      "Travel to NY to film the event with the team",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seats that carry no approval power at all stay refused.
// ─────────────────────────────────────────────────────────────────────────────
describe("nobody else approves anything", () => {
  test("a bookkeeper cannot approve — reviewing was never a record-side power", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const bk = await addMember(s, { email: "bk@publicworship.life", name: "BK" });
    await grantRole(s, bk.personId, "bookkeeper", "chapter");

    await expect(
      bk.as.mutation(api.transactionCodings.approve, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(s, txnId)).toBe("submitted");
  });

  test("a plain member with no seat and no grant cannot approve", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const plain = await addMember(s, {
      email: "plain@publicworship.life",
      name: "Plain",
    });

    await expect(
      plain.as.mutation(api.transactionCodings.approve, {
        transactionId: txnId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await codingStatus(s, txnId)).toBe("submitted");
  });
});
