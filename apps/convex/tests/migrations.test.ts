/**
 * retireSuppliesPackedStatus — retiring the legacy `packed` supply status.
 *
 * Legacy scopes (status column still carrying `packed`) get: the option
 * dropped, `have_it` made the canonical complete option (appended if an
 * author removed it), `packed` items rewritten to `have_it`, and — on event
 * items — `fields.packedIn` backfilled for anything that was complete under
 * the OLD option set (old terminal meant packed, including author-customized
 * complete values). New-vocabulary scopes are untouched: a `have_it` item on
 * a new event must never gain a phantom packedIn.
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";
import { runRepointDerivedSeatDuties } from "../migrations/0024_repoint_derived_seat_duties";

const LEGACY_OPTIONS = [
  { value: "pull_from_storage", label: "Pull from storage", color: "blue" },
  { value: "have_it", label: "Have it", color: "teal" },
  { value: "packed", label: "Packed", color: "green", isComplete: true },
];

const NEW_OPTIONS = [
  { value: "pull_from_storage", label: "Pull from storage", color: "blue" },
  { value: "have_it", label: "Have it", color: "green", isComplete: true },
];

/** Seed one event with a supplies status column + items. */
type StatusOption = {
  value: string;
  label: string;
  color?: string;
  isComplete?: boolean;
};

async function seedSuppliesEvent(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  options: StatusOption[],
  items: { status?: string; fields?: Record<string, unknown> }[],
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: `t-${Math.floor(now % 100000)}-${items.length}`,
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "E",
      eventDate: now + 7 * 24 * 3600 * 1000,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const columnId = await ctx.db.insert("eventColumns", {
      eventId,
      module: "supplies",
      key: "status",
      label: "Status",
      kind: "system",
      type: "status",
      options,
      isVisible: true,
      order: 0,
    });
    const itemIds: Id<"eventItems">[] = [];
    for (let i = 0; i < items.length; i++) {
      itemIds.push(
        await ctx.db.insert("eventItems", {
          eventId,
          chapterId,
          module: "supplies",
          title: `Supply ${i}`,
          order: i,
          status: items[i].status,
          fields: items[i].fields,
        }),
      );
    }
    return { eventId, columnId, itemIds };
  });
}

describe("retireSuppliesPackedStatus", () => {
  test("legacy scope: packed option dropped, items rewritten, packedIn backfilled", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const legacyCustom = [
      ...LEGACY_OPTIONS,
      // An author-added terminal value — complete under the OLD model.
      { value: "loaded", label: "Loaded", color: "green", isComplete: true },
    ];
    const { columnId, itemIds } = await seedSuppliesEvent(
      t,
      s.chapterId,
      s.userId,
      legacyCustom,
      [
        { status: "packed" }, // → have_it + packedIn
        { status: "loaded" }, // custom-complete → keeps status, gains packedIn
        { status: "have_it" }, // partial under old model → untouched
      ],
    );

    await t.mutation(internal.migrations.retireSuppliesPackedStatus, {});

    const { column, items } = await run(t, async (ctx) => ({
      column: await ctx.db.get(columnId),
      items: await Promise.all(itemIds.map((id) => ctx.db.get(id))),
    }));
    const options = column!.options as any[];
    expect(options.some((o) => o.value === "packed")).toBe(false);
    const haveIt = options.find((o) => o.value === "have_it")!;
    expect(haveIt.isComplete).toBe(true);
    // The author's own complete option survives untouched.
    expect(options.find((o) => o.value === "loaded")!.isComplete).toBe(true);

    expect(items[0]!.status).toBe("have_it");
    expect((items[0]!.fields as any).packedIn).toBe(true);
    expect(items[1]!.status).toBe("loaded");
    expect((items[1]!.fields as any).packedIn).toBe(true);
    expect(items[2]!.status).toBe("have_it");
    expect((items[2]!.fields as any)?.packedIn).toBeUndefined();
  });

  test("legacy scope whose author removed have_it gets it re-appended for the rewrite", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const noHaveIt = [
      { value: "pull_from_storage", label: "Pull from storage" },
      { value: "packed", label: "Packed", color: "green", isComplete: true },
    ];
    const { columnId, itemIds } = await seedSuppliesEvent(
      t,
      s.chapterId,
      s.userId,
      noHaveIt,
      [{ status: "packed" }],
    );
    await t.mutation(internal.migrations.retireSuppliesPackedStatus, {});
    const { column, items } = await run(t, async (ctx) => ({
      column: await ctx.db.get(columnId),
      items: await Promise.all(itemIds.map((id) => ctx.db.get(id))),
    }));
    const options = column!.options as any[];
    // The rewritten item's new value exists and is terminal — the column is
    // never left without a complete option.
    const haveIt = options.find((o) => o.value === "have_it");
    expect(haveIt).toBeDefined();
    expect(haveIt.isComplete).toBe(true);
    expect(items[0]!.status).toBe("have_it");
    expect((items[0]!.fields as any).packedIn).toBe(true);
  });

  test("new-vocabulary scope is untouched: have_it never gains a phantom packedIn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { columnId, itemIds } = await seedSuppliesEvent(
      t,
      s.chapterId,
      s.userId,
      NEW_OPTIONS,
      [{ status: "have_it" }, { status: "have_it", fields: { packedIn: true } }],
    );
    await t.mutation(internal.migrations.retireSuppliesPackedStatus, {});
    const { column, items } = await run(t, async (ctx) => ({
      column: await ctx.db.get(columnId),
      items: await Promise.all(itemIds.map((id) => ctx.db.get(id))),
    }));
    expect(column!.options).toEqual(NEW_OPTIONS);
    expect((items[0]!.fields as any)?.packedIn).toBeUndefined();
    // Already-packed state survives, of course.
    expect((items[1]!.fields as any).packedIn).toBe(true);
  });

  test("backfill inserts missing defaults AND normalizes the leading column order", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A pre-rule supplies grid: no Timing/Due columns, plus an author-added
    // custom column sitting mid-list.
    const { eventId } = await seedSuppliesEvent(
      t,
      s.chapterId,
      s.userId,
      NEW_OPTIONS,
      [],
    );
    await run(t, async (ctx) => {
      const extras = [
        { key: "source", label: "Source", kind: "custom", type: "select" },
        { key: "warehouse", label: "Warehouse", kind: "custom", type: "text" },
        { key: "notes", label: "Notes", kind: "custom", type: "longtext" },
      ] as const;
      for (let i = 0; i < extras.length; i++) {
        await ctx.db.insert("eventColumns", {
          eventId,
          module: "supplies",
          ...extras[i],
          isVisible: true,
          order: i + 1, // after the status column seeded at order 0
        });
      }
      // Title snapshotted at the tail — an out-of-order legacy layout.
      await ctx.db.insert("eventColumns", {
        eventId,
        module: "supplies",
        key: "title",
        label: "Item",
        kind: "system",
        type: "text",
        isVisible: true,
        order: 4,
      });
    });

    const res = await t.mutation(
      internal.migrations.backfillMissingDefaultColumns,
      {},
    );
    expect(res.eventColumnsAdded).toBeGreaterThan(0); // offset/due_date at least
    expect(res.columnsReordered).toBeGreaterThan(0);

    const keys = await run(t, async (ctx) =>
      (
        await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q) =>
            q.eq("eventId", eventId).eq("module", "supplies"),
          )
          .collect()
      )
        .sort((a, b) => a.order - b.order)
        .map((c) => c.key),
    );
    // Canonical lead first; the author's columns keep their relative order;
    // the other backfilled defaults follow.
    expect(keys.slice(0, 4)).toEqual(["title", "status", "offset", "due_date"]);
    expect(keys.indexOf("source")).toBeLessThan(keys.indexOf("warehouse"));
    expect(keys.indexOf("warehouse")).toBeLessThan(keys.indexOf("notes"));
    expect(keys).toContain("container");

    // Idempotent: a second run adds and reorders nothing.
    const again = await t.mutation(
      internal.migrations.backfillMissingDefaultColumns,
      {},
    );
    expect(again.eventColumnsAdded).toBe(0);
    expect(again.columnsReordered).toBe(0);
  });

  test("idempotent: a second run changes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSuppliesEvent(t, s.chapterId, s.userId, LEGACY_OPTIONS, [
      { status: "packed" },
    ]);
    const first = await t.mutation(
      internal.migrations.retireSuppliesPackedStatus,
      {},
    );
    expect(first.columnsUpdated).toBe(1);
    expect(first.eventItemsUpdated).toBe(1);
    const second = await t.mutation(
      internal.migrations.retireSuppliesPackedStatus,
      {},
    );
    expect(second.columnsUpdated).toBe(0);
    expect(second.eventItemsUpdated).toBe(0);
  });
});

/**
 * The auto-migration runner (`migrations.runPending`) + its ledger. Walks the
 * ordered `MIGRATIONS` registry, running each entry not yet in the
 * `schemaMigrations` ledger and recording it, so deploys self-apply and
 * already-run migrations skip.
 */
const REGISTRY_NAMES = [
  "0000_seed_ledger",
  "0007_cleanup_renamed_guide_slugs",
  "0008_cleanup_orphaned_placements",
  "0009_backfill_people_services",
  "0010_backfill_template_people_teams",
  "0011_backfill_person_status",
  "0012_materialize_how_to_docs",
  "0013_fold_project_status_notes",
  "0014_copy_guest_allowlist",
  "0015_audit_column_types",
  "0016_clear_legacy_fields",
  "0017_purge_guest_allowlist",
  "0018_backfill_course_completions",
  "0019_backfill_run_of_show_duration",
  "0020_permits_states_and_fallback",
  "0021_inventory_category_to_tags",
  "0022_seed_seat_defs",
  "0023_seed_seat_assignments",
  "0024_repoint_derived_seat_duties",
  "0025_add_cd_finance_viewer",
  "0026_migrate_budget_v1_lines",
  "0027_sync_linked_budget_identity",
  "0028_reaward_course_completions",
];
const SEEDED_HISTORICAL = [
  "backfillMissingDefaultColumns",
  "migrateRolesToScoped",
  "cleanupLegacyRoles",
  "retireSuppliesPackedStatus",
  "showSuppliesQty",
  "migrateModulesToDeltas",
];

describe("migrations.runPending", () => {
  test("clean DB: applies every registry migration and writes the ledger", async () => {
    const t = newT();
    const res = await t.mutation(internal.migrations.runPending, {});
    expect(res.applied).toEqual(REGISTRY_NAMES);

    const names = await run(t, async (ctx) =>
      (await ctx.db.query("schemaMigrations").collect()).map((r) => r.name),
    );
    // 3 registry entries + 6 historical names seeded by 0000_seed_ledger.
    for (const n of [...REGISTRY_NAMES, ...SEEDED_HISTORICAL]) {
      expect(names).toContain(n);
    }
    expect(names).toHaveLength(REGISTRY_NAMES.length + SEEDED_HISTORICAL.length);
  });

  test("second run is a no-op (everything already ledgered)", async () => {
    const t = newT();
    await t.mutation(internal.migrations.runPending, {});
    const res = await t.mutation(internal.migrations.runPending, {});
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual(REGISTRY_NAMES);
  });

  test("a ledgered name is skipped even when its effect is absent", async () => {
    const t = newT();
    // Pre-ledger 0000_seed_ledger WITHOUT running it, so its effect (the 6
    // historical names) is absent — the ledger, not the effect, is the truth.
    await run(t, async (ctx) => {
      await ctx.db.insert("schemaMigrations", {
        name: "0000_seed_ledger",
        ranAt: Date.now(),
      });
    });
    const res = await t.mutation(internal.migrations.runPending, {});
    expect(res.skipped).toEqual(["0000_seed_ledger"]);
    expect(res.applied).toEqual(
      REGISTRY_NAMES.filter((n) => n !== "0000_seed_ledger"),
    );
    const names = await run(t, async (ctx) =>
      (await ctx.db.query("schemaMigrations").collect()).map((r) => r.name),
    );
    // 0000's body never ran, so no historical names were seeded.
    for (const n of SEEDED_HISTORICAL) expect(names).not.toContain(n);
  });
});

describe("cleanupOrphanedPlacements", () => {
  test("deletes placements whose ref row is gone, keeps live ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemIds } = await seedSuppliesEvent(
      t,
      s.chapterId,
      s.userId,
      NEW_OPTIONS,
      [{}, {}],
    );
    const { orphanId, liveId } = await run(t, async (ctx) => {
      const liveId = await ctx.db.insert("siteMapPlacements", {
        chapterId: s.chapterId,
        eventId,
        kind: "supply",
        refId: String(itemIds[0]),
        x: 0.1,
        y: 0.1,
        createdAt: Date.now(),
      });
      const orphanId = await ctx.db.insert("siteMapPlacements", {
        chapterId: s.chapterId,
        eventId,
        kind: "supply",
        refId: String(itemIds[1]),
        x: 0.2,
        y: 0.2,
        createdAt: Date.now(),
      });
      // Delete the second item, dangling its placement.
      await ctx.db.delete(itemIds[1]);
      return { orphanId, liveId };
    });

    await t.mutation(internal.migrations.runPending, {});

    const { orphan, live } = await run(t, async (ctx) => ({
      orphan: await ctx.db.get(orphanId),
      live: await ctx.db.get(liveId),
    }));
    expect(orphan).toBeNull();
    expect(live).not.toBeNull();
  });
});

/**
 * 0024_repoint_derived_seat_duties — owner decision (verbatim): "the
 * expectation for Chapter Director at one place is gonna be the same for the
 * expectation somewhere else." Chapter Director is ONE role with identical
 * expectations across every chapter, so the central chart's DERIVED
 * `chapter_directors` mirror (holders computed, never assigned) must never
 * carry a duty of its own. This backfill repoints any pre-fix
 * `responsibilities.assigneeSeatIds` entry naming the derived seat onto the
 * real chapter-chart `chapter_director` seat, deduping if a row already had
 * both.
 *
 * These tests only pin the repoint MECHANICS (id-swap + dedupe + idempotency)
 * — the real-world EFFECT of the repoint (an org-wide expectation reaching
 * every chapter's director, not just the authoring chapter's) is pinned by
 * `responsibilities.ts`'s `orgWideCatalog` resolution and exercised end-to-end
 * in `tests/responsibilities.test.ts`'s "a duty authored in chapter A mapped
 * to chapter_director is visible via list/dutiesForSeat from chapter B…"
 * test — this file just proves the migration correctly gets a row OFF the
 * dead derived id (which can never resolve, having no `seatAssignments`) and
 * ONTO the real one, which `orgWideCatalog` then fans out org-wide.
 */
describe("repointDerivedSeatDuties", () => {
  async function seedSeats(t: ReturnType<typeof newT>) {
    return run(t, async (ctx) => {
      const now = Date.now();
      const derivedId = await ctx.db.insert("seatDefs", {
        slug: "chapter_directors",
        title: "Chapter Directors",
        chart: "central",
        parentSlug: "expansion_director",
        maxHolders: 50,
        duties: [],
        capabilities: [],
        sortOrder: 0,
        derived: true,
        createdAt: now,
        updatedAt: now,
      });
      const realId = await ctx.db.insert("seatDefs", {
        slug: "chapter_director",
        title: "Chapter Director",
        chart: "chapter",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: [],
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      });
      // An unrelated seat, present so the migration's dedupe/repoint logic
      // must not disturb entries that aren't the derived seat.
      const otherId = await ctx.db.insert("seatDefs", {
        slug: "treasurer",
        title: "Treasurer",
        chart: "chapter",
        parentSlug: "chapter_director",
        maxHolders: 1,
        duties: [],
        capabilities: [],
        sortOrder: 2,
        createdAt: now,
        updatedAt: now,
      });
      return { derivedId, realId, otherId };
    });
  }

  async function insertDuty(
    t: ReturnType<typeof newT>,
    chapterId: Id<"chapters">,
    userId: Id<"users">,
    title: string,
    assigneeSeatIds: Id<"seatDefs">[] | undefined,
  ) {
    return run(t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId,
        title,
        cadence: "ad_hoc",
        assigneeSeatIds,
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("repoints the derived seat id to the real seat id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { derivedId, realId } = await seedSeats(t);
    const dutyId = await insertDuty(t, s.chapterId, s.userId, "Meet with directors", [
      derivedId,
    ]);

    const res = await run(t, (ctx) => runRepointDerivedSeatDuties(ctx));
    expect(res).toEqual({ repointed: 1, deduped: 0 });

    const row = await run(t, (ctx) => ctx.db.get(dutyId));
    expect(row!.assigneeSeatIds).toEqual([realId]);
  });

  test("dedupes when a row already has both the derived and the real seat", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { derivedId, realId, otherId } = await seedSeats(t);
    const dutyId = await insertDuty(t, s.chapterId, s.userId, "Dual-mapped duty", [
      realId,
      derivedId,
      otherId,
    ]);

    const res = await run(t, (ctx) => runRepointDerivedSeatDuties(ctx));
    expect(res).toEqual({ repointed: 1, deduped: 1 });

    const row = await run(t, (ctx) => ctx.db.get(dutyId));
    // The derived id collapses into the already-present real id; the
    // unrelated seat and ordering of the surviving entries are preserved.
    expect(row!.assigneeSeatIds).toEqual([realId, otherId]);
  });

  test("leaves untouched rows alone: no seats, seats without the derived id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { realId, otherId } = await seedSeats(t);
    const noSeatsId = await insertDuty(
      t,
      s.chapterId,
      s.userId,
      "No seats",
      undefined,
    );
    const realOnlyId = await insertDuty(t, s.chapterId, s.userId, "Real only", [
      realId,
    ]);
    const otherOnlyId = await insertDuty(
      t,
      s.chapterId,
      s.userId,
      "Other only",
      [otherId],
    );

    const res = await run(t, (ctx) => runRepointDerivedSeatDuties(ctx));
    expect(res).toEqual({ repointed: 0, deduped: 0 });

    const [noSeats, realOnly, otherOnly] = await run(t, async (ctx) => [
      await ctx.db.get(noSeatsId),
      await ctx.db.get(realOnlyId),
      await ctx.db.get(otherOnlyId),
    ]);
    expect(noSeats!.assigneeSeatIds).toBeUndefined();
    expect(realOnly!.assigneeSeatIds).toEqual([realId]);
    expect(otherOnly!.assigneeSeatIds).toEqual([otherId]);
  });

  test("idempotent: a second run repoints and dedupes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { derivedId, realId } = await seedSeats(t);
    await insertDuty(t, s.chapterId, s.userId, "Meet with directors", [
      derivedId,
    ]);

    const first = await run(t, (ctx) => runRepointDerivedSeatDuties(ctx));
    expect(first).toEqual({ repointed: 1, deduped: 0 });

    const second = await run(t, (ctx) => runRepointDerivedSeatDuties(ctx));
    expect(second).toEqual({ repointed: 0, deduped: 0 });
  });

  test("safe no-op when seatDefs hasn't been seeded yet", async () => {
    const t = newT();
    await setupChapter(t);
    const res = await run(t, (ctx) => runRepointDerivedSeatDuties(ctx));
    expect(res).toEqual({ repointed: 0, deduped: 0 });
  });
});
