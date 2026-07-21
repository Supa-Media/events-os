import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * One-time "give" donations (Territories `/give` redesign) tests:
 *  - `prepareGiveDonation` match-or-creates a donor at the right scope
 *    (central vs a chapter), returning the chapter name only for a chapter;
 *  - `recordGiveDonationPaid` records exactly one gift per Stripe session and
 *    is idempotent on redelivery;
 *  - the recorded amount comes from `amountTotalCents` (the Stripe-settled
 *    value), never any other number;
 *  - an invalid/foreign `donorId` is a safe no-op.
 *
 * `startGiveDonationCheckout` itself makes a live Stripe network call, so
 * (mirroring `givingPledges.test.ts`) these tests exercise `prepareGiveDonation`
 * + `recordGiveDonationPaid` directly rather than the action.
 */

async function scopeGifts(t: ReturnType<typeof newT>, scope: Id<"chapters"> | "central") {
  return run(t, (ctx) =>
    ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .collect(),
  );
}

// ── prepareGiveDonation ───────────────────────────────────────────────────────

describe("prepareGiveDonation", () => {
  test("central scope: matches-or-creates a central donor, no chapterName", async () => {
    const t = newT();
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: "central",
      amountCents: 2500,
      name: "Central Giver",
      email: "Giver@Example.com",
    });
    expect(prepared.amountCents).toBe(2500);
    expect((prepared as { chapterName?: string }).chapterName).toBeUndefined();

    const donor = await run(t, (ctx) => ctx.db.get(prepared.donorId));
    expect(donor?.scope).toBe("central");
    expect(donor?.email).toBe("giver@example.com");
    expect(donor?.source).toBe("map");

    // Same email again → matches the SAME donor, doesn't create a second one.
    const again = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: "central",
      amountCents: 5000,
      name: "Central Giver",
      email: "giver@example.com",
    });
    expect(again.donorId).toBe(prepared.donorId);
  });

  test("chapter scope: matches-or-creates a chapter donor and returns chapterName", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Queens" });

    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: s.chapterId,
      amountCents: 10000,
      name: "Chapter Giver",
      email: "chapter@example.com",
    });
    expect(prepared.chapterName).toBe("Queens");
    const donor = await run(s.t, (ctx) => ctx.db.get(prepared.donorId));
    expect(donor?.scope).toBe(s.chapterId);
    expect(donor?.source).toBe("map");
  });

  test("rejects a non-positive or non-integer amount", async () => {
    const t = newT();
    await expect(
      t.mutation(internal.givingDonations.prepareGiveDonation, {
        scope: "central",
        amountCents: 0,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.givingDonations.prepareGiveDonation, {
        scope: "central",
        amountCents: 25.5,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });

  test("rejects a missing name or invalid email", async () => {
    const t = newT();
    await expect(
      t.mutation(internal.givingDonations.prepareGiveDonation, {
        scope: "central",
        amountCents: 2500,
        name: "  ",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.givingDonations.prepareGiveDonation, {
        scope: "central",
        amountCents: 2500,
        name: "X",
        email: "not-an-email",
      }),
    ).rejects.toThrow();
  });

  test("an unknown chapter id is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Delete the chapter, then try to prepare a gift scoped to its (now stale) id.
    await run(s.t, (ctx) => ctx.db.delete(s.chapterId));
    await expect(
      t.mutation(internal.givingDonations.prepareGiveDonation, {
        scope: s.chapterId,
        amountCents: 2500,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });
});

// ── recordGiveDonationPaid ───────────────────────────────────────────────────

describe("recordGiveDonationPaid", () => {
  test("records exactly one gift, amount from amountTotalCents, idempotent on redelivery", async () => {
    const t = newT();
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: "central",
      amountCents: 5000, // the PREPARE-time amount — must NOT be what gets recorded
      name: "Donor One",
      email: "donor1@example.com",
    });

    const first = await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_test_1",
      amountTotalCents: 7500, // the SETTLED (Stripe) amount — this is what must land
      donorId: String(prepared.donorId),
      scope: "central",
    });
    expect(first).toBe(true);

    let gifts = await scopeGifts(t, "central");
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({
      donorId: prepared.donorId,
      amountCents: 7500,
      method: "stripe",
      externalRef: "give:cs_test_1",
    });

    const donor = await run(t, (ctx) => ctx.db.get(prepared.donorId));
    expect(donor?.lifetimeCents).toBe(7500);
    expect(donor?.giftCount).toBe(1);

    // Redelivery of the SAME session is idempotent — no second gift.
    const second = await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_test_1",
      amountTotalCents: 7500,
      donorId: String(prepared.donorId),
      scope: "central",
    });
    expect(second).toBe(false);
    gifts = await scopeGifts(t, "central");
    expect(gifts).toHaveLength(1);
  });

  test("chapter-scoped gift lands in the chapter's book", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Brooklyn" });
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: s.chapterId,
      amountCents: 2500,
      name: "Chapter Donor",
      email: "chapterdonor@example.com",
    });

    const ok = await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_test_chapter",
      amountTotalCents: 2500,
      donorId: String(prepared.donorId),
      scope: String(s.chapterId),
    });
    expect(ok).toBe(true);

    const gifts = await scopeGifts(t, s.chapterId);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].scope).toBe(s.chapterId);
  });

  test("an invalid/foreign donorId is a safe no-op", async () => {
    const t = newT();
    const bogus = await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_test_bogus",
      amountTotalCents: 5000,
      donorId: "not-a-real-donor-id",
      scope: "central",
    });
    expect(bogus).toBe(false);
    expect(await scopeGifts(t, "central")).toHaveLength(0);
  });

  test("a deleted donor id is a safe no-op", async () => {
    const t = newT();
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: "central",
      amountCents: 2500,
      name: "Gone Donor",
      email: "gone@example.com",
    });
    await run(t, (ctx) => ctx.db.delete(prepared.donorId));

    const result = await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_test_gone",
      amountTotalCents: 2500,
      donorId: String(prepared.donorId),
      scope: "central",
    });
    expect(result).toBe(false);
  });

  test("a non-positive or non-integer settled amount is a safe no-op", async () => {
    const t = newT();
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: "central",
      amountCents: 2500,
      name: "Bad Amount",
      email: "badamount@example.com",
    });
    const zero = await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_test_zero",
      amountTotalCents: 0,
      donorId: String(prepared.donorId),
      scope: "central",
    });
    expect(zero).toBe(false);
    expect(await scopeGifts(t, "central")).toHaveLength(0);
  });
});
