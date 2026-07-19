import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Territories P6 — canonical import tests: preview dispositions for all four
 * row types (gift/ticket/contact/recurring), the suspected-duplicate 24h
 * boundary, commit idempotency + externalRef dedup (cross-batch), ticket
 * rows never creating a donor/gift, matched-order vs history-only, the
 * central-scope ticket/contact no-ops, allowSuspected, batch self-reschedule
 * (>100 rows), and access gating. Supersedes the deleted
 * `importGivebutterCsv`/`importGivebutterRecurring` suites — see
 * `givingImport.ts`'s header comment.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Link a `people` row to the caller's user and seat them, so their
 *  seat-derived giving capability resolves. Requires seeded seatDefs. */
async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<Id<"people">> {
  return run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
    return personId;
  });
}

/** A superuser-seat-seeded chapter with the caller seated as development
 *  director at central (full giving.manage everywhere). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

async function crmCounts(s: ChapterSetup, scope: Id<"chapters"> | "central") {
  return run(s.t, async (ctx) => {
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    const pledges = await ctx.db
      .query("pledges")
      .withIndex("by_scope_and_status", (q) => q.eq("scope", scope))
      .collect();
    return { donors, gifts, pledges };
  });
}

async function chapterPeople(s: ChapterSetup) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

/** Minimal template + event, mirroring `ticketing.test.ts`/`givingPlatform.test.ts`. */
async function seedEvent(s: ChapterSetup, name = "Worship Night on the Pier") {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name,
      slug: "worship-night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Publish a ticketed event page and settle one PAID order for `email` via
 *  the same Stripe-webhook path `ticketing.test.ts` exercises. */
async function seedPaidTicketOrder(
  s: ChapterSetup,
  eventId: Id<"events">,
  email: string,
) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true, ticketsEnabled: true },
  });
  const ticketTypeId = (await s.as.mutation(api.ticketing.createTicketType, {
    eventId,
    name: "GA",
    priceCents: 2500,
  })) as Id<"ticketTypes">;
  const prepared = await s.t.mutation(internal.ticketing.prepareOrder, {
    slug: admin.page!.slug,
    name: "Terry Ticket",
    email,
    items: [{ ticketTypeId, quantity: 1 }],
  });
  await s.t.mutation(internal.ticketing.attachStripeSession, {
    orderId: prepared.orderId,
    sessionId: `cs_${prepared.orderId}`,
  });
  await s.t.mutation(internal.ticketing.markSessionPaid, {
    sessionId: `cs_${prepared.orderId}`,
    paymentIntentId: `pi_${prepared.orderId}`,
  });
}

// ── gift row dispositions ─────────────────────────────────────────────────────

describe("previewImport — gift rows", () => {
  test("new, externalRef duplicate, suspected-duplicate boundary (23h vs 25h), invalid", async () => {
    const s = await devDirectorSetup();
    const now = Date.now();

    // A brand-new donor + externalRef → new.
    const firstRow = {
      rowType: "gift" as const,
      name: "Dana Donor",
      email: "dana@example.com",
      amountCents: 5000,
      receivedAt: now,
      externalRef: "gb_1",
    };
    let preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [firstRow],
    });
    expect(preview.rows[0]).toMatchObject({ disposition: "new", donorMatch: "new" });
    expect(preview.summary).toMatchObject({ giftRowCount: 1, totalGiftCents: 5000 });

    // Commit it for real so later previews see actual DB state.
    const committed = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [firstRow],
    });
    expect(committed.imported.gifts).toBe(1);

    // Same externalRef again → duplicate (authoritative dedup key).
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [firstRow],
    });
    expect(preview.rows[0].disposition).toBe("duplicate");
    expect(preview.rows[0].donorMatch).toBe("email");

    // Same donor + same amount, NO externalRef, 23h later → suspected-duplicate.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [
        {
          rowType: "gift",
          name: "Dana Donor",
          email: "dana@example.com",
          amountCents: 5000,
          receivedAt: now + 23 * HOUR_MS,
        },
      ],
    });
    expect(preview.rows[0].disposition).toBe("suspected-duplicate");

    // Same shape but 25h later → outside the window → new.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [
        {
          rowType: "gift",
          name: "Dana Donor",
          email: "dana@example.com",
          amountCents: 5000,
          receivedAt: now + 25 * HOUR_MS,
        },
      ],
    });
    expect(preview.rows[0].disposition).toBe("new");

    // Invalid amount.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [{ rowType: "gift", name: "Bad Amount", amountCents: 0, receivedAt: now }],
    });
    expect(preview.rows[0].disposition).toBe("invalid");

    // The gift/ticket split surfaces even a single-type batch correctly.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [firstRow, { rowType: "ticket", name: "Buyer", email: "b@example.com" }],
    });
    expect(preview.summary.giftRowCount).toBe(1);
    expect(preview.summary.ticketRowCount).toBe(1);
  });
});

// ── ticket row dispositions ────────────────────────────────────────────────────

describe("previewImport / importCanonical — ticket rows", () => {
  test("matched-order vs history-only; never creates a donor/gift; central scope is a no-op", async () => {
    const s = await devDirectorSetup();
    const eventId = await seedEvent(s);
    await seedPaidTicketOrder(s, eventId, "buyer@example.com");

    // Preview: matches the paid order via eventHint + email.
    let preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [
        {
          rowType: "ticket",
          name: "Terry Ticket",
          email: "buyer@example.com",
          eventHint: "Worship Night on the Pier",
        },
        {
          rowType: "ticket",
          name: "No Match",
          email: "nomatch@example.com",
          eventHint: "Worship Night on the Pier",
        },
      ],
    });
    expect(preview.rows[0]).toMatchObject({ disposition: "matched-order", donorMatch: "new" });
    expect(preview.rows[1].disposition).toBe("history-only");

    // Commit: creates people, never donors/gifts.
    const result = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [
        {
          rowType: "ticket",
          name: "Terry Ticket",
          email: "buyer@example.com",
          eventHint: "Worship Night on the Pier",
        },
        {
          rowType: "ticket",
          name: "No Match",
          email: "nomatch@example.com",
          eventHint: "Worship Night on the Pier",
        },
      ],
    });
    expect(result.imported.people).toBe(2);
    expect(result.imported.gifts).toBe(0);
    expect(result.ticketHistoryLinked).toBe(1);

    const counts = await crmCounts(s, s.chapterId);
    expect(counts.donors).toHaveLength(0);
    expect(counts.gifts).toHaveLength(0);
    // `devDirectorSetup` seats the caller via their own chapter `people` row
    // ("Seated Caller") — excluded here since it predates this import.
    const people = (await chapterPeople(s)).filter((p) => p.name !== "Seated Caller");
    expect(people).toHaveLength(2);
    expect(people.every((p) => p.isTeamMember === false)).toBe(true);
    const matched = people.find((p) => p.email === "buyer@example.com");
    expect(matched?.notes).toContain("Ticket history matched");
    const unmatched = people.find((p) => p.email === "nomatch@example.com");
    expect(unmatched?.notes).toContain("Bought tickets");

    // Central scope: pure no-op — no people, no donors, no gifts, no counters bumped.
    const centralResult = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [{ rowType: "ticket", name: "Central Buyer", email: "c@example.com" }],
    });
    expect(centralResult.imported.people).toBe(0);
    expect(centralResult.imported.gifts).toBe(0);
    expect(centralResult.skippedInvalid).toBe(0);
    expect(centralResult.skippedDuplicates).toBe(0);

    const centralPreview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [{ rowType: "ticket", name: "Central Buyer", email: "c@example.com" }],
    });
    expect(centralPreview.rows[0]).toMatchObject({ disposition: "history-only", donorMatch: "n/a" });
  });
});

// ── contact row dispositions ───────────────────────────────────────────────────

describe("previewImport / importCanonical — contact rows", () => {
  test("new + matched; central scope reports invalid and creates nothing", async () => {
    const s = await devDirectorSetup();

    let preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Cara Contact", email: "cara@example.com" }],
    });
    expect(preview.rows[0]).toMatchObject({ disposition: "new", donorMatch: "new" });

    const result = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Cara Contact", email: "cara@example.com" }],
    });
    expect(result.imported.people).toBe(1);
    expect(result.imported.gifts).toBe(0);
    const counts = await crmCounts(s, s.chapterId);
    expect(counts.donors).toHaveLength(0); // contact-only creates no donor

    // Same identity again → matched, no new person.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Cara Contact", email: "cara@example.com" }],
    });
    expect(preview.rows[0].disposition).toBe("matched");
    const second = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Cara Contact", email: "cara@example.com" }],
    });
    expect(second.imported.people).toBe(0);
    const people = (await chapterPeople(s)).filter((p) => p.name !== "Seated Caller");
    expect(people).toHaveLength(1);

    // Central scope has no chapter roster — invalid, no-op.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: "central",
      rows: [{ rowType: "contact", name: "No Roster", email: "x@example.com" }],
    });
    expect(preview.rows[0].disposition).toBe("invalid");
    const centralResult = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [{ rowType: "contact", name: "No Roster", email: "x@example.com" }],
    });
    expect(centralResult.imported.people).toBe(0);
    expect(centralResult.skippedInvalid).toBe(1);
  });
});

// ── recurring row dispositions ─────────────────────────────────────────────────

describe("previewImport / importCanonical — recurring rows", () => {
  test("new, externalRef duplicate within the donor's own pledges, sub-floor invalid", async () => {
    const s = await devDirectorSetup();
    const row = {
      rowType: "recurring" as const,
      name: "Gina Giver",
      email: "gina@example.com",
      recurringMonthlyCents: 5000,
      externalRef: "gb_rec_1",
    };

    let preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [row],
    });
    expect(preview.rows[0]).toMatchObject({ disposition: "new", donorMatch: "new" });

    const committed = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [row],
    });
    expect(committed.imported.pledges).toBe(1);

    const counts = await crmCounts(s, s.chapterId);
    expect(counts.pledges).toHaveLength(1);
    expect(counts.pledges[0]).toMatchObject({ status: "past_due", origin: "imported" });

    // Same externalRef within the SAME donor's pledges → duplicate.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [row],
    });
    expect(preview.rows[0].disposition).toBe("duplicate");

    // Sub-floor amount → invalid.
    preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [{ rowType: "recurring", name: "Tiny", recurringMonthlyCents: 1000 }],
    });
    expect(preview.rows[0].disposition).toBe("invalid");
  });
});

// ── Commit idempotency + cross-batch externalRef dedup ─────────────────────────

describe("importCanonical — idempotency", () => {
  test("a full re-run of a mixed batch imports nothing new the second time", async () => {
    const s = await devDirectorSetup();
    const rows = [
      {
        rowType: "gift" as const,
        name: "Gina Giver",
        email: "gina@example.com",
        amountCents: 2000,
        receivedAt: Date.now(),
        externalRef: "gb_txn_1",
      },
      {
        rowType: "recurring" as const,
        name: "Rex Recurring",
        email: "rex@example.com",
        recurringMonthlyCents: 5000,
        externalRef: "gb_rec_1",
      },
      { rowType: "contact" as const, name: "Cara Contact", email: "cara@example.com" },
    ];

    const first = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows,
    });
    expect(first.imported).toMatchObject({ gifts: 1, pledges: 1, people: 1 });

    const second = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows,
    });
    expect(second.imported).toMatchObject({ gifts: 0, pledges: 0, people: 0 });
    expect(second.skippedDuplicates).toBe(2); // the gift + the pledge, both by externalRef

    const counts = await crmCounts(s, s.chapterId);
    expect(counts.gifts).toHaveLength(1);
    expect(counts.pledges).toHaveLength(1);
    // Seated Caller (setup) + Gina + Rex (auto-linked via `matchOrCreateDonor`
    // → `linkDonorToPerson`, territories P5 — a chapter-scope donor gets a
    // roster row too) + Cara (the explicit `contact` row) = 4, still just ONE
    // each even after the re-run.
    const people = await chapterPeople(s);
    expect(people).toHaveLength(4);
  });

  test("externalRef gift dedup holds across two SEPARATE commit calls", async () => {
    const s = await devDirectorSetup();
    const row = {
      rowType: "gift" as const,
      name: "First Call",
      email: "fc@example.com",
      amountCents: 3000,
      receivedAt: Date.now(),
      externalRef: "gb_cross_batch",
    };

    const call1 = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [row],
    });
    expect(call1.imported.gifts).toBe(1);

    const call2 = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [row],
    });
    expect(call2.imported.gifts).toBe(0);
    expect(call2.skippedDuplicates).toBe(1);

    const counts = await crmCounts(s, "central");
    expect(counts.gifts).toHaveLength(1);
  });
});

// ── allowSuspected ───────────────────────────────────────────────────────────

describe("importCanonical — allowSuspected", () => {
  test("a suspected-duplicate gift is skipped by default, committed with allowSuspected:true", async () => {
    const s = await devDirectorSetup();
    const now = Date.now();
    const firstRow = {
      rowType: "gift" as const,
      name: "Sue Spect",
      email: "sue@example.com",
      amountCents: 4000,
      receivedAt: now,
    };
    await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [firstRow],
    });

    const suspectedRow = {
      rowType: "gift" as const,
      name: "Sue Spect",
      email: "sue@example.com",
      amountCents: 4000,
      receivedAt: now + 2 * HOUR_MS,
    };

    const skipped = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [suspectedRow],
    });
    expect(skipped.imported.gifts).toBe(0);
    expect(skipped.skippedSuspected).toBe(1);

    const allowed = await s.as.mutation(api.givingImport.importCanonical, {
      scope: "central",
      rows: [suspectedRow],
      allowSuspected: true,
    });
    expect(allowed.imported.gifts).toBe(1);

    const counts = await crmCounts(s, "central");
    expect(counts.gifts).toHaveLength(2);
  });
});

// ── Batch scheduling ─────────────────────────────────────────────────────────

describe("importCanonical — batch self-reschedule", () => {
  test("more than 100 rows schedules the remainder, which finishes on drain", async () => {
    vi.useFakeTimers();
    try {
      const s = await devDirectorSetup();
      const rows = Array.from({ length: 150 }, (_, i) => ({
        rowType: "gift" as const,
        name: `Bulk Giver ${i}`,
        email: `bulk${i}@example.com`,
        amountCents: 100,
        receivedAt: Date.now(),
        externalRef: `gb_bulk_${i}`,
      }));

      const result = await s.as.mutation(api.givingImport.importCanonical, {
        scope: "central",
        rows,
      });
      expect(result.imported.gifts).toBe(100);
      expect(result.scheduledRemaining).toBe(50);

      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const counts = await crmCounts(s, "central");
      expect(counts.gifts).toHaveLength(150);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Access gating ─────────────────────────────────────────────────────────────

describe("canonical import access gating", () => {
  test("no giving seat is rejected on preview + commit; view-only can't either; a director passes", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t); // plain chapter admin, no giving seat
    // Carries an email so the manage-gated commit actually creates a contact
    // (a name-only row is now blocked by the no-identifier owner rule — this
    // test is about access gating, not that rule).
    const row = { rowType: "contact" as const, name: "X", email: "x@example.com" };

    await expect(
      s.as.query(api.givingImport.previewImport, { scope: s.chapterId, rows: [row] }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.givingImport.importCanonical, { scope: s.chapterId, rows: [row] }),
    ).rejects.toThrow();

    // A chapter treasurer has VIEW but not MANAGE — both preview and commit
    // (manage-gated) are still refused.
    await seatCaller(s, "treasurer", s.chapterId);
    await expect(
      s.as.query(api.givingImport.previewImport, { scope: s.chapterId, rows: [row] }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.givingImport.importCanonical, { scope: s.chapterId, rows: [row] }),
    ).rejects.toThrow();

    // A development director (central manage) can do both.
    await seatCaller(s, "development_director", "central");
    await expect(
      s.as.query(api.givingImport.previewImport, { scope: s.chapterId, rows: [row] }),
    ).resolves.toBeDefined();
    const committed = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [row],
    });
    expect(committed.imported.people).toBe(1);
  });
});
