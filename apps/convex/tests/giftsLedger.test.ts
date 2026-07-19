import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { matchOrCreateDonor, recordGiftForDonor } from "../lib/givingDonors";
import type { Id } from "../_generated/dataModel";

/**
 * Gifts ledger (owner requests #1–#6):
 *   - ledger ordering (newest-first) + all-scopes book tagging + view gating,
 *   - manual/external add (donor match-or-create + audit "created" + receipts + cash_app),
 *   - edit → donor + scope rollups net exactly + audit "edited",
 *   - donor reassignment (within scope) → both donors net, scope rollup neutral, audit,
 *   - scope move → both books net exactly, target donor auto-created + person-linked,
 *     gift-count integrity, system-written lock, audit "movedScope",
 *   - identity-grouped org-wide donors (personId / email / name), sums once,
 *   - manual merge preview + merge.
 * Rollup integrity is asserted against a recompute-FROM-ACTUALS every time.
 */

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

/** Central development director (full giving.manage everywhere). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

async function secondChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function scopeRollup(s: ChapterSetup, scope: Id<"chapters"> | "central") {
  return run(s.t, (ctx) =>
    ctx.db
      .query("givingScopeRollups")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .unique(),
  );
}

/** Recompute a scope's rollup from ACTUALS — the ground truth every rollup
 *  assertion checks against. */
async function actuals(s: ChapterSetup, scope: Id<"chapters"> | "central") {
  return run(s.t, async (ctx) => {
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect();
    return {
      lifetimeCents: gifts.reduce((n, g) => n + g.amountCents, 0),
      giftCount: gifts.length,
      donorCount: donors.length,
    };
  });
}

async function expectRollupMatchesActuals(
  s: ChapterSetup,
  scope: Id<"chapters"> | "central",
) {
  const roll = await scopeRollup(s, scope);
  const truth = await actuals(s, scope);
  expect(roll?.lifetimeCents ?? 0).toBe(truth.lifetimeCents);
  expect(roll?.giftCount ?? 0).toBe(truth.giftCount);
  expect(roll?.donorCount ?? 0).toBe(truth.donorCount);
}

async function giftAuditRows(s: ChapterSetup, giftId: Id<"gifts">) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("giftAudit")
      .withIndex("by_gift", (q) => q.eq("giftId", giftId))
      .order("desc")
      .collect(),
  );
}

// ── Ledger ordering + all-scopes tagging + gating ─────────────────────────────

describe("listGifts", () => {
  test("newest-first within a book; all-scopes tags each row with its book", async () => {
    const s = await devDirectorSetup();
    const other = await secondChapter(s, "Boston");

    const now = Date.now();
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Central Donor",
      amountCents: 1000,
      method: "wire",
      receivedAt: now - 3000,
    });
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Central Donor",
      amountCents: 2000,
      method: "wire",
      receivedAt: now - 1000,
    });
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: other,
      name: "Boston Donor",
      amountCents: 5000,
      method: "zelle",
      receivedAt: now - 2000,
    });

    const central = await s.as.query(api.givingPlatform.listGifts, {
      scope: "central",
    });
    expect(central.allScopes).toBe(false);
    expect(central.gifts.map((g) => g.amountCents)).toEqual([2000, 1000]); // desc

    const all = await s.as.query(api.givingPlatform.listGifts, {
      scope: "central",
      allScopes: true,
    });
    expect(all.allScopes).toBe(true);
    // Merged newest-first across books: 2000(central), 5000(Boston), 1000(central).
    expect(all.gifts.map((g) => g.amountCents)).toEqual([2000, 5000, 1000]);
    const boston = all.gifts.find((g) => g.amountCents === 5000);
    expect(boston?.bookLabel).toBe("Boston");
    expect(all.gifts.find((g) => g.amountCents === 2000)?.bookLabel).toBe("Central");
  });

  test("a caller with no giving access can't read the ledger", async () => {
    const s = await setupChapter(newT()); // plain admin, no giving seat
    await expect(
      s.as.query(api.givingPlatform.listGifts, { scope: s.chapterId }),
    ).rejects.toThrow();
  });

  // Giving CRM v2 (owner request #2): `from`/`to` narrow the SAME
  // `by_scope_and_received` index read server-side, both single-scope and
  // all-scopes.
  test("from/to narrow the single-scope ledger to the inclusive range", async () => {
    const s = await devDirectorSetup();
    const now = Date.now();
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Old Gift",
      amountCents: 1000,
      method: "cash",
      receivedAt: now - 10_000,
    });
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Mid Gift",
      amountCents: 2000,
      method: "cash",
      receivedAt: now - 5000,
    });
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "New Gift",
      amountCents: 3000,
      method: "cash",
      receivedAt: now,
    });

    const ranged = await s.as.query(api.givingPlatform.listGifts, {
      scope: "central",
      from: now - 6000,
      to: now - 1,
    });
    expect(ranged.gifts.map((g) => g.amountCents)).toEqual([2000]);

    // Bounds are inclusive.
    const inclusive = await s.as.query(api.givingPlatform.listGifts, {
      scope: "central",
      from: now - 5000,
      to: now,
    });
    expect(inclusive.gifts.map((g) => g.amountCents).sort()).toEqual([2000, 3000]);

    // Open range (`from` only) still respects the lower bound.
    const openEnd = await s.as.query(api.givingPlatform.listGifts, {
      scope: "central",
      from: now - 4000,
    });
    expect(openEnd.gifts.map((g) => g.amountCents)).toEqual([3000]);
  });

  test("from/to narrow the all-scopes merged ledger the same way", async () => {
    const s = await devDirectorSetup();
    const other = await secondChapter(s, "Boston");
    const now = Date.now();
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Central Old",
      amountCents: 1000,
      method: "wire",
      receivedAt: now - 10_000,
    });
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: other,
      name: "Boston New",
      amountCents: 5000,
      method: "zelle",
      receivedAt: now,
    });

    const all = await s.as.query(api.givingPlatform.listGifts, {
      scope: "central",
      allScopes: true,
      from: now - 1000,
    });
    expect(all.gifts.map((g) => g.amountCents)).toEqual([5000]);
  });
});

// ── Add gift (manual / external) ──────────────────────────────────────────────

describe("addGift", () => {
  test("creates donor + gift, bumps rollups, writes a created audit row", async () => {
    const s = await devDirectorSetup();
    const { giftId, donorId } = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Wire Giver",
      email: "wire@example.com",
      amountCents: 100000, // $1,000 wire
      method: "wire",
      receivedAt: Date.parse("2025-09-17"),
      note: "Relay wire",
    });
    const donor = await run(s.t, (ctx) => ctx.db.get(donorId));
    expect(donor?.lifetimeCents).toBe(100000);
    expect(donor?.giftCount).toBe(1);
    await expectRollupMatchesActuals(s, "central");

    const audit = await giftAuditRows(s, giftId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("created");
    expect(audit[0].actorUserId).toBe(s.userId);
    expect(audit[0].changes?.find((c) => c.field === "Amount")?.to).toBe("$1,000.00");
  });

  test("cash_app method persists and a receipt attaches", async () => {
    const s = await devDirectorSetup();
    const receiptId = await storeBlob(s.t);
    const { giftId } = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Cash App Giver",
      amountCents: 2500,
      method: "cash_app",
      receiptStorageIds: [receiptId],
    });
    const gift = await run(s.t, (ctx) => ctx.db.get(giftId));
    expect(gift?.method).toBe("cash_app");
    expect(gift?.receiptStorageIds).toEqual([receiptId]);
  });

  test("a non-manager can't add a gift", async () => {
    const s = await setupChapter(newT());
    await expect(
      s.as.mutation(api.givingPlatform.addGift, {
        scope: s.chapterId,
        name: "X",
        amountCents: 100,
        method: "cash",
      }),
    ).rejects.toThrow();
  });
});

// ── Edit → rollups exact + audit ──────────────────────────────────────────────

describe("editGift audit", () => {
  test("amount edit nets donor + scope exactly and writes an edited audit", async () => {
    const s = await devDirectorSetup();
    const { giftId, donorId } = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Edit Me",
      amountCents: 5000,
      method: "cash",
    });
    await s.as.mutation(api.givingPlatform.editGift, {
      giftId,
      amountCents: 8000,
      reason: "typo",
    });
    const donor = await run(s.t, (ctx) => ctx.db.get(donorId));
    expect(donor?.lifetimeCents).toBe(8000);
    await expectRollupMatchesActuals(s, "central");

    const audit = await giftAuditRows(s, giftId);
    expect(audit[0].action).toBe("edited");
    const amt = audit[0].changes?.find((c) => c.field === "Amount");
    expect(amt).toEqual({ field: "Amount", from: "$50.00", to: "$80.00" });
    expect(audit[0].note).toBe("typo");
  });
});

// ── Donor reassignment (within scope) ─────────────────────────────────────────

describe("reassignGift", () => {
  test("moves a gift between donors in the same book; both net, scope neutral", async () => {
    const s = await devDirectorSetup();
    const a = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Donor A",
      amountCents: 3000,
      method: "cash",
    });
    const b = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Donor B",
      amountCents: 1000,
      method: "cash",
    });
    const scopeBefore = await scopeRollup(s, "central");

    await s.as.mutation(api.givingPlatform.reassignGift, {
      giftId: a.giftId,
      toDonorId: b.donorId,
    });

    const donorA = await run(s.t, (ctx) => ctx.db.get(a.donorId));
    const donorB = await run(s.t, (ctx) => ctx.db.get(b.donorId));
    expect(donorA?.lifetimeCents).toBe(0);
    expect(donorA?.giftCount).toBe(0);
    expect(donorB?.lifetimeCents).toBe(4000);
    expect(donorB?.giftCount).toBe(2);

    // Scope rollup is neutral — money never left the book.
    const scopeAfter = await scopeRollup(s, "central");
    expect(scopeAfter?.lifetimeCents).toBe(scopeBefore?.lifetimeCents);
    expect(scopeAfter?.giftCount).toBe(scopeBefore?.giftCount);
    await expectRollupMatchesActuals(s, "central");

    const audit = await giftAuditRows(s, a.giftId);
    expect(audit[0].action).toBe("reassignedDonor");
    expect(audit[0].changes?.[0]).toEqual({
      field: "Donor",
      from: "Donor A",
      to: "Donor B",
    });
  });

  test("rejects a cross-scope reassignment target", async () => {
    const s = await devDirectorSetup();
    const other = await secondChapter(s, "Austin");
    const a = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "A",
      amountCents: 1000,
      method: "cash",
    });
    const b = await s.as.mutation(api.givingPlatform.addGift, {
      scope: other,
      name: "B",
      amountCents: 1000,
      method: "cash",
    });
    await expect(
      s.as.mutation(api.givingPlatform.reassignGift, {
        giftId: a.giftId,
        toDonorId: b.donorId,
      }),
    ).rejects.toThrow(/CROSS_SCOPE|same book/);
  });
});

// ── Scope move (central-manage; both books net exactly) ───────────────────────

describe("moveGiftScope", () => {
  test("moves a gift central→chapter, creating + linking the target donor", async () => {
    const s = await devDirectorSetup();
    // A roster person in the target chapter, so the moved donor person-links.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Mover Giver",
        email: "mover@example.com",
        createdAt: Date.now(),
      }),
    );
    const { giftId, donorId } = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Mover Giver",
      email: "mover@example.com",
      amountCents: 7000,
      method: "wire",
    });

    const centralBefore = await actuals(s, "central");
    const chapterBefore = await actuals(s, s.chapterId);

    await s.as.mutation(api.givingPlatform.moveGiftScope, {
      giftId,
      toScope: s.chapterId,
      reason: "belongs to the chapter",
    });

    // Gift now lives in the chapter book.
    const gift = await run(s.t, (ctx) => ctx.db.get(giftId));
    expect(gift?.scope).toBe(s.chapterId);
    expect(gift?.donorId).not.toBe(donorId);

    // Source donor emptied; both books net EXACTLY vs actuals.
    const srcDonor = await run(s.t, (ctx) => ctx.db.get(donorId));
    expect(srcDonor?.lifetimeCents).toBe(0);
    expect(srcDonor?.giftCount).toBe(0);
    await expectRollupMatchesActuals(s, "central");
    await expectRollupMatchesActuals(s, s.chapterId);

    // Book totals shifted by exactly the gift.
    const centralAfter = await actuals(s, "central");
    const chapterAfter = await actuals(s, s.chapterId);
    expect(centralBefore.giftCount - centralAfter.giftCount).toBe(1);
    expect(chapterAfter.giftCount - chapterBefore.giftCount).toBe(1);
    expect(chapterAfter.lifetimeCents - chapterBefore.lifetimeCents).toBe(7000);

    // Target donor created in the chapter, person-linked.
    const target = gift ? await run(s.t, (ctx) => ctx.db.get(gift.donorId)) : null;
    expect(target?.scope).toBe(s.chapterId);
    expect(target?.personId).toBeDefined();

    const audit = await giftAuditRows(s, giftId);
    expect(audit[0].action).toBe("movedScope");
    expect(audit[0].changes?.[0].field).toBe("Book");
  });

  test("refuses to move a system-written (event donation) gift", async () => {
    const s = await devDirectorSetup();
    const { giftId } = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Locked",
      amountCents: 3000,
      method: "cash",
    });
    await run(s.t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T",
        slug: "t",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const eventId = await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "E",
        eventDate: Date.now(),
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const donationId = await ctx.db.insert("donations", {
        chapterId: s.chapterId,
        eventId,
        name: "X",
        amountCents: 3000,
        currency: "usd",
        method: "card",
        status: "paid",
        createdAt: Date.now(),
      });
      await ctx.db.patch(giftId, { donationId });
    });
    await expect(
      s.as.mutation(api.givingPlatform.moveGiftScope, {
        giftId,
        toScope: s.chapterId,
      }),
    ).rejects.toThrow(/GIFT_LOCKED/);
  });
});

// ── Identity-grouped org-wide donors ──────────────────────────────────────────

describe("listOrgDonorsByIdentity", () => {
  test("groups a linked personId across books and sums once", async () => {
    const s = await devDirectorSetup();
    const other = await secondChapter(s, "Denver");
    const { personId } = await run(s.t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Shared Person",
        createdAt: Date.now(),
      });
      return { personId };
    });
    // Two chapter donors (different books) both linked to the same personId.
    const d1 = await run(s.t, async (ctx) => {
      const id = await matchOrCreateDonor(ctx, { scope: s.chapterId, name: "Shared A" });
      await recordGiftForDonor(ctx, { donorId: id, amountCents: 4000, receivedAt: Date.now(), method: "cash" });
      await ctx.db.patch(id, { personId });
      return id;
    });
    const d2 = await run(s.t, async (ctx) => {
      const id = await matchOrCreateDonor(ctx, { scope: other, name: "Shared B" });
      await recordGiftForDonor(ctx, { donorId: id, amountCents: 6000, receivedAt: Date.now(), method: "cash" });
      await ctx.db.patch(id, { personId });
      return id;
    });

    const res = await s.as.query(api.givingPlatform.listOrgDonorsByIdentity, {});
    const group = res.donors.find((g) => g.key === `p:${personId}`);
    expect(group).toBeDefined();
    expect(group?.lifetimeCents).toBe(10000);
    expect(group?.bookCount).toBe(2);
    const donorIds = group?.books.map((b) => b.donorId).sort();
    expect(donorIds).toEqual([d1, d2].sort());
  });

  test("falls back to email, then name, across books", async () => {
    const s = await devDirectorSetup();
    const other = await secondChapter(s, "Reno");

    // Insert donors DIRECTLY (no person link — a chapter donor created through
    // the normal path would auto-link a personId, which by design wins over the
    // email/name fallback keys this test exercises).
    const seed = (
      scope: Id<"chapters"> | "central",
      name: string,
      email: string | undefined,
      amountCents: number,
    ) =>
      run(s.t, async (ctx) => {
        const donorId = await ctx.db.insert("donors", {
          scope,
          kind: "individual" as const,
          name,
          ...(email ? { email } : {}),
          status: "prospect" as const,
          lifetimeCents: 0,
          giftCount: 0,
          createdAt: Date.now(),
        });
        await recordGiftForDonor(ctx, {
          donorId,
          amountCents,
          receivedAt: Date.now(),
          method: "cash",
        });
      });

    // Email fallback: central + chapter donors sharing an email, no personId.
    await seed("central", "Email One", "same@example.com", 1000);
    await seed(other, "Email Two", "same@example.com", 2000);
    // Name fallback: two books, no email, same name.
    await seed("central", "Nameonly Person", undefined, 500);
    await seed(other, "Nameonly Person", undefined, 700);

    const res = await s.as.query(api.givingPlatform.listOrgDonorsByIdentity, {});
    const byEmail = res.donors.find((g) => g.key === "e:same@example.com");
    expect(byEmail?.lifetimeCents).toBe(3000);
    expect(byEmail?.bookCount).toBe(2);
    const byName = res.donors.find((g) => g.key === "n:nameonly person");
    expect(byName?.lifetimeCents).toBe(1200);
    expect(byName?.bookCount).toBe(2);
  });
});

// ── Manual merge preview + merge ──────────────────────────────────────────────

describe("previewDonorMerge + mergeDonors", () => {
  test("preview reports what moves; merge folds the duplicate exactly", async () => {
    const s = await devDirectorSetup();
    const a = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Keep",
      amountCents: 5000,
      method: "cash",
    });
    const b = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Absorb",
      amountCents: 3000,
      method: "cash",
    });

    const preview = await s.as.query(api.givingPlatform.previewDonorMerge, {
      scope: "central",
      survivorId: a.donorId,
      duplicateId: b.donorId,
    });
    expect(preview.duplicate.giftCount).toBe(1);
    expect(preview.resulting.lifetimeCents).toBe(8000);
    expect(preview.resulting.giftCount).toBe(2);

    await s.as.mutation(api.dataHygiene.mergeDonors, {
      scope: "central",
      survivorId: a.donorId,
      duplicateId: b.donorId,
    });
    const survivor = await run(s.t, (ctx) => ctx.db.get(a.donorId));
    expect(survivor?.lifetimeCents).toBe(8000);
    expect(survivor?.giftCount).toBe(2);
    expect(await run(s.t, (ctx) => ctx.db.get(b.donorId))).toBeNull();
    await expectRollupMatchesActuals(s, "central");
  });
});
