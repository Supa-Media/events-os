import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Finance settings tests — the deployment-wide `financeSettings` singleton +
 * its runtime `sandboxMode` toggle:
 *  - `setSandboxMode` is SUPERUSER-gated (a non-superuser, even a finance
 *    manager, is rejected),
 *  - it UPSERTS the singleton (at most one row) and stamps `updatedBy`,
 *  - `getFinanceSettings` is finance-VIEWER gated and reads the flag back
 *    (default false when the row doesn't exist).
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

/** Grant the seeded caller a finance role (person linked to the user). */
async function grantFinance(
  s: ChapterSetup,
  role: "viewer" | "manager",
): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Fin Person",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function financeSettingsRows(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("financeSettings").collect());
}

describe("setSandboxMode (superuser gate + upsert)", () => {
  test("a non-superuser (even a finance manager) is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t); // default leader@ — NOT a superuser
    await grantFinance(s, "manager");
    await expect(
      s.as.mutation(api.financeSettings.setSandboxMode, { sandboxMode: true }),
    ).rejects.toBeInstanceOf(ConvexError);
    // No row was written.
    expect((await financeSettingsRows(s)).length).toBe(0);
  });

  test("a superuser flips it on, then off — upserting ONE row + stamping updatedBy", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    const on = await s.as.mutation(api.financeSettings.setSandboxMode, {
      sandboxMode: true,
    });
    expect(on.sandboxMode).toBe(true);

    let rows = await financeSettingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].sandboxMode).toBe(true);
    expect(rows[0].updatedBy).toBe(s.userId);
    expect(rows[0].updatedAt).toBeTruthy();

    // Flip off → same row is patched (upsert, not a second insert).
    const off = await s.as.mutation(api.financeSettings.setSandboxMode, {
      sandboxMode: false,
    });
    expect(off.sandboxMode).toBe(false);
    rows = await financeSettingsRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0].sandboxMode).toBe(false);
  });
});

describe("getFinanceSettings (viewer gate + read)", () => {
  test("defaults to sandboxMode:false when the singleton doesn't exist", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL }); // implicit manager
    const settings = await s.as.query(api.financeSettings.getFinanceSettings, {});
    expect(settings.sandboxMode).toBe(false);
  });

  test("a viewer reads back the flag a superuser set", async () => {
    const t = newT();
    // Superuser flips it on.
    const admin = await setupChapter(t, { email: SUPERUSER_EMAIL });
    await admin.as.mutation(api.financeSettings.setSandboxMode, {
      sandboxMode: true,
    });

    // A finance viewer (in another chapter — the singleton is deployment-wide)
    // reads the same value.
    const s = await setupChapter(t, {
      email: "viewer@publicworship.life",
      chapterName: "Boston",
    });
    await grantFinance(s, "viewer");
    const settings = await s.as.query(api.financeSettings.getFinanceSettings, {});
    expect(settings.sandboxMode).toBe(true);
  });

  test("a caller with no finance role is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t); // leader@, no financeRoles grant
    await expect(
      s.as.query(api.financeSettings.getFinanceSettings, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
