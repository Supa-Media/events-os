import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { findCrossScopeDupes } from "../removeCrossScopeGivebutterDupes";

/**
 * The pairing rules behind the 2026-08-14 Givebutter cleanup.
 *
 * The runner itself is bound to production totals, but its judgement — which
 * rows are duplicates of which — is exactly what `genesisDedupe2026` got wrong
 * when it deleted six rows on amount + date alone and was wrong about every
 * one. These tests are the difference between the two passes: same person
 * required, one-to-one consumption, and the older chapter-scoped row kept.
 *
 * Delete this file with the module.
 */

const DAY = Date.parse("2025-06-05T12:00:00Z");

async function donor(
  s: ChapterSetup,
  opts: { name: string; email?: string; scope: string; identityId?: Id<"donorIdentities"> },
): Promise<Id<"donors">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("donors", {
      scope: opts.scope as never,
      kind: "individual",
      name: opts.name,
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.identityId ? { identityId: opts.identityId } : {}),
      status: "prospect",
      lifetimeCents: 0,
      giftCount: 0,
      createdAt: Date.now(),
    }),
  );
}

/** A gift with a controlled `_creationTime`, which convex-test honours from
 *  the insertion order — so the original is inserted first and then aged by
 *  patching nothing; instead the ref prefix and the runner's date gate do the
 *  work. `receivedAt` is what pairs them. */
async function gift(
  s: ChapterSetup,
  opts: { donorId: Id<"donors">; cents: number; ref: string; receivedAt?: number },
): Promise<Id<"gifts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("gifts", {
      donorId: opts.donorId,
      amountCents: opts.cents,
      receivedAt: opts.receivedAt ?? DAY,
      currency: "usd",
      method: "givebutter",
      externalRef: opts.ref,
      scope: "central" as never,
      createdAt: Date.now(),
    }),
  );
}

describe("findCrossScopeDupes", () => {
  test("pairs a bare-id import row with the same person's older gb:txn: row", async () => {
    const s = await setupChapter(newT());
    const ny = await donor(s, { name: "Mary Cubero Navarro", email: "m@x.com", scope: s.chapterId });
    const central = await donor(s, { name: "Mary Cubero Navarro", email: "M@X.com", scope: "central" });
    await gift(s, { donorId: ny, cents: 5500, ref: "gb:txn:123" });
    const dupeId = await gift(s, { donorId: central, cents: 5500, ref: "UfZv2aOCB7NMm3jU" });

    const { pairs } = await run(s.t, (ctx) => findCrossScopeDupes(ctx));

    expect(pairs).toHaveLength(1);
    // The bare-id import row is the one that goes; the older gb:txn: row stays.
    expect(pairs[0].dupe._id).toBe(dupeId);
    expect(pairs[0].keep.externalRef).toBe("gb:txn:123");
  });

  test("REFUSES to pair same amount + same day when it's a different person", async () => {
    const s = await setupChapter(newT());
    const a = await donor(s, { name: "Layomi Kupoluyi", email: "l@x.com", scope: s.chapterId });
    const b = await donor(s, { name: "Charisma Stevens", email: "c@x.com", scope: "central" });
    await gift(s, { donorId: a, cents: 5500, ref: "gb:txn:1" });
    await gift(s, { donorId: b, cents: 5500, ref: "1IAU5exceAjKadpI" });

    const { pairs } = await run(s.t, (ctx) => findCrossScopeDupes(ctx));

    // Two real $55 gifts on one day from two people. This is the exact shape
    // the genesis pass collapsed, and it must survive untouched.
    expect(pairs).toEqual([]);
  });

  test("consumes each original ONCE — two imports cannot claim one row", async () => {
    const s = await setupChapter(newT());
    const ny = await donor(s, { name: "Seyi", email: "s@x.com", scope: s.chapterId });
    const central = await donor(s, { name: "Seyi", email: "s@x.com", scope: "central" });
    // ONE original, TWO same-amount same-day import rows.
    await gift(s, { donorId: ny, cents: 2500, ref: "gb:txn:9" });
    await gift(s, { donorId: central, cents: 2500, ref: "aaaaaaaaaaaaaaaa" });
    await gift(s, { donorId: central, cents: 2500, ref: "bbbbbbbbbbbbbbbb" });

    const { pairs } = await run(s.t, (ctx) => findCrossScopeDupes(ctx));

    // Only one may be claimed — the second is a genuine second gift as far as
    // the evidence goes, and deleting it would be the genesis mistake again.
    expect(pairs).toHaveLength(1);
  });

  test("leaves a genuinely new gift alone — nothing to pair with", async () => {
    const s = await setupChapter(newT());
    const central = await donor(s, { name: "Austin Erickson", email: "a@x.com", scope: "central" });
    await gift(s, {
        donorId: central,
        cents: 5000,
        ref: "XadrsOtead2aUJ6c",
        receivedAt: Date.parse("2026-08-13T12:00:00Z"),
      });

    const { pairs } = await run(s.t, (ctx) => findCrossScopeDupes(ctx));

    expect(pairs).toEqual([]);
  });

  test("never treats a namespaced ref as an import row", async () => {
    const s = await setupChapter(newT());
    const ny = await donor(s, { name: "Charisma", email: "c@x.com", scope: s.chapterId });
    const central = await donor(s, { name: "Charisma", email: "c@x.com", scope: "central" });
    await gift(s, { donorId: ny, cents: 30927, ref: "gb:txn:5" });
    // The Stripe gift from the same day carries a `give:` ref — namespaced, so
    // it is not from the bad import and is not a candidate.
    await gift(s, { donorId: central, cents: 30927, ref: "give:cs_live_abc" });

    const { pairs } = await run(s.t, (ctx) => findCrossScopeDupes(ctx));

    expect(pairs).toEqual([]);
  });

  test("matches on identity when emails disagree", async () => {
    const s = await setupChapter(newT());
    const identityId = await run(s.t, (ctx) =>
      ctx.db.insert("donorIdentities", {
        key: "e:jude@x.com",
        name: "Jude Omodon",
        lifetimeCents: 0,
        giftCount: 0,
        scopes: [],
        createdAt: Date.now(),
      }),
    );
    // The real pair: "Chukwuka Jude Omodon" vs "Jude Omodon", and here with no
    // shared email either — identity is what proves they are one person.
    const ny = await donor(s, { name: "Chukwuka Jude Omodon", scope: s.chapterId, identityId });
    const central = await donor(s, { name: "Jude Omodon", scope: "central", identityId });
    await gift(s, { donorId: ny, cents: 100000, ref: "gb:txn:7" });
    await gift(s, { donorId: central, cents: 100000, ref: "6idS5kxVqMQDKpfl" });

    const { pairs } = await run(s.t, (ctx) => findCrossScopeDupes(ctx));

    expect(pairs).toHaveLength(1);
  });
});
