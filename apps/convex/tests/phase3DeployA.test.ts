/**
 * Phase 3 — Deploy A (additive, non-destructive). Covers:
 *   - each backfill migration copies old → new, is idempotent, and NEVER
 *     deletes the legacy field;
 *   - the `guestAllowlist` → `accessAllowlist` copy + the OTP access fallback
 *     (login works reading EITHER table);
 *   - the `eventTypes` → `templates` module rename shim (both `api.eventTypes.*`
 *     and `api.templates.*` resolve to the same behavior).
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";

import { runBackfillPeopleServices } from "../migrations/0009_backfill_people_services";
import { runBackfillTemplatePeopleTeams } from "../migrations/0010_backfill_template_people_teams";
import { runBackfillPersonStatus } from "../migrations/0011_backfill_person_status";
import { runMaterializeHowToDocs } from "../migrations/0012_materialize_how_to_docs";
import { runFoldProjectStatusNotes } from "../migrations/0013_fold_project_status_notes";
import { runCopyGuestAllowlist } from "../migrations/0014_copy_guest_allowlist";

// ── backfillPeopleServices ───────────────────────────────────────────────────
describe("backfillPeopleServices", () => {
  test("copies skills → services, keeps skills, idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Ada",
        skills: ["worship", "vocals"],
        createdAt: Date.now(),
      }),
    );

    const first = await run(t, (ctx) => runBackfillPeopleServices(ctx));
    expect(first.copied).toBe(1);

    const after = await run(t, (ctx) => ctx.db.get(personId));
    expect(after!.services).toEqual(["worship", "vocals"]);
    // Legacy field is NOT dropped.
    expect(after!.skills).toEqual(["worship", "vocals"]);

    // Idempotent: a second run copies nothing.
    const second = await run(t, (ctx) => runBackfillPeopleServices(ctx));
    expect(second.copied).toBe(0);
  });

  test("skips a row that already has services", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Ben",
        skills: ["audio"],
        services: ["logistics"],
        createdAt: Date.now(),
      }),
    );
    const res = await run(t, (ctx) => runBackfillPeopleServices(ctx));
    expect(res.copied).toBe(0);
    const after = await run(t, (ctx) => ctx.db.get(personId));
    expect(after!.services).toEqual(["logistics"]);
  });
});

// ── backfillTemplatePeopleTeams ──────────────────────────────────────────────
describe("backfillTemplatePeopleTeams", () => {
  test("copies team → teams, keeps team, idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { rowId } = await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T",
        slug: `t-${Date.now()}`,
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const rowId = await ctx.db.insert("templatePeople", {
        eventTypeId,
        name: "Stage Manager",
        team: "Production",
        order: 0,
        createdAt: Date.now(),
      });
      return { rowId };
    });

    const first = await run(t, (ctx) => runBackfillTemplatePeopleTeams(ctx));
    expect(first.copied).toBe(1);

    const after = await run(t, (ctx) => ctx.db.get(rowId));
    expect(after!.teams).toEqual(["Production"]);
    expect(after!.team).toBe("Production"); // legacy kept

    const second = await run(t, (ctx) => runBackfillTemplatePeopleTeams(ctx));
    expect(second.copied).toBe(0);
  });
});

// ── backfillPersonStatus ─────────────────────────────────────────────────────
describe("backfillPersonStatus", () => {
  test("derives status from isActive, keeps isActive, idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { activeId, inactiveId } = await run(t, async (ctx) => {
      const activeId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Active",
        isActive: true,
        createdAt: Date.now(),
      });
      const inactiveId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Inactive",
        isActive: false,
        createdAt: Date.now(),
      });
      return { activeId, inactiveId };
    });

    const first = await run(t, (ctx) => runBackfillPersonStatus(ctx));
    expect(first.copied).toBe(2);

    const [active, inactive] = await run(t, async (ctx) => [
      await ctx.db.get(activeId),
      await ctx.db.get(inactiveId),
    ]);
    expect(active!.status).toBe("active");
    expect(active!.isActive).toBe(true); // legacy kept
    expect(inactive!.status).toBe("inactive");
    expect(inactive!.isActive).toBe(false);

    const second = await run(t, (ctx) => runBackfillPersonStatus(ctx));
    expect(second.copied).toBe(0);
  });

  test("never overwrites an existing richer status", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Transitioning",
        status: "transitioning_in",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const res = await run(t, (ctx) => runBackfillPersonStatus(ctx));
    expect(res.copied).toBe(0);
    const after = await run(t, (ctx) => ctx.db.get(personId));
    expect(after!.status).toBe("transitioning_in");
  });
});

// ── materializeHowToDocs ─────────────────────────────────────────────────────
describe("materializeHowToDocs", () => {
  test("creates a note doc, links howToDocId, keeps legacy howTo, idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const dutyId = await run(t, async (ctx) => {
      // A roster person is needed to author the doc.
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Owner",
        userId: s.userId,
        createdAt: Date.now(),
      });
      return ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Post the weekly report",
        howTo: "Fill the template, post in #reports",
        cadence: "weekly",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await run(t, (ctx) => runMaterializeHowToDocs(ctx));
    expect(first.created).toBe(1);

    const duty = await run(t, (ctx) => ctx.db.get(dutyId));
    expect(duty!.howToDocId).toBeTruthy();
    expect(duty!.howTo).toBe("Fill the template, post in #reports"); // legacy kept
    const doc = await run(t, (ctx) => ctx.db.get(duty!.howToDocId!));
    expect(doc!.kind).toBe("note");
    expect(doc!.body).toBe("Fill the template, post in #reports");

    // Idempotent: no duplicate docs.
    const second = await run(t, (ctx) => runMaterializeHowToDocs(ctx));
    expect(second.created).toBe(0);
    const docCount = await run(
      t,
      async (ctx) => (await ctx.db.query("docs").collect()).length,
    );
    expect(docCount).toBe(1);
  });

  test("skips a chapter with no roster person to author", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Do the thing",
        howTo: "Somehow",
        cadence: "ad_hoc",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const res = await run(t, (ctx) => runMaterializeHowToDocs(ctx));
    expect(res.created).toBe(0);
    expect(res.skippedNoAuthor).toBe(1);
  });
});

// ── foldProjectStatusNotes ───────────────────────────────────────────────────
describe("foldProjectStatusNotes", () => {
  test("folds statusNote/nextSteps into one comment, keeps legacy, idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await run(t, async (ctx) => {
      const ownerId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Owner",
        createdAt: Date.now(),
      });
      return ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Music recording",
        status: "in_progress",
        ownerPersonId: ownerId,
        statusNote: "Tracking week 2",
        nextSteps: "Pitch to artists",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await run(t, (ctx) => runFoldProjectStatusNotes(ctx));
    expect(first.folded).toBe(1);

    const { project, comments } = await run(t, async (ctx) => ({
      project: await ctx.db.get(projectId),
      comments: await ctx.db
        .query("projectComments")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    }));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Tracking week 2\n\nNext steps: Pitch to artists");
    // Legacy fields NOT dropped.
    expect(project!.statusNote).toBe("Tracking week 2");
    expect(project!.nextSteps).toBe("Pitch to artists");

    // Idempotent: no duplicate comment.
    const second = await run(t, (ctx) => runFoldProjectStatusNotes(ctx));
    expect(second.folded).toBe(0);
  });
});

// ── copyGuestAllowlist + OTP fallback ────────────────────────────────────────
describe("copyGuestAllowlist + OTP access fallback", () => {
  test("copies guestAllowlist → accessAllowlist, keeps legacy rows, idempotent", async () => {
    const t = newT();
    await run(t, (ctx) =>
      ctx.db.insert("guestAllowlist", {
        email: "guest@gmail.com",
        note: "Invited speaker",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const first = await run(t, (ctx) => runCopyGuestAllowlist(ctx));
    expect(first.copied).toBe(1);

    const { legacy, copied } = await run(t, async (ctx) => ({
      legacy: await ctx.db.query("guestAllowlist").collect(),
      copied: await ctx.db.query("accessAllowlist").collect(),
    }));
    expect(legacy).toHaveLength(1); // legacy row kept
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({
      email: "guest@gmail.com",
      note: "Invited speaker",
      isActive: true,
    });

    // Idempotent: an email already in accessAllowlist is not re-copied.
    const second = await run(t, (ctx) => runCopyGuestAllowlist(ctx));
    expect(second.copied).toBe(0);
  });

  async function signInAs(t: ReturnType<typeof newT>, email: string) {
    const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
    return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  }

  test("Deploy B: a legacy-only guestAllowlist row is NO LONGER honored", async () => {
    const t = newT();
    const as = await signInAs(t, "legacy@gmail.com");
    // Only a legacy row exists — no accessAllowlist row. Post-Deploy-B the
    // fallback is gone (rows were copied by copyGuestAllowlist), so a
    // legacy-only row does not grant access.
    await run(t, (ctx) =>
      ctx.db.insert("guestAllowlist", {
        email: "legacy@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    expect((await as.query(api.profiles.me, {}))?.allowed).toBe(false);
  });

  test("login works reading the accessAllowlist table only", async () => {
    const t = newT();
    const as = await signInAs(t, "moved@gmail.com");
    await run(t, async (ctx) => {
      // A stale legacy row saying active is ignored; only accessAllowlist counts.
      await ctx.db.insert("guestAllowlist", {
        email: "moved@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("accessAllowlist", {
        email: "moved@gmail.com",
        isActive: false,
        createdAt: Date.now(),
      });
    });
    // accessAllowlist row present and revoked → denied (legacy row ignored).
    expect((await as.query(api.profiles.me, {}))?.allowed).toBe(false);
  });

  test("grant writes accessAllowlist and login is admitted through it", async () => {
    const t = newT();
    const admin = await signInAs(t, "lkupo@publicworship.life");
    const guest = await signInAs(t, "vip@gmail.com");
    await admin.mutation(api.accessAllowlist.grantAccess, {
      email: "vip@gmail.com",
      note: "VIP",
    });
    const rows = await run(
      t,
      async (ctx) => await ctx.db.query("accessAllowlist").collect(),
    );
    expect(rows.find((r) => r.email === "vip@gmail.com")?.isActive).toBe(true);
    expect((await guest.query(api.profiles.me, {}))?.allowed).toBe(true);
  });
});

// ── eventTypes → templates module rename shim ────────────────────────────────
describe("eventTypes → templates rename shim", () => {
  test("both api.templates.* and api.eventTypes.* resolve and agree", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Create through the NEW module.
    const eventTypeId = (await s.as.mutation(api.templates.create, {
      name: "Pop Up Worship",
    })) as Id<"eventTypes">;

    // List resolves through BOTH the new module and the legacy shim.
    const viaNew = await s.as.query(api.templates.list, {});
    const viaShim = await s.as.query(api.eventTypes.list, {});
    expect(viaNew.map((x) => x._id)).toContain(eventTypeId);
    expect(viaShim.map((x) => x._id)).toEqual(viaNew.map((x) => x._id));

    // Get resolves through the legacy shim path too.
    const detail = await s.as.query(api.eventTypes.get, { eventTypeId });
    expect(detail?.eventType._id).toBe(eventTypeId);
  });
});
