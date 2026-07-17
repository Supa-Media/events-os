/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CENTRAL,
  LAUNCH_BUDGET_TEMPLATE,
  launchTemplateTotalCents,
  skimTransferGroupId,
  launchTransferGroupId,
  settlementTransferGroupId,
  countsAsSpend,
} from "@events-os/shared";

/**
 * WP-4.1 (the skim) + WP-4.2 (launch grants) — the City Launch Fund money flows.
 *
 * A central↔chapter transfer is a PAIR of `flow:"transfer"` transactions linked
 * by a shared `transferGroupId`; excluded from spend everywhere; integer cents;
 * idempotent on the deterministic group id. `record*` books manual truth;
 * `initiate*` moves real money over Increase (mocked here) then books the pair.
 */

function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A central-scope finance role at a chosen rank (person owned by the caller). */
async function asCentral(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A chapter-only manager (person + manager grant, chapter scope). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A central Executive Director specialized role (the launch-grant gate, #149). */
async function asCentralEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope: "central",
      title: "executive_director",
      roleKind: "leadership",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** Insert an ACTIVE production Increase account for a scope. */
async function seedActiveAccount(
  s: ChapterSetup,
  scope: Id<"chapters"> | typeof CENTRAL,
  increaseAccountId: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: scope,
      sandbox: false,
      increaseAccountId,
      increaseEntityId: "entity_shared",
      onboardingStatus: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

function legsFor(s: ChapterSetup, transferGroupId: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_transfer_group", (q) =>
        q.eq("transferGroupId", transferGroupId),
      )
      .collect(),
  );
}

// ── WP-4.1 · The skim ─────────────────────────────────────────────────────────

describe("recordSkimTransfer — the ledger pair", () => {
  test("records a linked outflow/inflow transfer pair (chapter → central)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    const res = await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 42_000,
      note: "March skim",
    });
    expect(res.amountCents).toBe(42_000);
    expect(res.transferGroupId).toBe(skimTransferGroupId(s.chapterId, 2026, 3));

    const legs = await legsFor(s, res.transferGroupId);
    expect(legs.length).toBe(2);
    // Both legs: transfer flow, skim source, equal integer cents, same group id.
    for (const leg of legs) {
      expect(leg.flow).toBe("transfer");
      expect(leg.source).toBe("skim");
      expect(leg.amountCents).toBe(42_000);
      expect(countsAsSpend(leg.flow)).toBe(false);
    }
    // The source leg belongs to the chapter; the destination leg to central.
    const chapterLeg = legs.find((l) => l.chapterId === s.chapterId);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    expect(chapterLeg?._id).toBe(res.outflowId);
    expect(centralLeg?._id).toBe(res.inflowId);
    expect(centralLeg).toBeTruthy();
  });

  test("skim math: 15% of revenue, integer-rounded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    // 250_000 × 0.15 = 37_500 exactly.
    const exact = await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 1,
      monthlyBackerRevenueCents: 250_000,
    });
    expect(exact.amountCents).toBe(37_500);

    // 333_333 × 0.15 = 49_999.95 → rounds UP to 50_000.
    const rounded = await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 2,
      monthlyBackerRevenueCents: 333_333,
    });
    expect(rounded.amountCents).toBe(50_000);
  });

  test("explicit-amount path uses the given cents verbatim", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const res = await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 4,
      amountCents: 12_345,
    });
    expect(res.amountCents).toBe(12_345);
  });

  test("rejects providing both, or neither, of revenue and amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await expect(
      s.as.mutation(api.transfers.recordSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 5,
        monthlyBackerRevenueCents: 100_000,
        amountCents: 15_000,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.transfers.recordSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 5,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("idempotency: re-recording the same month is REJECTED (no double-move)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const args = {
      chapterId: s.chapterId,
      year: 2026,
      month: 6,
      amountCents: 20_000,
    };
    await s.as.mutation(api.transfers.recordSkimTransfer, args);
    await expect(
      s.as.mutation(api.transfers.recordSkimTransfer, args),
    ).rejects.toThrow(/already been recorded/i);
    // Still exactly one pair (two legs) — the reject didn't add a third leg.
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 6));
    expect(legs.length).toBe(2);
  });
});

describe("skim — excluded from spend + budget rollups; fund position", () => {
  test("a skim never counts as spend and drives the City Launch Fund position", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 40_000,
    });

    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    // No real spend exists — only transfer legs, which are excluded everywhere.
    expect(dash.totalMonthSpendCents).toBe(0);
    expect(dash.orgUnattributedCents).toBe(0);
    // The fund received the skim (all-time + this period).
    expect(dash.cityLaunchFund.skimsReceivedCents).toBe(40_000);
    expect(dash.cityLaunchFund.positionCents).toBe(40_000);
    expect(dash.cityLaunchFund.periodSkimsReceivedCents).toBe(40_000);
    expect(dash.cityLaunchFund.periodNetCents).toBe(40_000);
  });

  test("fund position is period-aware but the balance is all-time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 1,
      amountCents: 10_000,
    });
    await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 2,
      amountCents: 25_000,
    });
    // Viewing March: nothing landed in March, but the balance is all-time.
    const march = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    expect(march.cityLaunchFund.periodSkimsReceivedCents).toBe(0);
    expect(march.cityLaunchFund.skimsReceivedCents).toBe(35_000);
    // Viewing February: only Feb's skim is in-period.
    const feb = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 2,
    });
    expect(feb.cityLaunchFund.periodSkimsReceivedCents).toBe(25_000);
  });
});

describe("skim — authz", () => {
  test("chapter manager (no central reach) is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.mutation(api.transfers.recordSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 10_000,
      }),
    ).rejects.toThrow(/central/i);
  });

  test("central VIEWER is FORBIDDEN on the write (needs bookkeeper+)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    await expect(
      s.as.mutation(api.transfers.recordSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 10_000,
      }),
    ).rejects.toThrow(ConvexError);
    // No pair was written.
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 3));
    expect(legs.length).toBe(0);
  });
});

// ── WP-4.2 · Launch grants ────────────────────────────────────────────────────

describe("recordLaunchGrant — pair + stamped budget", () => {
  test("books a central → chapter pair and stamps the launch budget (nonzero lines)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const newChapter = await makeChapter(s, "Boston");

    const res = await s.as.mutation(api.transfers.recordLaunchGrant, {
      chapterId: newChapter,
      year: 2026,
    });
    // Default amount = the template total.
    expect(res.amountCents).toBe(launchTemplateTotalCents());
    expect(res.transferGroupId).toBe(launchTransferGroupId(newChapter));

    const legs = await legsFor(s, res.transferGroupId);
    expect(legs.length).toBe(2);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    const chapterLeg = legs.find((l) => l.chapterId === newChapter);
    expect(centralLeg?._id).toBe(res.outflowId); // central pays out
    expect(chapterLeg?._id).toBe(res.inflowId); // the new chapter receives
    for (const leg of legs) {
      expect(leg.flow).toBe("transfer");
      expect(leg.source).toBe("launch_grant");
    }

    // One budget per NONZERO template line, stamped on the receiving chapter.
    const nonzero = LAUNCH_BUDGET_TEMPLATE.filter((l) => l.amountCents > 0);
    expect(res.budgetIds.length).toBe(nonzero.length);
    const budgets = await run(s.t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_period", (q) =>
          q.eq("chapterId", newChapter).eq("year", 2026),
        )
        .collect(),
    );
    expect(budgets.length).toBe(nonzero.length);
    for (const b of budgets) {
      expect(b.type).toBe("one_time");
      expect(b.cadence).toBe("one_off");
      expect(b.amountCents).toBeGreaterThan(0);
    }
    const equipment = budgets.find((b) => b.label === "Launch equipment");
    expect(equipment?.amountCents).toBe(430_000);
  });

  test("a launch grant reduces the City Launch Fund position", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper"); // for the skim
    await asCentralEd(s); // for the launch grant
    const newChapter = await makeChapter(s, "Boston");

    await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 900_000,
    });
    await s.as.mutation(api.transfers.recordLaunchGrant, {
      chapterId: newChapter,
      year: 2026,
      amountCents: 500_000,
    });
    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    expect(dash.cityLaunchFund.skimsReceivedCents).toBe(900_000);
    expect(dash.cityLaunchFund.launchGrantsMadeCents).toBe(500_000);
    expect(dash.cityLaunchFund.positionCents).toBe(400_000);
    // The launch grant is a transfer — still zero real spend.
    expect(dash.totalMonthSpendCents).toBe(0);
  });

  test("idempotency: a chapter can be launch-granted only once", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const newChapter = await makeChapter(s, "Boston");
    await s.as.mutation(api.transfers.recordLaunchGrant, { chapterId: newChapter });
    await expect(
      s.as.mutation(api.transfers.recordLaunchGrant, { chapterId: newChapter }),
    ).rejects.toThrow(/already/i);
  });
});

describe("launch grant — authz", () => {
  test("chapter manager is FORBIDDEN (needs central ED/FM)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const newChapter = await makeChapter(s, "Boston");
    await expect(
      s.as.mutation(api.transfers.recordLaunchGrant, { chapterId: newChapter }),
    ).rejects.toThrow(ConvexError);
  });

  test("central bookkeeper (no ED/FM title) is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper"); // central reach, but not an ED/FM seat
    const newChapter = await makeChapter(s, "Boston");
    await expect(
      s.as.mutation(api.transfers.recordLaunchGrant, { chapterId: newChapter }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── Real movement (initiate*) — degrade + mocked Increase ─────────────────────

describe("initiateSkimTransfer — degrade without a live path (no fetch)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INCREASE_API_KEY;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = originalKey;
  });

  test("no active accounts → NOT_CONFIGURED, network never touched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called on the degrade path");
    }) as unknown as typeof fetch;

    await expect(
      s.as.action(api.transfers.initiateSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 40_000,
      }),
    ).rejects.toThrow(/record the transfer manually|active/i);
    // No ledger pair was booked.
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 3));
    expect(legs.length).toBe(0);
  });

  test("accounts live but API key unset → NOT_CONFIGURED, network never touched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await seedActiveAccount(s, s.chapterId, "account_ch");
    await seedActiveAccount(s, CENTRAL, "account_central");
    delete process.env.INCREASE_API_KEY;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the key is unset");
    }) as unknown as typeof fetch;

    await expect(
      s.as.action(api.transfers.initiateSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 40_000,
      }),
    ).rejects.toThrow(/isn't set|manually/i);
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 3));
    expect(legs.length).toBe(0);
  });
});

describe("initiateSkimTransfer — real movement (mocked Increase)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INCREASE_API_KEY;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = originalKey;
  });

  test("posts a correct /account_transfers body and records the pair with the id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await seedActiveAccount(s, s.chapterId, "account_ch");
    await seedActiveAccount(s, CENTRAL, "account_central");
    process.env.INCREASE_API_KEY = "test_key";

    const calls: Array<{
      path: string;
      method: string;
      body: Record<string, unknown> | null;
      idempotencyKey: string | null;
    }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        path: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        idempotencyKey: headers["Idempotency-Key"] ?? null,
      });
      return new Response(
        JSON.stringify({ id: "account_transfer_x", status: "complete" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await s.as.action(api.transfers.initiateSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 40_000,
    });
    expect(res.increaseTransferId).toBe("account_transfer_x");

    // Exactly one account-transfer POST with the right body + idempotency key.
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toContain("/account_transfers");
    expect(call.body).toMatchObject({
      account_id: "account_ch",
      destination_account_id: "account_central",
      amount: 40_000,
    });
    expect(call.idempotencyKey).toBe(skimTransferGroupId(s.chapterId, 2026, 3));

    // The ledger pair was booked, stamped with the Increase transfer id.
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 3));
    expect(legs.length).toBe(2);
    for (const leg of legs) {
      expect(leg.externalId).toBe("account_transfer_x");
      expect(leg.amountCents).toBe(40_000);
    }
  });
});

describe("initiateSkimTransfer — non-complete Increase status (IMPORTANT 2)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INCREASE_API_KEY;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = originalKey;
  });

  function mockFetchReturning(status: string) {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "account_transfer_pending", status }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
  }

  test("pending_approval: throws TRANSFER_PENDING_APPROVAL, books nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await seedActiveAccount(s, s.chapterId, "account_ch");
    await seedActiveAccount(s, CENTRAL, "account_central");
    process.env.INCREASE_API_KEY = "test_key";
    mockFetchReturning("pending_approval");

    let caught: unknown;
    try {
      await s.as.action(api.transfers.initiateSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 40_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "TRANSFER_PENDING_APPROVAL",
    );
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 3));
    expect(legs.length).toBe(0);
  });

  test("canceled: throws TRANSFER_CANCELED, books nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await seedActiveAccount(s, s.chapterId, "account_ch");
    await seedActiveAccount(s, CENTRAL, "account_central");
    process.env.INCREASE_API_KEY = "test_key";
    mockFetchReturning("canceled");

    let caught: unknown;
    try {
      await s.as.action(api.transfers.initiateSkimTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 4,
        amountCents: 40_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "TRANSFER_CANCELED",
    );
    const legs = await legsFor(s, skimTransferGroupId(s.chapterId, 2026, 4));
    expect(legs.length).toBe(0);
  });
});

describe("initiateLaunchGrant — non-complete Increase status (IMPORTANT 2)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.INCREASE_API_KEY;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = originalKey;
  });

  function mockFetchReturning(status: string) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "account_transfer_grant", status }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("pending_approval: throws TRANSFER_PENDING_APPROVAL, books nothing (no budget stamped)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const newChapter = await makeChapter(s, "Boston");
    await seedActiveAccount(s, CENTRAL, "account_central");
    await seedActiveAccount(s, newChapter, "account_boston");
    process.env.INCREASE_API_KEY = "test_key";
    mockFetchReturning("pending_approval");

    let caught: unknown;
    try {
      await s.as.action(api.transfers.initiateLaunchGrant, {
        chapterId: newChapter,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "TRANSFER_PENDING_APPROVAL",
    );
    const legs = await legsFor(s, launchTransferGroupId(newChapter));
    expect(legs.length).toBe(0);
    const budgets = await run(s.t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_period", (q) =>
          q.eq("chapterId", newChapter).eq("year", new Date().getFullYear()),
        )
        .collect(),
    );
    expect(budgets.length).toBe(0);
  });

  test("canceled: throws TRANSFER_CANCELED, books nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const newChapter = await makeChapter(s, "Boston");
    await seedActiveAccount(s, CENTRAL, "account_central");
    await seedActiveAccount(s, newChapter, "account_boston");
    process.env.INCREASE_API_KEY = "test_key";
    mockFetchReturning("canceled");

    let caught: unknown;
    try {
      await s.as.action(api.transfers.initiateLaunchGrant, {
        chapterId: newChapter,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "TRANSFER_CANCELED",
    );
    const legs = await legsFor(s, launchTransferGroupId(newChapter));
    expect(legs.length).toBe(0);
  });
});

// ── IMPORTANT 1 · sandbox transfer legs must not pollute the PROD fund position

describe("dashboardCentral.cityLaunchFund — mode-filtered (IMPORTANT 1)", () => {
  test("a sandbox-externalId skim leg is excluded from prod mode, included in sandbox mode; manual legs count in both", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    // Manual leg (no externalId) — env-neutral, must count in BOTH modes.
    await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 1,
      amountCents: 10_000,
    });
    // A "production" real leg (non-sandbox externalId).
    await s.as.mutation(internal.transfers.recordSkimPairFromIncrease, {
      chapterId: s.chapterId,
      year: 2026,
      month: 2,
      amountCents: 20_000,
      increaseTransferId: "account_transfer_prod",
    });
    // A sandbox-initiated real leg.
    await s.as.mutation(internal.transfers.recordSkimPairFromIncrease, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 40_000,
      increaseTransferId: "sandbox_account_transfer_9",
    });

    // Default (no financeSettings row) is production mode.
    const prod = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 1,
    });
    expect(prod.cityLaunchFund.skimsReceivedCents).toBe(30_000); // manual + prod real
    expect(prod.cityLaunchFund.positionCents).toBe(30_000);

    // Flip to sandbox mode.
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: true,
        updatedAt: Date.now(),
      }),
    );
    const sandbox = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 1,
    });
    expect(sandbox.cityLaunchFund.skimsReceivedCents).toBe(50_000); // manual + sandbox real
    expect(sandbox.cityLaunchFund.positionCents).toBe(50_000);
  });
});

describe("removeChapterAccount — sandbox transfer-leg cascade (IMPORTANT 1)", () => {
  test("deletes the removed chapter's sandbox skim leg; a manual leg survives", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A single central "manager" grant satisfies BOTH `requireFinanceManager`
    // (removeChapterAccount — rank ≥ manager, any scope) AND
    // `requireCentralFinanceRole(..., "bookkeeper")` (recordSkimTransfer —
    // central + rank ≥ bookkeeper). `viewerPerson` resolves the caller to
    // exactly ONE roster row per chapter, so granting via a single person
    // (rather than `asChapterManager` + `asCentral`, which each seed a
    // SEPARATE person) is what actually composes here.
    await asCentral(s, "manager");

    // Sandbox mode + a sandbox-test increaseAccounts row (removable).
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: true,
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: true,
        increaseAccountId: "sandbox_acct_test",
        increaseEntityId: "entity_sandbox",
        onboardingStatus: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // A sandbox-initiated skim pair (the chapter-side leg carries the id).
    await s.as.mutation(internal.transfers.recordSkimPairFromIncrease, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 10_000,
      increaseTransferId: "sandbox_account_transfer_9",
    });
    // A manually-recorded skim pair (no externalId) — env-neutral, must survive.
    await s.as.mutation(api.transfers.recordSkimTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 4,
      amountCents: 5_000,
    });

    await s.as.mutation(api.increase.removeChapterAccount, {});

    const sandboxLegs = await legsFor(
      s,
      skimTransferGroupId(s.chapterId, 2026, 3),
    );
    expect(sandboxLegs.find((l) => l.chapterId === s.chapterId)).toBeUndefined();

    const manualLegs = await legsFor(
      s,
      skimTransferGroupId(s.chapterId, 2026, 4),
    );
    expect(manualLegs.length).toBe(2);
  });

  test("deletes the removed chapter's sandbox settlement leg; a manual leg survives", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Same single central "manager" grant as the skim case above — it
    // satisfies both `requireFinanceManager` (removeChapterAccount) and
    // `requireCentralFinanceRole(..., "bookkeeper")` (recordSettlementTransfer).
    await asCentral(s, "manager");

    // Sandbox mode + a sandbox-test increaseAccounts row (removable).
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: true,
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: true,
        increaseAccountId: "sandbox_acct_test",
        increaseEntityId: "entity_sandbox",
        onboardingStatus: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // A sandbox-initiated settlement pair (the chapter-side leg carries the id).
    await s.as.mutation(internal.transfers.recordSettlementPairFromIncrease, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 10_000,
      direction: "chapter_to_central",
      increaseTransferId: "sandbox_account_transfer_9",
    });
    // A manually-recorded settlement pair (no externalId) — env-neutral, must
    // survive.
    await s.as.mutation(api.transfers.recordSettlementTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 4,
      amountCents: 5_000,
      direction: "chapter_to_central",
    });

    await s.as.mutation(api.increase.removeChapterAccount, {});

    const sandboxLegs = await legsFor(
      s,
      settlementTransferGroupId(s.chapterId, 2026, 3),
    );
    expect(sandboxLegs.find((l) => l.chapterId === s.chapterId)).toBeUndefined();

    const manualLegs = await legsFor(
      s,
      settlementTransferGroupId(s.chapterId, 2026, 4),
    );
    expect(manualLegs.length).toBe(2);
  });
});

describe("transferReadiness", () => {
  test("false without accounts, true once both are active", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const before = await s.as.query(api.transfers.transferReadiness, {
      chapterId: s.chapterId,
    });
    expect(before.canMoveReal).toBe(false);

    await seedActiveAccount(s, s.chapterId, "account_ch");
    await seedActiveAccount(s, CENTRAL, "account_central");
    const after = await s.as.query(api.transfers.transferReadiness, {
      chapterId: s.chapterId,
    });
    expect(after.canMoveReal).toBe(true);
  });
});

// ── WP-4.5 · Inter-scope settlement balances ──────────────────────────────────
//
// "Your card determines whose account paid; reconcile determines whose budget
// it was; Central settles the difference monthly alongside the skim." A
// chapter's card can pay for a CENTRAL budget line (direction a — the common
// case); a `settlement` transfer pair true-ups the resulting cash imbalance,
// mirroring the skim/launch-grant ledger machinery exactly.

/** A chapter (non-central) budget, minimal fields. */
async function makeChapterBudget(
  s: ChapterSetup,
  amountCents: number,
  year = 2026,
): Promise<Id<"budgets">> {
  return s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "monthly",
    year,
  });
}

/** A central budget, minimal fields (caller needs central reach). */
async function makeCentralBudget(
  s: ChapterSetup,
  amountCents: number,
  year = 2026,
): Promise<Id<"budgets">> {
  return s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "monthly",
    year,
    central: true,
  });
}

/** A chapter-owned outflow txn (a card charge) explicitly linked to a budget. */
async function chapterSpendLinkedTo(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  amountCents: number,
  postedAt: number,
): Promise<void> {
  await s.as.mutation(api.finances.createManualTransaction, {
    flow: "outflow",
    amountCents,
    postedAt,
    budgetId,
  });
}

const MARCH_2026 = Date.UTC(2026, 2, 10, 16); // noon-ish ET, March 10 2026

describe("interScopeBalances — direction (a): chapter spend linked to a CENTRAL budget", () => {
  test("nets as 'central owes the chapter', all-time + this period", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 12_000, MARCH_2026);

    const march = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = march.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(12_000); // positive = central owes the chapter
    expect(row?.periodNetCents).toBe(12_000);

    // A different month: the all-time balance holds, but nothing landed THIS
    // period.
    const april = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 4,
    });
    const rowApril = april.find((b) => b.chapterId === s.chapterId);
    expect(rowApril?.netCents).toBe(12_000);
    expect(rowApril?.periodNetCents).toBe(0);
  });

  test("a chapter's own-budget spend never contributes (only central-linked spend does)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // "manager" (not "bookkeeper"): creating a CHAPTER budget needs
    // `requireFinanceManager` — a central grant is applicable to any chapter,
    // but the RANK still has to clear manager (see `createBudget`'s
    // non-central path).
    await asCentral(s, "manager");
    const chapterBudgetId = await makeChapterBudget(s, 50_000);
    await chapterSpendLinkedTo(s, chapterBudgetId, 9_000, MARCH_2026);

    const balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = balances.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(0);
    expect(row?.periodNetCents).toBe(0);
  });
});

describe("interScopeBalances — direction (b): verified NOT attributable today", () => {
  test("a central txn cannot attribute to a chapter budget (write-time rejection)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager"); // manager rank to create the chapter budget below
    const chapterBudgetId = await makeChapterBudget(s, 10_000);
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 500,
        postedAt: MARCH_2026,
        budgetId: chapterBudgetId,
        central: true,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("query math IS correct for direction (b) if the link existed anyway (future-proofing)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    // Bypass the write-time gate directly (proving the case above is a WRITE
    // restriction, not a query-side blind spot) — insert a central-owned txn
    // linked to a chapter budget the way `createManualTransaction` never
    // will, and confirm `interScopeBalances` still nets it correctly.
    const chapterBudgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10_000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: "outflow",
        amountCents: 8_000,
        currency: "usd",
        postedAt: MARCH_2026,
        budgetId: chapterBudgetId,
        status: "categorized",
        createdAt: Date.now(),
      }),
    );

    const balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = balances.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(-8_000); // negative = the chapter owes central
    expect(row?.periodNetCents).toBe(-8_000);
  });
});

describe("interScopeBalances — authz", () => {
  test("chapter manager (no central reach) is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.transfers.interScopeBalances, {}),
    ).rejects.toThrow(/central/i);
  });

  test("central VIEWER can read (query is viewer+, not a write)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(Array.isArray(balances)).toBe(true);
  });
});

describe("recordSettlementTransfer — nets out interScopeBalances", () => {
  test("a central_to_chapter settlement books central outflow → chapter inflow and fully nets the balance", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 20_000, MARCH_2026);

    let balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      20_000,
    );

    const res = await s.as.mutation(api.transfers.recordSettlementTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 3,
      amountCents: 20_000,
      direction: "central_to_chapter",
    });
    expect(res.amountCents).toBe(20_000);
    expect(res.transferGroupId).toBe(
      settlementTransferGroupId(s.chapterId, 2026, 3),
    );

    const legs = await legsFor(s, res.transferGroupId);
    expect(legs.length).toBe(2);
    const chapterLeg = legs.find((l) => l.chapterId === s.chapterId);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    // Central pays out (sourceScope); the chapter receives (destScope) — same
    // shape as a launch grant. Both legs share `flow:"transfer"` (excluded
    // from spend, like every transfer leg) — `outflowId`/`inflowId` and the
    // shared `transferDirection` are what distinguish the pair's shape.
    expect(centralLeg?._id).toBe(res.outflowId);
    expect(chapterLeg?._id).toBe(res.inflowId);
    for (const leg of legs) {
      expect(leg.source).toBe("settlement");
      expect(leg.flow).toBe("transfer");
      expect(leg.transferDirection).toBe("central_to_chapter");
      expect(leg.amountCents).toBe(20_000);
      expect(countsAsSpend(leg.flow)).toBe(false);
    }

    balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      0,
    );
  });

  test("a chapter_to_central settlement books chapter outflow → central inflow (same shape as the skim)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const res = await s.as.mutation(api.transfers.recordSettlementTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 5,
      amountCents: 7_000,
      direction: "chapter_to_central",
    });
    const legs = await legsFor(s, res.transferGroupId);
    const chapterLeg = legs.find((l) => l.chapterId === s.chapterId);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    // The chapter pays out (sourceScope); central receives (destScope).
    expect(chapterLeg?._id).toBe(res.outflowId);
    expect(centralLeg?._id).toBe(res.inflowId);
    for (const leg of legs) {
      expect(leg.flow).toBe("transfer");
      expect(leg.transferDirection).toBe("chapter_to_central");
    }
  });

  test("idempotency: re-recording the same chapter/month settlement is REJECTED", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const args = {
      chapterId: s.chapterId,
      year: 2026,
      month: 6,
      amountCents: 5_000,
      direction: "central_to_chapter" as const,
    };
    await s.as.mutation(api.transfers.recordSettlementTransfer, args);
    // Re-recording the SAME month is rejected even with the OPPOSITE
    // direction — the group id is keyed on (chapter, year, month) only.
    await expect(
      s.as.mutation(api.transfers.recordSettlementTransfer, {
        ...args,
        direction: "chapter_to_central",
        amountCents: 1_000,
      }),
    ).rejects.toThrow(/already been recorded/i);
    const legs = await legsFor(
      s,
      settlementTransferGroupId(s.chapterId, 2026, 6),
    );
    expect(legs.length).toBe(2);
  });
});

describe("recordSettlementTransfer — authz", () => {
  test("chapter manager is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.mutation(api.transfers.recordSettlementTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 1_000,
        direction: "central_to_chapter",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("central VIEWER is FORBIDDEN on the write (needs bookkeeper+)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    await expect(
      s.as.mutation(api.transfers.recordSettlementTransfer, {
        chapterId: s.chapterId,
        year: 2026,
        month: 3,
        amountCents: 1_000,
        direction: "central_to_chapter",
      }),
    ).rejects.toThrow(ConvexError);
    const legs = await legsFor(
      s,
      settlementTransferGroupId(s.chapterId, 2026, 3),
    );
    expect(legs.length).toBe(0);
  });
});

describe("interScopeBalances — mode-filtered settlements (IMPORTANT 1 parity, #163)", () => {
  test("a sandbox-externalId settlement leg is excluded from prod mode, included in sandbox; manual legs count in both", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    // Gross balance: 50_000 owed to the chapter (a manual, source:"manual"
    // card txn — environment-neutral, shows in both modes).
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 50_000, MARCH_2026);

    // Manual settlement leg (no externalId) — env-neutral, counts in BOTH.
    await s.as.mutation(api.transfers.recordSettlementTransfer, {
      chapterId: s.chapterId,
      year: 2026,
      month: 1,
      amountCents: 10_000,
      direction: "central_to_chapter",
    });
    // A "production" real settlement leg (non-sandbox externalId).
    await s.as.mutation(internal.transfers.recordSettlementPairFromIncrease, {
      chapterId: s.chapterId,
      year: 2026,
      month: 2,
      amountCents: 15_000,
      direction: "central_to_chapter",
      increaseTransferId: "account_transfer_prod",
    });
    // A sandbox-initiated real settlement leg.
    await s.as.mutation(internal.transfers.recordSettlementPairFromIncrease, {
      chapterId: s.chapterId,
      year: 2026,
      month: 4,
      amountCents: 5_000,
      direction: "central_to_chapter",
      increaseTransferId: "sandbox_account_transfer_9",
    });

    // Default (no financeSettings row) is production mode: 50_000 gross −
    // (10_000 manual + 15_000 prod) settled = 25_000.
    const prod = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 1,
    });
    expect(prod.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      25_000,
    );

    // Flip to sandbox mode: 50_000 gross − (10_000 manual + 5_000 sandbox)
    // settled = 35_000. The prod real leg drops out; the sandbox one counts.
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: true,
        updatedAt: Date.now(),
      }),
    );
    const sandbox = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 1,
    });
    expect(sandbox.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      35_000,
    );
  });
});
