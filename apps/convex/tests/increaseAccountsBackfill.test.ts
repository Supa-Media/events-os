/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { newT, run, type TestConvex } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-1.2 ("accounts fully opaque + automatic") backend tests:
 *  - `backfillChapterAccounts` provisions an Increase account for every
 *    chapter AND the org level (`"central"`), reusing the exact
 *    Idempotency-Key + match-before-create provisioning flow
 *    (`provisionChapterAccount`'s `runProvisionFlow`, just fanned out over
 *    every scope instead of the caller's one chapter),
 *  - already-active accounts are SKIPPED (never re-provisioned or duplicated),
 *  - re-running the backfill is a full no-op (idempotent),
 *  - the `increaseAccounts.chapterId` schema union accepts the `"central"`
 *    sentinel (the WP-1.2 schema widening).
 *
 * No `INCREASE_API_KEY` in the ambient test env, so every test either mocks
 * `fetch` explicitly or asserts the degrade-to-`pending` path — mirrors
 * `increase.test.ts`'s `provisionChapterAccount` suite.
 */

async function makeChapter(t: TestConvex, name: string): Promise<Id<"chapters">> {
  return run(t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function accountsFor(
  t: TestConvex,
  chapterId: Id<"chapters"> | "central",
) {
  return run(t, (ctx) =>
    ctx.db
      .query("increaseAccounts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect(),
  );
}

describe("backfillChapterAccounts", () => {
  const PROVISION_ENV = [
    "INCREASE_API_KEY",
    "INCREASE_ENTITY_ID",
    "INCREASE_PROGRAM_ID",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof PROVISION_ENV)[number], string>> =
    {};
  for (const k of PROVISION_ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of PROVISION_ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  /** Dispatches `GET /programs` (one auto-resolved program), `GET /accounts`
   *  (empty — no match-before-create hit), and `POST /accounts` (opens a new
   *  account per call, numbered so each scope gets a distinct id). */
  function mockIncreaseFetch() {
    let n = 0;
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (path.includes("/programs")) {
        return new Response(JSON.stringify({ data: [{ id: "program_auto" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path.includes("/accounts")) {
        if (method === "GET") {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        n += 1;
        return new Response(
          JSON.stringify({ id: `account_${n}`, status: "open" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  test("provisions an account for every chapter AND central, none pre-existing", async () => {
    const t = newT();
    const chapterA = await makeChapter(t, "New York");
    const chapterB = await makeChapter(t, "Los Angeles");

    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = "entity_shared_org";
    delete process.env.INCREASE_PROGRAM_ID;
    mockIncreaseFetch();

    const result = await t.action(internal.increase.backfillChapterAccounts, {});

    expect(result.skipped).toEqual([]);
    expect(result.provisioned.length).toBe(3); // central + 2 chapters
    expect(result.provisioned.every((p) => p.status === "active")).toBe(true);
    const scopes = result.provisioned.map((p) => p.scope).sort();
    expect(scopes).toEqual([chapterA, chapterB, "central"].map(String).sort());

    // A real row exists for each scope, including the "central" sentinel —
    // proves the schema union accepts it.
    expect((await accountsFor(t, "central")).length).toBe(1);
    expect((await accountsFor(t, chapterA)).length).toBe(1);
    expect((await accountsFor(t, chapterB)).length).toBe(1);
    const centralRow = (await accountsFor(t, "central"))[0];
    expect(centralRow.onboardingStatus).toBe("active");
    expect(centralRow.chapterId).toBe("central");
  });

  test("skips a chapter/central that already has an ACTIVE current-mode account", async () => {
    const t = newT();
    const chapterA = await makeChapter(t, "New York");

    // Pre-provision central directly (mirrors an already-run backfill).
    const now = Date.now();
    await run(t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: "central",
        sandbox: false,
        onboardingStatus: "active",
        increaseEntityId: "entity_shared_org",
        increaseAccountId: "account_existing_central",
        createdAt: now,
        updatedAt: now,
      }),
    );

    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = "entity_shared_org";
    delete process.env.INCREASE_PROGRAM_ID;
    mockIncreaseFetch();

    const result = await t.action(internal.increase.backfillChapterAccounts, {});

    expect(result.skipped).toEqual(["central"]);
    expect(result.provisioned.map((p) => p.scope)).toEqual([String(chapterA)]);

    // Central's row is untouched (still the pre-existing id).
    const centralRows = await accountsFor(t, "central");
    expect(centralRows.length).toBe(1);
    expect(centralRows[0].increaseAccountId).toBe("account_existing_central");
  });

  test("is idempotent — re-running after a full provision provisions nothing new", async () => {
    const t = newT();
    await makeChapter(t, "New York");

    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = "entity_shared_org";
    delete process.env.INCREASE_PROGRAM_ID;
    mockIncreaseFetch();

    const first = await t.action(internal.increase.backfillChapterAccounts, {});
    expect(first.provisioned.length).toBe(2); // central + the one chapter

    const second = await t.action(internal.increase.backfillChapterAccounts, {});
    expect(second.provisioned).toEqual([]);
    expect(second.skipped.length).toBe(2);

    // Still exactly one row per scope — no duplicate-account cascade.
    expect((await accountsFor(t, "central")).length).toBe(1);
  });

  test("degrades to pending (never throws) when the Increase env isn't configured — still creates rows for every scope", async () => {
    const t = newT();
    await makeChapter(t, "New York");

    delete process.env.INCREASE_API_KEY;
    delete process.env.INCREASE_ENTITY_ID;
    delete process.env.INCREASE_PROGRAM_ID;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the env is unset");
    }) as unknown as typeof fetch;

    const result = await t.action(internal.increase.backfillChapterAccounts, {});

    expect(result.skipped).toEqual([]);
    expect(result.provisioned.every((p) => p.status === "pending")).toBe(true);
    expect((await accountsFor(t, "central"))[0].onboardingStatus).toBe(
      "pending",
    );
  });
});

// ── central-scope match-before-create: EXACT match only (I1) ────────────────

describe("provisionAccountForScope — central adoption is exact-match only", () => {
  const PROVISION_ENV = [
    "INCREASE_API_KEY",
    "INCREASE_ENTITY_ID",
    "INCREASE_PROGRAM_ID",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof PROVISION_ENV)[number], string>> =
    {};
  for (const k of PROVISION_ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of PROVISION_ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  /** Dispatches `GET /programs` (one auto-resolved program), `GET /accounts`
   *  (returns the given entity accounts — the match-before-create list), and
   *  `POST /accounts` (opens a new account, recorded so tests can assert
   *  whether a create happened at all). */
  function mockIncreaseFetch(entityAccounts: Array<{ id: string; name: string }>) {
    const calls: Array<{ path: string; method: string }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (path.includes("/programs")) {
        return new Response(JSON.stringify({ data: [{ id: "program_auto" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path.includes("/accounts")) {
        if (method === "GET") {
          return new Response(JSON.stringify({ data: entityAccounts }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ id: "account_new_central", status: "open" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  test("a bare 'Public Worship' account (fuzzy-substring of the central name) is NOT adopted — a fresh central account is created", async () => {
    const t = newT();
    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = "entity_shared_org";
    delete process.env.INCREASE_PROGRAM_ID;

    // The org's real pre-existing prod account, named for the nonprofit itself
    // — a SUBSTRING of `CENTRAL_ACCOUNT_NAME` ("Public Worship — Central").
    // Fuzzy matching (chapter behavior) would wrongly adopt this as the City
    // Launch Fund's home; exact-match-only central provisioning must not.
    const calls = mockIncreaseFetch([{ id: "account_org", name: "Public Worship" }]);

    const account = await t.action(internal.increase.provisionAccountForScope, {
      scope: "central",
    });

    expect(account.onboardingStatus).toBe("active");
    // A NEW account was minted, not the pre-existing "Public Worship" one.
    expect(account.increaseAccountId).toBe("account_new_central");
    expect(account.increaseAccountId).not.toBe("account_org");
    const post = calls.find(
      (c) => c.method === "POST" && c.path.includes("/accounts"),
    );
    expect(post).toBeTruthy();
  });

  test("an exact 'Public Worship — Central' account IS adopted (linked, no create)", async () => {
    const t = newT();
    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = "entity_shared_org";
    delete process.env.INCREASE_PROGRAM_ID;

    const calls = mockIncreaseFetch([
      { id: "account_org", name: "Public Worship" },
      { id: "account_central_exact", name: "Public Worship — Central" },
    ]);

    const account = await t.action(internal.increase.provisionAccountForScope, {
      scope: "central",
    });

    expect(account.onboardingStatus).toBe("active");
    expect(account.increaseAccountId).toBe("account_central_exact");
    // No POST /accounts — the exact match was linked, not duplicated.
    const post = calls.find(
      (c) => c.method === "POST" && c.path.includes("/accounts"),
    );
    expect(post).toBeUndefined();
  });
});
