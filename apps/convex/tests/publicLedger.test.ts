/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * THE PUBLIC LEDGER — publishing the books, and being held to them.
 *
 * This suite pins the promises the feature makes to a stranger reading the
 * page. They are, in order of how badly a regression would hurt:
 *
 *  1. WHAT IS PUBLISHED IS FROZEN. Editing the live books after publication
 *     must not change one character of what the public sees. This is the
 *     whole design — a live page would let an edit silently rewrite the
 *     public record — so it is the first thing tested and the thing every
 *     other test is arranged around.
 *  2. A CORRECTION IS VISIBLE. An amendment publishes as revision N+1 with a
 *     dated, attributed, explained log entry, and revision N stays readable.
 *     A silent fix is the failure mode this feature exists to prevent.
 *  3. NAMES NEVER PUBLISH. Attendee and traveler names are internal forever
 *     (owner decision 2026-08-08 — some are minors). The published row must
 *     carry the headcount and the affiliation mix and nothing else, and that
 *     has to hold at the STORAGE layer, not just in a projection somebody
 *     could forget to apply.
 *  4. THE TOTALS DON'T DOUBLE-COUNT. Internal transfers and processor payout
 *     deposits publish as lines (the owner asked for "literally all the
 *     transactions") but count toward nothing, or the org's revenue appears
 *     twice — once when the gift was received and again when the bank
 *     deposit landed.
 *  5. NOTHING PUBLISHES BY ACCIDENT. Every lifecycle move is gated, an
 *     unreviewed month cannot go out, and an amendment cannot go out
 *     unexplained.
 */

// Mid-month so the Eastern-offset padding in the period scan cannot drift a
// fixture into a neighbouring month in either direction.
const AUG_2026 = Date.UTC(2026, 7, 14, 16);
const AUG_KEY = "2026-08";
const SEP_2026 = Date.UTC(2026, 8, 14, 16);

// `lib/superuser.ts`'s allowlist. A superuser is the only caller who may
// publish their own preparation (the solo-operator relaxation), so the suite
// needs one to drive the happy path without inventing a second human for
// every test — and a separate NON-superuser to prove the gate still bites.
const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function seedPerson(s: ChapterSetup, name = "Kansi"): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/** Give `personId` a seat at `scope` carrying `finance.publish` — the only
 *  thing that authorizes publication (`lib/publicLedgerAccess.ts`). */
async function seedPublishSeat(
  s: ChapterSetup,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central" = s.chapterId,
): Promise<void> {
  const seatDefId = await run(s.t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: `publisher_${personId}`,
      title: "Publisher",
      chart: "chapter",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities: ["finance.publish"],
      sortOrder: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

/** A superuser finance manager holding the publish seat — the solo operator
 *  the org actually is today, and the shortest path to a published month. */
async function asPublisher(): Promise<ChapterSetup> {
  const s = await setupChapter(newT(), { email: SUPERUSER_EMAIL });
  const personId = await seedPerson(s);
  await grantRole(s, personId, "manager", "central");
  await seedPublishSeat(s, personId, "central");
  return s;
}

type TxnFixture = Partial<{
  postedAt: number;
  amountCents: number;
  flow: "outflow" | "inflow" | "transfer";
  status: "unreviewed" | "categorized" | "reconciled" | "excluded";
  merchantName: string;
  payoutProcessor: "stripe" | "givebutter" | "other";
  preMarkFlow: "outflow" | "inflow";
  historicalImportBatch: string;
}>;

async function insertTxn(
  s: ChapterSetup,
  f: TxnFixture = {},
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: f.flow ?? "outflow",
      amountCents: f.amountCents ?? 1000,
      postedAt: f.postedAt ?? AUG_2026,
      status: f.status ?? "reconciled",
      merchantName: f.merchantName ?? "Costco",
      payoutProcessor: f.payoutProcessor,
      preMarkFlow: f.preMarkFlow,
      historicalImportBatch: f.historicalImportBatch,
      createdAt: Date.now(),
    }),
  );
}

/** An APPROVED coding — the only kind that publishes. `attendees` carries
 *  real names precisely so the privacy test has something that could leak. */
async function approveCoding(
  s: ChapterSetup,
  transactionId: Id<"transactions">,
  fields: {
    businessPurpose: string;
    publicPurpose?: string;
    headcount?: number;
    attendees?: { name: string; affiliation: string }[];
  },
): Promise<void> {
  await run(s.t, async (ctx) => {
    await ctx.db.insert("transactionCodings", {
      transactionId,
      chapterId: s.chapterId,
      expenseType: fields.attendees ? "meal" : "general",
      businessPurpose: fields.businessPurpose,
      publicPurpose: fields.publicPurpose,
      headcount: fields.headcount,
      attendees: fields.attendees as never,
      status: "approved",
      codedByUserId: s.userId,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(transactionId, { codingState: "approved" });
  });
}

/** Prepare → submit → publish, the whole happy path in one call. */
async function publishMonth(
  s: ChapterSetup,
  periodKey = AUG_KEY,
): Promise<{ revision: number }> {
  await s.as.mutation(api.publicLedger.submit, { periodKey });
  return s.as.mutation(api.publicLedger.publish, { periodKey });
}

const statementOf = (s: ChapterSetup, periodKey = AUG_KEY) =>
  s.as.query(api.publicLedger.publicStatement, { periodKey });

// ── 1. Frozen ────────────────────────────────────────────────────────────────

describe("what is published is frozen", () => {
  test("editing the live books after publication changes nothing public", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 4783, merchantName: "Costco" });
    await approveCoding(s, txnId, {
      businessPurpose: "Water and cups for the Sunday setup team",
    });
    await publishMonth(s);

    const before = await statementOf(s);
    expect(before).not.toBeNull();
    expect(before!.expenseCents).toBe(4783);
    expect(before!.entries[0].counterparty).toBe("Costco");

    // Now rewrite the live row underneath it — a different amount, a
    // different merchant, and a whole extra transaction in the same month.
    await run(s.t, (ctx) =>
      ctx.db.patch(txnId, { amountCents: 999_99, merchantName: "Somewhere else" }),
    );
    await insertTxn(s, { amountCents: 50_000, merchantName: "Late arrival" });

    const after = await statementOf(s);
    // Not one character moves. A live page would have published all three
    // edits to the world without anyone deciding to.
    expect(after!.expenseCents).toBe(4783);
    expect(after!.entries).toHaveLength(1);
    expect(after!.entries[0].counterparty).toBe("Costco");
    expect(after!.entries[0].amountCents).toBe(4783);
  });

  test("an unpublished month reads as null, never as zeros", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 1234 });
    // A page that rendered $0.00 for a month nobody has closed would be
    // stating something false with total confidence.
    expect(await statementOf(s)).toBeNull();
    expect(await statementOf(s, "2026-09")).toBeNull();
  });
});

// ── 2. Corrections are visible ───────────────────────────────────────────────

describe("a correction is published, not slipped in", () => {
  test("amending republishes as revision 2 and logs why", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 4783 });
    await approveCoding(s, txnId, { businessPurpose: "Water for the setup team" });
    expect((await publishMonth(s)).revision).toBe(1);

    await s.as.mutation(api.publicLedger.startAmendment, {
      periodKey: AUG_KEY,
      reason: "corrected_amount",
      note: "The Costco run was entered as $47.83; the receipt says $52.10.",
    });
    // The public keeps seeing revision 1 the entire time the correction is
    // being prepared — never a gap, never a half-edited draft.
    const midAmendment = await statementOf(s);
    expect(midAmendment!.expenseCents).toBe(4783);
    expect(midAmendment!.books[0].revision).toBe(1);

    await run(s.t, (ctx) => ctx.db.patch(txnId, { amountCents: 5210 }));
    expect((await publishMonth(s)).revision).toBe(2);

    const after = await statementOf(s);
    expect(after!.expenseCents).toBe(5210);
    expect(after!.books[0].revision).toBe(2);
    expect(after!.books[0].amendments).toHaveLength(1);
    expect(after!.books[0].amendments[0]).toMatchObject({
      revision: 2,
      reason: "corrected_amount",
    });
    expect(after!.books[0].amendments[0].note).toContain("$52.10");
  });

  test("revision 1's frozen rows survive the amendment, unchanged", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 4783 });
    await approveCoding(s, txnId, { businessPurpose: "Water for the setup team" });
    await publishMonth(s);
    await s.as.mutation(api.publicLedger.startAmendment, {
      periodKey: AUG_KEY,
      reason: "corrected_amount",
      note: "The Costco run was entered wrong; correcting it to the receipt.",
    });
    await run(s.t, (ctx) => ctx.db.patch(txnId, { amountCents: 5210 }));
    await publishMonth(s);

    // "What exactly did revision 1 say?" has to stay answerable forever —
    // that is the entire mechanism by which a correction is a correction
    // rather than a rewrite.
    const rev1 = await run(s.t, async (ctx) => {
      const rows = await ctx.db.query("financePublicationEntries").collect();
      return rows.filter((r) => r.revision === 1);
    });
    expect(rev1).toHaveLength(1);
    expect(rev1[0].amountCents).toBe(4783);
  });

  test("an amendment with no explanation is refused", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s);
    await approveCoding(s, txnId, { businessPurpose: "Supplies for the team" });
    await publishMonth(s);

    await expect(
      s.as.mutation(api.publicLedger.startAmendment, {
        periodKey: AUG_KEY,
        reason: "other",
        // "fixed" explains nothing, and an amendment log of "fixed" is worse
        // than no log — it looks like disclosure without being any.
        note: "fixed",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("there is no unpublish — a published month can only be amended", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s);
    await approveCoding(s, txnId, { businessPurpose: "Supplies for the team" });
    await publishMonth(s);
    // Withdrawing a statement already made is exactly the power a
    // transparency page gives up. The only move from `published` is `amend`.
    await expect(
      s.as.mutation(api.publicLedger.submit, { periodKey: AUG_KEY }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 3. Names never publish ───────────────────────────────────────────────────

describe("privacy holds at the storage layer", () => {
  test("attendee names are never written into a published row", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 18_000, merchantName: "Chipotle" });
    await approveCoding(s, txnId, {
      businessPurpose: "Dinner with the Sunday volunteer team",
      headcount: 12,
      attendees: [
        { name: "Michael Reid", affiliation: "team" },
        { name: "Ada Okafor", affiliation: "team" },
        { name: "Sam Ellis", affiliation: "community_member" },
      ],
    });
    await publishMonth(s);

    // Not "the projection drops it" — the frozen ROW must not contain it, so
    // no future reader of this table can leak what was never stored.
    const frozen = await run(s.t, (ctx) =>
      ctx.db.query("financePublicationEntries").collect(),
    );
    const serialized = JSON.stringify(frozen);
    expect(serialized).not.toContain("Michael Reid");
    expect(serialized).not.toContain("Ada Okafor");
    expect(serialized).not.toContain("Sam Ellis");

    // What DOES publish is the accountability answer: how many, and who they
    // were to us.
    const entry = (await statementOf(s))!.entries[0];
    expect(entry.headcount).toBe(12);
    expect(entry.affiliationMix).toEqual({ team: 2, community_member: 1 });
  });

  test("the approver's public rewrite wins over the author's own words", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s);
    await approveCoding(s, txnId, {
      // Real production text: a name typed into free text bypasses the
      // structured attendee protection entirely.
      businessPurpose: "Travel with Michael Reid from the all-team meeting",
      publicPurpose: "Travel from the all-team meeting in Manhattan",
    });
    await publishMonth(s);

    const entry = (await statementOf(s))!.entries[0];
    expect(entry.purpose).toBe("Travel from the all-team meeting in Manhattan");
    expect(entry.purpose).not.toContain("Michael Reid");
  });

  test("an unapproved coding does not publish its purpose", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("transactionCodings", {
        transactionId: txnId,
        chapterId: s.chapterId,
        expenseType: "general",
        businessPurpose: "Something nobody has reviewed yet",
        status: "submitted",
        codedByUserId: s.userId,
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(txnId, { codingState: "submitted" });
    });
    await publishMonth(s);

    // The row still publishes — hiding it would be worse — but it publishes
    // as an explicit gap rather than as an unreviewed assertion.
    const entry = (await statementOf(s))!.entries[0];
    expect(entry.purpose).toBeNull();
    expect((await statementOf(s))!.uncodedCount).toBe(1);
  });

  test("the giving roll carries no donor field at all", async () => {
    const s = await asPublisher();
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Jordan Blake",
        email: "jordan@example.com",
        status: "active",
        lifetimeCents: 5000,
        giftCount: 1,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("gifts", {
        donorId,
        scope: s.chapterId,
        amountCents: 5000,
        currency: "usd",
        receivedAt: AUG_2026,
        method: "stripe",
        createdAt: Date.now(),
      }),
    );
    await publishMonth(s);

    const frozen = await run(s.t, (ctx) =>
      ctx.db.query("financePublicationEntries").collect(),
    );
    expect(JSON.stringify(frozen)).not.toContain("Jordan Blake");
    expect(JSON.stringify(frozen)).not.toContain(donorId);

    const statement = (await statementOf(s))!;
    expect(statement.gifts).toHaveLength(1);
    expect(statement.gifts[0]).toMatchObject({ amountCents: 5000, method: "Card" });
    expect(statement.incomeCents).toBe(5000);
  });
});

// ── 4. Totals don't double-count ─────────────────────────────────────────────

describe("everything publishes; not everything counts", () => {
  test("a processor payout deposit is shown but adds nothing to income", async () => {
    const s = await asPublisher();
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "A Giver",
        status: "active",
        lifetimeCents: 10_000,
        giftCount: 1,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("gifts", {
        donorId,
        scope: s.chapterId,
        amountCents: 10_000,
        currency: "usd",
        receivedAt: AUG_2026,
        method: "stripe",
        createdAt: Date.now(),
      }),
    );
    // The same $100 arriving in the bank, marked as the Stripe settlement.
    await insertTxn(s, {
      flow: "inflow",
      amountCents: 10_000,
      payoutProcessor: "stripe",
      merchantName: "Stripe payout",
    });
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    // Counted ONCE, at the layer that earned it.
    expect(statement.incomeCents).toBe(10_000);
    // And the deposit is still on the page, marked, so the ledger is complete.
    const deposit = statement.entries.find((e) => e.counterparty === "Stripe payout");
    expect(deposit).toBeDefined();
    expect(deposit!.direction).toBe("internal");
    expect(deposit!.countsInTotals).toBe(false);
  });

  test("an intentionally excluded row does not publish at all", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 2500, merchantName: "Real charge" });
    await insertTxn(s, {
      amountCents: 9999,
      status: "excluded",
      merchantName: "Duplicate import",
    });
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    // An exclusion is the org asserting this is NOT a transaction. Publishing
    // it as one would be the opposite of clarifying.
    expect(statement.entries).toHaveLength(1);
    expect(statement.expenseCents).toBe(2500);
  });

  test("counted outflows sum exactly to the published expense total", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 1000 });
    await insertTxn(s, { amountCents: 2050 });
    await insertTxn(s, { flow: "transfer", preMarkFlow: "outflow", amountCents: 77_000 });
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    const summed = statement.entries
      .filter((e) => e.countsInTotals && e.direction === "out")
      .reduce((t, e) => t + e.amountCents, 0);
    // A reader can verify this from the CSV. If the two ever disagree, the
    // page is quietly hiding something.
    expect(summed).toBe(statement.expenseCents);
    expect(statement.expenseCents).toBe(3050);
  });

  test("rebuilt-from-records rows are counted AND disclosed", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 4000, historicalImportBatch: "genesis-2026-08" });
    await insertTxn(s, { amountCents: 1000 });
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    // Inside the totals, because they are genuinely part of the month —
    // never invisible, because "green" means something different for them.
    expect(statement.expenseCents).toBe(5000);
    expect(statement.reconstructedCount).toBe(1);
    expect(statement.reconstructedCents).toBe(4000);
    expect(statement.entries.filter((e) => e.reconstructed)).toHaveLength(1);
  });

  test("only the requested month publishes", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 1111, postedAt: AUG_2026 });
    await insertTxn(s, { amountCents: 2222, postedAt: SEP_2026 });
    await publishMonth(s, AUG_KEY);

    const statement = (await statementOf(s, AUG_KEY))!;
    expect(statement.expenseCents).toBe(1111);
    expect(await statementOf(s, "2026-09")).toBeNull();
  });
});

// ── 5. Nothing publishes by accident ─────────────────────────────────────────

describe("the lifecycle refuses shortcuts", () => {
  test("a month cannot be published without going through review", async () => {
    const s = await asPublisher();
    await insertTxn(s);
    await expect(
      s.as.mutation(api.publicLedger.publish, { periodKey: AUG_KEY }),
    ).rejects.toThrow(ConvexError);
  });

  test("a finance manager without the publish seat cannot publish", async () => {
    // Deliberately NOT a superuser: the seat is what authorizes publication,
    // and holding the whole finance ladder is not the same power.
    const s = await setupChapter(newT(), { email: "treasurer@publicworship.life" });
    const personId = await seedPerson(s, "Treasurer");
    await grantRole(s, personId, "manager", "central");
    await insertTxn(s);

    await s.as.mutation(api.publicLedger.submit, { periodKey: AUG_KEY });
    await expect(
      s.as.mutation(api.publicLedger.publish, { periodKey: AUG_KEY }),
    ).rejects.toThrow(ConvexError);
  });

  test("a non-superuser cannot publish their own preparation", async () => {
    const s = await setupChapter(newT(), { email: "cd@publicworship.life" });
    const personId = await seedPerson(s, "Chapter Director");
    await grantRole(s, personId, "manager", "central");
    await seedPublishSeat(s, personId, "central");
    await insertTxn(s);

    await s.as.mutation(api.publicLedger.submit, { periodKey: AUG_KEY });
    // Separation of duties: the reviewer must be a second pair of eyes.
    await expect(
      s.as.mutation(api.publicLedger.publish, { periodKey: AUG_KEY }),
    ).rejects.toThrow(ConvexError);
  });

  test("a superuser self-publish is allowed but RECORDED as single-party", async () => {
    const s = await asPublisher();
    await insertTxn(s);
    await publishMonth(s);

    const revision = await run(s.t, (ctx) =>
      ctx.db.query("financePublicationRevisions").first(),
    );
    // The solo-operator relaxation is a stated fact on every revision, so
    // that when there IS a second person, every past decision can be
    // re-reviewed for which kind it was.
    expect(revision!.approvalParty).toBe("single");
  });

  test("a malformed month is refused rather than coerced", async () => {
    const s = await asPublisher();
    for (const bad of ["2026-13", "2026-8", "august", ""]) {
      await expect(
        s.as.query(api.publicLedger.publicStatement, { periodKey: bad }),
      ).rejects.toThrow(ConvexError);
    }
  });

  test("sending a month back requires a note the preparer can act on", async () => {
    const s = await asPublisher();
    await insertTxn(s);
    await s.as.mutation(api.publicLedger.submit, { periodKey: AUG_KEY });
    await expect(
      s.as.mutation(api.publicLedger.requestChanges, {
        periodKey: AUG_KEY,
        note: "no",
      }),
    ).rejects.toThrow(ConvexError);

    await s.as.mutation(api.publicLedger.requestChanges, {
      periodKey: AUG_KEY,
      note: "The Costco line needs its receipt attached before this goes out.",
    });
    const console_ = await s.as.query(api.publicLedger.console_, {});
    const august = console_!.months.find((m) => m.periodKey === AUG_KEY);
    expect(august!.status).toBe("changes_requested");
    expect(august!.reviewNote).toContain("receipt");
  });
});

// ── The month picker ─────────────────────────────────────────────────────────

describe("published months", () => {
  test("only published months are listed, newest first", async () => {
    const s = await asPublisher();
    await insertTxn(s, { postedAt: AUG_2026 });
    await insertTxn(s, { postedAt: SEP_2026 });
    await publishMonth(s, AUG_KEY);
    expect(await s.as.query(api.publicLedger.publishedMonths, {})).toEqual([
      expect.objectContaining({ periodKey: AUG_KEY, bookCount: 1 }),
    ]);

    await publishMonth(s, "2026-09");
    const months = await s.as.query(api.publicLedger.publishedMonths, {});
    expect(months.map((m) => m.periodKey)).toEqual(["2026-09", AUG_KEY]);
  });
});
