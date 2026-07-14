import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  getFinanceRole,
  resolveCallerPersonId,
  requireFinanceRole,
  requireFinanceManager,
  requireFinanceCentral,
  assertSeparationOfDuties,
} from "../lib/finance";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Phase 0 finance foundation tests:
 *  - the graded finance-role authz (viewer < bookkeeper < manager) in
 *    `lib/finance.ts`, including superuser-implicit-manager and the central tier,
 *  - separation of duties (approver ≠ requester),
 *  - and that the finance schema accepts the canonical integer-cents shapes.
 */

/** Run a callback with the seeded caller's identity (auth-scoped ctx). */
function asRun<T>(
  s: ChapterSetup,
  fn: (ctx: MutationCtx) => Promise<T>,
): Promise<T> {
  return (
    s.as as unknown as {
      run: (f: (ctx: unknown) => Promise<T>) => Promise<T>;
    }
  ).run(fn as (ctx: unknown) => Promise<T>);
}

/** Insert a roster `people` row linked to the seeded user (so `viewerPerson`
 *  resolves the caller). Returns the new person id. */
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

/** Grant the caller a finance role. */
async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

async function expectConvexError(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ConvexError);
}

describe("resolveCallerPersonId", () => {
  test("throws when the caller has no roster row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expectConvexError(
      asRun(s, (ctx) => resolveCallerPersonId(ctx, s.chapterId)),
    );
  });

  test("returns the caller's person id when a roster row exists", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    const resolved = await asRun(s, (ctx) =>
      resolveCallerPersonId(ctx, s.chapterId),
    );
    expect(resolved).toEqual(personId);
  });
});

describe("getFinanceRole (graded ladder)", () => {
  test("no grant → null role, not a manager, not central", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    const access = await asRun(s, (ctx) => getFinanceRole(ctx, s.chapterId));
    expect(access.role).toBeNull();
    expect(access.isManager).toBe(false);
    expect(access.isCentral).toBe(false);
  });

  test("a viewer grant is a viewer, not a manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "viewer");
    const access = await asRun(s, (ctx) => getFinanceRole(ctx, s.chapterId));
    expect(access.role).toBe("viewer");
    expect(access.isManager).toBe(false);
  });

  test("a manager grant is a manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager");
    const access = await asRun(s, (ctx) => getFinanceRole(ctx, s.chapterId));
    expect(access.role).toBe("manager");
    expect(access.isManager).toBe(true);
  });

  test("superusers are implicitly central managers with no grant", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    // No people row, no financeRoles row — superuser short-circuits.
    const access = await asRun(s, (ctx) => getFinanceRole(ctx, s.chapterId));
    expect(access.role).toBe("manager");
    expect(access.isManager).toBe(true);
    expect(access.isCentral).toBe(true);
  });

  test("a central-scoped grant sets isCentral", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager", "central");
    const access = await asRun(s, (ctx) => getFinanceRole(ctx, s.chapterId));
    expect(access.isCentral).toBe(true);
    expect(access.isManager).toBe(true);
  });
});

describe("requireFinanceRole (gating)", () => {
  test("viewer grant passes viewer gate, fails manager gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "viewer");
    await expect(
      asRun(s, (ctx) => requireFinanceRole(ctx, s.chapterId, "viewer")),
    ).resolves.toBeDefined();
    await expectConvexError(
      asRun(s, (ctx) => requireFinanceRole(ctx, s.chapterId, "manager")),
    );
  });

  test("bookkeeper grant passes viewer + bookkeeper, fails manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    await expect(
      asRun(s, (ctx) => requireFinanceRole(ctx, s.chapterId, "bookkeeper")),
    ).resolves.toBeDefined();
    await expectConvexError(
      asRun(s, (ctx) => requireFinanceManager(ctx, s.chapterId)),
    );
  });

  test("no grant fails even the viewer gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);
    await expectConvexError(
      asRun(s, (ctx) => requireFinanceRole(ctx, s.chapterId, "viewer")),
    );
  });

  test("manager grant passes requireFinanceManager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager");
    await expect(
      asRun(s, (ctx) => requireFinanceManager(ctx, s.chapterId)),
    ).resolves.toBeDefined();
  });
});

describe("requireFinanceCentral", () => {
  test("a chapter-only manager is NOT central", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager", "chapter");
    await expectConvexError(
      asRun(s, (ctx) => requireFinanceCentral(ctx, s.chapterId)),
    );
  });

  test("a central grant passes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager", "central");
    await expect(
      asRun(s, (ctx) => requireFinanceCentral(ctx, s.chapterId)),
    ).resolves.toBeDefined();
  });
});

describe("assertSeparationOfDuties", () => {
  test("throws when approver === requester", () => {
    const id = "person_1" as unknown as Id<"people">;
    expect(() => assertSeparationOfDuties(id, id)).toThrow(ConvexError);
  });

  test("passes when approver ≠ requester", () => {
    const a = "person_1" as unknown as Id<"people">;
    const b = "person_2" as unknown as Id<"people">;
    expect(() => assertSeparationOfDuties(a, b)).not.toThrow();
  });
});

describe("grantFinanceRole (upsert + central-escalation guard)", () => {
  test("re-granting a weaker role downgrades in place (max stays correct)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    // Bootstrap: the caller is a chapter manager.
    await grantRole(s, personId, "manager");

    // Downgrade self to viewer through the real mutation (upsert).
    await s.as.mutation(api.financeRoles.grantFinanceRole, {
      personId,
      role: "viewer",
      scope: "chapter",
    });

    // Effective role reflects the downgrade, and only one grant row remains.
    const access = await asRun(s, (ctx) => getFinanceRole(ctx, s.chapterId));
    expect(access.role).toBe("viewer");
    expect(access.isManager).toBe(false);
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("financeRoles")
        .withIndex("by_chapter_and_person", (q) =>
          q.eq("chapterId", s.chapterId).eq("personId", personId),
        )
        .collect(),
    );
    expect(rows.length).toBe(1);
  });

  test("a chapter-only manager cannot grant central reach (no self-escalation)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager", "chapter");

    // Attempt to confer central scope without holding it → rejected.
    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId,
        role: "manager",
        scope: "central",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a central manager CAN grant central reach", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const granter = await seedSelfPerson(s);
    await grantRole(s, granter, "manager", "central");
    const grantee = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Grantee",
        createdAt: Date.now(),
      }),
    );
    const roleId = await s.as.mutation(api.financeRoles.grantFinanceRole, {
      personId: grantee,
      role: "manager",
      scope: "central",
    });
    expect(roleId).toBeDefined();
  });
});

describe("finance schema shapes", () => {
  test("accepts an integer-cents transaction + a graded finance role", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId, roleId } = await run(s.t, async (ctx) => {
      const fundId = await ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      });
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Bookkeeper",
        createdAt: Date.now(),
      });
      const txnId = await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1234,
        postedAt: Date.now(),
        fundId,
        status: "unreviewed",
        createdAt: Date.now(),
      });
      const roleId = await ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      });
      return { txnId, roleId };
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.amountCents).toBe(1234);
    expect(Number.isInteger(txn?.amountCents)).toBe(true);
    const role = await run(s.t, (ctx) => ctx.db.get(roleId));
    expect(role?.role).toBe("bookkeeper");
  });
});
