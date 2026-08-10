/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
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
 * The Coding tab's two queries: the reviewer's `reviewQueue` and the
 * `workload` roll-up that both the tab gate and the by-chapter table read.
 *
 * The rules worth pinning here are the ones a screen can't be trusted to
 * enforce on its own:
 *
 *  - a caller WITHOUT org-wide reach is pinned to their own book no matter
 *    what `scope`/`chapterId` they send. The client offers a Treasurer no
 *    "All books" pill, but the client is not the gate.
 *  - rows the caller can't decide come back `canReview: false` rather than
 *    disappearing (the Reconcile `canEdit` posture), so a reviewer's own
 *    coding is visibly waiting on somebody else.
 *  - the tab gate is a real gate: someone with nothing to code and no review
 *    authority gets zeroes, so `_layout.tsx` can hide the tab rather than
 *    offering a dead one.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

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

async function seedTxn(
  s: ChapterSetup,
  book: Id<"chapters"> | "central",
  opts: { personId?: Id<"people">; merchantName?: string } = {},
): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: book,
      source: "manual",
      flow: "outflow",
      amountCents: 5800,
      postedAt: POST_POLICY,
      merchantName: opts.merchantName ?? "Peter Pan Bus Lines",
      personId: opts.personId,
      status: "unreviewed",
      receiptStorageId,
      createdAt: Date.now(),
    }),
  );
}

async function seedSubmittedCoding(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  book: Id<"chapters"> | "central",
  authorPersonId: Id<"people">,
  opts: { submittedAt?: number; expenseType?: "general" | "travel" | "meal" } = {},
): Promise<void> {
  const now = opts.submittedAt ?? Date.now();
  const authorUserId =
    (await run(s.t, (ctx) => ctx.db.get(authorPersonId)))?.userId ??
    (await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: `author-${authorPersonId}@test.local` }),
    ));
  await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: book,
      expenseType: opts.expenseType ?? "general",
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

describe("reviewQueue — scope", () => {
  test("an FM sees every book with scope:'all', and each row says which book", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnB = await seedTxn(chapterB, chapterB.chapterId, {
      merchantName: "B Merchant",
    });
    await seedSubmittedCoding(chapterB, txnB, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const authorA = await seedPerson(chapterA, "A Cardholder");
    const txnA = await seedTxn(chapterA, chapterA.chapterId, {
      merchantName: "A Merchant",
    });
    await seedSubmittedCoding(chapterA, txnA, chapterA.chapterId, authorA);

    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const res = await chapterA.as.query(api.transactionCodings.reviewQueue, {
      scope: "all",
    });
    expect(res.orgWide).toBe(true);
    expect(res.rows.map((r) => r.merchantName).sort()).toEqual([
      "A Merchant",
      "B Merchant",
    ]);
    expect(res.rows.map((r) => r.book.name).sort()).toEqual([
      "Chapter A",
      "Chapter B",
    ]);
    expect(res.rows.every((r) => r.canReview)).toBe(true);
  });

  test("a chapterId drill-down narrows to that book", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnB = await seedTxn(chapterB, chapterB.chapterId, {
      merchantName: "B Merchant",
    });
    await seedSubmittedCoding(chapterB, txnB, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const authorA = await seedPerson(chapterA, "A Cardholder");
    const txnA = await seedTxn(chapterA, chapterA.chapterId, {
      merchantName: "A Merchant",
    });
    await seedSubmittedCoding(chapterA, txnA, chapterA.chapterId, authorA);

    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const res = await chapterA.as.query(api.transactionCodings.reviewQueue, {
      chapterId: chapterB.chapterId,
    });
    expect(res.rows.map((r) => r.merchantName)).toEqual(["B Merchant"]);
  });

  test("A TREASURER ASKING FOR 'all' STILL ONLY GETS THEIR OWN BOOK — the client isn't the gate", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const txnB = await seedTxn(chapterB, chapterB.chapterId, {
      merchantName: "B Merchant",
    });
    await seedSubmittedCoding(chapterB, txnB, chapterB.chapterId, authorB);

    const chapterA = await setupChapter(t, {
      email: "treasurer@publicworship.life",
      chapterName: "Chapter A",
    });
    const authorA = await seedPerson(chapterA, "A Cardholder");
    const txnA = await seedTxn(chapterA, chapterA.chapterId, {
      merchantName: "A Merchant",
    });
    await seedSubmittedCoding(chapterA, txnA, chapterA.chapterId, authorA);

    const trPersonId = await seedPerson(chapterA, "Treasurer", { self: true });
    await assignSeatDirect(chapterA, trPersonId, "treasurer", chapterA.chapterId);

    const res = await chapterA.as.query(api.transactionCodings.reviewQueue, {
      scope: "all",
    });
    expect(res.orgWide).toBe(false);
    expect(res.rows.map((r) => r.merchantName)).toEqual(["A Merchant"]);
  });

  test("a central-scope request returns central's codings", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Central Author");
    const txnId = await seedTxn(s, "central", { merchantName: "Central Co" });
    await seedSubmittedCoding(s, txnId, "central", author);

    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await assignSeatDirect(s, fm.personId, "financial_manager", "central");

    const res = await fm.as.query(api.transactionCodings.reviewQueue, {
      scope: "central",
    });
    expect(res.rows.map((r) => r.book.name)).toEqual(["Central"]);
    expect(res.rows[0].merchantName).toBe("Central Co");
  });

  test("somebody with no review authority gets an empty queue, not a throw", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const plain = await addMember(s, {
      email: "plain@publicworship.life",
      name: "Plain",
    });
    const res = await plain.as.query(api.transactionCodings.reviewQueue, {});
    expect(res).toEqual({ rows: [], hasMore: false, orgWide: false });
  });
});

describe("reviewQueue — the row carries enough to decide without opening it", () => {
  test("purpose, route, who wrote it, and what proves it all ride on the row", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Casey Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    const authorUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "casey@test.local" }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("transactionCodings", {
        transactionId: txnId,
        chapterId: s.chapterId,
        expenseType: "travel",
        businessPurpose: GOOD_PURPOSE,
        travelFrom: "Boston",
        travelTo: "New York",
        status: "submitted",
        codedByPersonId: author,
        codedByUserId: authorUserId,
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(txnId, { codingState: "submitted" }));

    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const res = await tr.as.query(api.transactionCodings.reviewQueue, {});
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.coding.businessPurpose).toBe(GOOD_PURPOSE);
    expect(row.coding.travelFrom).toBe("Boston");
    expect(row.coding.travelTo).toBe("New York");
    expect(row.coding.codedByName).toBe("Casey Cardholder");
    // The fixture attaches a receipt, so the reviewer can read the purpose
    // against a document without leaving the row.
    expect(row.documentation).toBe("receipt");
    expect(row.canReview).toBe(true);
  });

  test("the reviewer's OWN coding stays in the queue, flagged canReview:false rather than hidden", async () => {
    const s = await seatSetup();
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const txnId = await seedTxn(s, s.chapterId, { merchantName: "Their own" });
    await seedSubmittedCoding(s, txnId, s.chapterId, tr.personId);

    const res = await tr.as.query(api.transactionCodings.reviewQueue, {});
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].merchantName).toBe("Their own");
    expect(res.rows[0].canReview).toBe(false);
  });

  test("oldest submission first — the queue is a clock, not an inbox", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const now = Date.now();
    const older = await seedTxn(s, s.chapterId, { merchantName: "Older" });
    await seedSubmittedCoding(s, older, s.chapterId, author, {
      submittedAt: now - 10 * DAY_MS,
    });
    const newer = await seedTxn(s, s.chapterId, { merchantName: "Newer" });
    await seedSubmittedCoding(s, newer, s.chapterId, author, {
      submittedAt: now - DAY_MS,
    });

    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const res = await tr.as.query(api.transactionCodings.reviewQueue, {});
    expect(res.rows.map((r) => r.merchantName)).toEqual(["Older", "Newer"]);
  });
});

describe("workload — the tab gate and the by-chapter roll-up", () => {
  test("a cardholder with no finance seat still gets a count of their OWN charges to code", async () => {
    const s = await seatSetup();
    const cardholder = await addMember(s, {
      email: "casey@publicworship.life",
      name: "Casey",
    });
    await seedTxn(s, s.chapterId, { personId: cardholder.personId });
    await seedTxn(s, s.chapterId, { personId: cardholder.personId });

    const res = await cardholder.as.query(api.transactionCodings.workload, {});
    expect(res.mineToCode).toBe(2);
    expect(res.awaitingMyReview).toBe(0);
    expect(res.orgWide).toBe(false);
    expect(res.byChapter).toEqual([]);
  });

  test("somebody with nothing to code and no authority gets all zeroes — the tab hides", async () => {
    const s = await seatSetup();
    const plain = await addMember(s, {
      email: "plain@publicworship.life",
      name: "Plain",
    });
    const res = await plain.as.query(api.transactionCodings.workload, {});
    expect(res).toEqual({
      mineToCode: 0,
      awaitingMyReview: 0,
      orgWide: false,
      byChapter: [],
    });
  });

  test("a treasurer gets their own chapter's review count and NO roll-up", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Cardholder");
    const txnId = await seedTxn(s, s.chapterId);
    await seedSubmittedCoding(s, txnId, s.chapterId, author);

    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const res = await tr.as.query(api.transactionCodings.workload, {});
    expect(res.awaitingMyReview).toBe(1);
    expect(res.orgWide).toBe(false);
    expect(res.byChapter).toEqual([]);
  });

  test("an FM gets a per-book roll-up: what's still with cardholders, and what's waiting on a reviewer", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const chapterB = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Chapter B",
    });
    // B: one submitted (awaiting review) + one uncoded (still with its author).
    const authorB = await seedPerson(chapterB, "B Cardholder");
    const submittedB = await seedTxn(chapterB, chapterB.chapterId);
    await seedSubmittedCoding(chapterB, submittedB, chapterB.chapterId, authorB);
    await seedTxn(chapterB, chapterB.chapterId);

    const chapterA = await setupChapter(t, {
      email: "fm@publicworship.life",
      chapterName: "Chapter A",
    });
    const fmPersonId = await seedPerson(chapterA, "FM", { self: true });
    await assignSeatDirect(chapterA, fmPersonId, "financial_manager", "central");

    const res = await chapterA.as.query(api.transactionCodings.workload, {});
    expect(res.orgWide).toBe(true);
    // Central first, then the chapters.
    expect(res.byChapter[0].name).toBe("Central");
    const b = res.byChapter.find((r) => r.name === "Chapter B")!;
    expect(b.awaitingReview).toBe(1);
    expect(b.toCode).toBe(1);
    expect(res.awaitingMyReview).toBe(1);
  });
});
