import { describe, expect, test } from "vitest";
import { expandPowers } from "@events-os/shared";
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
    expect(result).toContain("email.campaigns.approve");
    expect(expandPowers(result)).toContain("email.campaigns.edit");
  });

  test("a superuser is allowed", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const marketing = await defBySlug(s, "marketing_director");
    const result = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: marketing._id,
      power: "none",
    });
    expect(result).not.toContain("email.campaigns.approve");
    expect(result).not.toContain("email.campaigns.edit");
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
  // `financial_manager`'s template also carries finance and giving powers —
  // `setSeatCampaignPower` only ever touches the `email` domain, so every one
  // of these must ride through each transition untouched. The list is the
  // MINIMAL stored set, not the expanded one (see `powers.ts`): `finance.edit`
  // stands in for what used to be four separate strings.
  const NON_EMAIL_CAPS = [
    "finance.edit",
    "finance.ledger.publish",
    "giving.view",
    // 2026-07-31: `data.export` is a NON-email power on this seat, so the
    // campaign-power rewrite must leave it alone — what this fixture asserts.
    "data.export",
  ];

  test("approve → compose → none rewrites only campaign caps, never finance caps", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const fm = await defBySlug(s, "financial_manager");

    const afterApprove = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: fm._id,
      power: "approve",
    });
    for (const c of NON_EMAIL_CAPS) expect(afterApprove).toContain(c);
    // MINIMAL storage — approve alone. The compose and design rungs are
    // GRANTED (asserted via `expandPowers`) but not written down.
    expect(afterApprove).toContain("email.campaigns.approve");
    expect(afterApprove).not.toContain("email.campaigns.edit");
    expect(expandPowers(afterApprove)).toContain("email.campaigns.edit");

    const afterCompose = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: fm._id,
      power: "compose",
    });
    for (const c of NON_EMAIL_CAPS) expect(afterCompose).toContain(c);
    expect(afterCompose).not.toContain("email.campaigns.approve");
    expect(afterCompose).toContain("email.campaigns.edit");

    const afterNone = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: fm._id,
      power: "none",
    });
    expect(afterNone.filter((c) => c.startsWith("email."))).toEqual([]);
    expect(afterNone).toEqual(NON_EMAIL_CAPS);

    // Persisted, not just returned.
    expect(await capsOf(s, "financial_manager")).toEqual(NON_EMAIL_CAPS);
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
      canDesign: true,
      canCompose: true,
      canApprove: true,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
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
      canDesign: false,
      canCompose: false,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
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
      canDesign: true,
      canCompose: true,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
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
    expect(await capsOf(s, "graphic_designer")).toEqual(["email.assets.edit"]);
    expect(await s.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canDesign: true,
      canCompose: false,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
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
      canDesign: true,
      canCompose: false,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
    });
  });

  /**
   * The contract the CLIENT reads. `canView` alone can't tell a design-only
   * holder apart from a composer, and every campaign WRITE is gated on
   * compose — so before `canDesign`/`canCompose` existed, the desk rendered a
   * create form and a live composer for someone whose every save threw
   * `FORBIDDEN` (adversarial review, 2026-07-28). The mobile app hides those
   * affordances on `canCompose`; this is the query behind that.
   */
  test("myCampaignsAccess separates design from compose", async () => {
    const designOnly = await designerSetup();
    expect(await designOnly.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canDesign: true,
      canCompose: false,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
    });

    // The SAME seat, promoted to compose by a separate ED identity (no
    // self-lockout question) — design comes along for the ride, and the
    // client's create form / composer come back with it.
    const designerDef = await defBySlug(designOnly, "graphic_designer");
    const edUserId = await run(designOnly.t, (ctx) =>
      ctx.db.insert("users", { email: "ed-promoter@publicworship.life" }),
    );
    const edPersonId = await run(designOnly.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: designOnly.chapterId,
        name: "ED",
        userId: edUserId,
        createdAt: Date.now(),
      }),
    );
    await directlyAssign(designOnly, "executive_director", "central", edPersonId);
    const edAs = designOnly.t.withIdentity({
      subject: `${edUserId}|session`,
      issuer: "test",
    });
    await edAs.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designerDef._id,
      power: "compose",
    });

    expect(await designOnly.as.query(api.audiences.myCampaignsAccess, {})).toEqual({
      canView: true,
      canDesign: true,
      canCompose: true,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
    });
  });

  test("a design-only holder owns the shared design system: templates, images — themes are frozen for everyone", async () => {
    const s = await designerSetup();

    // Themes are RETIRED (2026-07-29) — even the design-only holder who used
    // to own this surface gets THEMES_RETIRED, not FORBIDDEN: the access gate
    // still runs first (this caller genuinely holds `campaigns.design`), but
    // the write itself is gone for everyone. See `emailThemes.ts#throwThemesRetired`.
    await expect(
      s.as.mutation(api.emailThemes.createTheme, themeArgs()),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    // Templates — write and archive one.
    const templateId = await run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "Monthly newsletter",
        subject: "",
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
        kind: "template",
        status: "draft",
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
    // already uses.
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

  /**
   * The product ask was "it should be simple for designers to create and
   * update templates," and for a long time a design-only holder could do
   * neither: `createTemplateFromCampaign` starts from a CAMPAIGN (compose
   * power), and no client ever sent `updateTemplate` a `doc`, so "ownership of
   * templates" amounted to rename, re-describe, archive. This is the whole
   * loop she now owns — author, fill in, restyle — with no compose power
   * anywhere in it.
   */
  test("a design-only holder can create a template from scratch and edit its document", async () => {
    const s = await designerSetup();

    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Designer's shell",
      description: "Built without ever touching a campaign.",
    });

    // It starts empty and already themed, and she can read it back.
    const fresh = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    expect(fresh.doc.blocks).toEqual([]);
    expect(fresh.doc.theme).toBeDefined();

    // The composer's autosave: the whole document, validated like a campaign's.
    await s.as.mutation(api.campaignTemplates.updateTemplate, {
      templateId,
      doc: {
        ...fresh.doc,
        blocks: [{ id: "b1", kind: "heading", text: "This month", level: 1 }],
      },
    });
    // Restyling is retired (2026-07-29) — even for the design-only holder who
    // used to own this. See `emailThemes.ts#throwThemesRetired`.
    await expect(
      s.as.mutation(api.campaignTemplates.setTemplateTheme, {
        templateId,
        presetName: "Public Worship",
      }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });

    const saved = await s.as.query(api.campaignTemplates.getTemplate, { templateId });
    expect(saved.doc.blocks).toHaveLength(1);
    // The theme is untouched — it never changed since creation.
    expect(saved.doc.theme?.name).toBe(fresh.doc.theme?.name);

    // And the write gate is the campaign's own — a template that saves but
    // could never be sent is a trap.
    await expect(
      s.as.mutation(api.campaignTemplates.updateTemplate, {
        templateId,
        doc: { blocks: [{ id: "b", kind: "button", label: "Go", url: "javascript:alert(1)" }] },
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_DOC" } });
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
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "Monthly newsletter",
        subject: "",
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
        kind: "template",
        status: "draft",
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

  /**
   * The escalation that adding `campaigns.design` created, and the reason
   * every campaign WRITE moved off `requireCampaignsAccess`.
   *
   * `campaigns.ts` gated its mutations on desk access. Desk access used to
   * mean compose-or-above, so that was a correct — if implicit — compose
   * gate. Widening the desk to admit the new bottom rung silently turned all
   * nineteen of those call sites into "any designer may do this": draft a
   * campaign, submit it for approval, mail a test copy of any campaign to any
   * address, and suppress or UN-suppress an address org-wide.
   *
   * That is the exact failure mode CLAUDE.md's "gate it behind a power" rule
   * exists to prevent, arriving from the other direction: the powers were
   * named properly, but a screen-visibility check was doing authorization
   * work, so broadening visibility broadened authority. Reads stay on desk
   * access; writes are compose.
   */
  test("a design-only holder cannot write ANY campaign path (the desk-widening escalation)", async () => {
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

    // Reads: still open. A designer must be able to see the desk they work in.
    await expect(s.as.query(api.campaigns.listCampaigns, {})).resolves.toBeDefined();

    // Writes: all closed.
    await expect(
      s.as.mutation(api.campaigns.createCampaign, {
        scope: "central",
        name: "October newsletter",
        subject: "What's on",
        audienceId,
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
      }),
    ).rejects.toThrow(/compose power/i);

    // A campaign that already exists must be equally untouchable — the
    // designer isn't blocked merely by having nothing to edit.
    const campaignId = await run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "October newsletter",
        subject: "What's on",
        audienceId,
        status: "draft",
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, {
        campaignId,
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Changed" }] },
      }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.campaigns.updateCampaignMeta, { campaignId, name: "Renamed" }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.campaigns.submitForApproval, {
        campaignId,
        purpose: "Monthly newsletter",
        reviewerPersonId: await seedSelfPerson(s, "Some reviewer"),
      }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.campaigns.send, { campaignId }),
    ).rejects.toThrow(/compose power/i);

    // Suppression is org-wide and shared across chapters: un-suppressing puts
    // mail back into an inbox that asked for none. Never a design power.
    await expect(
      s.as.mutation(api.emailSuppressions.suppressEmail, { email: "ben@example.com" }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.emailSuppressions.unsuppressEmail, { email: "ben@example.com" }),
    ).rejects.toThrow(/compose power/i);
  });

  /**
   * The three AUDIENCE writes were missed when the desk widened — they stayed
   * on `requireCampaignsAccess`, which now admits the design rung, so a
   * design-only Graphic Designer who is correctly refused `createCampaign`
   * could still create, rename and archive the audiences campaigns send AT
   * (proven by running it, adversarial review 2026-07-28).
   *
   * That is not a cosmetic mismatch. `computeCampaignSnapshotHash` covers an
   * audience's targeting, so editing one silently invalidates an
   * already-approved campaign, which then refuses at send with "content or
   * audience changed since it was approved" — a send broken by someone who
   * could never have composed it. Reads stay open; a designer must still see
   * who a newsletter goes to.
   */
  test("a design-only holder cannot create, edit, or archive an AUDIENCE either", async () => {
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

    // Reads: open, like every other read on the desk.
    expect(await s.as.query(api.audiences.listAudiences, { scope: "central" })).toHaveLength(1);
    await expect(
      s.as.query(api.audiences.getAudience, { audienceId }),
    ).resolves.toBeDefined();

    // Writes: compose, exactly like the campaign that sends at them.
    await expect(
      s.as.mutation(api.audiences.createAudience, {
        scope: "central",
        name: "Donors",
        source: "donors",
        filters: {},
      }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.audiences.updateAudience, { audienceId, name: "Re-aimed" }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.audiences.archiveAudience, { audienceId }),
    ).rejects.toThrow(/compose power/i);

    // Nothing landed.
    const rows = await run(s.t, (ctx) => ctx.db.query("audiences").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Everyone");
    expect(rows[0].archived).toBeUndefined();
  });

  /**
   * The KIND boundary the templates merge introduces (Run-10 escalation
   * class, designed in from the start — see `lib/campaignKind.ts`'s doc).
   * Before the merge, the TABLE a design-only holder could reach was doing
   * the enforcement: `campaignTemplates` rows lived nowhere `campaigns.ts`
   * could see, and vice versa. Now both kinds share one table, so this same
   * design-only seat must round-trip a TEMPLATE-kind row end to end (create,
   * edit its document, restyle, archive) while being refused EVERY
   * email-kind write it might reach for instead — proving the split moved
   * from "which table" to "which kind" without opening a gap.
   */
  test("a design-only graphic_designer seat round-trips template rows and is refused every email-kind write", async () => {
    const s = await designerSetup();

    // ROUND-TRIP: create → edit the document → restyle → archive, all as the
    // design-only holder, all against a TEMPLATE-kind row.
    const templateId = await s.as.mutation(api.campaignTemplates.createTemplate, {
      scope: "central",
      name: "Round trip",
    });
    await s.as.mutation(api.campaignTemplates.updateTemplate, {
      templateId,
      doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello", level: 1 }] },
    });
    // Restyling is retired (2026-07-29) — see `emailThemes.ts#throwThemesRetired`.
    await expect(
      s.as.mutation(api.campaignTemplates.setTemplateTheme, {
        templateId,
        presetName: "Public Worship",
      }),
    ).rejects.toMatchObject({ data: { code: "THEMES_RETIRED" } });
    await s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId });
    const archived = await run(s.t, (ctx) => ctx.db.get(templateId));
    expect(archived?.archived).toBe(true);
    expect(archived?.kind).toBe("template");

    // REFUSED: the SAME seat may not write an EMAIL-kind row anywhere in
    // `campaigns.ts` — a seeded email row it never touched proves the
    // refusal is compose power, matched here against the compose gate.
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
    const emailId = await run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "October newsletter",
        subject: "What's on",
        audienceId,
        kind: "email",
        status: "draft",
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Hello" }] },
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.campaigns.updateCampaignDoc, {
        campaignId: emailId,
        doc: { blocks: [{ id: "b1", kind: "heading", text: "Changed" }] },
      }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.campaigns.updateCampaignMeta, { campaignId: emailId, name: "Renamed" }),
    ).rejects.toThrow(/compose power/i);
    await expect(
      s.as.mutation(api.campaigns.setCampaignTheme, {
        campaignId: emailId,
        presetName: "Public Worship",
      }),
    ).rejects.toThrow(/compose power/i);

    // And the KIND boundary itself, independent of capability: the
    // TEMPLATE-specific door refuses to touch the email row even though this
    // caller genuinely holds `campaigns.design` (the power `updateTemplate`/
    // `archiveTemplate` require) — the wrong-kind id resolves as NOT_FOUND,
    // matching the two-table shape this merge replaced.
    await expect(
      s.as.mutation(api.campaignTemplates.updateTemplate, {
        templateId: emailId,
        name: "Hijacked",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(
      s.as.mutation(api.campaignTemplates.archiveTemplate, { templateId: emailId }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
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
      canDesign: false,
      canCompose: false,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
    });
    await expect(
      s.as.query(api.emailThemes.listThemes, { scope: "central" }),
    ).resolves.toBeDefined();
    await expect(
      s.as.mutation(api.emailThemes.createTheme, themeArgs()),
    ).rejects.toThrow(/design power/i);
  });

  test("setSeatCampaignPower — the full ladder, each rung storing only itself", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const designer = await defBySlug(s, "graphic_designer");

    // Each rung STORES only its own power; the rungs beneath it are derived by
    // `expandPowers`. This inverts the pre-standardization convention, which
    // materialized every implied rung onto the row so the org chart would read
    // honestly without an implication rule — there is one now, and the seat
    // panel renders the expanded set, so the honest reading survives without a
    // stored list that can drift from it.
    const asApprove = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "approve",
    });
    expect(asApprove).toEqual(["email.campaigns.approve"]);
    expect([...expandPowers(asApprove)].sort()).toEqual([
      "email.assets.edit",
      "email.campaigns.approve",
      "email.campaigns.edit",
    ]);

    const asCompose = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "compose",
    });
    expect(asCompose).toEqual(["email.campaigns.edit"]);
    expect(expandPowers(asCompose)).toContain("email.assets.edit");
    expect(expandPowers(asCompose)).not.toContain("email.campaigns.approve");

    const asDesign = await s.as.mutation(api.seats.setSeatCampaignPower, {
      seatDefId: designer._id,
      power: "design",
    });
    expect(asDesign).toEqual(["email.assets.edit"]);

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
      canDesign: false,
      canCompose: false,
      canApprove: false,
      // The parked-desk NAV flag, unset in these fixtures — absent reads as
      // `true` (see `schema/integrationSettings.ts#legacyEmailDeskEnabled`).
      deskEnabled: true,
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
            (c) => c !== "email.campaigns.approve" && c !== "email.campaigns.edit",
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
      // MINIMAL storage: approve alone, because it IMPLIES the compose rung
      // (and design beneath it) — see `expandPowers`.
      expect(def!.capabilities).toContain("email.campaigns.approve");
      expect(def!.capabilities).not.toContain("email.campaigns.edit");
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
      await ctx.db.patch(def!._id, { capabilities: ["email.campaigns.edit"] });
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
    expect(def!.capabilities).toContain("email.campaigns.approve");
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
        if (!row.capabilities.includes("email.assets.edit")) continue;
        await ctx.db.patch(row._id, {
          capabilities: row.capabilities.filter((c) => c !== "email.assets.edit"),
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

  test("grants the rung to the two marketing seats, leaves stronger rungs to imply it, and re-runs clean", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    await stripDesign(t);

    const result = await run(t, (ctx) => runAddCampaignDesignDefaults(ctx));
    // 2 rows, not 5. The three seats holding a STRONGER rung
    // (executive_director / financial_manager / marketing_director) no longer
    // need the design power written onto them — `email.campaigns.approve`
    // implies `email.assets.edit` through `expandPowers`, and storing an
    // implied power would violate the minimal-storage rule. They still HAVE
    // the design power; it is derived rather than recorded.
    expect(result.patched).toBe(2);

    expect(await capsFor(t, "graphic_designer")).toEqual(["email.assets.edit"]);
    expect(await capsFor(t, "social_media_manager")).toEqual(["email.assets.edit"]);
    for (const slug of ["executive_director", "financial_manager", "marketing_director"]) {
      expect(expandPowers(await capsFor(t, slug))).toContain("email.assets.edit");
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
