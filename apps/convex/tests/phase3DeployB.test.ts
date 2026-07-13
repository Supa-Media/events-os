/**
 * Phase 3 — surviving Deploy-B behavior that Deploy C KEEPS.
 *
 * The original Deploy-B tests exercised `clearLegacyFields` (0016) and
 * `purgeGuestAllowlist` (0017) by SEEDING the legacy fields and the
 * `guestAllowlist` table. Deploy C dropped those fields + that table from the
 * schema, so the legacy input can no longer be constructed (convex-test
 * validates inserts against the schema). Both migrations are ledgered (they
 * never re-run) and are covered as no-ops on a clean DB by `migrations.test.ts`.
 *
 * What remains worth testing is the read cutover Deploy B introduced and Deploy
 * C keeps: readers surface a person's NEW `services` field on rows that carry
 * ONLY the new fields (no legacy `skills`), and OTP login works reading
 * `accessAllowlist` alone.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";

// ── OTP login reads accessAllowlist only ─────────────────────────────────────
describe("OTP login via accessAllowlist", () => {
  async function signInAs(t: ReturnType<typeof newT>, email: string) {
    const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
    return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  }

  test("an active accessAllowlist row admits login", async () => {
    const t = newT();
    const as = await signInAs(t, "vip@gmail.com");
    await run(t, (ctx) =>
      ctx.db.insert("accessAllowlist", {
        email: "vip@gmail.com",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    expect((await as.query(api.profiles.me, {}))?.allowed).toBe(true);
  });
});

// ── readers use the new fields only ──────────────────────────────────────────
describe("readers on new-field-only rows", () => {
  test("engagements.listForEvent surfaces person.services (no legacy skills)", async () => {
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
        // NEW field only — the legacy `skills` field no longer exists.
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
    // The return shape still exposes a `skills` alias (client back-compat),
    // populated from the person's `services`.
    expect(rows[0].person?.skills).toEqual(["worship", "vocals"]);
  });
});
