import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Cross-chapter donor IDENTITY layer (donor-identity, 2026-07).
 *
 * The giving book is per-`(scope, person)` on purpose — a giver to central AND
 * a chapter is two `donors` rows. This layer groups those rows into ONE
 * `donorIdentities` row (key = normalized email → phone → exact name), carrying
 * the `scopes` that person is part of + a recomputed aggregate, WITHOUT
 * touching the per-scope money rollups.
 *
 * Covered:
 *   - two same-email donors in different books → one identity, both scopes,
 *     combined lifetime, per-scope rollups untouched,
 *   - a single-scope donor → identity with one scope,
 *   - a new-scope donation extends `scopes`; a repeat gift in a known scope
 *     doesn't,
 *   - the person-link path leaves the identity consistent,
 *   - the backfill is dry-run-safe + idempotent,
 *   - per-chapter listing still returns only that chapter's donors,
 *   - the identity-grouped org query returns the person with their books.
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

/** The `donorIdentities` row a donor is attached to (or null). */
async function identityForDonor(s: ChapterSetup, donorId: Id<"donors">) {
  return run(s.t, async (ctx) => {
    const d = await ctx.db.get(donorId);
    if (!d?.identityId) return null;
    return ctx.db.get(d.identityId);
  });
}

async function donorRow(s: ChapterSetup, donorId: Id<"donors">) {
  return run(s.t, (ctx) => ctx.db.get(donorId));
}

async function allIdentities(s: ChapterSetup) {
  return run(s.t, (ctx) => ctx.db.query("donorIdentities").collect());
}

// ── Grouping ─────────────────────────────────────────────────────────────────

describe("donor identity grouping", () => {
  test("two same-email donors in different books group into ONE identity", async () => {
    const s = await devDirectorSetup();
    const ny = s.chapterId;

    // Same person gives $7,000 to central and $15,028.51 to New York.
    const central = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Oluseyi Olujide",
      email: "joseph.o.olujide@gmail.com",
      amountCents: 700000,
      method: "wire",
    });
    const newYork = await s.as.mutation(api.givingPlatform.addGift, {
      scope: ny,
      name: "Oluseyi Olujide",
      email: "Joseph.O.Olujide@gmail.com", // different case → same normalized key
      amountCents: 1502851,
      method: "zelle",
    });

    // Both donor rows point at the SAME identity.
    const idA = await identityForDonor(s, central.donorId);
    const idB = await identityForDonor(s, newYork.donorId);
    expect(idA).not.toBeNull();
    expect(idA?._id).toBe(idB?._id);

    // Identity aggregate = sum across books; scopes = both.
    expect(idA?.key).toBe("e:joseph.o.olujide@gmail.com");
    expect(idA?.lifetimeCents).toBe(700000 + 1502851);
    expect(idA?.giftCount).toBe(2);
    expect(new Set(idA?.scopes)).toEqual(new Set(["central", ny]));

    // Exactly one identity exists org-wide for this person.
    expect((await allIdentities(s)).length).toBe(1);

    // ADDITIVE: each donor row's OWN per-scope rollup is untouched.
    expect((await donorRow(s, central.donorId))?.lifetimeCents).toBe(700000);
    expect((await donorRow(s, newYork.donorId))?.lifetimeCents).toBe(1502851);
  });

  test("a donor in only one scope has an identity with one scope", async () => {
    const s = await devDirectorSetup();
    const g = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Solo Giver",
      email: "solo@example.com",
      amountCents: 5000,
      method: "cash",
    });
    const id = await identityForDonor(s, g.donorId);
    expect(id?.scopes).toEqual(["central"]);
    expect(id?.lifetimeCents).toBe(5000);
    expect(id?.giftCount).toBe(1);
  });

  test("a new-scope donation extends scopes; a repeat gift in a known scope does not", async () => {
    const s = await devDirectorSetup();
    const ny = s.chapterId;

    const central = await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Growing Giver",
      email: "grow@example.com",
      amountCents: 1000,
      method: "cash",
    });
    let id = await identityForDonor(s, central.donorId);
    expect(id?.scopes).toEqual(["central"]);

    // Another central gift (same donor) — scopes unchanged, aggregate grows.
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Growing Giver",
      email: "grow@example.com",
      amountCents: 2000,
      method: "cash",
    });
    id = await identityForDonor(s, central.donorId);
    expect(id?.scopes).toEqual(["central"]);
    expect(id?.lifetimeCents).toBe(3000);
    expect(id?.giftCount).toBe(2);

    // A gift in a NEW book extends scopes.
    const nyGift = await s.as.mutation(api.givingPlatform.addGift, {
      scope: ny,
      name: "Growing Giver",
      email: "grow@example.com",
      amountCents: 4000,
      method: "cash",
    });
    id = await identityForDonor(s, nyGift.donorId);
    expect(new Set(id?.scopes)).toEqual(new Set(["central", ny]));
    expect(id?.lifetimeCents).toBe(7000);
    expect(id?.giftCount).toBe(3);
  });

  test("the person-link path keeps the identity consistent", async () => {
    const s = await devDirectorSetup();
    const ny = s.chapterId;

    const g = await s.as.mutation(api.givingPlatform.addGift, {
      scope: ny,
      name: "Linked Giver",
      email: "linked@example.com",
      amountCents: 9000,
      method: "cash",
    });
    const before = await identityForDonor(s, g.donorId);
    expect(before?.lifetimeCents).toBe(9000);
    expect(before?.scopes).toEqual([ny]);

    // Link the chapter donor to a roster person on the SAME chapter.
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: ny,
        name: "Linked Giver",
        createdAt: Date.now(),
      }),
    );
    await s.as.mutation(api.givingPlatform.setDonorPerson, {
      donorId: g.donorId,
      personId,
    });

    // Identity is unchanged (email is the key, personId is only a link signal),
    // and the donor stays attached to the same identity.
    const after = await identityForDonor(s, g.donorId);
    expect(after?._id).toBe(before?._id);
    expect(after?.lifetimeCents).toBe(9000);
    expect(after?.scopes).toEqual([ny]);
    expect((await donorRow(s, g.donorId))?.personId).toBe(personId);
  });
});

// ── Backfill ─────────────────────────────────────────────────────────────────

describe("donorIdentityBackfill", () => {
  /** Insert a donor row DIRECTLY (no write path → no identity attached) with a
   *  preset per-scope rollup, mimicking a pre-identity-layer row. */
  async function insertLegacyDonor(
    s: ChapterSetup,
    scope: Id<"chapters"> | "central",
    name: string,
    email: string | undefined,
    lifetimeCents: number,
    giftCount: number,
  ): Promise<Id<"donors">> {
    return run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope,
        kind: "individual" as const,
        name,
        ...(email ? { email } : {}),
        status: "prospect" as const,
        lifetimeCents,
        giftCount,
        createdAt: Date.now(),
      }),
    );
  }

  test("dry-run writes nothing; execute attaches; a second execute is a no-op", async () => {
    const s = await devDirectorSetup();
    const ny = s.chapterId;

    const dCentral = await insertLegacyDonor(s, "central", "Legacy Person", "legacy@example.com", 700000, 1);
    const dNy = await insertLegacyDonor(s, ny, "Legacy Person", "legacy@example.com", 1502851, 3);

    // Dry run: reports what WOULD happen, writes nothing.
    const dry = await s.t.mutation(internal.donorIdentityBackfill.backfillDonorIdentities, {});
    expect(dry.scanned).toBe(2);
    expect(dry.attached).toBe(2);
    expect(dry.identitiesCreated).toBe(1);
    expect(dry.isDone).toBe(true);
    expect((await allIdentities(s)).length).toBe(0);
    expect((await donorRow(s, dCentral))?.identityId).toBeUndefined();

    // Execute: attach both donors into one identity with the summed aggregate.
    const run1 = await s.t.mutation(internal.donorIdentityBackfill.backfillDonorIdentities, {
      execute: true,
    });
    expect(run1.attached).toBe(2);
    expect(run1.identitiesCreated).toBe(1);

    const identities = await allIdentities(s);
    expect(identities.length).toBe(1);
    expect(identities[0].lifetimeCents).toBe(700000 + 1502851);
    expect(identities[0].giftCount).toBe(1 + 3);
    expect(new Set(identities[0].scopes)).toEqual(new Set(["central", ny]));
    expect((await identityForDonor(s, dCentral))?._id).toBe(identities[0]._id);
    expect((await identityForDonor(s, dNy))?._id).toBe(identities[0]._id);

    // Per-scope rollups are STILL untouched (additive).
    expect((await donorRow(s, dCentral))?.lifetimeCents).toBe(700000);
    expect((await donorRow(s, dNy))?.lifetimeCents).toBe(1502851);

    // Idempotent: a second execute creates no identity and changes nothing.
    const run2 = await s.t.mutation(internal.donorIdentityBackfill.backfillDonorIdentities, {
      execute: true,
    });
    expect(run2.attached).toBe(0);
    expect(run2.identitiesCreated).toBe(0);
    const after = await allIdentities(s);
    expect(after.length).toBe(1);
    expect(after[0]._id).toBe(identities[0]._id);
    expect(after[0].lifetimeCents).toBe(700000 + 1502851);
  });
});

// ── Chapter separation preserved ──────────────────────────────────────────────

describe("chapter separation + identity org view", () => {
  test("per-chapter listDonors still returns only that chapter's donors", async () => {
    const s = await devDirectorSetup();
    const ny = s.chapterId;

    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Shared Person",
      email: "shared@example.com",
      amountCents: 1000,
      method: "cash",
    });
    const nyGift = await s.as.mutation(api.givingPlatform.addGift, {
      scope: ny,
      name: "Shared Person",
      email: "shared@example.com",
      amountCents: 2000,
      method: "cash",
    });

    const chapterList = await s.as.query(api.givingPlatform.listDonors, { scope: ny });
    // Only the chapter's OWN donor row — the identity layer never leaks the
    // central row into a chapter's book.
    expect(chapterList.every((d) => d.scope === ny)).toBe(true);
    expect(chapterList.some((d) => d._id === nyGift.donorId)).toBe(true);
  });

  test("listDonorIdentities returns the person with their books", async () => {
    const s = await devDirectorSetup();
    const ny = s.chapterId;

    await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Org Person",
      email: "org@example.com",
      amountCents: 700000,
      method: "wire",
    });
    await s.as.mutation(api.givingPlatform.addGift, {
      scope: ny,
      name: "Org Person",
      email: "org@example.com",
      amountCents: 300000,
      method: "cash",
    });

    const res = await s.as.query(api.givingPlatform.listDonorIdentities, {});
    const group = res.donors.find((g) => g.key === "e:org@example.com");
    expect(group).toBeDefined();
    expect(group?.lifetimeCents).toBe(1000000);
    expect(group?.bookCount).toBe(2);
    expect(new Set(group?.scopeLabels)).toEqual(new Set(["Central", "New York"]));
  });
});
