import { describe, expect, test } from "vitest";
import { DEFAULT_ROLES } from "@events-os/shared";
import {
  LTN_PLANNING,
  LTN_COMMS,
  LTN_RUN_OF_SHOW,
  LTN_VOLUNTEER,
  LTN_PERMITS,
  LTN_SUPPLIES,
  LTN_RETRO,
  LTN_ROWS_BY_MODULE,
  LTN_DESCRIPTION,
} from "../lib/seed/loveThyNeighbor";
import { newT, run, setupChapter } from "./setup.helpers";
import { buildChapterRolesAndTemplates } from "../lib/seed/templates";
import { internal } from "../_generated/api";

/**
 * The ported Love Thy Neighbor row data must only ever reference the 4 real
 * template role keys — a typo'd role key silently resolves to `undefined` at
 * insert time (`addTemplateItems`'s `roleIdByKey[r.role]` doesn't throw on a
 * miss), so this is the only guardrail against a row quietly losing its owner.
 */
describe("Love Thy Neighbor seed data", () => {
  const validKeys = new Set(DEFAULT_ROLES.map((r) => r.key));
  const allRows = [
    ...LTN_PLANNING,
    ...LTN_COMMS,
    ...LTN_RUN_OF_SHOW,
    ...LTN_VOLUNTEER,
    ...LTN_PERMITS,
    ...LTN_SUPPLIES,
    ...LTN_RETRO,
  ];

  test("every row's role key is a real DEFAULT_ROLES key", () => {
    for (const row of allRows) {
      if (row.role) expect(validKeys.has(row.role)).toBe(true);
    }
  });

  test("LTN_ROWS_BY_MODULE covers all 7 grid modules with the matching arrays", () => {
    expect(LTN_ROWS_BY_MODULE.planning_doc).toBe(LTN_PLANNING);
    expect(LTN_ROWS_BY_MODULE.comms).toBe(LTN_COMMS);
    expect(LTN_ROWS_BY_MODULE.run_of_show).toBe(LTN_RUN_OF_SHOW);
    expect(LTN_ROWS_BY_MODULE.volunteer_expectations).toBe(LTN_VOLUNTEER);
    expect(LTN_ROWS_BY_MODULE.permits).toBe(LTN_PERMITS);
    expect(LTN_ROWS_BY_MODULE.supplies).toBe(LTN_SUPPLIES);
    expect(LTN_ROWS_BY_MODULE.retro).toBe(LTN_RETRO);
  });

  test("planning_doc rows outnumber Eden's 10 (this is LTN's own content, not a clone)", () => {
    expect(LTN_PLANNING.length).toBeGreaterThan(10);
  });

  test("description is set and does not mention Eden", () => {
    expect(LTN_DESCRIPTION.length).toBeGreaterThan(0);
    expect(LTN_DESCRIPTION.toLowerCase()).not.toContain("eden");
  });
});

describe("buildChapterRolesAndTemplates — Love Thy Neighbor", () => {
  test("LTN gets its own roles + items, independent of Eden", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);

    const { edenId, ltnId } = await run(t, (ctx) =>
      buildChapterRolesAndTemplates(ctx, chapterId, userId, Date.now()),
    );

    const ltn = await run(t, (ctx) => ctx.db.get(ltnId));
    expect(ltn?.deriveFromEventTypeId).toBeUndefined();

    const [edenRoles, ltnRoles] = await Promise.all([
      run(t, (ctx) =>
        ctx.db.query("templateRoles").withIndex("by_template", (q) => q.eq("eventTypeId", edenId)).collect(),
      ),
      run(t, (ctx) =>
        ctx.db.query("templateRoles").withIndex("by_template", (q) => q.eq("eventTypeId", ltnId)).collect(),
      ),
    ]);
    // Same 4 role keys, but distinct rows (own ids, not shared with Eden).
    expect(ltnRoles.map((r) => r.key).sort()).toEqual(edenRoles.map((r) => r.key).sort());
    expect(new Set(ltnRoles.map((r) => r._id))).not.toEqual(new Set(edenRoles.map((r) => r._id)));

    const ltnPlanningItems = await run(t, (ctx) =>
      ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) => q.eq("eventTypeId", ltnId).eq("module", "planning_doc"))
        .collect(),
    );
    // LTN's own 20-row Tasks list, not Eden's 10.
    expect(ltnPlanningItems.length).toBe(20);
  });
});

describe("seed.upgradeLoveThyNeighborTemplate", () => {
  test("replaces an existing chapter's stale LTN content in place, preserving its id", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);

    // Simulate prod's pre-migration state: an Eden-derived LTN stub with a
    // stale role/item shape (no LTN-specific content).
    const staleLtnId = await run(t, async (ctx) => {
      const now = Date.now();
      const edenId = await ctx.db.insert("eventTypes", {
        chapterId, name: "Eden", slug: "eden", disabledCoreModules: [],
        version: 1, isArchived: false, createdBy: userId, createdAt: now, updatedAt: now,
      });
      const ltnId = await ctx.db.insert("eventTypes", {
        chapterId, name: "Love Thy Neighbor", slug: "love-thy-neighbor",
        deriveFromEventTypeId: edenId, disabledCoreModules: [],
        version: 1, isArchived: false, createdBy: userId, createdAt: now, updatedAt: now,
      });
      const roleId = await ctx.db.insert("templateRoles", {
        eventTypeId: ltnId, key: "event_lead", label: "Event Lead / PM", order: 0, isArchived: false,
      });
      await ctx.db.insert("templateItems", {
        eventTypeId: ltnId, module: "planning_doc", title: "Stale Eden-clone row", order: 0, roleId,
      });
      return ltnId;
    });

    const result = await t.mutation(internal.seed.upgradeLoveThyNeighborTemplate, {
      chapterId,
      createdBy: userId,
    });

    expect(result.eventTypeId).toBe(staleLtnId); // same document, patched in place
    expect(result.replaced).toBe(true);

    const ltn = await run(t, (ctx) => ctx.db.get(staleLtnId));
    expect(ltn?.deriveFromEventTypeId).toBeUndefined();

    const items = await run(t, (ctx) =>
      ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) => q.eq("eventTypeId", staleLtnId).eq("module", "planning_doc"))
        .collect(),
    );
    expect(items.some((i) => i.title === "Stale Eden-clone row")).toBe(false);
    expect(items.length).toBe(20);

    // Idempotent: running it again doesn't duplicate rows.
    await t.mutation(internal.seed.upgradeLoveThyNeighborTemplate, { chapterId, createdBy: userId });
    const itemsAfterSecondRun = await run(t, (ctx) =>
      ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) => q.eq("eventTypeId", staleLtnId).eq("module", "planning_doc"))
        .collect(),
    );
    expect(itemsAfterSecondRun.length).toBe(20);
  });

  test("creates LTN fresh when the chapter has none yet", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);

    const result = await t.mutation(internal.seed.upgradeLoveThyNeighborTemplate, {
      chapterId,
      createdBy: userId,
    });

    expect(result.replaced).toBe(false);
    const ltn = await run(t, (ctx) => ctx.db.get(result.eventTypeId));
    expect(ltn?.name).toBe("Love Thy Neighbor");
  });
});
