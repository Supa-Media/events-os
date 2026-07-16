/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Specialized roles (leadership + finance) backend tests.
 *
 * Covers: super-admin gating, scope-validity, scope-local separation of duties
 * (rejected either order, allowed across scopes / across kinds at different
 * scopes), the finance bridge (grant + revoke of a `financeRoles` manager row),
 * one-holder-per-slot replacement, and the list / personSpecializedRoles shapes.
 */

/** A superuser-authenticated chapter setup (seyi@ is on the superuser allowlist). */
async function superuserSetup(): Promise<ChapterSetup> {
  const t = newT();
  return setupChapter(t, { email: "seyi@publicworship.life" });
}

/** Insert a bare roster person in a chapter and return its id. */
async function makePerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name,
      createdAt: Date.now(),
    }),
  );
}

/** Insert a second chapter and return its id. */
async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** The person's `financeRoles` grant at a scope (chapter id or "central"), or null. */
async function financeGrant(
  s: ChapterSetup,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("financeRoles")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", scope).eq("personId", personId),
      )
      .first(),
  );
}

describe("assign + scope validity", () => {
  test("ED@central and president@chapter both assign", async () => {
    const s = await superuserSetup();
    const ed = await makePerson(s, s.chapterId, "Exec");
    const pres = await makePerson(s, s.chapterId, "Prez");

    const edId = await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: ed,
      scope: "central",
      title: "executive_director",
    });
    const presId = await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: pres,
      scope: s.chapterId,
      title: "president",
    });
    expect(edId).toBeDefined();
    expect(presId).toBeDefined();

    const edRow = await run(s.t, (ctx) => ctx.db.get(edId));
    expect(edRow?.roleKind).toBe("leadership");
    expect(edRow?.scope).toBe("central");
  });

  test("ED@chapter and president@central are rejected", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "P");
    await expect(
      s.as.mutation(api.specializedRoles.assignSpecializedRole, {
        personId: p,
        scope: s.chapterId,
        title: "executive_director",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.specializedRoles.assignSpecializedRole, {
        personId: p,
        scope: "central",
        title: "president",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a non-superuser is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "leader@publicworship.life" });
    const p = await makePerson(s, s.chapterId, "P");
    await expect(
      s.as.mutation(api.specializedRoles.assignSpecializedRole, {
        personId: p,
        scope: s.chapterId,
        title: "president",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("separation of duties (scope-local)", () => {
  test("president@A then finance_manager@A is rejected", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "Dual");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: s.chapterId,
      title: "president",
    });
    await expect(
      s.as.mutation(api.specializedRoles.assignSpecializedRole, {
        personId: p,
        scope: s.chapterId,
        title: "finance_manager",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("finance_manager@A then president@A is rejected (other order)", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "Dual2");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: s.chapterId,
      title: "finance_manager",
    });
    await expect(
      s.as.mutation(api.specializedRoles.assignSpecializedRole, {
        personId: p,
        scope: s.chapterId,
        title: "president",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("president@A AND ED@central is allowed (different scopes)", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "Both");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: s.chapterId,
      title: "president",
    });
    // Same kind (leadership) at a different scope — no SoD conflict.
    const edId = await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: "central",
      title: "executive_director",
    });
    expect(edId).toBeDefined();
  });

  test("president@A AND finance_manager@B is allowed (cross-scope)", async () => {
    const s = await superuserSetup();
    const chapterB = await makeChapter(s, "Boston");
    const p = await makePerson(s, s.chapterId, "CrossScope");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: s.chapterId,
      title: "president",
    });
    const fmId = await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: chapterB,
      title: "finance_manager",
    });
    expect(fmId).toBeDefined();
  });
});

describe("finance bridge", () => {
  test("assigning finance_manager@A grants a financeRoles manager row; removing revokes", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "FinMgr");

    const roleId = await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: s.chapterId,
      title: "finance_manager",
    });
    const grant = await financeGrant(s, s.chapterId, p);
    expect(grant?.role).toBe("manager");
    expect(grant?.scope).toBe("chapter");

    await s.as.mutation(api.specializedRoles.removeSpecializedRole, { roleId });
    expect(await financeGrant(s, s.chapterId, p)).toBeNull();
  });

  test("finance_manager@central bridges to a central financeRoles grant", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "CentralFin");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: "central",
      title: "finance_manager",
    });
    const grant = await financeGrant(s, "central", p);
    expect(grant?.role).toBe("manager");
    expect(grant?.scope).toBe("central");
  });
});

describe("one holder per slot", () => {
  test("assigning president@A to a 2nd person replaces the 1st", async () => {
    const s = await superuserSetup();
    const first = await makePerson(s, s.chapterId, "First");
    const second = await makePerson(s, s.chapterId, "Second");

    const firstId = await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: first,
      scope: s.chapterId,
      title: "president",
    });
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: second,
      scope: s.chapterId,
      title: "president",
    });

    // The first assignment row is gone.
    expect(await run(s.t, (ctx) => ctx.db.get(firstId))).toBeNull();
    const rows = await s.as.query(api.specializedRoles.listSpecializedRoles, {
      scope: s.chapterId,
    });
    const presRows = rows.filter((r) => r.title === "president");
    expect(presRows.length).toBe(1);
    expect(presRows[0].personId).toBe(second);
  });

  test("replacing a finance slot unbridges the outgoing holder", async () => {
    const s = await superuserSetup();
    const first = await makePerson(s, s.chapterId, "FinA");
    const second = await makePerson(s, s.chapterId, "FinB");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: first,
      scope: s.chapterId,
      title: "finance_manager",
    });
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: second,
      scope: s.chapterId,
      title: "finance_manager",
    });
    // Outgoing holder lost the bridged grant; incoming holder has it.
    expect(await financeGrant(s, s.chapterId, first)).toBeNull();
    expect((await financeGrant(s, s.chapterId, second))?.role).toBe("manager");
  });
});

describe("list + personSpecializedRoles shapes", () => {
  test("listSpecializedRoles returns enriched rows; personSpecializedRoles mirrors a person", async () => {
    const s = await superuserSetup();
    const p = await makePerson(s, s.chapterId, "Alice");
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: s.chapterId,
      title: "president",
    });
    await s.as.mutation(api.specializedRoles.assignSpecializedRole, {
      personId: p,
      scope: "central",
      title: "executive_director",
    });

    const list = await s.as.query(api.specializedRoles.listSpecializedRoles, {});
    expect(list.length).toBeGreaterThanOrEqual(2);
    const pres = list.find((r) => r.title === "president");
    expect(pres?.personName).toBe("Alice");
    // WP-1.1: `president` displays as "Chapter Director" per the org chart —
    // the identifier is unchanged, only the label.
    expect(pres?.label).toBe("Chapter Director");
    expect(pres?.roleKind).toBe("leadership");
    expect(pres).toHaveProperty("personImageUrl");

    const mine = await s.as.query(api.specializedRoles.personSpecializedRoles, {
      personId: p,
    });
    expect(mine.map((r) => r.title).sort()).toEqual(
      ["executive_director", "president"].sort(),
    );
    expect(mine.find((r) => r.title === "executive_director")?.label).toBe(
      "Executive Director",
    );
  });
});
