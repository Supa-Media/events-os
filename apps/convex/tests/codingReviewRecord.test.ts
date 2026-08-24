/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { DEFAULT_CODING_REQUIRED_SINCE_MS, DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `transactionCodings.reviewRecord` — the whole record behind one queue row.
 *
 * Founder, 2026-08-24: "when reviewing it doesn't let me review all the fields
 * they entered, like if it's a meal, I should see people's names listed for the
 * meal, I should also be able to review receipts or receipt exception
 * requests."
 *
 * The rules worth pinning here are exactly the ones that were BROKEN before
 * this query existed, and that a screen cannot enforce for itself:
 *
 *  - a CENTRAL reviewer opening a CHAPTER's coding gets the attendee names,
 *    the receipt file, AND the exception request. Each of those has an
 *    existing reader that would refuse them: `receipts.listForTransaction`
 *    wants bookkeeper rank at the caller's HOME chapter, and
 *    `receiptExceptions.listForTransaction` is home-chapter-bound outright.
 *    Reviewing a claim you cannot read is the failure mode.
 *  - DECIDING the exception is NOT widened by any of that. `canDecideException`
 *    is the honest answer from `hasApproveReceiptException`, so the UI renders
 *    the request read-only rather than a button the server would refuse.
 *  - `canReview` obeys separation of duties, matching `approve`'s own rule, so
 *    the record never offers a decision that would throw.
 *  - a caller with no reach into the row's book gets a refusal, not an empty
 *    record — a readable shell would be an existence oracle for another
 *    chapter's spending.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const GOOD_PURPOSE = "Team dinner while filming the Eden event in Brooklyn";

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

/** A charge with a real `receipts` row + `receiptLinks` edge — the shape
 *  `finances.attachReceipt` actually produces, so the query is exercised
 *  through its primary path and not only its denorm fallback. */
async function seedReceiptedTxn(
  s: ChapterSetup,
  book: Id<"chapters"> | "central",
  opts: { personId?: Id<"people">; receipt?: boolean } = {},
): Promise<Id<"transactions">> {
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: book,
      source: "manual",
      flow: "outflow",
      amountCents: 5541,
      postedAt: POST_POLICY,
      merchantName: "DD *DOORDASH CAVA",
      description: "DD *DOORDASH CAVA | Address: 855-973-1040",
      personId: opts.personId,
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
  if (opts.receipt !== false) {
    const storageId = await storeBlob(s.t);
    const receiptId = await run(s.t, (ctx) =>
      ctx.db.insert("receipts", {
        chapterId: book,
        storageId,
        source: "upload",
        filename: "cava.pdf",
        amountCents: 5541,
        linkCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("receiptLinks", {
        receiptId,
        transactionId,
        chapterId: book,
        source: "upload",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(transactionId, { receiptStorageId: storageId }),
    );
  }
  return transactionId;
}

async function seedMealCoding(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  book: Id<"chapters"> | "central",
  authorPersonId: Id<"people">,
): Promise<void> {
  const now = Date.now();
  const authorUserId =
    (await run(s.t, (ctx) => ctx.db.get(authorPersonId)))?.userId ??
    (await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: `author-${authorPersonId}@test.local` }),
    ));
  await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: book,
      expenseType: "meal",
      businessPurpose: GOOD_PURPOSE,
      headcount: 3,
      attendees: [
        { name: "Seyi Olujide", affiliation: "team" },
        { name: "Ada Musician", affiliation: "contractor" },
        { name: "Ben Volunteer", affiliation: "volunteer" },
      ],
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

describe("reviewRecord — what a reviewer can finally read", () => {
  test("a central FM opening a chapter's meal coding gets the names, the receipt and the exception request", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const author = await seedPerson(chapterB, "B Cardholder");
    const txn = await seedReceiptedTxn(chapterB, chapterB.chapterId, {
      personId: author,
      receipt: false,
    });
    await seedMealCoding(chapterB, txn, chapterB.chapterId, author);

    // No receipt: an exception request is what documents this charge, and it
    // is the thing the founder could not read from the queue.
    const evidenceId = await storeBlob(chapterB.t);
    await run(chapterB.t, (ctx) =>
      ctx.db.insert("receiptExceptions", {
        transactionId: txn,
        chapterId: chapterB.chapterId,
        amountCents: 5541,
        reason: "lost",
        note: "Receipt was thrown out with the catering boxes after the shoot.",
        evidenceStorageIds: [evidenceId],
        attestations: [
          { key: "email", prompt: "Checked your email and spam?", answer: true },
        ],
        status: "pending",
        attestedByPersonId: author,
        attestedByUserId: chapterB.userId,
        attestedAt: Date.now(),
      }),
    );

    // The FM stands in a DIFFERENT chapter — the shape that made every
    // existing reader refuse.
    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const rec = await chapterA.as.query(api.transactionCodings.reviewRecord, {
      transactionId: txn,
    });

    // THE NAMES. The specific ask, and the §274(d) business-relationship
    // element a reviewer is being asked to weigh.
    expect(rec.coding?.attendees?.map((a) => a.name)).toEqual([
      "Seyi Olujide",
      "Ada Musician",
      "Ben Volunteer",
    ]);
    expect(rec.coding?.attendees?.map((a) => a.affiliation)).toEqual([
      "team",
      "contractor",
      "volunteer",
    ]);
    expect(rec.namesRedacted).toBe(false);
    expect(rec.coding?.headcount).toBe(3);

    // THE EXCEPTION REQUEST, whole — note, attestations and evidence, none of
    // which `receiptExceptions.listForTransaction` would hand this caller.
    expect(rec.exceptions).toHaveLength(1);
    expect(rec.exceptions[0]?.status).toBe("pending");
    expect(rec.exceptions[0]?.note).toContain("catering boxes");
    expect(rec.exceptions[0]?.attestations).toHaveLength(1);
    expect(rec.exceptions[0]?.evidence).toHaveLength(1);

    // THE CHARGE, including the raw statement line under the tidy name.
    expect(rec.charge.bookName).toBe("Chapter B");
    expect(rec.charge.rawBankLine).toContain("855-973-1040");
    expect(rec.charge.cardholderName).toBe("B Cardholder");
    expect(rec.canReview).toBe(true);
  });

  test("the receipt file itself comes through — the reader that would have refused it needs bookkeeper rank at home", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const author = await seedPerson(chapterB, "B Cardholder");
    const txn = await seedReceiptedTxn(chapterB, chapterB.chapterId, {
      personId: author,
    });
    await seedMealCoding(chapterB, txn, chapterB.chapterId, author);

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const rec = await chapterA.as.query(api.transactionCodings.reviewRecord, {
      transactionId: txn,
    });
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.filename).toBe("cava.pdf");
    expect(rec.receipts[0]?.url).toBeTruthy();
    // The receipt's own extracted amount rides along so a reviewer can check
    // the document against the charge without leaving the row.
    expect(rec.receipts[0]?.amountCents).toBe(5541);

    // The SAME caller through the pre-existing reader is REFUSED outright —
    // `receipts.listForTransaction` wants bookkeeper rank at their own
    // chapter, which a central FM seat does not confer there. That refusal is
    // the whole reason this query serves the file itself rather than sending
    // the reviewer to a screen that would 403 them.
    await expect(
      chapterA.as.query(api.receipts.listForTransaction, {
        transactionId: txn,
      }),
    ).rejects.toThrow(/Bookkeeper/);
  });

  test("a charge whose receipt predates the receipts layer still shows its proof", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txn = await seedReceiptedTxn(s, s.chapterId, {
      personId: author,
      receipt: false,
    });
    // The denormalized pointer alone, with no `receipts` row and no link —
    // the legacy shape the fallback exists for.
    const storageId = await storeBlob(s.t);
    await run(s.t, (ctx) => ctx.db.patch(txn, { receiptStorageId: storageId }));
    await seedMealCoding(s, txn, s.chapterId, author);

    const reviewer = await seedPerson(s, "Treasurer", { self: true });
    await assignSeatDirect(s, reviewer, "treasurer", s.chapterId);

    const rec = await s.as.query(api.transactionCodings.reviewRecord, {
      transactionId: txn,
    });
    expect(rec.receipts).toHaveLength(1);
    expect(rec.receipts[0]?.url).toBeTruthy();
  });
});

describe("reviewRecord — what it refuses to promise", () => {
  test("deciding the exception is not widened: a central FM on a chapter row reads it, can't decide it", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const author = await seedPerson(chapterB, "B Cardholder");
    const txn = await seedReceiptedTxn(chapterB, chapterB.chapterId, {
      personId: author,
      receipt: false,
    });
    await seedMealCoding(chapterB, txn, chapterB.chapterId, author);
    await run(chapterB.t, (ctx) =>
      ctx.db.insert("receiptExceptions", {
        transactionId: txn,
        chapterId: chapterB.chapterId,
        amountCents: 5541,
        reason: "lost",
        note: "Receipt was thrown out with the catering boxes after the shoot.",
        status: "pending",
        attestedByPersonId: author,
        attestedByUserId: chapterB.userId,
        attestedAt: Date.now(),
      }),
    );

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const rec = await chapterA.as.query(api.transactionCodings.reviewRecord, {
      transactionId: txn,
    });
    // Reads the request in full…
    expect(rec.exceptions).toHaveLength(1);
    // …and is told plainly that deciding it is somebody else's, so the UI
    // renders the reason instead of a button the server would refuse.
    expect(rec.canDecideException).toBe(false);
    // The CODING decision is theirs, though — that's what the queue handed
    // them, and the two powers are genuinely separate.
    expect(rec.canReview).toBe(true);
  });

  test("separation of duties: a reviewer opening their OWN coding gets canReview:false", async () => {
    const s = await seatSetup();
    const reviewer = await seedPerson(s, "Treasurer", { self: true });
    await assignSeatDirect(s, reviewer, "treasurer", s.chapterId);
    const txn = await seedReceiptedTxn(s, s.chapterId, { personId: reviewer });
    await seedMealCoding(s, txn, s.chapterId, reviewer);

    const rec = await s.as.query(api.transactionCodings.reviewRecord, {
      transactionId: txn,
    });
    // Visible — it IS outstanding work — but plainly not theirs to decide.
    expect(rec.coding?.businessPurpose).toBe(GOOD_PURPOSE);
    expect(rec.canReview).toBe(false);
  });

  test("a caller with no reach into the book is refused, not handed an empty record", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const author = await seedPerson(chapterB, "B Cardholder");
    const txn = await seedReceiptedTxn(chapterB, chapterB.chapterId, {
      personId: author,
    });
    await seedMealCoding(chapterB, txn, chapterB.chapterId, author);

    const chapterA = await setupChapter(t, {
      email: "stranger@publicworship.life",
      chapterName: "Chapter A",
    });
    await seedPerson(chapterA, "Nobody", { self: true });

    await expect(
      chapterA.as.query(api.transactionCodings.reviewRecord, {
        transactionId: txn,
      }),
    ).rejects.toThrow();
  });
});
