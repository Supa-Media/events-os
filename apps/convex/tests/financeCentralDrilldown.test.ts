/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { RECEIPT_GRACE_DAYS, formatCents } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Central → chapter drill-down + the chapter "Needs attention" queue.
 *
 * `dashboardChapter` now takes an OPTIONAL `chapterId`: absent (or the caller's
 * own chapter) is unchanged (viewer gate); a DIFFERENT chapter requires central
 * (org-wide) reach — so a central admin can drill into any chapter's dashboard
 * but a chapter-scoped manager cannot. The attention queue surfaces (a)
 * reimbursements awaiting approval and (b) cards nearing the 7-day receipt lock.
 *
 * A superuser (`seyi@publicworship.life`) is an implicit CENTRAL manager; a plain
 * chapter caller with a `manager` grant is chapter-only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** A chapter-only manager (person + manager grant, scope chapter). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

describe("dashboardChapter: central → chapter drill-down authz", () => {
  test("a central admin CAN read a different chapter's dashboard via chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");

    const dash = await s.as.query(api.finances.dashboardChapter, {
      chapterId: boston,
    });
    // A well-formed dashboard for the OTHER chapter (not a throw).
    expect(Array.isArray(dash.tiles)).toBe(true);
    expect(Array.isArray(dash.attention)).toBe(true);
  });

  test("a chapter-scoped manager CANNOT read a different chapter's dashboard", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");

    await expect(
      s.as.query(api.finances.dashboardChapter, { chapterId: boston }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("passing the caller's OWN chapterId is unchanged (viewer gate)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    const dash = await s.as.query(api.finances.dashboardChapter, {
      chapterId: s.chapterId,
    });
    expect(Array.isArray(dash.tiles)).toBe(true);
  });

  test("no chapterId arg still resolves the caller's own chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    expect(Array.isArray(dash.tiles)).toBe(true);
  });
});

describe("dashboardChapter: Needs-attention queue", () => {
  test("reimbursements awaiting approval surface as an item with count + total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    // Two approvable reimbursements (submitted + preapproved) → count 2, $80.
    await run(s.t, async (ctx) => {
      const base = {
        chapterId: s.chapterId,
        token: "tok",
        payeeName: "Payee",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await ctx.db.insert("reimbursementRequests", {
        ...base,
        status: "submitted",
        totalCents: 5000,
      });
      await ctx.db.insert("reimbursementRequests", {
        ...base,
        status: "preapproved",
        totalCents: 3000,
      });
      // A PAID one must NOT count (terminal, nothing to approve).
      await ctx.db.insert("reimbursementRequests", {
        ...base,
        status: "paid",
        totalCents: 9999,
      });
    });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const item = dash.attention.find((a) => a.kind === "reimbursements");
    expect(item).toBeDefined();
    expect(item?.badgeCount).toBe(2);
    expect(item?.detail).toContain(formatCents(8000));
  });

  test("cards nearing the receipt lock surface as an item counting cardholders", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asChapterManager(s);

    await run(s.t, async (ctx) => {
      const cardId = await ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      });
      // A missing-receipt outflow WITHIN the grace window (1 day old) → nearing.
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "increase_card",
        flow: "outflow",
        amountCents: 4200,
        postedAt: Date.now() - 1 * DAY_MS,
        status: "unreviewed",
        cardId,
        createdAt: Date.now(),
      });
    });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const item = dash.attention.find((a) => a.kind === "cards");
    expect(item).toBeDefined();
    expect(item?.badgeCount).toBe(1);
  });

  test("a charge already PAST the grace window is not 'nearing' (it auto-locks)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asChapterManager(s);

    await run(s.t, async (ctx) => {
      const cardId = await ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      });
      // Older than the grace window → overdue, not "nearing".
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "increase_card",
        flow: "outflow",
        amountCents: 4200,
        postedAt: Date.now() - (RECEIPT_GRACE_DAYS + 2) * DAY_MS,
        status: "unreviewed",
        cardId,
        createdAt: Date.now(),
      });
    });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    expect(dash.attention.find((a) => a.kind === "cards")).toBeUndefined();
  });

  test("a clean chapter has an empty attention queue", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const dash = await s.as.query(api.finances.dashboardChapter, {});
    expect(dash.attention).toEqual([]);
  });
});
