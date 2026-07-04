import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Access tests for the guest allowlist.
 *
 * A non-`publicworship.life` email is denied by default and admitted only once
 * seeded via `guests.allow` (internal, i.e. run from Convex). We drive the check
 * through `profiles.me`, whose `allowed` flag is the same `hasAccess` gate that
 * `requireAccess` enforces on every data function.
 */

/** Insert a bare `users` row and return a client authenticated as them. */
async function signInAs(t: ReturnType<typeof newT>, email: string) {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId: userId as Id<"users"> };
}

describe("guest allowlist access", () => {
  test("member domain is allowed without seeding", async () => {
    const t = newT();
    const { as } = await signInAs(t, "jane@publicworship.life");
    const me = await as.query(api.profiles.me, {});
    expect(me?.allowed).toBe(true);
  });

  test("unseeded guest is denied", async () => {
    const t = newT();
    const { as } = await signInAs(t, "guest@gmail.com");
    const me = await as.query(api.profiles.me, {});
    expect(me?.allowed).toBe(false);
  });

  test("seeded guest is allowed, and revoke removes access", async () => {
    const t = newT();
    const { as } = await signInAs(t, "Guest@Gmail.com");

    await t.mutation(internal.guests.allow, {
      email: "guest@gmail.com",
      note: "Invited speaker",
    });
    let me = await as.query(api.profiles.me, {});
    expect(me?.allowed).toBe(true);

    await t.mutation(internal.guests.revoke, { email: "guest@gmail.com" });
    me = await as.query(api.profiles.me, {});
    expect(me?.allowed).toBe(false);
  });

  test("allow normalizes case/whitespace and is idempotent", async () => {
    const t = newT();
    const { as } = await signInAs(t, "guest@gmail.com");

    await t.mutation(internal.guests.allow, { email: "  GUEST@Gmail.com " });
    await t.mutation(internal.guests.allow, { email: "guest@gmail.com" });

    const rows = await t.query(internal.guests.list, {});
    expect(rows.filter((r) => r.email === "guest@gmail.com")).toHaveLength(1);

    const me = await as.query(api.profiles.me, {});
    expect(me?.allowed).toBe(true);
  });

  test("allow rejects a domain member", async () => {
    const t = newT();
    await expect(
      t.mutation(internal.guests.allow, { email: "jane@publicworship.life" }),
    ).rejects.toThrow(ConvexError);
  });

  test("checkEmail pre-flight reflects the allowlist (unauthenticated)", async () => {
    const t = newT();
    // Members always pass, regardless of case.
    expect(
      await t.query(api.guests.checkEmail, { email: "Jane@Publicworship.life" }),
    ).toEqual({ allowed: true });
    // Unseeded guest is blocked...
    expect(
      await t.query(api.guests.checkEmail, { email: "guest@gmail.com" }),
    ).toEqual({ allowed: false });
    // ...until seeded.
    await t.mutation(internal.guests.allow, { email: "guest@gmail.com" });
    expect(
      await t.query(api.guests.checkEmail, { email: " GUEST@gmail.com " }),
    ).toEqual({ allowed: true });
  });
});

describe("superuser guest management", () => {
  test("me reports isSuperuser for admin emails only", async () => {
    const t = newT();
    const { as: admin } = await signInAs(t, "seyi@publicworship.life");
    const { as: member } = await signInAs(t, "member@publicworship.life");
    expect((await admin.query(api.profiles.me, {}))?.isSuperuser).toBe(true);
    expect((await member.query(api.profiles.me, {}))?.isSuperuser).toBe(false);
  });

  test("non-superuser cannot grant, revoke, or list", async () => {
    const t = newT();
    const { as } = await signInAs(t, "member@publicworship.life");
    await expect(
      as.mutation(api.guests.grantAccess, { email: "g@gmail.com" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      as.mutation(api.guests.revokeAccess, { email: "g@gmail.com" }),
    ).rejects.toThrow(ConvexError);
    await expect(as.query(api.guests.listGuests, {})).rejects.toThrow(
      ConvexError,
    );
  });

  test("superuser grants access (guest gets in) and can revoke it", async () => {
    const t = newT();
    const { as: admin } = await signInAs(t, "lkupo@publicworship.life");
    const { as: guest } = await signInAs(t, "guest@gmail.com");

    await admin.mutation(api.guests.grantAccess, {
      email: "guest@gmail.com",
      note: "VIP",
    });
    const rows = await admin.query(api.guests.listGuests, {});
    expect(rows.find((r) => r.email === "guest@gmail.com")?.isActive).toBe(true);
    expect((await guest.query(api.profiles.me, {}))?.allowed).toBe(true);

    await admin.mutation(api.guests.revokeAccess, { email: "guest@gmail.com" });
    expect((await guest.query(api.profiles.me, {}))?.allowed).toBe(false);
    const after = await admin.query(api.guests.listGuests, {});
    expect(after.find((r) => r.email === "guest@gmail.com")?.isActive).toBe(
      false,
    );
  });
});
