/// <reference types="vite/client" />
/**
 * Org-wide finance policy config surface (`financeSettings.getFinancePolicy` /
 * `setFinancePolicy`) — the two deployment-wide levers central finance owns:
 * the no-receipt auto-convert deadline and the card-prerequisite course. Both
 * default OFF, writes are gated to a central ED/FM, each field patches
 * independently, and the day count is range-validated. These are the surfaces
 * the Wave 2 charge-lifecycle + Academy-gated-cards features read.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Kansi",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** Make the caller a CENTRAL finance manager (the `setFinancePolicy` gate). */
async function makeCentralFm(s: ChapterSetup): Promise<void> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope: "central",
      title: "finance_manager",
      roleKind: "finance",
      createdAt: Date.now(),
    }),
  );
}

describe("finance policy config", () => {
  test("defaults to both levers off", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await makeCentralFm(s);
    const policy = await s.as.query(api.financeSettings.getFinancePolicy, {});
    expect(policy).toEqual({ noReceiptAutoConvertDays: null, cardPrerequisiteCourseSlug: null });
  });

  test("each field patches independently and round-trips", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await makeCentralFm(s);

    const afterDays = await s.as.mutation(api.financeSettings.setFinancePolicy, {
      noReceiptAutoConvertDays: 14,
    });
    expect(afterDays.noReceiptAutoConvertDays).toBe(14);
    expect(afterDays.cardPrerequisiteCourseSlug).toBeNull();

    // Setting the course leaves the day count untouched (independent field).
    const afterCourse = await s.as.mutation(api.financeSettings.setFinancePolicy, {
      cardPrerequisiteCourseSlug: "finance-card-and-receipts",
    });
    expect(afterCourse.noReceiptAutoConvertDays).toBe(14);
    expect(afterCourse.cardPrerequisiteCourseSlug).toBe("finance-card-and-receipts");

    // Clearing the days leaves the course untouched.
    const afterClear = await s.as.mutation(api.financeSettings.setFinancePolicy, {
      noReceiptAutoConvertDays: null,
    });
    expect(afterClear.noReceiptAutoConvertDays).toBeNull();
    expect(afterClear.cardPrerequisiteCourseSlug).toBe("finance-card-and-receipts");

    const finalRead = await s.as.query(api.financeSettings.getFinancePolicy, {});
    expect(finalRead).toEqual({
      noReceiptAutoConvertDays: null,
      cardPrerequisiteCourseSlug: "finance-card-and-receipts",
    });
  });

  test("rejects an out-of-range or non-integer deadline", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await makeCentralFm(s);
    await expect(
      s.as.mutation(api.financeSettings.setFinancePolicy, { noReceiptAutoConvertDays: 0 }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.financeSettings.setFinancePolicy, { noReceiptAutoConvertDays: 400 }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.financeSettings.setFinancePolicy, { noReceiptAutoConvertDays: 3.5 }),
    ).rejects.toThrow();
  });

  test("a non-central caller cannot set the policy", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A plain chapter member (no central ED/FM title) — the setupChapter admin
    // is a userChapters role, not a central specialized role.
    await expect(
      s.as.mutation(api.financeSettings.setFinancePolicy, { noReceiptAutoConvertDays: 14 }),
    ).rejects.toThrow();
  });
});
