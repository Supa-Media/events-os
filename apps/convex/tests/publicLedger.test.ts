/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PREVIEW_BANNER_TEXT } from "../lib/publicLedgerPage";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { CENTRAL } from "@events-os/shared";

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
      capabilities: ["finance.ledger.publish"],
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

/** The seatDef row seeded for a template `slug` — mirrors
 *  `financeGatesSeatUnion.test.ts#defBySlug`. */
async function defBySlug(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

/** Insert a `seatAssignments` row directly (bypassing `assignSeat`'s
 *  write-through, so no bridged `financeRoles` row comes along for free) —
 *  same shape as `financeGatesSeatUnion.test.ts#assignSeatDirect`. Used to
 *  prove the FIX-1 widening comes from the seat alone, not a stored grant. */
async function assignSeatDirect(
  s: ChapterSetup,
  personId: Id<"people">,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

// ── 1. Frozen ────────────────────────────────────────────────────────────────

describe("what is published is frozen", () => {
  test("editing the live books after publication changes nothing public", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 4783, merchantName: "Costco" });
    await approveCoding(s, txnId, {
      businessPurpose: "Water and cups for the WWS setup team",
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
      businessPurpose: "Dinner with the volunteer team",
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

  test("the console's default span reaches the book's earliest transaction, not a fixed 18 months", async () => {
    const s = await asPublisher();
    // Founder report, 2026-08-12: "coding publish only goes back March
    // 2025" — the old fixed 18-month default silently cut the calendar
    // while the genesis backfill reaches into 2024. The fixture sits 25
    // months back — outside that old window, inside the 60-month ceiling —
    // computed relative to the real clock so this can never rot into a
    // date-rollover flake (cards.test.ts's lesson), and mid-month so the
    // Eastern offset can't drift it into a neighbouring month.
    const now = new Date();
    const old = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 25, 14, 16);
    const d = new Date(old);
    const oldKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    await insertTxn(s, { postedAt: old });

    const c = await s.as.query(api.publicLedger.console_, {});
    expect(c!.months.some((m) => m.periodKey === oldKey)).toBe(true);
    expect(c!.months.length).toBeGreaterThan(18);

    // An explicit `months` arg still wins over the derived default.
    const explicit = await s.as.query(api.publicLedger.console_, { months: 3 });
    expect(explicit!.months).toHaveLength(3);
  });
});

// ── FIX 1: the ED/FM console+prepare widening ───────────────────────────────
// A founder-confirmed bug: the ED's (and, on their own book, the FM's) seat
// carries central reach and `finance.publish` but never a graded
// `financeRoles` ladder rank, so the pre-widening `requireLedgerConsole`/
// `requireLedgerPrepare` (which check `access.role`/`access.isManager` for
// the caller's OWN book — see `lib/publicLedgerAccess.ts`'s module doc)
// locked them out of the very console the design hands them. Every scenario
// below exercises the caller's OWN chapter book (`scope` omitted, so it
// defaults to `homeChapterId`) — the one branch that was broken; the CENTRAL/
// foreign-book branch already worked via `access.isCentral` and is unchanged.
describe("ED/FM console + prepare widening (own book, no financeRoles row)", () => {
  const consoleOf = (s: ChapterSetup) => s.as.query(api.publicLedger.console_, {});
  const prepare = (s: ChapterSetup) =>
    s.as.mutation(api.publicLedger.submit, { periodKey: AUG_KEY });

  test("a central executive_director seat (real seatAssignments row) reaches the console and can prepare their own chapter's book", async () => {
    const s = await setupChapter(newT(), { email: "ed@publicworship.life" });
    await run(s.t, (ctx) => runSeedSeatDefs(ctx));
    const personId = await seedPerson(s, "ED");
    await assignSeatDirect(s, personId, "executive_director", "central");
    await insertTxn(s);

    await expect(consoleOf(s)).resolves.toBeDefined();
    await expect(prepare(s)).resolves.toBeNull();
    const status = (await consoleOf(s))!.months.find((m) => m.periodKey === AUG_KEY);
    expect(status!.status).toBe("in_review");
  });

  test("an executive_director who exists only as a legacy specializedRoles row (no seatAssignments mirror) still reaches the console and can prepare — the drift `isCentralEdOrFm` covers", async () => {
    const s = await setupChapter(newT(), { email: "legacy-ed@publicworship.life" });
    const personId = await seedPerson(s, "Legacy ED");
    await run(s.t, (ctx) =>
      ctx.db.insert("specializedRoles", {
        personId,
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdAt: Date.now(),
      }),
    );
    await insertTxn(s);

    await expect(consoleOf(s)).resolves.toBeDefined();
    await expect(prepare(s)).resolves.toBeNull();
  });

  test("a central financial_manager seat reaches the console and can prepare their own chapter's book, with NO bridged central financeRoles grant", async () => {
    const s = await setupChapter(newT(), { email: "fm@publicworship.life" });
    await run(s.t, (ctx) => runSeedSeatDefs(ctx));
    const personId = await seedPerson(s, "FM");
    // Direct insert bypasses `assignSeat`'s write-through — no bridged
    // `financeRoles` grant comes along, unlike a real assignment. Proves the
    // widening comes from the seat itself, not the bridge.
    await assignSeatDirect(s, personId, "financial_manager", "central");
    await insertTxn(s);

    await expect(consoleOf(s)).resolves.toBeDefined();
    await expect(prepare(s)).resolves.toBeNull();
  });

  test("a chapter_director seat still sees the console (pre-existing viewer widening, unaffected) but still cannot prepare — not manager rank, and not ED/FM", async () => {
    const s = await setupChapter(newT(), { email: "cd@publicworship.life" });
    await run(s.t, (ctx) => runSeedSeatDefs(ctx));
    const personId = await seedPerson(s, "CD");
    await assignSeatDirect(s, personId, "chapter_director", s.chapterId);
    await insertTxn(s);

    await expect(consoleOf(s)).resolves.toBeDefined();
    await expect(prepare(s)).rejects.toThrow(ConvexError);
  });

  test("a plain member with no seat and no grant is denied both the console and prepare", async () => {
    const s = await setupChapter(newT(), { email: "nobody@publicworship.life" });
    await seedPerson(s, "No Grant");

    await expect(consoleOf(s)).rejects.toThrow(ConvexError);
    await expect(prepare(s)).rejects.toThrow(ConvexError);
  });

  test("a superuser reaches the console and can prepare with no seat and no grant at all — unchanged by the widening", async () => {
    const s = await setupChapter(newT(), { email: SUPERUSER_EMAIL });
    await seedPerson(s, "Superuser");
    await insertTxn(s);

    await expect(consoleOf(s)).resolves.toBeDefined();
    await expect(prepare(s)).resolves.toBeNull();
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

// ── The year rollup, budgets, and the people numbers ─────────────────────────

/** Insert a gift from a named donor. `identityKey` groups two donor rows into
 *  one person the way `donorIdentities` does in production, which is what the
 *  distinct-giver count has to respect. */
async function insertGift(
  s: ChapterSetup,
  opts: {
    donorName: string;
    amountCents: number;
    receivedAt: number;
    recurring?: boolean;
    identityId?: Id<"donorIdentities">;
  },
): Promise<void> {
  await run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: opts.donorName,
      status: "active",
      lifetimeCents: opts.amountCents,
      giftCount: 1,
      identityId: opts.identityId,
      createdAt: Date.now(),
    });
    const pledgeId = opts.recurring
      ? await ctx.db.insert("pledges", {
          donorId,
          scope: s.chapterId,
          amountCents: opts.amountCents,
          status: "active",
          origin: "stripe",
          createdAt: Date.now(),
        })
      : undefined;
    await ctx.db.insert("gifts", {
      donorId,
      scope: s.chapterId,
      amountCents: opts.amountCents,
      currency: "usd",
      receivedAt: opts.receivedAt,
      method: "stripe",
      pledgeId,
      createdAt: Date.now(),
    });
  });
}

const SEP_KEY = "2026-09";

describe("givers and backers are distinct PEOPLE", () => {
  test("one person giving four times is one giver, not four", async () => {
    const s = await asPublisher();
    const identityId = await run(s.t, (ctx) =>
      ctx.db.insert("donorIdentities", {
        key: "e:one@example.com",
        email: "one@example.com",
        name: "Weekly Giver",
        lifetimeCents: 0,
        giftCount: 0,
        scopes: [s.chapterId],
        createdAt: Date.now(),
      }),
    );
    // The same human, four donor rows, four gifts — the shape a weekly giver
    // produces, and the shape that inflates a headline number if you count
    // gifts and call them givers.
    for (const day of [2, 9, 16, 23]) {
      await insertGift(s, {
        donorName: "Weekly Giver",
        amountCents: 2500,
        receivedAt: Date.UTC(2026, 7, day, 16),
        identityId,
      });
    }
    await insertGift(s, {
      donorName: "Someone Else",
      amountCents: 10_000,
      receivedAt: AUG_2026,
    });
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    expect(statement.giftCount).toBe(5);
    expect(statement.giverCount).toBe(2);
  });

  test("a giver on a recurring pledge counts as a backer, once", async () => {
    const s = await asPublisher();
    const identityId = await run(s.t, (ctx) =>
      ctx.db.insert("donorIdentities", {
        key: "e:backer@example.com",
        email: "backer@example.com",
        name: "Monthly Backer",
        lifetimeCents: 0,
        giftCount: 0,
        scopes: [s.chapterId],
        createdAt: Date.now(),
      }),
    );
    // A monthly pledge AND a one-off from the same person: one giver, one
    // backer — not two of either.
    await insertGift(s, {
      donorName: "Monthly Backer",
      amountCents: 5000,
      receivedAt: AUG_2026,
      recurring: true,
      identityId,
    });
    await insertGift(s, {
      donorName: "Monthly Backer",
      amountCents: 2000,
      receivedAt: Date.UTC(2026, 7, 20, 16),
      identityId,
    });
    await insertGift(s, {
      donorName: "One Off",
      amountCents: 1000,
      receivedAt: AUG_2026,
    });
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    expect(statement.giverCount).toBe(2);
    expect(statement.backerCount).toBe(1);
  });

  test("giver identities are never returned to a public caller", async () => {
    const s = await asPublisher();
    await insertGift(s, {
      donorName: "Private Person",
      amountCents: 5000,
      receivedAt: AUG_2026,
    });
    await publishMonth(s);
    // The keys table exists and holds an identity — and no public payload
    // anywhere carries it.
    const keys = await run(s.t, (ctx) =>
      ctx.db.query("financePublicationGiverKeys").collect(),
    );
    expect(keys).toHaveLength(1);
    const statement = (await statementOf(s))!;
    expect(JSON.stringify(statement)).not.toContain(keys[0].key);
    expect(JSON.stringify(statement)).not.toContain("Private Person");
  });
});

describe("the year rollup", () => {
  test("adds the published months and says which they were", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 1000, postedAt: AUG_2026 });
    await insertTxn(s, { amountCents: 2500, postedAt: SEP_2026 });
    await publishMonth(s, AUG_KEY);
    await publishMonth(s, SEP_KEY);

    const year = await s.as.query(api.publicLedger.publicYearStatement, {
      year: "2026",
    });
    expect(year).not.toBeNull();
    expect(year!.expenseCents).toBe(3500);
    // A year missing ten months must never read like a whole one.
    expect(year!.months).toEqual([AUG_KEY, SEP_KEY]);
  });

  test("distinct givers are UNIONED across months, never summed", async () => {
    const s = await asPublisher();
    const identityId = await run(s.t, (ctx) =>
      ctx.db.insert("donorIdentities", {
        key: "e:faithful@example.com",
        email: "faithful@example.com",
        name: "Faithful",
        lifetimeCents: 0,
        giftCount: 0,
        scopes: [s.chapterId],
        createdAt: Date.now(),
      }),
    );
    // Same person gives in both months; a second person gives in one.
    await insertGift(s, {
      donorName: "Faithful",
      amountCents: 5000,
      receivedAt: AUG_2026,
      identityId,
    });
    await insertGift(s, {
      donorName: "Faithful",
      amountCents: 5000,
      receivedAt: SEP_2026,
      identityId,
    });
    await insertGift(s, {
      donorName: "August Only",
      amountCents: 1000,
      receivedAt: AUG_2026,
    });
    await publishMonth(s, AUG_KEY);
    await publishMonth(s, SEP_KEY);

    const aug = (await statementOf(s, AUG_KEY))!;
    const sep = (await statementOf(s, SEP_KEY))!;
    expect(aug.giverCount).toBe(2);
    expect(sep.giverCount).toBe(1);

    const year = await s.as.query(api.publicLedger.publicYearStatement, {
      year: "2026",
    });
    // Adding the monthly counts would say 3. There are 2 people.
    expect(year!.giverCount).toBe(2);
  });

  test("carries no lines by default, and says so", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 1000, postedAt: AUG_2026 });
    await publishMonth(s, AUG_KEY);

    const year = (await s.as.query(api.publicLedger.publicYearStatement, {
      year: "2026",
    }))!;
    // A year is thousands of rows; the page is summary-level and points at
    // the months and the CSV rather than rendering them.
    expect(year.entries).toHaveLength(0);
    expect(year.entriesTruncated).toBe(true);
    expect(year.entryCount).toBe(1);

    // ...and the CSV path asks for them explicitly.
    const forCsv = (await s.as.query(api.publicLedger.publicYearStatement, {
      year: "2026",
      entryLimit: 5000,
    }))!;
    expect(forCsv.entries).toHaveLength(1);
    expect(forCsv.entriesTruncated).toBe(false);
  });

  test("an unpublished year reads as null, and a malformed one is refused", async () => {
    const s = await asPublisher();
    expect(
      await s.as.query(api.publicLedger.publicYearStatement, { year: "2019" }),
    ).toBeNull();
    for (const bad of ["20260", "26", "twenty-twenty-six", "2026-08"]) {
      await expect(
        s.as.query(api.publicLedger.publicYearStatement, { year: bad }),
      ).rejects.toThrow(ConvexError);
    }
  });

  test("published years drive the dropdown, newest first", async () => {
    const s = await asPublisher();
    await insertTxn(s, { postedAt: AUG_2026 });
    await insertTxn(s, { postedAt: Date.UTC(2025, 4, 14, 16) });
    await publishMonth(s, AUG_KEY);
    await publishMonth(s, "2025-05");

    expect(await s.as.query(api.publicLedger.publishedYears, {})).toEqual([
      { year: "2026", monthCount: 1 },
      { year: "2025", monthCount: 1 },
    ]);
  });
});

describe("spend against the plan", () => {
  /** A budget with an approved cap — what the public page compares against. */
  async function insertBudget(
    s: ChapterSetup,
    label: string,
    amountCents: number,
  ): Promise<Id<"budgets">> {
    return run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents,
        label,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        month: 8,
        approvalStatus: "approved",
        approvedCents: amountCents,
        createdAt: Date.now(),
      }),
    );
  }

  test("publishes what each budget was allowed and what it used", async () => {
    const s = await asPublisher();
    const budgetId = await insertBudget(s, "Production gear", 100_000);
    const txnId = await insertTxn(s, { amountCents: 89_900 });
    await run(s.t, (ctx) => ctx.db.patch(txnId, { budgetId }));
    await publishMonth(s);

    const statement = (await statementOf(s))!;
    expect(statement.spendByBudget).toEqual([
      {
        label: "Production gear",
        allocatedCents: 100_000,
        spentCents: 89_900,
        count: 1,
      },
    ]);
  });

  test("unbudgeted spend is published plainly, with no allocation", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 6_500 });
    await publishMonth(s);

    const row = (await statementOf(s))!.spendByBudget[0];
    // "We did not budget this" and "we budgeted $0 for this" are different
    // statements; only the first is being made.
    expect(row.label).toBe("Not attached to a budget");
    expect(row.allocatedCents).toBeNull();
    expect(row.spentCents).toBe(6_500);
  });

  test("a year sums spend per budget, and drops allocations it can't add", async () => {
    const s = await asPublisher();
    const budgetId = await insertBudget(s, "Production gear", 100_000);
    const aug = await insertTxn(s, { amountCents: 40_000, postedAt: AUG_2026 });
    await run(s.t, (ctx) => ctx.db.patch(aug, { budgetId }));
    // September's charge hits the same budget by label but carries no budget
    // link, so the year has one row with spend from both and NO allocation —
    // adding a known cap to an unknown one would publish a wrong plan figure.
    await insertTxn(s, { amountCents: 15_000, postedAt: SEP_2026 });
    await publishMonth(s, AUG_KEY);
    await publishMonth(s, SEP_KEY);

    const year = (await s.as.query(api.publicLedger.publicYearStatement, {
      year: "2026",
    }))!;
    const gear = year.spendByBudget.find((b) => b.label === "Production gear");
    expect(gear).toMatchObject({ allocatedCents: 100_000, spentCents: 40_000 });
    const unbudgeted = year.spendByBudget.find(
      (b) => b.label === "Not attached to a budget",
    );
    expect(unbudgeted).toMatchObject({ allocatedCents: null, spentCents: 15_000 });
  });
});

// ── Publishing history (2024/2025 backfill) ─────────────────────────────────

describe("a pre-policy month discloses what a reader can see", () => {
  /** Pin the coding policy to its real default so pre-policy history behaves
   *  here the way it will in production. */
  async function pinPolicy(s: ChapterSetup): Promise<void> {
    await run(s.t, async (ctx) => {
      const existing = await ctx.db.query("financeSettings").first();
      const sinceMs = Date.UTC(2026, 7, 8);
      if (existing) {
        await ctx.db.patch(existing._id, { codingRequiredSinceMs: sinceMs });
        return;
      }
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        codingRequiredSinceMs: sinceMs,
      });
    });
  }

  test("grandfathered rows report ZERO uncoded and every line unexplained", async () => {
    const s = await asPublisher();
    await pinPolicy(s);
    // Three reconstructed 2024 charges, the shape the genesis backfill leaves.
    for (const amount of [4_000, 2_500, 1_200]) {
      await insertTxn(s, {
        amountCents: amount,
        postedAt: Date.UTC(2024, 5, 14, 16),
        historicalImportBatch: "genesis-2024",
      });
    }
    await publishMonth(s, "2024-06");

    const statement = (await statementOf(s, "2024-06"))!;
    // The policy asks nothing of pre-policy spend, so the POLICY gap is zero...
    expect(statement.uncodedCount).toBe(0);
    // ...but every row on the page reads "no published explanation", and the
    // disclosure has to say so. Reporting the policy number here would leave
    // the page silent about its single most visible property.
    expect(statement.unexplainedCount).toBe(3);
    expect(statement.unexplainedCents).toBe(7_700);
    expect(statement.reconstructedCount).toBe(3);
    expect(statement.entries.every((e) => e.purpose === null)).toBe(true);
  });

  test("a coded historical row publishes its explanation and leaves the gap", async () => {
    const s = await asPublisher();
    await pinPolicy(s);
    const explained = await insertTxn(s, {
      amountCents: 4_000,
      postedAt: Date.UTC(2024, 5, 14, 16),
      merchantName: "U-Haul",
    });
    // Coding a pre-policy row is allowed even though nothing requires it —
    // and it is the highest-leverage thing anyone can do to a historical
    // month, because the explanation publishes.
    await approveCoding(s, explained, {
      businessPurpose: "Van to move gear for the June outdoor night",
    });
    await insertTxn(s, { amountCents: 2_500, postedAt: Date.UTC(2024, 5, 20, 16) });
    await publishMonth(s, "2024-06");

    const statement = (await statementOf(s, "2024-06"))!;
    expect(statement.unexplainedCount).toBe(1);
    const coded = statement.entries.find((e) => e.counterparty === "U-Haul");
    expect(coded!.purpose).toBe("Van to move gear for the June outdoor night");
  });

  test("an internal movement is not counted as a missing explanation", async () => {
    const s = await asPublisher();
    await pinPolicy(s);
    await insertTxn(s, {
      flow: "inflow",
      amountCents: 50_000,
      payoutProcessor: "stripe",
      postedAt: Date.UTC(2024, 5, 14, 16),
    });
    await publishMonth(s, "2024-06");

    const statement = (await statementOf(s, "2024-06"))!;
    // A transfer between our own accounts has no business purpose to give.
    // Counting it would inflate the gap with rows that are complete.
    expect(statement.unexplainedCount).toBe(0);
    expect(statement.entries[0].direction).toBe("internal");
  });
});

// ── The month coding worklist (the backfill workbench's data) ────────────────

describe("the console preview answers at all", () => {
  // THE TEST THAT WAS MISSING. #642 added `unexplainedCount`/`unexplainedCents`
  // to the snapshot and to `publish`'s validator but not to `preview`'s — and
  // since `totalsOf` spreads the whole snapshot, `preview` failed its own
  // returns validation on EVERY call, for every account, every month, empty
  // or not. Nothing in this suite ever simply CALLED preview, so 60+ green
  // tests coexisted with a publish console that could not open (the founder's
  // night-long "Restricted", 2026-08-11/12 — a validator crash wearing denial
  // copy). These stay deliberately shallow: their job is to fail the moment
  // the snapshot and the validator drift apart again.
  test("preview returns totals for a month with lines", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 4_783 });
    const totals = await s.as.query(api.publicLedger.preview, {
      periodKey: AUG_KEY,
    });
    expect(totals).not.toBeNull();
    expect(totals?.unexplainedCount).toBe(1);
    expect(totals?.unexplainedCents).toBe(4_783);
  });

  test("preview returns totals for an empty month too", async () => {
    const s = await asPublisher();
    const totals = await s.as.query(api.publicLedger.preview, {
      periodKey: AUG_KEY,
    });
    expect(totals).not.toBeNull();
    expect(totals?.entryCount).toBe(0);
    expect(totals?.unexplainedCount).toBe(0);
  });
});

describe("explaining a month", () => {
  const worklist = (s: ChapterSetup, periodKey: string) =>
    s.as.query(api.finances.monthCodingWorklist, { periodKey });

  test("surfaces pre-policy rows the other coding surfaces cannot reach", async () => {
    const s = await asPublisher();
    // A genesis-backfilled row: no `personId` (so `personTransactions` can
    // never show it), reconciled and pre-policy (so the reconcile grid's
    // `uncoded` facet and `chargeTodo` both call it settled). It still
    // publishes blank, which is the only thing this worklist cares about.
    await insertTxn(s, {
      amountCents: 4_000,
      postedAt: Date.UTC(2024, 5, 14, 16),
      status: "reconciled",
      historicalImportBatch: "genesis-2024",
      merchantName: "U-Haul",
    });

    const list = (await worklist(s, "2024-06"))!;
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].merchantName).toBe("U-Haul");
    expect(list.totalCount).toBe(1);
    expect(list.explainedCount).toBe(0);
  });

  test("orders biggest first — the top of the list is most of the money", async () => {
    const s = await asPublisher();
    for (const amount of [500, 89_900, 4_000]) {
      await insertTxn(s, { amountCents: amount, postedAt: Date.UTC(2024, 5, 14, 16) });
    }
    const list = (await worklist(s, "2024-06"))!;
    expect(list.rows.map((r) => r.amountCents)).toEqual([89_900, 4_000, 500]);
  });

  test("an approved coding leaves the list and lands in the progress figure", async () => {
    const s = await asPublisher();
    const done = await insertTxn(s, {
      amountCents: 10_000,
      postedAt: Date.UTC(2024, 5, 14, 16),
    });
    await insertTxn(s, { amountCents: 2_000, postedAt: Date.UTC(2024, 5, 15, 16) });
    await approveCoding(s, done, { businessPurpose: "Van to move gear in June" });

    const list = (await worklist(s, "2024-06"))!;
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].amountCents).toBe(2_000);
    expect(list.explainedCount).toBe(1);
    expect(list.explainedCents).toBe(10_000);
    expect(list.totalCount).toBe(2);
    expect(list.totalCents).toBe(12_000);
  });

  test("internal movements and excluded rows are never asked about", async () => {
    const s = await asPublisher();
    // A payout deposit: real, published, and with no business purpose to give.
    await insertTxn(s, {
      flow: "inflow",
      amountCents: 50_000,
      payoutProcessor: "stripe",
      postedAt: Date.UTC(2024, 5, 14, 16),
    });
    // An intentional exclusion never publishes at all.
    await insertTxn(s, {
      amountCents: 9_999,
      status: "excluded",
      postedAt: Date.UTC(2024, 5, 15, 16),
    });
    const list = (await worklist(s, "2024-06"))!;
    expect(list.rows).toHaveLength(0);
    expect(list.totalCount).toBe(0);
  });

  test("only the requested month, and a malformed one is refused", async () => {
    const s = await asPublisher();
    await insertTxn(s, { amountCents: 1_000, postedAt: Date.UTC(2024, 5, 14, 16) });
    await insertTxn(s, { amountCents: 2_000, postedAt: Date.UTC(2024, 6, 14, 16) });
    expect((await worklist(s, "2024-06"))!.rows).toHaveLength(1);
    expect((await worklist(s, "2024-07"))!.rows).toHaveLength(1);
    await expect(worklist(s, "2024-6")).rejects.toThrow(ConvexError);
  });

  test("a caller with no finance grant cannot read a book's month", async () => {
    const s = await setupChapter(newT(), { email: "nobody@publicworship.life" });
    await seedPerson(s, "No Grant");
    await insertTxn(s, { amountCents: 1_000, postedAt: Date.UTC(2024, 5, 14, 16) });
    await expect(worklist(s, "2024-06")).rejects.toThrow(ConvexError);
  });

  // ── FIX 2: a zero-row resolved book must never read as "fully explained" ──
  // The founder-confirmed bug: a central-reach caller defaults to the central
  // desk, but ALL of 2024/2025's genesis-imported history lives on the New
  // York chapter's book (`financeGenesisBackfill.ts`, deliberately not
  // "central"). Central's book is genuinely empty for those months, which
  // this suite pins as `totalCount === 0` and — the fix — a populated
  // `otherBooks` list saying where the real rows are.
  describe("otherBooks — the 'switch desks' nudge for a central-reach caller", () => {
    test("a central-reach caller resolving to an EMPTY central book sees where the unexplained rows actually are", async () => {
      const s = await asPublisher(); // superuser: central reach, home chapter "New York"
      await insertTxn(s, {
        amountCents: 4_000,
        postedAt: Date.UTC(2024, 5, 14, 16),
        historicalImportBatch: "genesis-2024",
        merchantName: "U-Haul",
      });

      // The central book itself has nothing — exactly the false-positive
      // scenario: this must read as "central has nothing", not "done".
      const central = (await s.as.query(api.finances.monthCodingWorklist, {
        periodKey: "2024-06",
        scope: CENTRAL,
      }))!;
      expect(central.totalCount).toBe(0);
      expect(central.rows).toHaveLength(0);

      expect(central.otherBooks).toBeDefined();
      const nyRow = central.otherBooks!.find((b) => b.scopeName === "New York");
      expect(nyRow).toBeDefined();
      expect(nyRow!.totalCount).toBe(1);
      expect(nyRow!.scope).toBe(s.chapterId);
    });

    test("a chapter-only caller (no central reach) never gets an otherBooks list", async () => {
      const s = await setupChapter(newT(), { email: "treasurer2@publicworship.life" });
      const personId = await seedPerson(s, "Chapter Treasurer");
      await grantRole(s, personId, "manager"); // chapter-scoped only, no central grant
      await insertTxn(s, { amountCents: 1_000, postedAt: Date.UTC(2024, 5, 14, 16) });

      const list = (await worklist(s, "2024-06"))!;
      expect(list.otherBooks).toBeUndefined();
    });

    test("otherBooks omits books with nothing unexplained this month and sorts the rest biggest-first", async () => {
      const s = await asPublisher(); // home chapter "New York"
      const austinId = await run(s.t, (ctx) =>
        ctx.db.insert("chapters", {
          name: "Austin",
          isActive: true,
          createdAt: Date.now(),
        }),
      );
      // Chicago exists (an active book) but gets no transactions this month —
      // it must be OMITTED from `otherBooks`, not listed at zero.
      await run(s.t, (ctx) =>
        ctx.db.insert("chapters", {
          name: "Chicago",
          isActive: true,
          createdAt: Date.now(),
        }),
      );
      // New York: one unexplained line.
      await insertTxn(s, { amountCents: 1_000, postedAt: Date.UTC(2024, 5, 14, 16) });
      // Austin: two unexplained lines — should sort ABOVE New York.
      await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: austinId,
          source: "manual",
          flow: "outflow",
          amountCents: 2_000,
          postedAt: Date.UTC(2024, 5, 15, 16),
          status: "reconciled",
          merchantName: "Austin Vendor A",
          createdAt: Date.now(),
        }),
      );
      await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: austinId,
          source: "manual",
          flow: "outflow",
          amountCents: 3_000,
          postedAt: Date.UTC(2024, 5, 16, 16),
          status: "reconciled",
          merchantName: "Austin Vendor B",
          createdAt: Date.now(),
        }),
      );
      const central = (await s.as.query(api.finances.monthCodingWorklist, {
        periodKey: "2024-06",
        scope: CENTRAL,
      }))!;
      expect(central.otherBooks).toBeDefined();
      const names = central.otherBooks!.map((b) => b.scopeName);
      expect(names).toContain("Austin");
      expect(names).toContain("New York");
      expect(names).not.toContain("Chicago");
      expect(central.otherBooks!.findIndex((b) => b.scopeName === "Austin")).toBeLessThan(
        central.otherBooks!.findIndex((b) => b.scopeName === "New York"),
      );
    });
  });
});

// ── The full-page draft preview ──────────────────────────────────────────────
// `?preview=<token>` (`http.ts`) — the publish console's "see the full page
// before you publish" button. Everything here is about the one property that
// matters: a stranger with the URL but no token learns nothing, and a
// publisher with a token sees EXACTLY what publishing right now would put in
// front of that stranger — built from the live books, never written anywhere.

describe("the full-page draft preview", () => {
  test("minting a preview token requires console access", async () => {
    // A plain chapter member — no finance role, no finance seat, nothing
    // `requireLedgerConsole` recognizes.
    const s = await setupChapter(newT(), { email: "nobody@publicworship.life" });
    await expect(
      s.as.mutation(api.publicLedger.mintLedgerPreviewToken, {
        periodKey: AUG_KEY,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a valid token renders the live, unpublished month — including a draft-only line", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, {
      amountCents: 4783,
      merchantName: "Costco Wholesale",
    });
    await approveCoding(s, txnId, {
      businessPurpose: "Water and cups for the WWS setup team",
    });
    // Never submitted, never published — this line exists only in the live
    // books. A preview built from `financePublicationEntries` (there are
    // none) would render an empty month instead.
    const { token } = await s.as.mutation(api.publicLedger.mintLedgerPreviewToken, {
      periodKey: AUG_KEY,
    });

    const res = await s.t.fetch(`/finances/${AUG_KEY}?preview=${token}`, {});
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Costco Wholesale");
    expect(body).toContain(PREVIEW_BANNER_TEXT);
    expect(body).toContain('<meta name="robots" content="noindex">');
    // Never cached — a draft preview must not be served stale to a second
    // viewer of the same link.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("a garbage token, and a real token past its expiry, both 404 with no page", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { merchantName: "Costco" });
    await approveCoding(s, txnId, { businessPurpose: "Supplies" });
    const { token } = await s.as.mutation(api.publicLedger.mintLedgerPreviewToken, {
      periodKey: AUG_KEY,
    });

    const garbage = await s.t.fetch(
      `/finances/${AUG_KEY}?preview=not-a-real-token`,
      {},
    );
    expect(garbage.status).toBe(404);
    expect(await garbage.text()).not.toContain("Costco");

    // A token minted for August must not render September, or vice versa —
    // a token is single-scope+period, not a general bypass.
    const wrongPeriod = await s.t.fetch(`/finances/2026-09?preview=${token}`, {});
    expect(wrongPeriod.status).toBe(404);

    await run(s.t, async (ctx) => {
      const row = await ctx.db.query("financePublicationPreviewTokens").first();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    const expired = await s.t.fetch(`/finances/${AUG_KEY}?preview=${token}`, {});
    expect(expired.status).toBe(404);
    expect(await expired.text()).not.toContain("Costco");
  });

  test("a preview token never reaches a publicly-cacheable 404, even off an early-reject branch", async () => {
    // Regression for a MEDIUM finding: four early-reject branches (empty/
    // too-many path segments, an unrecognized sub-path, a malformed period,
    // giving.csv on a year) used to 404 through the PUBLIC `notFound`
    // (`Cache-Control: public, max-age=60`) before the handler ever looked
    // at `?preview=` — putting a live preview token's URL into a
    // publicly-cacheable response. Both proven URLs, pinned here.
    const s = await asPublisher();
    const { token } = await s.as.mutation(api.publicLedger.mintLedgerPreviewToken, {
      periodKey: AUG_KEY,
    });

    // An unrecognized sub-path — `sub != null && !wantsGivingCsv`.
    const bogusSub = await s.t.fetch(
      `/finances/${AUG_KEY}/bogus?preview=${token}`,
      {},
    );
    expect(bogusSub.status).toBe(404);
    expect(bogusSub.headers.get("cache-control")).toBe("no-store, private");

    // The bare `/finances/` (trailing slash, no period at all) — the
    // "empty raw" early-reject branch.
    const bare = await s.t.fetch(`/finances/?preview=${token}`, {});
    expect(bare.status).toBe(404);
    expect(bare.headers.get("cache-control")).toBe("no-store, private");
  });

  test("the public published route is unaffected — no banner, and the public cache header", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { merchantName: "Costco" });
    await approveCoding(s, txnId, { businessPurpose: "Supplies for the team" });
    await publishMonth(s);

    const res = await s.t.fetch(`/finances/${AUG_KEY}`, {});
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(PREVIEW_BANNER_TEXT);
    expect(body).not.toContain('name="robots"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("minting and viewing a preview writes no publication, revision, or entry row", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 4783 });
    await approveCoding(s, txnId, { businessPurpose: "Snacks for the team" });

    const { token } = await s.as.mutation(api.publicLedger.mintLedgerPreviewToken, {
      periodKey: AUG_KEY,
    });
    await s.t.fetch(`/finances/${AUG_KEY}?preview=${token}`, {});

    const [pubs, revisions, entries] = await Promise.all([
      run(s.t, (ctx) => ctx.db.query("financePublications").collect()),
      run(s.t, (ctx) => ctx.db.query("financePublicationRevisions").collect()),
      run(s.t, (ctx) => ctx.db.query("financePublicationEntries").collect()),
    ]);
    expect(pubs).toHaveLength(0);
    expect(revisions).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });
});

// ── "Chapter," not "Book" ────────────────────────────────────────────────────
// Founder directive (2026-08-12): the public page should read in chapter
// language — "Central / New York / Chicago" as a plain column — not the
// internal accounting term "book." Recon confirmed every
// `financePublicationEntries` row already carries a frozen `bookLabel`, and
// the month/year pages already merge every published book into one
// statement, so this is a render + copy sweep, not a data change: the tests
// below pin the RENDER (one merged table, a dedicated Chapter column, no
// double-printed name) and the COPY (the partial-coverage disclosure and the
// CSV header) rather than anything about the underlying data model.

/** Publish an explicit `scope`'s book for `periodKey` — `publishMonth`'s
 *  sibling for tests that need to publish a NON-home-chapter book (Central,
 *  or a second chapter) on the same caller. */
async function publishScope(
  s: ChapterSetup,
  scope: "central" | Id<"chapters">,
  periodKey = AUG_KEY,
): Promise<{ revision: number }> {
  await s.as.mutation(api.publicLedger.submit, { scope, periodKey });
  return s.as.mutation(api.publicLedger.publish, { scope, periodKey });
}

describe("the public page speaks in chapters", () => {
  test("a two-book published month renders ONE table, both books' rows each carrying their own Chapter cell", async () => {
    const s = await asPublisher(); // superuser: reaches every book; home chapter "New York"

    // New York's own book.
    const nyTxnId = await insertTxn(s, {
      amountCents: 1200,
      merchantName: "NY Hardware Co",
    });
    await approveCoding(s, nyTxnId, { businessPurpose: "Chairs for the Sunday setup" });
    await publishScope(s, s.chapterId, AUG_KEY);

    // Central's book, same month.
    const centralTxnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: "outflow",
        amountCents: 3400,
        postedAt: AUG_2026,
        status: "reconciled",
        merchantName: "Central Ops Supply",
        createdAt: Date.now(),
      }),
    );
    await approveCoding(s, centralTxnId, { businessPurpose: "Printer paper for HQ" });
    await publishScope(s, CENTRAL, AUG_KEY);

    const res = await s.t.fetch(`/finances/${AUG_KEY}`, {});
    expect(res.status).toBe(200);
    const body = await res.text();

    // ONE ledger table merges both books — not one table per book.
    expect(body.split('<table class="ledger">')).toHaveLength(2);
    expect(body).toContain('<th class="chapter">Chapter</th>');

    // Both books' lines are present, each carrying its own Chapter cell.
    expect(body).toContain("NY Hardware Co");
    expect(body).toContain("Central Ops Supply");
    expect(body).toContain('<td class="chapter">New York</td>');
    expect(body).toContain('<td class="chapter">Central</td>');

    // The old nested-span duplicate (bookLabel printed a second time inside
    // the "who" cell) is gone.
    expect(body).not.toContain('<span class="detail">New York</span>');
    expect(body).not.toContain('<span class="detail">Central</span>');

    // Both books published this month (2 of our 2 active books), so the
    // partial-coverage disclosure has nothing to say.
    expect(body).not.toContain("chapters have published");
    expect(body).not.toContain("chapter has published");
  });

  test("the partial-coverage disclosure reads in chapter language, singular and plural", async () => {
    const s = await asPublisher(); // home chapter "New York"; only Central publishes below

    const txnId = await insertTxn(s, { amountCents: 500, merchantName: "HQ Vendor" });
    await approveCoding(s, txnId, { businessPurpose: "Office supplies" });
    // `asPublisher` seeds exactly one chapter ("New York") + central, so
    // `totalBooks` is 2 — publishing only Central's book makes this
    // genuinely partial without inserting a third chapter.
    await publishScope(s, CENTRAL, AUG_KEY);

    const body = await (await s.t.fetch(`/finances/${AUG_KEY}`, {})).text();
    expect(body).toContain(
      "1 of our 2 chapters has published</strong> (Central) — the totals above cover that chapter only.",
    );
    // The old "books" phrasing must not survive anywhere on the page.
    expect(body).not.toMatch(/\bbooks?\b/i);
  });

  test("the ledger CSV header reads \"Chapter,\" not \"Book\"", async () => {
    const s = await asPublisher();
    const txnId = await insertTxn(s, { amountCents: 500, merchantName: "HQ Vendor" });
    await approveCoding(s, txnId, { businessPurpose: "Office supplies" });
    await publishMonth(s);

    const csvBody = await (await s.t.fetch(`/finances/${AUG_KEY}.csv`, {})).text();
    const header = csvBody.split("\n")[0];
    expect(header).toContain("Chapter");
    expect(header).not.toMatch(/\bBook\b/);

    const givingCsvBody = await (
      await s.t.fetch(`/finances/${AUG_KEY}/giving.csv`, {})
    ).text();
    const givingHeader = givingCsvBody.split("\n")[0];
    expect(givingHeader).toContain("Chapter");
    expect(givingHeader).not.toMatch(/\bBook\b/);
  });

  test("the empty-page hero and meta description speak in chapters, not books", async () => {
    const body = await (await newT().fetch("/finances", {})).text();
    expect(body).toContain(
      "We publish our finances month by month — every transaction, across every chapter",
    );
    expect(body).not.toMatch(/\bbooks?\b/i);
  });
});
