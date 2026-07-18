import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { AFFORDABILITY_TIERS, chapterAffordability } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Backer milestone ladder (`docs/plans/giving-platform.md` §3):
 *  - `seedMilestonesIfEmpty` idempotency,
 *  - `saveMilestones` validation (increasing thresholds, non-empty labels,
 *    the row cap) and its central-finance-manager gate,
 *  - `listMilestones`'s loose (any org member) read gate,
 *  - `finances.chapterAffordability` reading the configured ladder when rows
 *    exist and falling back to `AFFORDABILITY_TIERS` when the table is empty.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantCentralManager(s: ChapterSetup, personId: Id<"people">): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
}

async function grantChapterManager(s: ChapterSetup, personId: Id<"people">): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function expectConvexError(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ConvexError);
}

const VALID_ROWS = [
  { minBackers: 20, label: "WWS", commitment: "Worship With Strangers, monthly" },
  { minBackers: 30, label: "+Eden", commitment: "Eden" },
  { minBackers: 50, label: "+LTN", commitment: "Love Thy Neighbor" },
];

describe("seedMilestonesIfEmpty (idempotency)", () => {
  test("seeds the ladder from AFFORDABILITY_TIERS when the table is empty", async () => {
    const t = newT();
    await t.mutation(internal.backerMilestones.seedMilestonesIfEmpty, {});

    const rows = await run(t, (ctx) =>
      ctx.db.query("backerMilestones").withIndex("by_minBackers").order("asc").collect(),
    );
    expect(rows.length).toBe(AFFORDABILITY_TIERS.length);
    const sortedTiers = [...AFFORDABILITY_TIERS].sort((a, b) => a.minBackers - b.minBackers);
    rows.forEach((row, i) => {
      expect(row.minBackers).toBe(sortedTiers[i].minBackers);
      expect(row.label).toBe(sortedTiers[i].label);
      expect(row.commitment.length).toBeGreaterThan(0);
      expect(row.sortOrder).toBe(i);
    });
  });

  test("is a no-op once any row exists (doesn't duplicate or overwrite)", async () => {
    const t = newT();
    await t.mutation(internal.backerMilestones.seedMilestonesIfEmpty, {});
    const firstRun = await run(t, (ctx) => ctx.db.query("backerMilestones").collect());

    // A second call must not add more rows or touch the existing ones.
    await t.mutation(internal.backerMilestones.seedMilestonesIfEmpty, {});
    const secondRun = await run(t, (ctx) => ctx.db.query("backerMilestones").collect());
    expect(secondRun.length).toBe(firstRun.length);
    expect(secondRun.map((r) => r._id).sort()).toEqual(firstRun.map((r) => r._id).sort());
  });

  test("does not seed over a manually-configured (non-default) ladder", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("backerMilestones", {
        minBackers: 5,
        label: "Custom",
        commitment: "Something else entirely",
        sortOrder: 0,
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.backerMilestones.seedMilestonesIfEmpty, {});
    const rows = await run(t, (ctx) => ctx.db.query("backerMilestones").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("Custom");
  });
});

describe("listMilestones (read gate)", () => {
  test("any authenticated + allowed org member can read (no finance role needed)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s); // no financeRoles grant at all
    await run(s.t, (ctx) =>
      ctx.db.insert("backerMilestones", {
        minBackers: 20,
        label: "WWS",
        commitment: "Worship With Strangers, monthly",
        sortOrder: 0,
        updatedAt: Date.now(),
      }),
    );
    const rows = await s.as.query(api.backerMilestones.listMilestones, {});
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("WWS");
  });

  test("returns rows ordered by minBackers ascending regardless of insert order", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    for (const row of [VALID_ROWS[2], VALID_ROWS[0], VALID_ROWS[1]]) {
      await run(s.t, (ctx) =>
        ctx.db.insert("backerMilestones", { ...row, sortOrder: 0, updatedAt: Date.now() }),
      );
    }
    const rows = await s.as.query(api.backerMilestones.listMilestones, {});
    expect(rows.map((r) => r.minBackers)).toEqual([20, 30, 50]);
  });
});

describe("saveMilestones (validation + gating)", () => {
  test("a caller with no finance role at all is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, { rows: VALID_ROWS }),
    );
  });

  test("a plain CHAPTER finance manager (not central) is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantChapterManager(s, personId);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, { rows: VALID_ROWS }),
    );
  });

  test("a central finance manager may save a valid ladder", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);

    const saved = await s.as.mutation(api.backerMilestones.saveMilestones, {
      rows: VALID_ROWS,
    });
    expect(saved.length).toBe(3);
    expect(saved.map((r) => r.minBackers)).toEqual([20, 30, 50]);
    expect(saved.every((r) => r.updatedBy === s.userId)).toBe(true);

    const rows = await run(s.t, (ctx) => ctx.db.query("backerMilestones").collect());
    expect(rows.length).toBe(3);
  });

  test("replace-all: a second save fully replaces the first (no leftover rows)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);

    await s.as.mutation(api.backerMilestones.saveMilestones, { rows: VALID_ROWS });
    await s.as.mutation(api.backerMilestones.saveMilestones, {
      rows: [{ minBackers: 10, label: "Solo", commitment: "One rung only" }],
    });

    const rows = await run(s.t, (ctx) => ctx.db.query("backerMilestones").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("Solo");
  });

  test("rejects non-increasing thresholds (out of order)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [
          { minBackers: 30, label: "+Eden", commitment: "Eden" },
          { minBackers: 20, label: "WWS", commitment: "WWS monthly" },
        ],
      }),
    );
  });

  test("rejects duplicate thresholds (not strictly increasing)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [
          { minBackers: 20, label: "WWS", commitment: "WWS monthly" },
          { minBackers: 20, label: "Dup", commitment: "Duplicate threshold" },
        ],
      }),
    );
  });

  test("rejects an empty label", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [{ minBackers: 20, label: "   ", commitment: "WWS monthly" }],
      }),
    );
  });

  test("rejects an empty commitment", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [{ minBackers: 20, label: "WWS", commitment: "" }],
      }),
    );
  });

  test("rejects a non-positive or non-integer minBackers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [{ minBackers: 0, label: "WWS", commitment: "WWS monthly" }],
      }),
    );
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [{ minBackers: 12.5, label: "WWS", commitment: "WWS monthly" }],
      }),
    );
  });

  test("rejects more than the row cap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      minBackers: (i + 1) * 10,
      label: `T${i}`,
      commitment: `Commitment ${i}`,
    }));
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, { rows: tooMany }),
    );
  });

  test("a bad save leaves the previously-saved ladder untouched (all-or-nothing)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);

    await s.as.mutation(api.backerMilestones.saveMilestones, { rows: VALID_ROWS });
    await expectConvexError(
      s.as.mutation(api.backerMilestones.saveMilestones, {
        rows: [{ minBackers: 20, label: "", commitment: "broken" }],
      }),
    );

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("backerMilestones").withIndex("by_minBackers").order("asc").collect(),
    );
    expect(rows.map((r) => r.minBackers)).toEqual([20, 30, 50]);
  });

  test("a superuser (implicit central manager) may save without any stored grant", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    await seedSelfPerson(s);
    const saved = await s.as.mutation(api.backerMilestones.saveMilestones, {
      rows: VALID_ROWS,
    });
    expect(saved.length).toBe(3);
  });
});

describe("finances.chapterAffordability reflects the configured ladder", () => {
  test("falls back to AFFORDABILITY_TIERS when the table is empty", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantChapterManager(s, personId);
    await s.as.mutation(api.finances.setBackerCount, { backerCount: 25 });

    const result = await s.as.query(api.finances.chapterAffordability, {});
    expect(result.tierLabel).toBe(chapterAffordability(25, 1).tierLabel);
    expect(result.tierLabel).toBe("WWS");
  });

  test("reads a configured ladder's tier label once rows exist", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await grantChapterManager(s, personId);

    // A custom ladder — very different thresholds/labels than the constant.
    await s.as.mutation(api.backerMilestones.saveMilestones, {
      rows: [
        { minBackers: 5, label: "Spark", commitment: "First backers" },
        { minBackers: 15, label: "Kindle", commitment: "Monthly gathering" },
      ],
    });
    await s.as.mutation(api.finances.setBackerCount, { backerCount: 10 });

    const result = await s.as.query(api.finances.chapterAffordability, {});
    expect(result.tierLabel).toBe("Spark"); // 10 meets the 5-rung, not the 15-rung
    // The constant's own labels never applied here — proves it read the config.
    expect(result.tierLabel).not.toBe("WWS");
  });

  test("configured ladder still resolves PRE_TIER-equivalent (no rung met) correctly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralManager(s, personId);
    await grantChapterManager(s, personId);

    await s.as.mutation(api.backerMilestones.saveMilestones, {
      rows: [{ minBackers: 100, label: "Big", commitment: "Only at 100" }],
    });
    await s.as.mutation(api.finances.setBackerCount, { backerCount: 5 });

    const result = await s.as.query(api.finances.chapterAffordability, {});
    expect(result.tierLabel).toBe("Pre-tier");
  });
});
