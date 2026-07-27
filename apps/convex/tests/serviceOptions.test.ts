/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import appSchema from "../schema";
import { newT, run, setupChapter, modules, type ChapterSetup, type TestConvex } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import type { AudienceTargeting } from "../lib/audienceTargeting";
import { resolveServiceLabels } from "../lib/serviceCatalog";
import { runSeedServiceCatalog } from "../migrations/0045_seed_service_catalog";
import { runServiceConditionsToIds } from "../migrations/0046_service_conditions_to_ids";

/**
 * Service Catalog — `serviceOptions.ts` CRUD/merge, the `has_service`
 * subtree-match rewrite in `lib/audienceTargeting.ts`, and migrations
 * 0045/0046. Mirrors `tests/audienceTargeting.test.ts`'s setup conventions
 * (`setupChapter`, direct `ctx.db.insert` for fixtures, `previewAudience` for
 * targeting behavior).
 */

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ConvexError) return (e.data as { code?: string }).code;
    throw e;
  }
}

async function seedPerson(
  s: ChapterSetup,
  opts: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      status: "active",
      createdAt: Date.now(),
      ...opts,
    }),
  );
}

async function previewTargeting(s: ChapterSetup, targeting: AudienceTargeting) {
  return s.as.query(api.audiences.previewAudience, {
    scope: s.chapterId,
    source: "person_filters",
    filters: {},
    targeting,
  });
}

/**
 * A `t` whose schema has validation DISABLED, for the ONE thing a normal `t`
 * can't do: construct a pre-migration, pre-catalog `has_service` audience
 * condition (`{ service: string }`) — a shape the CURRENT schema (post this
 * PR) no longer accepts on a fresh write, but that migration 0046 must still
 * be able to read and convert (real prod rows in that shape predate the
 * schema change and were never re-validated). Spreading `appSchema` keeps
 * every table/index definition intact; only the top-level
 * `schemaValidation` flag flips, which is the ONLY thing `convex-test`
 * consults before calling `ctx.db.insert`/`patch`'s validator (see
 * `convex-test`'s `DatabaseFake._validate`) — so this is a test-only escape
 * hatch, not a change to the shipped schema.
 */
function newLooseT(): TestConvex {
  const loose = { ...(appSchema as unknown as Record<string, unknown>), schemaValidation: false };
  return convexTest(loose as any, modules) as unknown as TestConvex;
}

// ── create ───────────────────────────────────────────────────────────────

describe("serviceOptions.create", () => {
  test("rejects a duplicate name under the same parent (case-insensitive, trimmed)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    expect(
      await errorCode(s.as.mutation(api.serviceOptions.create, { name: "  VOCALS  " })),
    ).toBe("DUPLICATE_NAME");
  });

  test("allows the same name under DIFFERENT parents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const vocals = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const instruments = await s.as.mutation(api.serviceOptions.create, { name: "Instruments" });
    await expect(
      s.as.mutation(api.serviceOptions.create, { name: "Bass", parentId: vocals }),
    ).resolves.toBeTruthy();
    await expect(
      s.as.mutation(api.serviceOptions.create, { name: "Bass", parentId: instruments }),
    ).resolves.toBeTruthy();
  });

  test("rejects nesting a child under a child (one level only)", async () => {
    const t = newT();
    // previewAudience requires campaigns access — superuser bootstrap email,
    // same convention as `tests/audienceTargeting.test.ts`'s `asSuperuser`.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const parentId = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const childId = await s.as.mutation(api.serviceOptions.create, { name: "Tenor", parentId });
    expect(
      await errorCode(
        s.as.mutation(api.serviceOptions.create, { name: "Grandchild", parentId: childId }),
      ),
    ).toBe("TOO_DEEP");
  });

  test("rejects a name containing ':' or ','", async () => {
    const t = newT();
    const s = await setupChapter(t);
    expect(
      await errorCode(s.as.mutation(api.serviceOptions.create, { name: "Vocals:Tenor" })),
    ).toBe("INVALID_NAME");
    expect(
      await errorCode(s.as.mutation(api.serviceOptions.create, { name: "Audio, Video" })),
    ).toBe("INVALID_NAME");
  });

  test("rejects an empty/whitespace-only name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    expect(await errorCode(s.as.mutation(api.serviceOptions.create, { name: "   " }))).toBe(
      "INVALID_NAME",
    );
  });
});

// ── rename ───────────────────────────────────────────────────────────────

describe("serviceOptions.rename", () => {
  test("propagates to every reference: a person's resolved label changes without touching the person row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const serviceId = await s.as.mutation(api.serviceOptions.create, { name: "Vokals" });
    const personId = await seedPerson(s, { name: "Ada", serviceIds: [serviceId] });
    const before = await run(s.t, (ctx) => ctx.db.get(personId));

    await s.as.mutation(api.serviceOptions.rename, { serviceOptionId: serviceId, name: "Vocals" });

    const after = await run(s.t, (ctx) => ctx.db.get(personId));
    expect(after?.serviceIds).toEqual(before?.serviceIds);

    const labels = await run(s.t, (ctx) => resolveServiceLabels(ctx, after?.serviceIds));
    expect(labels).toEqual(["Vocals"]);
  });

  test("renaming a child updates its derived 'Parent:Child' label", async () => {
    const t = newT();
    // previewAudience requires campaigns access — superuser bootstrap email,
    // same convention as `tests/audienceTargeting.test.ts`'s `asSuperuser`.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const parentId = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const childId = await s.as.mutation(api.serviceOptions.create, { name: "Tenur", parentId });
    const personId = await seedPerson(s, { name: "Ben", serviceIds: [childId] });

    await s.as.mutation(api.serviceOptions.rename, { serviceOptionId: childId, name: "Tenor" });

    const person = await run(s.t, (ctx) => ctx.db.get(personId));
    const labels = await run(s.t, (ctx) => resolveServiceLabels(ctx, person?.serviceIds));
    expect(labels).toEqual(["Vocals:Tenor"]);
  });

  test("rejects a rename that collides with a sibling", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const otherId = await s.as.mutation(api.serviceOptions.create, { name: "Instruments" });
    expect(
      await errorCode(
        s.as.mutation(api.serviceOptions.rename, { serviceOptionId: otherId, name: "vocals" }),
      ),
    ).toBe("DUPLICATE_NAME");
  });
});

// ── setActive ────────────────────────────────────────────────────────────

describe("serviceOptions.setActive", () => {
  test("deactivating a parent hides it AND its children from `list` (unless includeInactive)", async () => {
    const t = newT();
    // previewAudience requires campaigns access — superuser bootstrap email,
    // same convention as `tests/audienceTargeting.test.ts`'s `asSuperuser`.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const parentId = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    await s.as.mutation(api.serviceOptions.create, { name: "Tenor", parentId });

    await s.as.mutation(api.serviceOptions.setActive, { serviceOptionId: parentId, isActive: false });

    const active = await s.as.query(api.serviceOptions.list, {});
    expect(active.find((p) => p._id === parentId)).toBeUndefined();

    const all = await s.as.query(api.serviceOptions.list, { includeInactive: true });
    const parent = all.find((p) => p._id === parentId);
    expect(parent?.isActive).toBe(false);
    expect(parent?.children).toHaveLength(1);
  });

  test("deactivating only a CHILD leaves its parent and siblings visible", async () => {
    const t = newT();
    // previewAudience requires campaigns access — superuser bootstrap email,
    // same convention as `tests/audienceTargeting.test.ts`'s `asSuperuser`.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const parentId = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const tenorId = await s.as.mutation(api.serviceOptions.create, { name: "Tenor", parentId });
    await s.as.mutation(api.serviceOptions.create, { name: "Alto", parentId });

    await s.as.mutation(api.serviceOptions.setActive, { serviceOptionId: tenorId, isActive: false });

    const active = await s.as.query(api.serviceOptions.list, {});
    const parent = active.find((p) => p._id === parentId);
    expect(parent).toBeTruthy();
    expect(parent?.children.map((c) => c.name)).toEqual(["Alto"]);
  });
});

// ── merge ────────────────────────────────────────────────────────────────

describe("serviceOptions.merge", () => {
  test("repoints people (deduping) and soft-deletes the merged-away option", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fromId = await s.as.mutation(api.serviceOptions.create, { name: "Audio" });
    const toId = await s.as.mutation(api.serviceOptions.create, { name: "Audio Engineering" });
    const otherId = await s.as.mutation(api.serviceOptions.create, { name: "Decor" });

    const onlyFromId = await seedPerson(s, { name: "A", serviceIds: [fromId, otherId] });
    const bothId = await seedPerson(s, { name: "B", serviceIds: [fromId, toId] });
    const neitherId = await seedPerson(s, { name: "C", serviceIds: [otherId] });

    const result = await s.as.mutation(api.serviceOptions.merge, { fromId, toId });
    expect(result.peopleRepointed).toBe(2);

    const onlyFrom = await run(s.t, (ctx) => ctx.db.get(onlyFromId));
    const both = await run(s.t, (ctx) => ctx.db.get(bothId));
    const neither = await run(s.t, (ctx) => ctx.db.get(neitherId));
    expect(new Set(onlyFrom?.serviceIds)).toEqual(new Set([toId, otherId]));
    expect(new Set(both?.serviceIds)).toEqual(new Set([toId]));
    expect(neither?.serviceIds).toEqual([otherId]);

    const from = await run(s.t, (ctx) => ctx.db.get(fromId));
    expect(from?.isActive).toBe(false);
  });

  test("repoints saved has_service audience conditions (include and exclude groups)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fromId = await s.as.mutation(api.serviceOptions.create, { name: "Audio" });
    const toId = await s.as.mutation(api.serviceOptions.create, { name: "Audio Engineering" });

    const audienceId = await run(s.t, (ctx) =>
      ctx.db.insert("audiences", {
        scope: s.chapterId,
        name: "Aud",
        source: "person_filters",
        filters: {},
        targeting: {
          groups: [{ conditions: [{ field: "has_service", op: "has", serviceId: fromId }] }],
          excludeGroups: [{ conditions: [{ field: "has_service", op: "has_not", serviceId: fromId }] }],
        },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await s.as.mutation(api.serviceOptions.merge, { fromId, toId });
    expect(result.audiencesRepointed).toBe(1);

    const audience = await run(s.t, (ctx) => ctx.db.get(audienceId));
    const targeting = audience?.targeting as AudienceTargeting;
    expect((targeting.groups[0].conditions[0] as any).serviceId).toBe(toId);
    expect((targeting.excludeGroups![0].conditions[0] as any).serviceId).toBe(toId);
  });

  test("rejects merging an option into itself, and options from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "Other" });
    const mine = await s.as.mutation(api.serviceOptions.create, { name: "Audio" });
    const theirs = await other.as.mutation(api.serviceOptions.create, { name: "Audio" });

    expect(await errorCode(s.as.mutation(api.serviceOptions.merge, { fromId: mine, toId: mine }))).toBe(
      "INVALID_INPUT",
    );
    expect(
      await errorCode(s.as.mutation(api.serviceOptions.merge, { fromId: mine, toId: theirs })),
    ).toBe("NOT_FOUND");
  });
});

// ── has_service subtree matching (audienceTargeting.ts) ─────────────────

describe("has_service: subtree rollup", () => {
  test("'has' on a PARENT matches a person tagged with a CHILD; 'has_not' excludes them", async () => {
    const t = newT();
    // previewAudience requires campaigns access — superuser bootstrap email,
    // same convention as `tests/audienceTargeting.test.ts`'s `asSuperuser`.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const parentId = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const childId = await s.as.mutation(api.serviceOptions.create, { name: "Tenor", parentId });
    await seedPerson(s, { name: "Tenor", email: "tenor@example.com", serviceIds: [childId] });
    await seedPerson(s, { name: "Nobody", email: "nobody@example.com" });

    const has = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "has_service", op: "has", serviceId: parentId } as any] }],
    });
    expect(has.sample.map((r: any) => r.email)).toEqual(["tenor@example.com"]);

    const hasNot = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "has_service", op: "has_not", serviceId: parentId } as any] }],
    });
    expect(hasNot.sample.map((r: any) => r.email)).toEqual(["nobody@example.com"]);
  });

  test("matching a CHILD directly does not admit a sibling child or the bare parent-only tag", async () => {
    const t = newT();
    // previewAudience requires campaigns access — superuser bootstrap email,
    // same convention as `tests/audienceTargeting.test.ts`'s `asSuperuser`.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const parentId = await s.as.mutation(api.serviceOptions.create, { name: "Vocals" });
    const tenorId = await s.as.mutation(api.serviceOptions.create, { name: "Tenor", parentId });
    const altoId = await s.as.mutation(api.serviceOptions.create, { name: "Alto", parentId });
    await seedPerson(s, { name: "Tenor", email: "tenor@example.com", serviceIds: [tenorId] });
    await seedPerson(s, { name: "Alto", email: "alto@example.com", serviceIds: [altoId] });
    await seedPerson(s, { name: "Bare", email: "bare@example.com", serviceIds: [parentId] });

    const has = await previewTargeting(s, {
      groups: [{ conditions: [{ field: "has_service", op: "has", serviceId: tenorId } as any] }],
    });
    expect(has.sample.map((r: any) => r.email)).toEqual(["tenor@example.com"]);
  });
});

// ── migration 0045: seed catalog + backfill legacy strings ───────────────

describe("migration 0045: seed catalog + backfill legacy people.services strings", () => {
  const LEGACY_STRINGS = [
    "worship leading",
    "prayer",
    "instrumentalist",
    "sales",
    "florist",
    "videography",
    "operations",
    "decor",
    "vocalist",
    "photography",
    "driving",
    "preaching",
    "design",
  ];

  test("maps all 13 known legacy strings, reports an unmapped one, and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const mappedIds: Id<"people">[] = [];
    for (const value of LEGACY_STRINGS) {
      mappedIds.push(await seedPerson(s, { name: value, services: [value] }));
    }
    const unmappedId = await seedPerson(s, { name: "Juggler", services: ["juggling"] });

    const first = await run(s.t, (ctx) => runSeedServiceCatalog(ctx));
    expect(first.peopleBackfilled).toBe(LEGACY_STRINGS.length);
    expect(first.unmapped.map((u) => u.value)).toEqual(["juggling"]);
    expect(first.catalogRowsCreated).toBeGreaterThan(0);

    for (const id of mappedIds) {
      const person = await run(s.t, (ctx) => ctx.db.get(id));
      expect(person?.serviceIds?.length).toBeGreaterThan(0);
    }
    const juggler = await run(s.t, (ctx) => ctx.db.get(unmappedId));
    expect(juggler?.serviceIds).toBeUndefined();

    // Re-run: catalog is fully seeded (no new rows), every mapped person is
    // skipped as already-set, and the unmapped one is (harmlessly) reported
    // again rather than silently dropped.
    const second = await run(s.t, (ctx) => runSeedServiceCatalog(ctx));
    expect(second.catalogRowsCreated).toBe(0);
    expect(second.peopleSkippedAlreadySet).toBe(LEGACY_STRINGS.length);
    expect(second.unmapped.map((u) => u.value)).toEqual(["juggling"]);
  });
});

// ── migration 0046: has_service string → serviceId ────────────────────────

describe("migration 0046: convert has_service string conditions to serviceId", () => {
  test("converts a resolvable string condition; leaves an unmatched one untouched and reports it", async () => {
    const t = newLooseT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) => runSeedServiceCatalog(ctx));
    const catalog = await s.as.query(api.serviceOptions.list, {});
    const audioEngineering = catalog.find((o) => o.name === "Audio Engineering")!;
    expect(audioEngineering).toBeTruthy();

    // Pre-catalog shape: `service: string`, no `serviceId` — exactly what a
    // real prod row predating this PR's schema deploy looks like.
    const goodId = await run(s.t, (ctx) =>
      ctx.db.insert("audiences", {
        scope: s.chapterId,
        name: "Good",
        source: "person_filters",
        filters: {},
        targeting: {
          groups: [{ conditions: [{ field: "has_service", op: "has", service: "Audio Engineering" }] }],
        },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any),
    );
    const badId = await run(s.t, (ctx) =>
      ctx.db.insert("audiences", {
        scope: s.chapterId,
        name: "Bad",
        source: "person_filters",
        filters: {},
        targeting: {
          groups: [{ conditions: [{ field: "has_service", op: "has", service: "made-up-skill" }] }],
        },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any),
    );

    const result = await run(s.t, (ctx) => runServiceConditionsToIds(ctx));
    expect(result.conditionsConverted).toBe(1);
    expect(result.unresolved).toEqual([
      { audienceId: badId, audienceName: "Bad", value: "made-up-skill", reason: "no_match" },
    ]);

    const good = await run(s.t, (ctx) => ctx.db.get(goodId));
    expect((good?.targeting as any).groups[0].conditions[0].serviceId).toBe(audioEngineering._id);
    expect((good?.targeting as any).groups[0].conditions[0].service).toBeUndefined();

    const bad = await run(s.t, (ctx) => ctx.db.get(badId));
    expect((bad?.targeting as any).groups[0].conditions[0].service).toBe("made-up-skill");
    expect((bad?.targeting as any).groups[0].conditions[0].serviceId).toBeUndefined();

    // Idempotent: re-running neither reconverts the good one nor re-flips the
    // bad one into anything else.
    const second = await run(s.t, (ctx) => runServiceConditionsToIds(ctx));
    expect(second.conditionsConverted).toBe(0);
    expect(second.skippedAlreadyIds).toBe(1);
    expect(second.unresolved).toEqual([
      { audienceId: badId, audienceName: "Bad", value: "made-up-skill", reason: "no_match" },
    ]);
  });

  test("a central-scoped audience's condition has no single-chapter anchor — left untouched, reported", async () => {
    const t = newLooseT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) => runSeedServiceCatalog(ctx));

    const centralId = await run(s.t, (ctx) =>
      ctx.db.insert("audiences", {
        scope: "central",
        name: "Central",
        source: "person_filters",
        filters: {},
        targeting: {
          groups: [{ conditions: [{ field: "has_service", op: "has", service: "Audio Engineering" }] }],
        },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any),
    );

    const result = await run(s.t, (ctx) => runServiceConditionsToIds(ctx));
    expect(result.unresolved).toEqual([
      { audienceId: centralId, audienceName: "Central", value: "Audio Engineering", reason: "no_chapter_anchor" },
    ]);
    const central = await run(s.t, (ctx) => ctx.db.get(centralId));
    expect((central?.targeting as any).groups[0].conditions[0].service).toBe("Audio Engineering");
  });
});
