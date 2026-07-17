/**
 * Test suite for migration 0023: seeding seatAssignments from specializedRoles.
 *
 * This migration maps legacy specializedRoles rows to seatAssignments via a
 * title@scope → seat slug mapping, preserves timestamps and grantedBy metadata,
 * and ensures idempotency by skipping pre-existing assignments.
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";

describe("0023_seed_seat_assignments", () => {
  test("migration creates correct seatAssignments from all four title/scope combinations", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Seed specializedRoles before running migrations.
    await run(t, async (ctx) => {
      // Create test people for each role.
      const peopleIds: Id<"people">[] = [];
      for (let i = 0; i < 4; i++) {
        peopleIds.push(
          await ctx.db.insert("people", {
            chapterId: s.chapterId,
            name: `Person${i}`,
            email: `person${i}@test.com`,
            createdAt: Date.now(),
          }),
        );
      }

      const createdBy = s.userId;
      const createdAt = Date.now();

      // Create specializedRoles rows for all four mapping types:
      // 1. executive_director @ central
      await ctx.db.insert("specializedRoles", {
        personId: peopleIds[0],
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdBy,
        createdAt,
      });

      // 2. president @ chapter (maps to chapter_director)
      await ctx.db.insert("specializedRoles", {
        personId: peopleIds[1],
        scope: s.chapterId,
        title: "president",
        roleKind: "leadership",
        createdBy,
        createdAt: createdAt + 1000,
      });

      // 3. finance_manager @ central (maps to financial_manager)
      await ctx.db.insert("specializedRoles", {
        personId: peopleIds[2],
        scope: "central",
        title: "finance_manager",
        roleKind: "finance",
        createdBy,
        createdAt: createdAt + 2000,
      });

      // 4. finance_manager @ chapter (maps to treasurer)
      await ctx.db.insert("specializedRoles", {
        personId: peopleIds[3],
        scope: s.chapterId,
        title: "finance_manager",
        roleKind: "finance",
        createdBy: undefined, // Test case: no createdBy
        createdAt: createdAt + 3000,
      });
    });

    // Run the migration via runPending.
    await t.mutation(internal.migrations.runPending, {});

    // Verify the seatAssignments were created with correct mappings.
    const assignments = await run(t, async (ctx) => {
      const rows = await ctx.db.query("seatAssignments").collect();
      return rows.sort((a, b) => a.createdAt - b.createdAt);
    });

    expect(assignments).toHaveLength(4);

    // Verify seat defs were resolved correctly.
    const seatDefED = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "executive_director"))
        .unique(),
    );
    const seatDefChapterDir = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
        .unique(),
    );
    const seatDefFinMgr = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "financial_manager"))
        .unique(),
    );
    const seatDefTreasurer = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique(),
    );

    // Check all four assignments in order.
    expect(assignments[0].seatDefId).toBe(seatDefED?._id);
    expect(assignments[0].scope).toBe("central");
    expect(assignments[0].grantedBy).toBe(s.userId);

    expect(assignments[1].seatDefId).toBe(seatDefChapterDir?._id);
    expect(assignments[1].scope).toBe(s.chapterId);

    expect(assignments[2].seatDefId).toBe(seatDefFinMgr?._id);
    expect(assignments[2].scope).toBe("central");

    expect(assignments[3].seatDefId).toBe(seatDefTreasurer?._id);
    expect(assignments[3].scope).toBe(s.chapterId);
    expect(assignments[3].grantedBy).toBeUndefined();
  });

  test("migration is idempotent: second run of runPending skips all existing assignments", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Seed specializedRoles before running migrations.
    await run(t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Test",
        email: "test@example.com",
        createdAt: Date.now(),
      });

      await ctx.db.insert("specializedRoles", {
        personId,
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdBy: s.userId,
        createdAt: Date.now(),
      });
    });

    // Run all pending migrations for the first time.
    await t.mutation(internal.migrations.runPending, {});

    // Verify the assignment was created.
    let assignments = await run(t, (ctx) =>
      ctx.db.query("seatAssignments").collect(),
    );
    expect(assignments).toHaveLength(1);

    // Run migrations again - should be a no-op via ledger.
    const res2 = await t.mutation(internal.migrations.runPending, {});

    // All migrations should be skipped (already in ledger).
    expect(res2.applied).toEqual([]);
    expect(res2.skipped.length).toBeGreaterThan(0);

    // Verify no duplicate was created.
    assignments = await run(t, (ctx) =>
      ctx.db.query("seatAssignments").collect(),
    );
    expect(assignments).toHaveLength(1);
  });


  test("pre-existing identical assignments are not duplicated", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Seed both an assignment and a matching specializedRoles row.
    await run(t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Duplicate",
        email: "duplicate@example.com",
        createdAt: Date.now(),
      });

      // Create the specializedRoles row.
      await ctx.db.insert("specializedRoles", {
        personId,
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdAt: Date.now(),
      });
    });

    await t.mutation(internal.migrations.runPending, {});

    // Verify only one assignment exists (not duplicated).
    const assignments = await run(t, (ctx) =>
      ctx.db.query("seatAssignments").collect(),
    );

    expect(assignments).toHaveLength(1);
  });
});
