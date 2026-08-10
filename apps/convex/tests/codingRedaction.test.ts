/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  DEFAULT_CODING_REQUIRED_SINCE_MS,
  DAY_MS,
  MIN_PURPOSE_LENGTH,
  publishedPurpose,
} from "@events-os/shared";
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
 * THE APPROVER'S REDACTION PASS — and the invariant that makes it safe.
 *
 * Owner, 2026-08-09: the approver should be able to get a coding ready for
 * public viewing rather than bouncing it back over one name in the sentence.
 *
 * The rule this suite exists to defend: **redaction is not falsification.**
 * A coding is substantiation for an IRS accountable plan, so the author's own
 * `businessPurpose` must survive every rewrite, unchanged and readable. If a
 * future change ever "simplifies" this into editing the purpose in place,
 * these tests are what should fail.
 *
 * The hole it closes is specific: structured attendee names render
 * internal-only forever, but a name typed into the free-text purpose bypasses
 * that entirely — real production text reads "Travel with Michael Reid from
 * all team meeting in Manhattan to LIRR in Rosedale".
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const AUTHOR_WORDS =
  "Travel with Michael Reid from the all-team meeting in Manhattan to the LIRR";
const REDACTED = "Travel from the all-team meeting in Manhattan to the LIRR";

async function seatSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t);
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
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

/** A submitted coding whose purpose names somebody. */
async function seedCoding(
  s: ChapterSetup,
  authorPersonId: Id<"people">,
): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  const txnId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: POST_POLICY,
      merchantName: "Uber",
      status: "unreviewed",
      receiptStorageId,
      codingState: "submitted",
      createdAt: Date.now(),
    }),
  );
  const authorUserId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: `author-${authorPersonId}@test.local` }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId: txnId,
      chapterId: s.chapterId,
      expenseType: "travel",
      businessPurpose: AUTHOR_WORDS,
      travelFrom: "Manhattan",
      travelTo: "Rosedale",
      status: "submitted",
      codedByPersonId: authorPersonId,
      codedByUserId: authorUserId,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return txnId;
}

async function codingRow(s: ChapterSetup, transactionId: Id<"transactions">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .unique(),
  );
}

describe("redaction is not falsification", () => {
  test("THE INVARIANT: an approver's rewrite never touches the author's words", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: REDACTED,
    });

    const row = await codingRow(s, txnId);
    // The published version is the redaction…
    expect(row?.publicPurpose).toBe(REDACTED);
    // …and the author's testimony is byte-for-byte what they wrote.
    expect(row?.businessPurpose).toBe(AUTHOR_WORDS);
    expect(row?.publicPurposeByPersonId).toBe(tr.personId);
    expect(row?.publicPurposeAt).toBeGreaterThan(0);
  });

  test("`publishedPurpose` is the single place that decision lives", () => {
    expect(
      publishedPurpose({
        businessPurpose: AUTHOR_WORDS,
        publicPurpose: REDACTED,
      }),
    ).toBe(REDACTED);
    expect(
      publishedPurpose({ businessPurpose: AUTHOR_WORDS, publicPurpose: null }),
    ).toBe(AUTHOR_WORDS);
    // A blank/whitespace rewrite is not a redaction — it would publish nothing
    // at all, so the author's words stand.
    expect(
      publishedPurpose({ businessPurpose: AUTHOR_WORDS, publicPurpose: "   " }),
    ).toBe(AUTHOR_WORDS);
  });

  test("clearing the redaction restores the author's wording as what publishes", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: REDACTED,
    });
    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: null,
    });

    const row = await codingRow(s, txnId);
    expect(row?.publicPurpose).toBeUndefined();
    expect(row?.businessPurpose).toBe(AUTHOR_WORDS);
  });

  test("the published wording still has to say something — a redaction can't gut it", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await expect(
      tr.as.mutation(api.transactionCodings.setPublicPurpose, {
        transactionId: txnId,
        publicPurpose: "travel",
      }),
    ).rejects.toMatchObject({ data: { code: "PURPOSE_TOO_SHORT" } });
    expect("travel".length).toBeLessThan(MIN_PURPOSE_LENGTH);
  });
});

describe("who may redact", () => {
  test("every approval seat can — here the Chapter Director, whose seat carries no manager rank", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const cd = await addMember(s, {
      email: "cd@publicworship.life",
      name: "Cara CD",
    });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    await cd.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: REDACTED,
    });
    expect((await codingRow(s, txnId))?.publicPurpose).toBe(REDACTED);
  });

  test("SEPARATION OF DUTIES: you cannot rewrite what publishes on your OWN coding", async () => {
    const s = await seatSetup();
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);
    // The treasurer is the AUTHOR this time.
    const txnId = await seedCoding(s, tr.personId);

    await expect(
      tr.as.mutation(api.transactionCodings.setPublicPurpose, {
        transactionId: txnId,
        publicPurpose: REDACTED,
      }),
    ).rejects.toMatchObject({ data: { code: "SOD_VIOLATION" } });
    expect((await codingRow(s, txnId))?.publicPurpose).toBeUndefined();
  });

  test("a bookkeeper cannot — rewriting what publishes is part of deciding", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const bk = await addMember(s, {
      email: "bk@publicworship.life",
      name: "Bo Bookkeeper",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: bk.personId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    await expect(
      bk.as.mutation(api.transactionCodings.setPublicPurpose, {
        transactionId: txnId,
        publicPurpose: REDACTED,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("the trail, and what the author sees", () => {
  test("a redaction writes an audit row naming who did it, carrying both strings", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: REDACTED,
    });

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("financeAuditLog").collect(),
    );
    const entry = rows.find((r) => r.action === "coding_redact");
    expect(entry).toBeTruthy();
    expect(entry?.actorPersonId).toBe(tr.personId);
    expect(entry?.before).toBe(AUTHOR_WORDS);
    expect(entry?.after).toBe(REDACTED);
    expect(entry?.field).toBe("publicPurpose");
  });

  test("a no-op save writes nothing — opening the field and changing your mind isn't a redaction", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: AUTHOR_WORDS,
    });

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("financeAuditLog").collect(),
    );
    expect(rows.filter((r) => r.action === "coding_redact")).toHaveLength(0);
    expect((await codingRow(s, txnId))?.publicPurpose).toBeUndefined();
  });

  test("THE AUTHOR SEES IT — the rewrite and who made it come back on their own read", async () => {
    const s = await seatSetup();
    const cardholder = await addMember(s, {
      email: "julie@publicworship.life",
      name: "Julie",
    });
    const txnId = await seedCoding(s, cardholder.personId);
    // The charge is theirs, so they can read it with no finance grant at all.
    await run(s.t, (ctx) =>
      ctx.db.patch(txnId, { personId: cardholder.personId }),
    );
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);
    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: REDACTED,
    });

    const data = await cardholder.as.query(
      api.transactionCodings.getForTransaction,
      { transactionId: txnId },
    );
    expect(data.coding?.businessPurpose).toBe(AUTHOR_WORDS);
    expect(data.coding?.publicPurpose).toBe(REDACTED);
    expect(data.coding?.publicPurposeByName).toBe("Tara Treasurer");
    expect(data.coding?.publicPurposeAt).toBeGreaterThan(0);
  });

  test("and it rides on the reviewer's queue row too, so an approver sees both before deciding", async () => {
    const s = await seatSetup();
    const author = await seedPerson(s, "Julie");
    const txnId = await seedCoding(s, author);
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);
    await tr.as.mutation(api.transactionCodings.setPublicPurpose, {
      transactionId: txnId,
      publicPurpose: REDACTED,
    });

    const queue = await tr.as.query(api.transactionCodings.reviewQueue, {});
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0].coding.businessPurpose).toBe(AUTHOR_WORDS);
    expect(queue.rows[0].coding.publicPurpose).toBe(REDACTED);
  });
});
