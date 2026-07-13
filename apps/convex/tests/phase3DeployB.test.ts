/**
 * Phase 3 — Deploy B (read cutover + legacy drain). Covers:
 *   - `clearLegacyFields` (0016) nulls every legacy field but leaves the new
 *     fields intact, and is idempotent;
 *   - `purgeGuestAllowlist` (0017) empties the legacy table and is idempotent,
 *     and OTP login still works reading `accessAllowlist` only;
 *   - readers return correct data from rows that carry ONLY the new fields.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";

import { runClearLegacyFields } from "../migrations/0016_clear_legacy_fields";
import { runPurgeGuestAllowlist } from "../migrations/0017_purge_guest_allowlist";

// ── clearLegacyFields (0016) ─────────────────────────────────────────────────
describe("clearLegacyFields", () => {
  test("nulls every legacy field, keeps the new fields, idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();

    const ids = await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T",
        slug: `t-${now}`,
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Ada",
        // legacy + new both present (post-backfill state)
        skills: ["worship"],
        services: ["worship"],
        isActive: true,
        status: "active",
        createdAt: now,
      });
      const templatePersonId = await ctx.db.insert("templatePeople", {
        eventTypeId,
        name: "Greeter",
        team: "welcome",
        teams: ["welcome"],
        order: 0,
        createdAt: now,
      });
      const docId = await ctx.db.insert("docs", {
        chapterId: s.chapterId,
        kind: "note",
        title: "Runbook",
        body: "Steps",
        shareId: `sh-${now}`,
        seedHash: "deadbeef",
        createdBy: personId,
        createdAt: now,
        updatedAt: now,
      });
      const dutyId = await ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "Weekly report",
        howTo: "Fill the template",
        howToDocId: docId,
        cadence: "weekly",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const projectId = await ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Music",
        status: "in_progress",
        statusNote: "Tracking week 2",
        nextSteps: "Pitch to artists",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const markerId = await ctx.db.insert("siteMarkers", {
        chapterId: s.chapterId,
        eventTypeId,
        x: 0.5,
        y: 0.5,
        label: "Stage",
        color: "red",
        category: "stage",
        createdAt: now,
      });
      return {
        personId,
        templatePersonId,
        docId,
        dutyId,
        projectId,
        markerId,
      };
    });

    const first = await run(t, (ctx) => runClearLegacyFields(ctx));
    expect(first.cleared).toBe(6);

    const after = await run(t, async (ctx) => ({
      person: await ctx.db.get(ids.personId),
      templatePerson: await ctx.db.get(ids.templatePersonId),
      doc: await ctx.db.get(ids.docId),
      duty: await ctx.db.get(ids.dutyId),
      project: await ctx.db.get(ids.projectId),
      marker: await ctx.db.get(ids.markerId),
    }));

    // Legacy fields drained…
    expect(after.person!.skills).toBeUndefined();
    expect(after.person!.isActive).toBeUndefined();
    expect(after.templatePerson!.team).toBeUndefined();
    expect(after.doc!.seedHash).toBeUndefined();
    expect(after.duty!.howTo).toBeUndefined();
    expect(after.project!.statusNote).toBeUndefined();
    expect(after.project!.nextSteps).toBeUndefined();
    expect(after.marker!.category).toBeUndefined();

    // …new fields untouched.
    expect(after.person!.services).toEqual(["worship"]);
    expect(after.person!.status).toBe("active");
    expect(after.templatePerson!.teams).toEqual(["welcome"]);
    expect(after.duty!.howToDocId).toBe(ids.docId);
    expect(after.marker!.color).toBe("red");

    // Idempotent: a second run clears nothing.
    const second = await run(t, (ctx) => runClearLegacyFields(ctx));
    expect(second.cleared).toBe(0);
  });
});

// ── purgeGuestAllowlist (0017) ───────────────────────────────────────────────
describe("purgeGuestAllowlist", () => {
  async function signInAs(t: ReturnType<typeof newT>, email: string) {
    const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
    return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  }

  test("empties the legacy table, keeps accessAllowlist, idempotent", async () => {
    const t = newT();
    await run(t, async (ctx) => {
      await ctx.db.insert("guestAllowlist", {
        email: "a@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("guestAllowlist", {
        email: "b@gmail.com",
        isActive: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert("accessAllowlist", {
        email: "a@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      });
    });

    const first = await run(t, (ctx) => runPurgeGuestAllowlist(ctx));
    expect(first.deleted).toBe(2);

    const { legacy, access } = await run(t, async (ctx) => ({
      legacy: await ctx.db.query("guestAllowlist").collect(),
      access: await ctx.db.query("accessAllowlist").collect(),
    }));
    expect(legacy).toHaveLength(0);
    expect(access).toHaveLength(1);

    // Idempotent: a second run deletes nothing.
    const second = await run(t, (ctx) => runPurgeGuestAllowlist(ctx));
    expect(second.deleted).toBe(0);
  });

  test("OTP login still works reading accessAllowlist only, after the purge", async () => {
    const t = newT();
    const as = await signInAs(t, "vip@gmail.com");
    await run(t, async (ctx) => {
      await ctx.db.insert("guestAllowlist", {
        email: "vip@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("accessAllowlist", {
        email: "vip@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      });
    });

    await run(t, (ctx) => runPurgeGuestAllowlist(ctx));

    // The legacy row is gone; the accessAllowlist row still admits them.
    expect((await as.query(api.profiles.me, {}))?.allowed).toBe(true);
  });
});

// ── readers use the new fields only ──────────────────────────────────────────
describe("readers on new-field-only rows", () => {
  test("engagements.listForEvent surfaces person.services (no skills present)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const eventId = await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T",
        slug: `t-${now}`,
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "E",
        eventDate: now + 7 * 24 * 3600 * 1000,
        status: "planning",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Ada",
        // NEW field only — no legacy `skills`.
        services: ["worship", "vocals"],
        status: "active",
        createdAt: now,
      });
      await ctx.db.insert("engagements", {
        chapterId: s.chapterId,
        eventId,
        personId,
        type: "volunteer",
        status: "confirmed",
        createdAt: now,
      });
      return eventId;
    });

    const rows = await s.as.query(api.engagements.listForEvent, { eventId });
    expect(rows).toHaveLength(1);
    expect(rows[0].person?.skills).toEqual(["worship", "vocals"]);
  });
});
