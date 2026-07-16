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
