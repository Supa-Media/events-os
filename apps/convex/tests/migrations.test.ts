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
