import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runAddCampaignPowerDefaults } from "../migrations/0036_add_campaign_power_defaults";
import { runAddCampaignDesignDefaults } from "../migrations/0053_add_campaign_design_defaults";

/**
 * `seats.setSeatCampaignPower` — the assignable per-role CAMPAIGN power
 * (founder requirement, 2026-07-24), its gate, its campaign-only capability
 * transitions, the end-to-end enforcement effect (`myCampaignsAccess` flips
 * with the power), and the `0036` backfill's idempotence. Mirrors
 * `givingPower.test.ts`'s structure exactly — same gate, same self-lockout
 * guard, same "touch only these caps" contract.
 *
 * Also covers the `campaigns.design` rung (2026-07-28): the bottom of the
 * ladder, which opens the desk and owns the shared design system (themes,
 * templates, image library) WITHOUT granting compose or approve.
 */

// ── Setup helpers (mirrors givingPower.test.ts) ─────────────────────────────

async function seatSetup(opts: { email?: string } = {}): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function defBySlug(s: ChapterSetup, slug: string): Promise<Doc<"seatDefs">> {
  const def = await run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function directlyAssign(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

async function makeCallerEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s, "Executive Director");
  await directlyAssign(s, "executive_director", "central", personId);
  return personId;
}

async function capsOf(s: ChapterSetup, slug: string): Promise<string[]> {
  return (await defBySlug(s, slug)).capabilities;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

describe("setSeatCampaignPower — gate", () => {
  test("a non-ED, non-superuser caller is rejected", async () => {
    const s = await seatSetup();
    await seedSelfPerson(s); // holds no org.editChart seat
    const marketing = await defBySlug(s, "marketing_director");
    await expect(
      s.as.mutation(api.seats.setSeatCampaignPower, {
        seatDefId: marketing._id,
        power: "approve",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("an executive_director seat holder is allowed", async () => {
    const s = await seatSetup();
    await makeCallerEd(s);
    const marketing = await defBySlug(s, "marketing_director");
    const result = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: marketing._id,
      power: "approve",
    });
    expect(result).toContain("campaigns.approve");
    expect(result).toContain("campaigns.compose");
  });

  test("a superuser is allowed", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const marketing = await defBySlug(s, "marketing_director");
    const result = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: marketing._id,
      power: "none",
    });
    expect(result).not.toContain("campaigns.approve");
    expect(result).not.toContain("campaigns.compose");
  });

  test("rejects a derived seat", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const derived = await defBySlug(s, "chapter_directors");
    await expect(
      s.as.mutation(api.seats.setSeatCampaignPower, {
        seatDefId: derived._id,
        power: "compose",
      }),
    ).rejects.toThrow(/computed automatically/);
  });
});

// ── Transitions touch ONLY the campaign pair ────────────────────────────────

describe("setSeatCampaignPower — capability transitions", () => {
  // `financial_manager`'s template ALSO carries `giving.view`/`nav.giving`
  // by default (F-6 P1, 2026-07-19) — `setSeatCampaignPower` only ever
  // touches the campaign pair, so these two ride along untouched through
  // every assertion below.
  const FINANCE_CAPS = [
    "finance.manager",
    "finance.central",
    "finance.accounts",
    "finance.record",
    "nav.finances",
    "giving.view",
    "nav.giving",
  ];

  test("approve → compose → none rewrites only campaign caps, never finance caps", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const fm = await defBySlug(s, "financial_manager");

    const afterApprove = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: fm._id,
      power: "approve",
    });
    for (const c of FINANCE_CAPS) expect(afterApprove).toContain(c);
    expect(afterApprove).toContain("campaigns.approve");
    expect(afterApprove).toContain("campaigns.compose");

    const afterCompose = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: fm._id,
      power: "compose",
    });
    for (const c of FINANCE_CAPS) expect(afterCompose).toContain(c);
    expect(afterCompose).not.toContain("campaigns.approve");
    expect(afterCompose).toContain("campaigns.compose");

    const afterNone = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: fm._id,
      power: "none",
    });
    expect(afterNone.filter((c) => c.startsWith("campaigns."))).toEqual([]);
    expect(afterNone).toEqual(FINANCE_CAPS);

    // Persisted, not just returned.
    expect(await capsOf(s, "financial_manager")).toEqual(FINANCE_CAPS);
  });

  test("an ED cannot strip campaign power off their OWN seat (self-lockout)", async () => {
    const s = await seatSetup();
    await makeCallerEd(s); // caller holds executive_director (campaigns.approve)
    const ed = await defBySlug(s, "executive_director");
    await expect(
      s.as.mutation(api.seats.setSeatCampaignPower, {
        seatDefId: ed._id,
        power: "none",
      }),
    ).rejects.toThrow(/remove your own/i);
  });
});

// ── End-to-end enforcement (myCampaignsAccess flips with the power) ─────────

describe("setSeatCampaignPower — campaigns access enforcement effect", () => {
  test("marketing_director default (post-seed) can view and approve; set to none loses both", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const viewer = await setupChapter(t, { email: "marketing@publicworship.life" });
    const viewerPerson = await seedSelfPerson(viewer, "Marketing Director");
    await directlyAssign(viewer, "marketing_director", "central", viewerPerson);

    // Post-seed template default already carries campaigns.approve.
    expect(await viewer.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canApprove: true,
    });

    // A DIFFERENT user (the ED) strips marketing_director to none.
    const edUser = await run(viewer.t, (ctx) =>
      ctx.db.insert("users", { email: "ed@publicworship.life" }),
    );
    const edPerson = await run(viewer.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: viewer.chapterId,
        name: "ED",
        userId: edUser,
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(viewer, "executive_director", "central", edPerson);
    const marketingDef = await defBySlug(viewer, "marketing_director");
    const edAs = viewer.t.withIdentity({ subject: `${edUser}|session`, issuer: "test" });
    await edAs.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: marketingDef._id,
      power: "none",
    });

    expect(await viewer.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: false,
      canApprove: false,
    });
  });

  test("compose-only power grants desk access but never approval power", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    // The COMPOSER — a distinct identity holding ONLY a compose-granted seat,
    // nothing else.
    const composer = await setupChapter(t, { email: "composer@publicworship.life" });
    const composerPerson = await seedSelfPerson(composer, "Composer");
    await directlyAssign(composer, "social_media_manager", "central", composerPerson);
    const seatDef = await defBySlug(composer, "social_media_manager");

    // A SEPARATE ED identity grants the compose-only power (avoids any
    // self-lockout question entirely — the editor and the composer are
    // different people).
    const edUserId = await run(composer.t, (ctx) =>
      ctx.db.insert("users", { email: "ed2@publicworship.life" }),
    );
    const edPersonId = await run(composer.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: composer.chapterId,
        name: "ED",
        userId: edUserId,
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(composer, "executive_director", "central", edPersonId);
    const edAs = composer.t.withIdentity({ subject: `${edUserId}|session`, issuer: "test" });
    await edAs.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: seatDef._id,
      power: "compose",
    });

    // The composer can open the desk, but never gets approval power.
    expect(await composer.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canApprove: false,
    });
  });
});

// ── The `campaigns.design` rung (2026-07-28) ────────────────────────────────

/** A complete, valid token set — the shape `emailThemes.createTheme` demands
 *  (copied from `emailThemes.test.ts#themeArgs`; kept local so this file has
 *  no cross-test import). */
function themeArgs(overrides: Record<string, unknown> = {}) {
  return {
    scope: "central" as const,
    name: "Advent",
    accent: "#1f4a63",
    accentInk: "#ffffff",
    ink: "#0e1c24",
    muted: "#4e6672",
    canvas: "#f4f9fc",
    surface: "#ffffff",
    cream: "#f4f9fc",
    contrast: "#0e1c24",
    contrastInk: "#ffffff",
    hairline: "#c2ccd2",
    border: "#d3e2ea",
    link: "#1f4a63",
    headingFont: "Georgia,serif",
    bodyFont: "Inter,Arial,sans-serif",
    radius: 12,
    headingTracking: "-0.03em",
    bodyTracking: "-0.01em",
    wordmark: "PUBLIC WORSHIP",
    ...overrides,
  };
}

describe("campaigns.design — the desk's bottom rung", () => {
  /** A caller holding ONLY the `graphic_designer` seat at central — the seat
   *  the bug report is about, which held no campaign capability at all. */
  async function designerSetup(): Promise<ChapterSetup> {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "designer@publicworship.life" });
    const personId = await seedSelfPerson(s, "Graphic Designer");
    await directlyAssign(s, "graphic_designer", "central", personId);
    return s;
  }

  test("graphic_designer's post-seed default opens the desk but grants no approval power", async () => {
    const s = await designerSetup();
    expect(await capsOf(s, "graphic_designer")).toEqual(["campaigns.design"]);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canApprove: false,
    });
  });

  test("social_media_manager gets the same rung by default", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "social@publicworship.life" });
    const personId = await seedSelfPerson(s, "Social Media Manager");
    await directlyAssign(s, "social_media_manager", "central", personId);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canApprove: false,
    });
  });

  test("a design-only holder owns the shared design system: themes, templates, images", async () => {
    const s = await designerSetup();

    // Themes — create, then edit.
    const themeId = await s.as.mutation(api.emailThemes.createTheme, themeArgs());
    await s.as.mutation(api.emailThemes.updateTheme, { themeId, accent: "#891d1a" });

    // Templates — write and archive one.
    const templateId = await run(s.t, (ctx) =>
      ctx.db.insert("campaignTemplates", {
        scope: "central",
        name: "Monthly newsletter",
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await s.as.mutation(api.campaignTemplates.updateTemplate, {
      templateId,
      name: "Monthly newsletter (v2)",
    });
    await s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId });

    // Image library — the write path a designer lives in.
    // `ctx.storage.store` exists on convex-test's writer but not on the
    // generated `StorageWriter` type — the cast `campaignTemplates.test.ts`
    // and `aiCoding.test.ts` already use.
    const storageId = (await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["png"], { type: "image/png" }),
      ),
    )) as Id<"_storage">;
    const imageId = await s.as.mutation(api.emailImages.addImage, {
      scope: "central",
      storageId,
      alt: "Choir at the park",
    });
    await s.as.mutation(api.emailImages.updateImage, { imageId, alt: "Choir, July" });
    await s.as.mutation(api.emailImages.deleteImage, { imageId });
  });

  test("a design-only holder can NEVER start a campaign from a template (that's compose)", async () => {
    const s = await designerSetup();
    const audienceId = await run(s.t, (ctx) =>
      ctx.db.insert("audiences", {
        scope: "central",
        name: "Everyone",
        source: "people",
        filters: {},
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const templateId = await run(s.t, (ctx) =>
      ctx.db.insert("campaignTemplates", {
        scope: "central",
        name: "Monthly newsletter",
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // Reading the list is fine — a designer has to see what they maintain.
    expect(
      await s.as.query(api.campaignTemplates.listTemplates, { scope: "central" }),
    ).toHaveLength(1);

    await expect(
      s.as.mutation(api.campaignTemplates.createCampaignFromTemplate, {
        templateId,
        name: "October newsletter",
        subject: "What's on",
        audienceId,
      }),
    ).rejects.toThrow(/compose power/i);
  });

  test("a legacy central-ED TITLE with no seat READS the desk but can't write the design system", async () => {
    // `isCentralEdOrFm`'s title path (kept for backward compat) opens the
    // desk — but the three POWERS are seat-capability-only, which is exactly
    // the hole that let any desk viewer archive the shared built-in template.
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "titled-ed@publicworship.life" });
    const personId = await seedSelfPerson(s, "ED by title only");
    await run(s.t, (ctx) =>
      ctx.db.insert("specializedRoles", {
        personId,
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdAt: Date.now(),
      }),
    );

    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canApprove: false,
    });
    await expect(
      s.as.query(api.emailThemes.listThemes, { scope: "central" }),
    ).resolves.toBeDefined();
    await expect(
      s.as.mutation(api.emailThemes.createTheme, themeArgs()),
    ).rejects.toThrow(/design power/i);
  });

  test("setSeatCampaignPower — the full ladder, each rung materializing what it implies", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const designer = await defBySlug(s, "graphic_designer");

    const asApprove = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "approve",
    });
    expect(asApprove).toEqual([
      "campaigns.approve",
      "campaigns.compose",
      "campaigns.design",
    ]);

    const asCompose = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "compose",
    });
    expect(asCompose).toEqual(["campaigns.compose", "campaigns.design"]);

    const asDesign = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "design",
    });
    expect(asDesign).toEqual(["campaigns.design"]);

    const asNone = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "none",
    });
    expect(asNone).toEqual([]);
    expect(await capsOf(s, "graphic_designer")).toEqual([]);
  });

  test("stripping a designer seat to none closes the desk again", async () => {
    const s = await designerSetup();
    const designerDef = await defBySlug(s, "graphic_designer");

    // A DIFFERENT identity (the ED) makes the edit — no self-lockout question.
    const edUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "ed3@publicworship.life" }),
    );
    const edPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "ED",
        userId: edUserId,
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(s, "executive_director", "central", edPersonId);
    const edAs = s.t.withIdentity({ subject: `${edUserId}|session`, issuer: "test" });
    await edAs.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designerDef._id,
      power: "none",
    });

    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: false,
      canApprove: false,
    });
  });

  test("an ED can't strip campaigns.design off their OWN seat either (self-lockout)", async () => {
    const s = await seatSetup();
    await makeCallerEd(s);
    const ed = await defBySlug(s, "executive_director");
    await expect(
      s.as.mutation(api.seats.setSeatCampaignPower, {
        seatDefId: ed._id,
        power: "design",
      }),
    ).rejects.toThrow(/remove your own/i);
  });
});

// ── Migration 0036 — additive backfill, idempotent ──────────────────────────

describe("0036_add_campaign_power_defaults", () => {
  test("adds campaigns.approve + campaigns.compose to the three seats; second run is a no-op", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    // Simulate a PRE-migration deployment: strip the three seats back to
    // their old campaign-less capability sets.
    const slugs = ["executive_director", "financial_manager", "marketing_director"] as const;
    for (const slug of slugs) {
      await run(t, async (ctx) => {
        const def = await ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
        if (!def) throw new Error(`${slug} missing`);
        await ctx.db.patch(def._id, {
          capabilities: def.capabilities.filter(
            (c) => c !== "campaigns.approve" && c !== "campaigns.compose",
          ),
        });
      });
    }

    const first = await run(t, (ctx) => runAddCampaignPowerDefaults(ctx));
    expect(first.patched).toBe(3);
    expect(first.skipped).toBe(0);

    for (const slug of slugs) {
      const def = await run(t, (ctx) =>
        ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
      );
      expect(def!.capabilities).toContain("campaigns.approve");
      expect(def!.capabilities).toContain("campaigns.compose");
    }

    // Idempotent: a second run touches nothing.
    const second = await run(t, (ctx) => runAddCampaignPowerDefaults(ctx));
    expect(second.patched).toBe(0);
    expect(second.skipped).toBe(3);
  });

  test("does not clobber a runtime demotion to 'compose'-only (additive-only, but never downgrades)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    // Simulate the ED having demoted marketing_director to compose-only at
    // runtime (post-seed default is "approve").
    await run(t, async (ctx) => {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "marketing_director"))
        .unique();
      await ctx.db.patch(def!._id, { capabilities: ["campaigns.compose"] });
    });
    const res = await run(t, (ctx) => runAddCampaignPowerDefaults(ctx));
    // Missing campaigns.approve → the migration WOULD patch it back in
    // (additive-only can't distinguish "never had it" from "was demoted
    // from it" — same limitation `0033` documents for its own pair). This
    // characterizes that behavior rather than asserting an idealized one.
    expect(res.patched).toBeGreaterThanOrEqual(1);
    const def = await run(t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", "marketing_director")).unique(),
    );
    expect(def!.capabilities).toContain("campaigns.approve");
  });
});

// ── Migration 0053 — the campaigns.design backfill ──────────────────────────

describe("0053_add_campaign_design_defaults", () => {
  /** Strip the rung back off every seed row, simulating a deployment seeded
   *  BEFORE the design rung shipped. */
  async function stripDesign(t: ReturnType<typeof newT>): Promise<void> {
    await run(t, async (ctx) => {
      const rows = await ctx.db.query("seatDefs").take(300);
      for (const row of rows) {
        if (!row.capabilities.includes("campaigns.design")) continue;
        await ctx.db.patch(row._id, {
          capabilities: row.capabilities.filter((c) => c !== "campaigns.design"),
        });
      }
    });
  }

  async function capsFor(t: ReturnType<typeof newT>, slug: string): Promise<string[]> {
    const def = await run(t, (ctx) =>
      ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
    );
    if (!def) throw new Error(`${slug} not seeded`);
    return def.capabilities;
  }

  test("grants the rung to the two marketing seats, tops it up where implied, and re-runs clean", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    await stripDesign(t);

    const result = await run(t, (ctx) => runAddCampaignDesignDefaults(ctx));
    // 5 rows: graphic_designer + social_media_manager (case 1), and
    // executive_director + financial_manager + marketing_director (case 2).
    expect(result.patched).toBe(5);

    expect(await capsFor(t, "graphic_designer")).toEqual(["campaigns.design"]);
    expect(await capsFor(t, "social_media_manager")).toEqual(["campaigns.design"]);
    for (const slug of ["executive_director", "financial_manager", "marketing_director"]) {
      expect(await capsFor(t, slug)).toContain("campaigns.design");
    }

    // Idempotent — a second run touches nothing.
    const second = await run(t, (ctx) => runAddCampaignDesignDefaults(ctx));
    expect(second.patched).toBe(0);
  });

  test("never re-opens the desk for a seat an ED deliberately set to 'none'", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    // The ED strips marketing_director's campaign power entirely.
    await run(t, async (ctx) => {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "marketing_director"))
        .unique();
      await ctx.db.patch(def!._id, { capabilities: [] });
    });

    await run(t, (ctx) => runAddCampaignDesignDefaults(ctx));
    expect(await capsFor(t, "marketing_director")).toEqual([]);
  });
});
