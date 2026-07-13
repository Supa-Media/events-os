/**
 * Phase 3 — surviving Deploy-A/B behavior that Deploy C KEEPS.
 *
 * The original Deploy-A tests exercised the one-shot backfill migrations
 * (skills→services, team→teams, isActive→status, howTo→doc, statusNote fold)
 * and the `guestAllowlist` → `accessAllowlist` copy by SEEDING the legacy
 * fields/table. Deploy C dropped every one of those fields and the
 * `guestAllowlist` table from the schema, so that legacy input can no longer be
 * constructed (convex-test validates inserts against the schema). Those
 * migrations are ledgered (they never re-run) and their no-op-on-clean-DB
 * behavior is covered by `migrations.test.ts`'s `runPending` suite.
 *
 * What remains worth testing here is the behavior Deploy C KEEPS:
 *   - the `eventTypes` → `templates` module rename shim (both `api.eventTypes.*`
 *     and `api.templates.*` resolve to the same behavior — OTA-lagged clients);
 *   - the `accessAllowlist` grant/revoke → OTP-login access path.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";

// ── accessAllowlist grant/revoke → OTP access ────────────────────────────────
describe("accessAllowlist access path", () => {
  async function signInAs(t: ReturnType<typeof newT>, email: string) {
    const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
    return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  }

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

  test("a revoked accessAllowlist row denies login", async () => {
    const t = newT();
    const as = await signInAs(t, "moved@gmail.com");
    await run(t, (ctx) =>
      ctx.db.insert("accessAllowlist", {
        email: "moved@gmail.com",
        isActive: false,
        createdAt: Date.now(),
      }),
    );
    expect((await as.query(api.profiles.me, {}))?.allowed).toBe(false);
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
