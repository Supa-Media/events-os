/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The reviewer-side digest: "codings are waiting on you."
 *
 * There was no manager-side notification of any kind before this — the review
 * loop's only email told the AUTHOR their coding came back. So the tests that
 * matter most here are the ones about restraint, because this is the one email
 * in the system that tells a small group about everybody else's work:
 *
 *  - BATCHED: one email per reviewer listing everything, never one per
 *    submission.
 *  - CAPPED per run, oldest-submitted first.
 *  - SEED-ONLY on first touch past the 30-day horizon, so arming it on a
 *    backlog stamps history silently instead of mailing months of it.
 *  - Never nudges anyone about a coding they wrote (they can't decide it).
 *  - Reaches the seats that can actually approve — including the two that
 *    carry `finance.approve` and NOT `finance.manager`, which the pre-existing
 *    manager-set enumeration would have skipped.
 */

const REMINDER_BATCH_LIMIT = 25; // mirrors cards.ts
const REMINDER_SEED_ONLY_DAYS = 30; // mirrors cards.ts

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
  opts: { pwEmail?: string; self?: boolean } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      pwEmail: opts.pwEmail,
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
      pwEmail: opts.email,
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

/** A submitted coding, `ageDays` old, on its own charge. */
async function seedSubmitted(
  s: ChapterSetup,
  opts: {
    ageDays?: number;
    authorPersonId?: Id<"people">;
    merchantName?: string;
    purpose?: string;
    book?: Id<"chapters"> | "central";
  } = {},
): Promise<Id<"transactionCodings">> {
  const book = opts.book ?? s.chapterId;
  const submittedAt = Date.now() - (opts.ageDays ?? 3) * DAY_MS;
  // Hoisted OUT of the insert's transaction: `storeBlob` opens its own
  // convex-test transaction, and starting one inside a running mutation
  // deadlocks (every test in this file timed out at 5s until this moved).
  const receiptStorageId = await storeBlob(s.t);
  const txnId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: book,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: submittedAt,
      merchantName: opts.merchantName ?? "Delta",
      status: "unreviewed",
      receiptStorageId,
      codingState: "submitted",
      createdAt: submittedAt,
    }),
  );
  const authorPersonId =
    opts.authorPersonId ?? (await seedPerson(s, "Casey Cardholder"));
  const authorUserId =
    (await run(s.t, (ctx) => ctx.db.get(authorPersonId)))?.userId ??
    (await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: `a-${authorPersonId}@test.local` }),
    ));
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactionCodings", {
      transactionId: txnId,
      chapterId: book,
      expenseType: "general",
      businessPurpose:
        opts.purpose ?? "Software subscription for the Eden event livestream",
      status: "submitted",
      codedByPersonId: authorPersonId,
      codedByUserId: authorUserId,
      submittedAt,
      updatedAt: submittedAt,
    }),
  );
}

/** Capture what Resend was asked to send. */
function captureEmails(): {
  sent: { to: string; subject: string; html: string }[];
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.RESEND_API_KEY;
  const prevAppUrl = process.env.APP_URL;
  process.env.RESEND_API_KEY = "resend_test_key";
  process.env.APP_URL = "https://app.publicworship.life";
  const sent: { to: string; subject: string; html: string }[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    sent.push({ to: body.to, subject: body.subject, html: body.html });
    return { ok: true, status: 200, text: async () => "{}" };
  }) as unknown as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
    },
  };
}

describe("advanceCodingReviewReminders — restraint", () => {
  test("a coding submitted TODAY isn't nudged — an hour old isn't late", async () => {
    const s = await seatSetup();
    await seedSubmitted(s, { ageDays: 0 });
    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(ids).toEqual([]);
  });

  test("stamps and returns a coding past the grace period", async () => {
    const s = await seatSetup();
    const codingId = await seedSubmitted(s, { ageDays: 3 });
    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(ids).toEqual([codingId]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(codingId)))?.reviewerRemindedAt,
    ).toBeGreaterThan(0);
  });

  test("IDEMPOTENT — the next morning's run doesn't re-nudge the same queue", async () => {
    const s = await seatSetup();
    await seedSubmitted(s, { ageDays: 3 });
    const first = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(first).toHaveLength(1);
    const second = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(second).toEqual([]);
  });

  test("re-nudges once the re-nudge window has passed", async () => {
    const s = await seatSetup();
    const codingId = await seedSubmitted(s, { ageDays: 3 });
    await s.t.mutation(internal.cards.advanceCodingReviewReminders, {});
    // Backdate the stamp past the 7-day window.
    await run(s.t, (ctx) =>
      ctx.db.patch(codingId, {
        reviewerRemindedAt: Date.now() - 8 * DAY_MS,
      }),
    );
    const again = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(again).toEqual([codingId]);
  });

  test("caps at REMINDER_BATCH_LIMIT per run, oldest submission first", async () => {
    const s = await seatSetup();
    const ids: Id<"transactionCodings">[] = [];
    for (let i = 0; i < REMINDER_BATCH_LIMIT + 5; i++) {
      // Newest first into the DB, so ordering can't come from insertion order.
      ids.push(await seedSubmitted(s, { ageDays: 2 + i * 0.01 }));
    }
    const batch = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(batch).toHaveLength(REMINDER_BATCH_LIMIT);
    // The 5 NEWEST are the ones left behind.
    expect(new Set(batch)).toEqual(new Set(ids.slice(5)));
    for (const id of ids.slice(0, 5)) {
      expect(
        (await run(s.t, (ctx) => ctx.db.get(id)))?.reviewerRemindedAt,
      ).toBeUndefined();
    }
  });

  test("NO BURST: a coding older than the seed-only horizon is stamped SILENTLY on first touch", async () => {
    const s = await seatSetup();
    const codingId = await seedSubmitted(s, {
      ageDays: REMINDER_SEED_ONLY_DAYS + 15,
    });
    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    // Not mailable…
    expect(ids).toEqual([]);
    // …but stamped, so it joins the normal cadence from here rather than
    // being suppressed forever.
    expect(
      (await run(s.t, (ctx) => ctx.db.get(codingId)))?.reviewerRemindedAt,
    ).toBeGreaterThan(0);
  });

  test("an approved coding is never in the queue at all", async () => {
    const s = await seatSetup();
    const codingId = await seedSubmitted(s, { ageDays: 5 });
    await run(s.t, (ctx) => ctx.db.patch(codingId, { status: "approved" }));
    expect(
      await s.t.mutation(internal.cards.advanceCodingReviewReminders, {}),
    ).toEqual([]);
  });
});

describe("getCodingReviewDigests — who hears about it", () => {
  test("ONE email per reviewer listing every waiting coding — never one per submission", async () => {
    const s = await seatSetup();
    await seedSubmitted(s, { ageDays: 3, merchantName: "Delta" });
    await seedSubmitted(s, { ageDays: 4, merchantName: "Amtrak" });
    await seedSubmitted(s, { ageDays: 5, merchantName: "Zoom" });

    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    const digests = await s.t.query(internal.cards.getCodingReviewDigests, {
      codingIds: ids,
    });
    expect(digests).toHaveLength(1);
    expect(digests[0].email).toBe("treasurer@publicworship.life");
    expect(digests[0].items).toHaveLength(3);
    expect(digests[0].items.map((i) => i.merchantName).sort()).toEqual([
      "Amtrak",
      "Delta",
      "Zoom",
    ]);
  });

  test("reaches an EXECUTIVE DIRECTOR — a seat with finance.approve and no finance.manager, which the manager-set enumeration would have skipped", async () => {
    const s = await seatSetup();
    await seedSubmitted(s, { ageDays: 3 });
    const ed = await addMember(s, {
      email: "ed@publicworship.life",
      name: "Eve ED",
    });
    await assignSeatDirect(s, ed.personId, "executive_director", "central");

    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    const digests = await s.t.query(internal.cards.getCodingReviewDigests, {
      codingIds: ids,
    });
    expect(digests.map((d) => d.email)).toContain("ed@publicworship.life");
  });

  test("reaches a CHAPTER DIRECTOR for their own chapter", async () => {
    const s = await seatSetup();
    await seedSubmitted(s, { ageDays: 3 });
    const cd = await addMember(s, {
      email: "cd@publicworship.life",
      name: "Cara CD",
    });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    const digests = await s.t.query(internal.cards.getCodingReviewDigests, {
      codingIds: ids,
    });
    expect(digests.map((d) => d.email)).toContain("cd@publicworship.life");
  });

  test("SEPARATION OF DUTIES: a reviewer is never told about a coding they wrote — and gets no email when that's the only one", async () => {
    const s = await seatSetup();
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);
    await seedSubmitted(s, { ageDays: 3, authorPersonId: tr.personId });

    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    expect(ids).toHaveLength(1);
    const digests = await s.t.query(internal.cards.getCodingReviewDigests, {
      codingIds: ids,
    });
    expect(digests).toEqual([]);
  });

  test("a coding decided between the sweep and the send is dropped, not mailed about", async () => {
    const s = await seatSetup();
    const codingId = await seedSubmitted(s, { ageDays: 3 });
    const tr = await addMember(s, {
      email: "treasurer@publicworship.life",
      name: "Tara Treasurer",
    });
    await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

    const ids = await s.t.mutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    await run(s.t, (ctx) => ctx.db.patch(codingId, { status: "approved" }));
    const digests = await s.t.query(internal.cards.getCodingReviewDigests, {
      codingIds: ids,
    });
    expect(digests).toEqual([]);
  });
});

describe("the digest email itself", () => {
  test("names the charges, quotes each purpose, and links to the Coding tab", async () => {
    const cap = captureEmails();
    try {
      const s = await seatSetup();
      await seedSubmitted(s, {
        ageDays: 4,
        merchantName: "Amtrak",
        purpose: "Travel to NY to film the Eden event with the team",
      });
      const tr = await addMember(s, {
        email: "treasurer@publicworship.life",
        name: "Tara Treasurer",
      });
      await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

      const res = await s.t.action(
        internal.cards.sendCodingReviewReminders,
        {},
      );
      expect(res).toEqual({ nudgedCodings: 1, reviewersEmailed: 1 });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].to).toBe("treasurer@publicworship.life");
      expect(cap.sent[0].subject).toBe("1 coding is waiting on your review");
      expect(cap.sent[0].html).toContain("Amtrak");
      expect(cap.sent[0].html).toContain(
        "Travel to NY to film the Eden event with the team",
      );
      expect(cap.sent[0].html).toMatch(
        /href="https:\/\/app\.publicworship\.life\/finances\/coding"/,
      );
    } finally {
      cap.restore();
    }
  });

  test("plural subject, and one email covering several codings", async () => {
    const cap = captureEmails();
    try {
      const s = await seatSetup();
      await seedSubmitted(s, { ageDays: 3, merchantName: "Delta" });
      await seedSubmitted(s, { ageDays: 4, merchantName: "Zoom" });
      const tr = await addMember(s, {
        email: "treasurer@publicworship.life",
        name: "Tara Treasurer",
      });
      await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

      const res = await s.t.action(
        internal.cards.sendCodingReviewReminders,
        {},
      );
      expect(res).toEqual({ nudgedCodings: 2, reviewersEmailed: 1 });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe("2 codings are waiting on your review");
    } finally {
      cap.restore();
    }
  });

  test("nothing waiting → no mutation churn, no email", async () => {
    const cap = captureEmails();
    try {
      const s = await seatSetup();
      const res = await s.t.action(
        internal.cards.sendCodingReviewReminders,
        {},
      );
      expect(res).toEqual({ nudgedCodings: 0, reviewersEmailed: 0 });
      expect(cap.sent).toEqual([]);
    } finally {
      cap.restore();
    }
  });

  test("degrades to a no-op without RESEND_API_KEY", async () => {
    const prev = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const s = await seatSetup();
      await seedSubmitted(s, { ageDays: 3 });
      const tr = await addMember(s, {
        email: "treasurer@publicworship.life",
        name: "Tara Treasurer",
      });
      await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);
      await expect(
        s.t.action(internal.cards.sendCodingReviewReminders, {}),
      ).resolves.toEqual({ nudgedCodings: 1, reviewersEmailed: 1 });
    } finally {
      if (prev === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });
});

describe("PRODUCTION SAFETY: the state this actually arms into", () => {
  test("six codings in one chapter, all submitted today, produce exactly zero emails on the first run", async () => {
    // This mirrors production as of 2026-08-09: `transactionCodings` holds 6
    // rows, all `submitted`, all in ONE chapter, all submitted within the
    // last day. The grace period alone means arming this mails nobody until
    // tomorrow — and tomorrow it is ONE email listing six lines.
    const cap = captureEmails();
    try {
      const s = await seatSetup();
      const author = await seedPerson(s, "Julie");
      for (let i = 0; i < 6; i++) {
        await seedSubmitted(s, {
          ageDays: 0,
          authorPersonId: author,
          merchantName: `Merchant ${i}`,
        });
      }
      const tr = await addMember(s, {
        email: "treasurer@publicworship.life",
        name: "Tara Treasurer",
      });
      await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

      expect(
        await s.t.action(internal.cards.sendCodingReviewReminders, {}),
      ).toEqual({ nudgedCodings: 0, reviewersEmailed: 0 });
      expect(cap.sent).toEqual([]);
    } finally {
      cap.restore();
    }
  });

  test("and once they age past the grace period it is ONE email with six lines, not six emails", async () => {
    const cap = captureEmails();
    try {
      const s = await seatSetup();
      const author = await seedPerson(s, "Julie");
      for (let i = 0; i < 6; i++) {
        await seedSubmitted(s, {
          ageDays: 2,
          authorPersonId: author,
          merchantName: `Merchant ${i}`,
        });
      }
      const tr = await addMember(s, {
        email: "treasurer@publicworship.life",
        name: "Tara Treasurer",
      });
      await assignSeatDirect(s, tr.personId, "treasurer", s.chapterId);

      const res = await s.t.action(
        internal.cards.sendCodingReviewReminders,
        {},
      );
      expect(res).toEqual({ nudgedCodings: 6, reviewersEmailed: 1 });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe("6 codings are waiting on your review");
    } finally {
      cap.restore();
    }
  });
});
