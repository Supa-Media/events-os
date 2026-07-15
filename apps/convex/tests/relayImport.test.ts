/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { parseRelayReference } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Relay monthly-statement CSV import (`stripeFinance.importRelayTransactions`)
 * + the pure `parseRelayReference` helper.
 *
 * Covers:
 *  - `parseRelayReference` splits a card reference (person / last-4 / card name),
 *    handles a hyphenated name, and returns null for a payout-style reference;
 *  - the import INSERTS new `relay_csv` rows (correct flow/amount/status/source)
 *    and DEDUPS on re-import (idempotent `externalId`);
 *  - an overlapping already-synced `stripe_fc` charge is ENRICHED (last-4 +
 *    attribution) instead of duplicated;
 *  - a card reference find-or-creates a legacy card + matches a person by name
 *    (attribution stamped on the txn);
 *  - a payout reference gets NO card;
 *  - gating: below-bookkeeper is rejected.
 */

// ── Seed helpers ─────────────────────────────────────────────────────────────

/** Noon UTC of a calendar date — safely inside that Eastern day (~7–8am ET). */
function noonUtc(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

async function seedCallerPerson(s: ChapterSetup): Promise<Id<"people">> {
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

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
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

/** A bookkeeper-graded caller (person linked to the auth user + a grant). */
async function asBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedCallerPerson(s);
  await grantRole(s, personId, "bookkeeper");
  return personId;
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      createdAt: Date.now(),
    }),
  );
}

async function seedFund(s: ChapterSetup): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedAccount(
  s: ChapterSetup,
  opts: { defaultFundId?: Id<"funds"> } = {},
): Promise<Id<"legacyAccounts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("legacyAccounts", {
      chapterId: s.chapterId,
      stripeFcAccountId: "fca_relay_test",
      institutionName: "Relay",
      last4: "4207",
      type: "depository",
      defaultFundId: opts.defaultFundId,
      backfilledAt: Date.now(),
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function relayTxns(s: ChapterSetup) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  ).then((rows) => rows.filter((r) => r.source === "relay_csv"));
}

// ── parseRelayReference (pure) ───────────────────────────────────────────────

describe("parseRelayReference", () => {
  test("splits a card reference into person / last-4 / card name", () => {
    expect(
      parseRelayReference("Oluseyi Olujide - 2702 (Seyi's PW Card)"),
    ).toEqual({
      personName: "Oluseyi Olujide",
      cardLast4: "2702",
      cardName: "Seyi's PW Card",
    });
  });

  test("handles a hyphenated person name (splits at ' - NNNN ')", () => {
    expect(parseRelayReference("Agujudah Okey-Uche - 2588 (AJ's Card)")).toEqual(
      {
        personName: "Agujudah Okey-Uche",
        cardLast4: "2588",
        cardName: "AJ's Card",
      },
    );
  });

  test("returns null for a payout-style reference (no last-4 / card tail)", () => {
    expect(
      parseRelayReference(
        "Public Worship - Love Wins 3/28 - Sent By Oluseyi Olujide",
      ),
    ).toBeNull();
  });

  test("returns null for empty / missing references", () => {
    expect(parseRelayReference("")).toBeNull();
    expect(parseRelayReference(undefined)).toBeNull();
    expect(parseRelayReference(null)).toBeNull();
  });
});

// ── importRelayTransactions ──────────────────────────────────────────────────

describe("importRelayTransactions", () => {
  test("inserts relay_csv rows (correct flow/amount/status) and dedups on re-import", async () => {
    const s = await setupChapter(newT());
    await asBookkeeper(s);
    const fund = await seedFund(s);
    const account = await seedAccount(s, { defaultFundId: fund });

    const rows = [
      {
        postedAt: noonUtc(2026, 3, 29),
        merchant: "Blackmagic Cloud Store",
        amountCents: -1250,
        reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
        status: "SETTLED",
      },
      {
        postedAt: noonUtc(2026, 3, 31),
        merchant: "Isaiah Jones",
        amountCents: -22500,
        reference: "Public Worship - Love Wins 3/28 - Sent By Oluseyi Olujide",
        status: "SETTLED",
      },
    ];

    const res = await s.as.mutation(api.stripeFinance.importRelayTransactions, {
      legacyAccountId: account,
      rows,
    });
    expect(res).toEqual({
      created: 2,
      enriched: 0,
      skipped: 0,
      // No person named "Oluseyi Olujide" in the chapter yet → no card minted.
      cardsCreated: 0,
      cardsLinked: 0,
    });

    const inserted = await relayTxns(s);
    expect(inserted.length).toBe(2);
    const card = inserted.find((r) => r.merchantName === "Blackmagic Cloud Store");
    expect(card?.flow).toBe("outflow");
    expect(card?.amountCents).toBe(1250); // stored non-negative
    expect(card?.status).toBe("unreviewed");
    expect(card?.cardLast4).toBe("2702");
    expect(card?.fundId).toBe(fund);
    expect(card?.description).toBe("Oluseyi Olujide - 2702 (Seyi's PW Card)");

    // Re-import the exact same statement → every row dedups, nothing new.
    const res2 = await s.as.mutation(api.stripeFinance.importRelayTransactions, {
      legacyAccountId: account,
      rows,
    });
    expect(res2).toEqual({
      created: 0,
      enriched: 0,
      skipped: 2,
      cardsCreated: 0,
      cardsLinked: 0,
    });
    expect((await relayTxns(s)).length).toBe(2);
  });

  test("attributes a card reference via a find-or-created legacy card + name match", async () => {
    const s = await setupChapter(newT());
    await asBookkeeper(s);
    const account = await seedAccount(s);
    const holder = await seedPerson(s, "Oluseyi Olujide");

    const rows = [
      {
        postedAt: noonUtc(2026, 3, 29),
        merchant: "Blackmagic Cloud Store",
        amountCents: -1250,
        reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
      },
      // A SECOND charge on the same card reuses the created card (no 2nd card).
      {
        postedAt: noonUtc(2026, 3, 30),
        merchant: "Givebutter",
        amountCents: -3380,
        reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
      },
    ];

    const res = await s.as.mutation(api.stripeFinance.importRelayTransactions, {
      legacyAccountId: account,
      rows,
    });
    expect(res.created).toBe(2);
    expect(res.cardsCreated).toBe(1);
    expect(res.cardsLinked).toBe(2);

    const cards = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_chapter_and_last4", (q) =>
          q.eq("chapterId", s.chapterId).eq("last4", "2702"),
        )
        .collect(),
    );
    expect(cards.length).toBe(1);
    expect(cards[0].source).toBe("legacy");
    expect(cards[0].cardholderPersonId).toBe(holder);

    const txns = await relayTxns(s);
    for (const t of txns) {
      expect(t.cardId).toBe(cards[0]._id);
      expect(t.personId).toBe(holder);
    }
  });

  test("enriches an overlapping stripe_fc charge instead of inserting a duplicate", async () => {
    const s = await setupChapter(newT());
    await asBookkeeper(s);
    const account = await seedAccount(s);
    const holder = await seedPerson(s, "Oluseyi Olujide");

    // An already-synced FC charge: same abs amount + same Eastern day, last-4
    // only inside the merchant string, unattributed.
    const fcId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "stripe_fc",
        flow: "outflow",
        amountCents: 1250,
        postedAt: Date.UTC(2026, 2, 29, 20, 0, 0), // 4pm ET, same day
        merchantName: "POS PURCHASE BLACKMAGIC | **2702",
        status: "unreviewed",
        externalId: "stripe_fc:fctxn_x",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.stripeFinance.importRelayTransactions, {
      legacyAccountId: account,
      rows: [
        {
          postedAt: noonUtc(2026, 3, 29),
          merchant: "Blackmagic Cloud Store",
          amountCents: -1250,
          reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
        },
      ],
    });
    // Folded into the FC row — no new relay_csv row.
    expect(res.created).toBe(0);
    expect(res.enriched).toBe(1);
    expect(res.cardsCreated).toBe(1);
    expect(res.cardsLinked).toBe(1);
    expect((await relayTxns(s)).length).toBe(0);

    // The FC row now carries the parsed last-4 + attribution.
    const fc = await run(s.t, (ctx) => ctx.db.get(fcId));
    expect(fc?.cardLast4).toBe("2702");
    expect(fc?.personId).toBe(holder);
    expect(fc?.cardId).toBeTruthy();
  });

  test("a payout row gets no card and imports as a plain relay_csv row", async () => {
    const s = await setupChapter(newT());
    await asBookkeeper(s);
    const account = await seedAccount(s);

    const res = await s.as.mutation(api.stripeFinance.importRelayTransactions, {
      legacyAccountId: account,
      rows: [
        {
          postedAt: noonUtc(2026, 3, 31),
          merchant: "Isaiah Jones",
          amountCents: -22500,
          reference:
            "Public Worship - Love Wins 3/28 - Sent By Oluseyi Olujide",
        },
      ],
    });
    expect(res.created).toBe(1);
    expect(res.cardsCreated).toBe(0);
    expect(res.cardsLinked).toBe(0);

    const [txn] = await relayTxns(s);
    expect(txn.cardId).toBeUndefined();
    expect(txn.personId).toBeUndefined();
    expect(txn.cardLast4).toBeUndefined();
    expect(txn.flow).toBe("outflow");
  });

  test("runImportRelayTransactions (no auth) resolves the active FC account and imports rows", async () => {
    const s = await setupChapter(newT());
    // No finance role granted — the internal mutation is unauthenticated ops.
    const holder = await seedPerson(s, "Oluseyi Olujide");
    const fund = await seedFund(s);
    await seedAccount(s, { defaultFundId: fund });

    const rows = [
      {
        postedAt: noonUtc(2026, 3, 29),
        merchant: "Blackmagic Cloud Store",
        amountCents: -1250,
        reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
        status: "SETTLED",
      },
      {
        postedAt: noonUtc(2026, 3, 31),
        merchant: "Isaiah Jones",
        amountCents: -22500,
        reference: "Public Worship - Love Wins 3/28 - Sent By Oluseyi Olujide",
        status: "SETTLED",
      },
    ];

    // Called on the raw (unauthenticated) test instance — no chapterId, so it
    // resolves the single active FC account deployment-wide.
    const res = await s.t.mutation(
      internal.stripeFinance.runImportRelayTransactions,
      { rows },
    );
    expect(res).toEqual({
      created: 2,
      enriched: 0,
      skipped: 0,
      cardsCreated: 1, // a legacy card is minted for the matched cardholder
      cardsLinked: 1, // the card charge is attributed; the payout is not
    });

    const inserted = await relayTxns(s);
    expect(inserted.length).toBe(2);
    const card = inserted.find(
      (r) => r.merchantName === "Blackmagic Cloud Store",
    );
    expect(card?.flow).toBe("outflow");
    expect(card?.amountCents).toBe(1250);
    expect(card?.cardLast4).toBe("2702");
    expect(card?.fundId).toBe(fund);
    expect(card?.personId).toBe(holder);
    expect(card?.cardId).toBeTruthy();

    // Re-run the same statement → every row dedups (idempotent), no new rows.
    const res2 = await s.t.mutation(
      internal.stripeFinance.runImportRelayTransactions,
      { rows },
    );
    expect(res2).toEqual({
      created: 0,
      enriched: 0,
      skipped: 2,
      cardsCreated: 0,
      cardsLinked: 0,
    });
    expect((await relayTxns(s)).length).toBe(2);
  });

  test("runImportRelayTransactions throws when no active FC account resolves", async () => {
    const s = await setupChapter(newT());
    // No legacy account seeded at all.
    await expect(
      s.t.mutation(internal.stripeFinance.runImportRelayTransactions, {
        rows: [
          {
            postedAt: noonUtc(2026, 3, 29),
            merchant: "Blackmagic Cloud Store",
            amountCents: -1250,
            reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
          },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("rejects a below-bookkeeper caller", async () => {
    const s = await setupChapter(newT());
    const person = await seedCallerPerson(s);
    await grantRole(s, person, "viewer");
    const account = await seedAccount(s);

    await expect(
      s.as.mutation(api.stripeFinance.importRelayTransactions, {
        legacyAccountId: account,
        rows: [
          {
            postedAt: noonUtc(2026, 3, 29),
            merchant: "Blackmagic Cloud Store",
            amountCents: -1250,
            reference: "Oluseyi Olujide - 2702 (Seyi's PW Card)",
          },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });
});
