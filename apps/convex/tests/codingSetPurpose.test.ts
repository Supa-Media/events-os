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
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * THE GRID'S INLINE "WHAT IT WAS FOR" CELL — `transactionCodings.setPurpose`.
 *
 * The column exists so a month's explanations read without opening anything;
 * tapping a cell nevertheless opened the documentation modal, which the founder
 * named as self-defeating. The cell is now an input on the rows that can take
 * one, and this mutation is what it calls.
 *
 * The guarantee that actually matters here is the QUIET one. `submitCoding`
 * writes with `db.replace`, so a purpose-only call built the obvious way —
 * `{ expenseType: "general", businessPurpose }` — would erase a meal's
 * attendee list, a trip's route and a stay's place, silently, on the §274(d)
 * record. So the first two tests below are about what SURVIVES an edit, not
 * about what changes.
 *
 * Everything else pins that the narrow path is not a laxer path: the same
 * length floor, the same approved-coding refusal, the same authorship, and an
 * ordinary `coding_submit` audit round rather than a lesser kind of edit
 * because of which control it was typed into.
 */

const POST_POLICY = DEFAULT_CODING_REQUIRED_SINCE_MS + 30 * DAY_MS;
const ORIGINAL =
  "Dinner with the volunteer team after the Eden shoot in Queens";
const REVISED =
  "Dinner with the volunteer crew after the Eden album shoot in Queens";

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manager Mo",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A SECOND authenticated member — the coding's author. Separation of duties
 *  forbids deciding your own coding, so every test that needs an approval or a
 *  send-back has to have somebody else write it. That is also the realistic
 *  shape: a cardholder explains, a reviewer decides. */
async function addAuthor(s: ChapterSetup): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  personId: Id<"people">;
}> {
  const userId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: "cardholder@publicworship.life" }),
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
      name: "Cardholder Cass",
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

/** A post-policy, receipted outflow. `personId` makes it that cardholder's OWN
 *  charge, which is what lets them author its coding — `resolveAuthor` allows
 *  the transaction's own person or a bookkeeper, nobody else. */
async function seedTxn(
  s: ChapterSetup,
  opts: { personId?: Id<"people"> } = {},
): Promise<Id<"transactions">> {
  const receiptStorageId = await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 8_400,
      postedAt: POST_POLICY,
      merchantName: "SWEETGREEN",
      status: "unreviewed",
      receiptStorageId,
      ...(opts.personId ? { personId: opts.personId } : {}),
      createdAt: Date.now(),
    }),
  );
}

async function codingFor(s: ChapterSetup, transactionId: Id<"transactions">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .unique(),
  );
}

describe("editing the sentence preserves everything else", () => {
  test("THE POINT: a meal keeps its attendees when only the purpose changes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const transactionId = await seedTxn(s);

    await s.as.mutation(api.transactionCodings.submit, {
      transactionId,
      expenseType: "meal",
      businessPurpose: ORIGINAL,
      headcount: 2,
      attendees: [
        { name: "Ada Reyes", affiliation: "volunteer" },
        { name: "Sam Oyelaran", affiliation: "contractor" },
      ],
    });

    await s.as.mutation(api.transactionCodings.setPurpose, {
      transactionId,
      businessPurpose: REVISED,
    });

    const coding = await codingFor(s, transactionId);
    expect(coding?.businessPurpose).toBe(REVISED);
    // The whole reason this mutation exists rather than a call to `submit`.
    // `submitCoding` REPLACES the row, so a partial field set is a silent
    // deletion — and the deleted thing here would be the §274(d) element that
    // makes a meal substantiated at all.
    expect(coding?.expenseType).toBe("meal");
    expect(coding?.headcount).toBe(2);
    expect(coding?.attendees?.map((a) => a.name)).toEqual([
      "Ada Reyes",
      "Sam Oyelaran",
    ]);
  });

  test("travel keeps its route", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const transactionId = await seedTxn(s);

    await s.as.mutation(api.transactionCodings.submit, {
      transactionId,
      expenseType: "travel",
      businessPurpose: ORIGINAL,
      travelFrom: "Rosedale",
      travelTo: "Midtown",
    });

    await s.as.mutation(api.transactionCodings.setPurpose, {
      transactionId,
      businessPurpose: REVISED,
    });

    const coding = await codingFor(s, transactionId);
    expect(coding?.expenseType).toBe("travel");
    expect(coding?.travelFrom).toBe("Rosedale");
    expect(coding?.travelTo).toBe("Midtown");
    expect(coding?.businessPurpose).toBe(REVISED);
  });
});

describe("the narrow path is not a laxer path", () => {
  test("the length floor still bites", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const transactionId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId,
      expenseType: "general",
      businessPurpose: ORIGINAL,
    });

    await expect(
      s.as.mutation(api.transactionCodings.setPurpose, {
        transactionId,
        businessPurpose: "lunch",
      }),
    ).rejects.toThrow();

    // AND THE OLD SENTENCE IS STILL THERE. `submitCoding` validates before it
    // writes, so a refused edit must leave the record exactly as it was rather
    // than half-applied.
    const coding = await codingFor(s, transactionId);
    expect(coding?.businessPurpose).toBe(ORIGINAL);
  });

  test("an APPROVED coding is refused, and the message points at the send-back", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const author = await addAuthor(s);
    const transactionId = await seedTxn(s, { personId: author.personId });
    await author.as.mutation(api.transactionCodings.submit, {
      transactionId,
      expenseType: "general",
      businessPurpose: ORIGINAL,
    });
    await s.as.mutation(api.transactionCodings.approve, { transactionId });

    await expect(
      s.as.mutation(api.transactionCodings.setPurpose, {
        transactionId,
        businessPurpose: REVISED,
      }),
    ).rejects.toThrow(/reviewer/i);

    const coding = await codingFor(s, transactionId);
    expect(coding?.status).toBe("approved");
    expect(coding?.businessPurpose).toBe(ORIGINAL);
  });

  test("a row with NO coding is refused — there is no type to preserve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const transactionId = await seedTxn(s);

    // Inventing `general` for a restaurant charge would write a coding that
    // fails substantiation, from a control with nowhere to say who was there.
    // Those rows keep their route into the full sheet.
    await expect(
      s.as.mutation(api.transactionCodings.setPurpose, {
        transactionId,
        businessPurpose: REVISED,
      }),
    ).rejects.toThrow();

    expect(await codingFor(s, transactionId)).toBeNull();
  });
});

describe("the record reads as a revision", () => {
  test("an edit is an ordinary coding_submit round carrying the new sentence", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const transactionId = await seedTxn(s);
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId,
      expenseType: "general",
      businessPurpose: ORIGINAL,
    });
    await s.as.mutation(api.transactionCodings.setPurpose, {
      transactionId,
      businessPurpose: REVISED,
    });

    const entries = await run(s.t, (ctx) =>
      ctx.db
        .query("financeAuditLog")
        .filter((q) => q.eq(q.field("subjectId"), transactionId))
        .collect(),
    );
    const submits = entries.filter((e) => e.action === "coding_submit");
    expect(submits).toHaveLength(2);
    const edit = submits[submits.length - 1];
    // Carries the NEW sentence, exactly as a typed round does — this is what
    // makes the trail a readable revision history rather than a list of
    // undifferentiated writes.
    expect(edit.reason).toBe(REVISED);
    expect(edit.after).toBe("Resubmitted");
    expect(edit.actorPersonId).toBe(personId);
  });

  test("re-editing a sent-back coding puts it back in the reviewer's queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const author = await addAuthor(s);
    const transactionId = await seedTxn(s, { personId: author.personId });
    await author.as.mutation(api.transactionCodings.submit, {
      transactionId,
      expenseType: "general",
      businessPurpose: ORIGINAL,
    });
    await s.as.mutation(api.transactionCodings.requestChanges, {
      transactionId,
      reviewNote: "Say which project this served.",
    });

    await s.as.mutation(api.transactionCodings.setPurpose, {
      transactionId,
      businessPurpose: REVISED,
    });

    const coding = await codingFor(s, transactionId);
    // The send-back loop is an edit conversation, and answering it from the
    // grid has to land in the same place as answering it from the sheet.
    expect(coding?.status).toBe("submitted");
    const txn = await run(s.t, (ctx) => ctx.db.get(transactionId));
    expect(txn?.codingState).toBe("submitted");
  });
});

describe("the grid is told which rows may be edited", () => {
  test("listReconcile marks a submitted coding editable and an approved one not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const author = await addAuthor(s);
    const open = await seedTxn(s, { personId: author.personId });
    const locked = await seedTxn(s, { personId: author.personId });
    for (const transactionId of [open, locked]) {
      await author.as.mutation(api.transactionCodings.submit, {
        transactionId,
        expenseType: "general",
        businessPurpose: ORIGINAL,
      });
    }
    await s.as.mutation(api.transactionCodings.approve, {
      transactionId: locked,
    });

    const res = await s.as.query(api.finances.listReconcile, {});
    const rowFor = (id: Id<"transactions">) =>
      res.rows.find((r) => r.id === id);
    // The flag the cell reads to decide whether to offer a cursor. It must
    // track the CODING's status, not the row's — a locked sentence is locked
    // whatever else is true of the transaction.
    expect(rowFor(open)?.explanation?.editable).toBe(true);
    expect(rowFor(locked)?.explanation?.editable).toBe(false);
  });
});
