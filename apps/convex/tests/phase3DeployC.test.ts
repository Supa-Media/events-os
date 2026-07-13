/**
 * Phase 3 — Deploy C (subtractive). Proves the tightened grid-column `type`
 * validator (schema/shared.ts: `v.string()` → union of `COLUMN_TYPES`) is live:
 * a column carrying an in-vocabulary `type` still inserts, and one carrying an
 * out-of-vocabulary `type` is now REJECTED by the schema validator.
 *
 * The `0015_audit_column_types` migration reported 0 offenders on prod, so this
 * tightening validates against all existing columns; this test guards the fence.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter } from "./setup.helpers";

describe("tightened grid column `type` validator", () => {
  async function seedTemplate(s: Awaited<ReturnType<typeof setupChapter>>) {
    return run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T",
        slug: `t-${Date.now()}`,
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("accepts an in-vocabulary type", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedTemplate(s);
    const colId = await run(t, (ctx) =>
      ctx.db.insert("templateColumns", {
        eventTypeId,
        module: "planning_doc",
        key: "cost",
        label: "Cost",
        kind: "custom",
        type: "currency", // ∈ COLUMN_TYPES
        isVisible: true,
        order: 0,
      }),
    );
    const col = await run(t, (ctx) => ctx.db.get(colId));
    expect(col?.type).toBe("currency");
  });

  test("rejects an out-of-vocabulary type", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedTemplate(s);
    await expect(
      run(t, (ctx) =>
        ctx.db.insert("templateColumns", {
          eventTypeId,
          module: "planning_doc",
          key: "bogus",
          label: "Bogus",
          kind: "custom",
          // Not in COLUMN_TYPES — the tightened union must reject this.
          type: "bogus_type" as never,
          isVisible: true,
          order: 0,
        }),
      ),
    ).rejects.toThrow();
  });
});
