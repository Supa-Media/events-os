/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  affordabilityTierLabel,
  chapterAffordability,
  BACKER_UNIT_CENTS,
  OPERATING_FLOOR_FIXED_CENTS,
  OPERATING_FLOOR_PER_TEAMMATE_CENTS,
  CENTRAL_SKIM_PCT,
  PRE_TIER_LABEL,
} from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-4.3 — the affordability header: backers → tier → monthly revenue →
 * operating floor → central skim → discretionary.
 *
 *  - Pure math (tier boundaries, teammate scaling, negative discretionary)
 *    against `chapterAffordability`/`affordabilityTierLabel` in
 *    `@events-os/shared` — no Convex needed.
 *  - The `finances.chapterAffordability` query + `finances.setBackerCount`
 *    mutation's authz (chapter finance-manager rank to edit).
 */

describe("chapterAffordability (pure math, packages/shared)", () => {
  test("19 backers is pre-tier", () => {
    expect(affordabilityTierLabel(19)).toBe(PRE_TIER_LABEL);
  });

  test("20 backers hits the WWS tier", () => {
    expect(affordabilityTierLabel(20)).toBe("WWS");
  });

  test("29 backers is still WWS (below the next threshold)", () => {
    expect(affordabilityTierLabel(29)).toBe("WWS");
  });

  test("30 backers hits the +Eden tier", () => {
    expect(affordabilityTierLabel(30)).toBe("+Eden");
  });

  test("49 backers is still +Eden", () => {
    expect(affordabilityTierLabel(49)).toBe("+Eden");
  });

  test("50 backers hits the +LTN tier", () => {
    expect(affordabilityTierLabel(50)).toBe("+LTN");
  });

  test("0 backers is pre-tier", () => {
    expect(affordabilityTierLabel(0)).toBe(PRE_TIER_LABEL);
  });

  test("monthly revenue is backers × $50 (BACKER_UNIT_CENTS)", () => {
    const result = chapterAffordability(20, 5);
    expect(BACKER_UNIT_CENTS).toBe(5000);
    expect(result.monthlyRevenueCents).toBe(20 * 5000);
  });

  test("the playbook's stated $670 floor for a 5-person team", () => {
    const result = chapterAffordability(0, 5);
    expect(result.floorCents).toBe(67_000);
    expect(OPERATING_FLOOR_FIXED_CENTS + 5 * OPERATING_FLOOR_PER_TEAMMATE_CENTS).toBe(
      67_000,
    );
  });

  test("teammate count scales the floor linearly", () => {
    const zero = chapterAffordability(0, 0);
    const three = chapterAffordability(0, 3);
    const ten = chapterAffordability(0, 10);
    expect(zero.floorCents).toBe(OPERATING_FLOOR_FIXED_CENTS);
    expect(three.floorCents).toBe(
      OPERATING_FLOOR_FIXED_CENTS + 3 * OPERATING_FLOOR_PER_TEAMMATE_CENTS,
    );
    expect(ten.floorCents).toBe(
      OPERATING_FLOOR_FIXED_CENTS + 10 * OPERATING_FLOOR_PER_TEAMMATE_CENTS,
    );
  });

  test("skim is 15% of monthly revenue", () => {
    const result = chapterAffordability(40, 5);
    expect(CENTRAL_SKIM_PCT).toBe(0.15);
    expect(result.skimCents).toBe(Math.round(40 * 5000 * 0.15));
  });

  test("discretionary = revenue - floor - skim (comfortably positive)", () => {
    // 50 backers @ 5-person team: revenue $2,500, floor $670, skim $375.
    const result = chapterAffordability(50, 5);
    expect(result.monthlyRevenueCents).toBe(250_000);
    expect(result.floorCents).toBe(67_000);
    expect(result.skimCents).toBe(37_500);
    expect(result.discretionaryCents).toBe(250_000 - 67_000 - 37_500);
    expect(result.discretionaryCents).toBeGreaterThan(0);
  });

  test("discretionary goes negative ('under water') when revenue can't cover floor + skim", () => {
    // 5 backers, 5-person team: revenue $250, floor $670, skim $37.50 → deep negative.
    const result = chapterAffordability(5, 5);
    expect(result.discretionaryCents).toBeLessThan(0);
    expect(result.discretionaryCents).toBe(25_000 - 67_000 - Math.round(25_000 * 0.15));
  });

  test("0 backers, 0 teammates: revenue and skim are 0, discretionary is -floor", () => {
    const result = chapterAffordability(0, 0);
    expect(result.monthlyRevenueCents).toBe(0);
    expect(result.skimCents).toBe(0);
    expect(result.discretionaryCents).toBe(-OPERATING_FLOOR_FIXED_CENTS);
  });
});

// ── Convex query + mutation ───────────────────────────────────────────────────

async function seedSelfPerson(
  s: ChapterSetup,
  opts: { isTeamMember?: boolean; isPlaceholder?: boolean; isSamplePerson?: boolean } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: opts.isTeamMember ?? true,
      isPlaceholder: opts.isPlaceholder,
      isSamplePerson: opts.isSamplePerson,
      createdAt: Date.now(),
    }),
  );
}

async function grantManager(s: ChapterSetup, personId: Id<"people">): Promise<void> {
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

async function grantViewer(s: ChapterSetup, personId: Id<"people">): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "viewer",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function expectConvexError(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ConvexError);
}

describe("finances.chapterAffordability (query)", () => {
  test("unset backer count reads as 0, with 0 teammates on an empty roster", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantViewer(s, personId);

    const result = await s.as.query(api.finances.chapterAffordability, {});
    expect(result.backerCount).toBe(0);
    // The caller themself is a team member (isTeamMember: true), so count is 1.
    expect(result.teammateCount).toBe(1);
    expect(result.canEdit).toBe(false); // viewer, not manager
  });

  test("teammateCount excludes placeholders and sample persons, includes user-linked rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s); // isTeamMember: true, userId set
    await grantViewer(s, personId);

    // A placeholder crew row (materialized stand-in) — excluded.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Placeholder",
        isPlaceholder: true,
        createdAt: Date.now(),
      }),
    );
    // An Academy sample person — excluded even if flagged isTeamMember.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Sample",
        isTeamMember: true,
        isSamplePerson: true,
        createdAt: Date.now(),
      }),
    );
    // A real volunteer with no isTeamMember flag and no user link — excluded.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Volunteer",
        createdAt: Date.now(),
      }),
    );
    // A second real team member (no user link, but isTeamMember: true) — included.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Teammate 2",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.finances.chapterAffordability, {});
    expect(result.teammateCount).toBe(2); // caller + "Teammate 2"
  });

  test("computed fields match the shared pure function for a set backer count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantManager(s, personId);
    await s.as.mutation(api.finances.setBackerCount, { backerCount: 30 });

    const result = await s.as.query(api.finances.chapterAffordability, {});
    const expected = chapterAffordability(30, 1); // 1 teammate: the caller
    expect(result.backerCount).toBe(30);
    expect(result.tierLabel).toBe(expected.tierLabel);
    expect(result.monthlyRevenueCents).toBe(expected.monthlyRevenueCents);
    expect(result.floorCents).toBe(expected.floorCents);
    expect(result.skimCents).toBe(expected.skimCents);
    expect(result.discretionaryCents).toBe(expected.discretionaryCents);
    expect(result.canEdit).toBe(true); // manager
  });

  test("no finance role at all fails even the viewer gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    await expectConvexError(s.as.query(api.finances.chapterAffordability, {}));
  });
});

describe("finances.setBackerCount (mutation authz)", () => {
  test("a plain member (no finance role) is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    await expectConvexError(
      s.as.mutation(api.finances.setBackerCount, { backerCount: 25 }),
    );
  });

  test("a viewer-only grant is FORBIDDEN (needs manager rank)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantViewer(s, personId);
    await expectConvexError(
      s.as.mutation(api.finances.setBackerCount, { backerCount: 25 }),
    );
  });

  test("a chapter finance-manager (Treasurer/Chapter Director rank) may set it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantManager(s, personId);

    const result = await s.as.mutation(api.finances.setBackerCount, {
      backerCount: 42,
    });
    expect(result.backerCount).toBe(42);

    const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
    expect(chapter?.backerCount).toBe(42);
    expect(chapter?.backerCountUpdatedAt).toBeTypeOf("number");
    expect(chapter?.backerCountUpdatedBy).toBe(s.userId);
  });

  test("rejects a negative or non-integer backer count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantManager(s, personId);

    await expectConvexError(
      s.as.mutation(api.finances.setBackerCount, { backerCount: -1 }),
    );
    await expectConvexError(
      s.as.mutation(api.finances.setBackerCount, { backerCount: 2.5 }),
    );
  });
});
