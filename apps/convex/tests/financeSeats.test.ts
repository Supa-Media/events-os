/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `financeRoles.mySeats` — the caller's REAL finance seats (WP-0.2).
 *
 * Seats replace the fake "Preview as" switcher: the dashboard routes by what
 * the caller actually holds. A seat is derived from `financeRoles` grants
 * (scope `"central"` → the central desk; scope `"chapter"` → that chapter's
 * desk) plus the superuser allowlist (implicit central manager — the bootstrap
 * path). No grants → no seats → the member view.
 */

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

async function grantChapter(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager" = "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/**
 * A central grant in the shape `grantFinanceRole` writes it: keyed on the
 * granting chapter's id with `scope: "central"` (the scope field, not the
 * chapterId sentinel, is what makes it central).
 */
async function grantCentralOnChapterRow(
  s: ChapterSetup,
  personId: Id<"people">,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
}

/** A central grant in the shape the specialized-roles bridge writes it:
 *  keyed on the `"central"` sentinel. */
async function grantCentralOnSentinel(
  s: ChapterSetup,
  personId: Id<"people">,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: "central",
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
}

/** Assign a super-admin-managed specialized-role TITLE at a scope, bypassing
 *  the `requireSuperuser`-gated mutation (direct row insert — mirrors how the
 *  `canViewAccounts` tests below seed titles). Used by both describe blocks. */
async function assignSpecializedRole(
  s: ChapterSetup,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central",
  title: "executive_director" | "president" | "finance_manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope,
      title,
      roleKind: title === "finance_manager" ? "finance" : "leadership",
      createdAt: Date.now(),
    }),
  );
}

describe("financeRoles.mySeats", () => {
  test("(a) a central-scope grant yields exactly one central seat — no chapter seat", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnChapterRow(s, personId);

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([{ scope: "central", role: "manager" }]);
  });

  test("(a2) a bridge-shaped central grant (chapterId sentinel) also yields the central seat", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnSentinel(s, personId);

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([{ scope: "central", role: "manager" }]);
  });

  test("(b) a chapter grant yields exactly one chapter seat with the chapter's name", async () => {
    const t = newT();
    const s = await setupChapter(t); // chapter "New York"
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "bookkeeper");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "bookkeeper",
      },
    ]);
  });

  test("(c) central + chapter grants (dual-hat) yield both seats, central first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnSentinel(s, personId);
    await grantChapter(s, personId, "manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      { scope: "central", role: "manager" },
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "manager",
      },
    ]);
  });

  test("(d) no finance grants → no seats (member), even with a roster row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([]);
  });

  test("(d2) no roster row at all → no seats", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([]);
  });

  test("(e) a superuser holds the central seat implicitly — no financeRoles row needed", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([{ scope: "central", role: "manager" }]);
  });

  test("(e2) a superuser with a real chapter grant is dual-hat: central + chapter", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      { scope: "central", role: "manager" },
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "manager",
      },
    ]);
  });

  test("a placeholder roster row never confers a seat", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Placeholder me",
        userId: s.userId,
        isPlaceholder: true,
        createdAt: Date.now(),
      }),
    );
    await grantChapter(s, personId, "manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([]);
  });

  // ── WP-1.1: display-only title enrichment ──────────────────────────────────
  test("a central seat with an executive_director specialized role carries that title", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnSentinel(s, personId);
    await assignSpecializedRole(s, personId, "central", "executive_director");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      { scope: "central", role: "manager", title: "executive_director" },
    ]);
  });

  test("a central seat with a finance_manager specialized role carries that title", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnSentinel(s, personId);
    await assignSpecializedRole(s, personId, "central", "finance_manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      { scope: "central", role: "manager", title: "finance_manager" },
    ]);
  });

  test("a chapter seat with a president specialized role carries that title", async () => {
    const t = newT();
    const s = await setupChapter(t); // chapter "New York"
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "manager");
    await assignSpecializedRole(s, personId, s.chapterId, "president");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "manager",
        title: "president",
      },
    ]);
  });

  test("a chapter seat with a (chapter-scope) finance_manager specialized role carries that title", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "manager");
    await assignSpecializedRole(s, personId, s.chapterId, "finance_manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "manager",
        title: "finance_manager",
      },
    ]);
  });

  test("a seat with a finance grant but no specialized role has no title field", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "manager",
      },
    ]);
    expect(seats[0]).not.toHaveProperty("title");
  });

  // #143 leftover: a person holding TWO grants at the same scope (e.g. a
  // stale "viewer" row left behind after being promoted to "manager") must
  // collapse to ONE seat at the STRONGER role — never two seats, never the
  // weaker one winning.
  test("(f) two chapter grants at the same scope for one person dedup to a single seat at the stronger role", async () => {
    const t = newT();
    const s = await setupChapter(t); // chapter "New York"
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "viewer");
    await grantChapter(s, personId, "manager");

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "manager",
      },
    ]);
  });

  test("(f2) two CENTRAL grants for one person dedup to a single central seat at the stronger role", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnSentinel(s, personId); // manager
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: "central",
        personId,
        role: "viewer",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([{ scope: "central", role: "manager" }]);
  });

  // #143 leftover: a person with seats in MULTIPLE chapters (one `people` row
  // per chapter, same userId) gets a chapter seat for EACH, sorted by
  // chapter name — not just the first/home chapter.
  test("(g) a person with grants in two different chapters gets both seats, sorted by chapter name", async () => {
    const t = newT();
    const s = await setupChapter(t); // chapter "New York"
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "bookkeeper");

    const atlanta = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Atlanta",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const atlantaPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: atlanta,
        name: "Caller",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: atlanta,
        personId: atlantaPersonId,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    // "Atlanta" sorts before "New York".
    expect(seats).toEqual([
      { scope: "chapter", chapterId: atlanta, chapterName: "Atlanta", role: "manager" },
      {
        scope: "chapter",
        chapterId: s.chapterId,
        chapterName: "New York",
        role: "bookkeeper",
      },
    ]);
  });
});

/**
 * `financeRoles.canViewAccounts` (WP-1.2) — the ED/FM-only gate behind the
 * Accounts tab + the Cards tab's Relay/legacy section. TIGHTER than a plain
 * central finance seat: only a CENTRAL `executive_director` or
 * `finance_manager` SPECIALIZED role (or a superuser) sees `true`.
 */
describe("financeRoles.canViewAccounts", () => {
  test("a central executive_director sees true", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await assignSpecializedRole(s, personId, "central", "executive_director");

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(true);
  });

  test("a central finance_manager sees true", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await assignSpecializedRole(s, personId, "central", "finance_manager");

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(true);
  });

  test("a CHAPTER-scope finance manager (plain financeRoles grant, no ED/FM title) sees false", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantChapter(s, personId, "manager");

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(false);
  });

  test("a plain CENTRAL financeRoles grant with no ED/FM specialized role sees false (tighter than isCentral)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantCentralOnSentinel(s, personId);

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(false);
  });

  test("a chapter-scope finance_manager specialized role (not central) sees false", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await assignSpecializedRole(s, personId, s.chapterId, "finance_manager");

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(false);
  });

  test("a superuser sees true with no grants at all", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(true);
  });

  test("no finance access at all sees false", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSelfPerson(s);

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(false);
  });

  test("an unauthenticated caller sees false, not a thrown NOT_AUTHENTICATED error", async () => {
    const t = newT();
    await setupChapter(t); // seed a chapter so the deployment is non-empty

    // No `.withIdentity(...)` — a signed-out client calling the query directly.
    expect(await t.query(api.financeRoles.canViewAccounts, {})).toBe(false);
  });
});
