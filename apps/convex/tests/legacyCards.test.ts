/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { extractCardLast4, isCardEligible } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Legacy (Relay) card linking + pw-email card eligibility:
 *  - the pure helpers `extractCardLast4` (parse the trailing `**NNNN`, null when
 *    absent) + `isCardEligible` (@publicworship.life, case-insensitive),
 *  - `linkRelayCard` creates a legacy card + attributes matching txns, is
 *    idempotent, and rejects a non-pw-email person,
 *  - `listRelayCardCandidates` aggregates distinct last-4s across BOTH stripe_fc
 *    and relay_csv txns (a card seen only in CSV history is still surfaced),
 *  - `unlinkRelayCard` deletes the card + clears its attribution,
 *  - `people.cardEligible` returns only pw-email people,
 *  - `backfillLegacyCardAttribution` is idempotent.
 */

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      pwEmail: "caller@publicworship.life",
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

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager");
  return personId;
}

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; pwEmail?: string | null },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      pwEmail: opts.pwEmail ?? undefined,
      createdAt: Date.now(),
    }),
  );
}

/** Seed a stripe_fc transaction carrying a parsed last-4. */
async function seedFcTxn(
  s: ChapterSetup,
  opts: {
    externalId: string;
    cardLast4?: string;
    amountCents: number;
    flow?: "outflow" | "inflow";
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "stripe_fc",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      postedAt: Date.now(),
      cardLast4: opts.cardLast4,
      merchantName: opts.cardLast4 ? `PURCHASE | **${opts.cardLast4}` : "Misc",
      status: "unreviewed",
      externalId: opts.externalId,
      createdAt: Date.now(),
    }),
  );
}

/** Seed a relay_csv transaction carrying a parsed last-4. */
async function seedCsvTxn(
  s: ChapterSetup,
  opts: {
    externalId: string;
    cardLast4?: string;
    amountCents: number;
    flow?: "outflow" | "inflow";
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "relay_csv",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      postedAt: Date.now(),
      cardLast4: opts.cardLast4,
      merchantName: opts.cardLast4 ? `RELAY | **${opts.cardLast4}` : "Misc",
      status: "unreviewed",
      externalId: opts.externalId,
      createdAt: Date.now(),
    }),
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("extractCardLast4", () => {
  test("parses the trailing **NNNN out of a description", () => {
    expect(extractCardLast4("POS PURCHASE FOO | **2702")).toBe("2702");
    expect(extractCardLast4("**1234")).toBe("1234");
    // Prefers the LAST masked group when several are present.
    expect(extractCardLast4("ACH **0000 ... CARD **9876")).toBe("9876");
  });

  test("returns null when no masked last-4 is present", () => {
    expect(extractCardLast4("Office Depot")).toBeNull();
    expect(extractCardLast4("")).toBeNull();
    expect(extractCardLast4(undefined)).toBeNull();
    expect(extractCardLast4(null)).toBeNull();
    // A masked group that isn't exactly 4 digits doesn't match.
    expect(extractCardLast4("card **12")).toBeNull();
  });
});

describe("isCardEligible", () => {
  test("only a @publicworship.life email is eligible (case-insensitive)", () => {
    expect(isCardEligible("a@publicworship.life")).toBe(true);
    expect(isCardEligible("  A@PublicWorship.Life  ")).toBe(true);
    expect(isCardEligible("a@gmail.com")).toBe(false);
    expect(isCardEligible(undefined)).toBe(false);
    expect(isCardEligible(null)).toBe(false);
    expect(isCardEligible("")).toBe(false);
  });
});

// ── linkRelayCard ────────────────────────────────────────────────────────────

describe("linkRelayCard", () => {
  test("creates a legacy card + attributes existing matching txns", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const holder = await seedPerson(s, {
      name: "Relay Holder",
      pwEmail: "relay@publicworship.life",
    });
    const a = await seedFcTxn(s, { externalId: "fc:a", cardLast4: "2702", amountCents: 1500 });
    const b = await seedFcTxn(s, { externalId: "fc:b", cardLast4: "2702", amountCents: 500 });
    // A different last-4 must NOT be attributed.
    const other = await seedFcTxn(s, { externalId: "fc:c", cardLast4: "9999", amountCents: 300 });

    const res = await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: holder,
    });
    expect(res.attributed).toBe(2);

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
    expect(cards[0].increaseCardId).toBeUndefined();

    const ta = await run(s.t, (ctx) => ctx.db.get(a));
    const tb = await run(s.t, (ctx) => ctx.db.get(b));
    const tc = await run(s.t, (ctx) => ctx.db.get(other));
    expect(ta?.cardId).toBe(res.cardId);
    expect(ta?.personId).toBe(holder);
    expect(tb?.personId).toBe(holder);
    expect(tc?.cardId).toBeUndefined();
  });

  test("is idempotent — one legacy card per (chapter, last4)", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const holder = await seedPerson(s, {
      name: "Relay Holder",
      pwEmail: "relay@publicworship.life",
    });
    await seedFcTxn(s, { externalId: "fc:a", cardLast4: "2702", amountCents: 1500 });

    const first = await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: holder,
    });
    const second = await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: holder,
    });
    expect(second.cardId).toBe(first.cardId);
    // Second run attributes nothing new (already attributed).
    expect(second.attributed).toBe(0);

    const cards = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(cards.length).toBe(1);
  });

  test("rejects a person without a @publicworship.life email (NOT_CARD_ELIGIBLE)", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const ineligible = await seedPerson(s, { name: "Outsider", pwEmail: "x@gmail.com" });

    await expect(
      s.as.mutation(api.legacyCards.linkRelayCard, {
        last4: "2702",
        personId: ineligible,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const cards = await run(s.t, (ctx) =>
      ctx.db
        .query("cards")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(cards.length).toBe(0);
  });

  test("re-linking re-points the card + its own txns to a new cardholder", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const first = await seedPerson(s, { name: "First", pwEmail: "first@publicworship.life" });
    const second = await seedPerson(s, { name: "Second", pwEmail: "second@publicworship.life" });
    const a = await seedFcTxn(s, { externalId: "fc:a", cardLast4: "2702", amountCents: 1500 });

    const linked = await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: first,
    });
    await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: second,
    });

    const card = await run(s.t, (ctx) => ctx.db.get(linked.cardId));
    expect(card?.cardholderPersonId).toBe(second);
    const ta = await run(s.t, (ctx) => ctx.db.get(a));
    expect(ta?.personId).toBe(second);
  });
});

// ── unlinkRelayCard ──────────────────────────────────────────────────────────

describe("unlinkRelayCard", () => {
  test("deletes the legacy card + clears its attributed txns", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const holder = await seedPerson(s, {
      name: "Relay Holder",
      pwEmail: "relay@publicworship.life",
    });
    const a = await seedFcTxn(s, { externalId: "fc:a", cardLast4: "2702", amountCents: 1500 });
    const linked = await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: holder,
    });

    const res = await s.as.mutation(api.legacyCards.unlinkRelayCard, {
      cardId: linked.cardId,
    });
    expect(res.cleared).toBe(1);

    expect(await run(s.t, (ctx) => ctx.db.get(linked.cardId))).toBeNull();
    const ta = await run(s.t, (ctx) => ctx.db.get(a));
    expect(ta?.cardId).toBeUndefined();
    expect(ta?.personId).toBeUndefined();
  });
});

// ── listRelayCardCandidates ──────────────────────────────────────────────────

describe("listRelayCardCandidates", () => {
  test("aggregates distinct last-4s with count + spend + linked card", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const holder = await seedPerson(s, {
      name: "Relay Holder",
      pwEmail: "relay@publicworship.life",
    });
    await seedFcTxn(s, { externalId: "fc:a", cardLast4: "2702", amountCents: 1500 });
    await seedFcTxn(s, { externalId: "fc:b", cardLast4: "2702", amountCents: 500 });
    await seedFcTxn(s, { externalId: "fc:c", cardLast4: "9999", amountCents: 300 });
    // A row with no last-4 is ignored.
    await seedFcTxn(s, { externalId: "fc:d", amountCents: 100 });

    await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "2702",
      personId: holder,
    });

    const candidates = await s.as.query(api.legacyCards.listRelayCardCandidates, {});
    expect(candidates.length).toBe(2);
    const c2702 = candidates.find((c) => c.last4 === "2702")!;
    expect(c2702.txnCount).toBe(2);
    expect(c2702.spentCents).toBe(2000);
    expect(c2702.linkedCard?.personId).toBe(holder);
    const c9999 = candidates.find((c) => c.last4 === "9999")!;
    expect(c9999.linkedCard).toBeNull();
  });

  test("surfaces a last-4 seen ONLY in relay_csv history (no stripe_fc)", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    // A card used only before the FC window: it appears solely on CSV rows.
    await seedCsvTxn(s, { externalId: "csv:a", cardLast4: "4040", amountCents: 1200 });
    await seedCsvTxn(s, { externalId: "csv:b", cardLast4: "4040", amountCents: 800 });
    // An inflow (refund) on the same last-4 counts toward the txn count but not spend.
    await seedCsvTxn(s, {
      externalId: "csv:c",
      cardLast4: "4040",
      amountCents: 300,
      flow: "inflow",
    });

    const candidates = await s.as.query(api.legacyCards.listRelayCardCandidates, {});
    expect(candidates.length).toBe(1);
    const c = candidates[0];
    expect(c.last4).toBe("4040");
    expect(c.txnCount).toBe(3);
    expect(c.spentCents).toBe(2000); // only the two outflows
    expect(c.linkedCard).toBeNull(); // unlinked → UI shows "Link to person"
  });

  test("a linked CSV-only last-4 shows its person", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const holder = await seedPerson(s, {
      name: "CSV Holder",
      pwEmail: "csv@publicworship.life",
    });
    await seedCsvTxn(s, { externalId: "csv:a", cardLast4: "4040", amountCents: 1200 });

    await s.as.mutation(api.legacyCards.linkRelayCard, {
      last4: "4040",
      personId: holder,
    });

    const candidates = await s.as.query(api.legacyCards.listRelayCardCandidates, {});
    const c = candidates.find((x) => x.last4 === "4040")!;
    expect(c.linkedCard?.personId).toBe(holder);
    expect(c.linkedCard?.personName).toBe("CSV Holder");
  });

  test("sums count + spend across BOTH sources for a shared last-4", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    // Same card seen in the FC window and in CSV history — one candidate, summed.
    await seedFcTxn(s, { externalId: "fc:a", cardLast4: "2702", amountCents: 1500 });
    await seedCsvTxn(s, { externalId: "csv:a", cardLast4: "2702", amountCents: 500 });
    await seedCsvTxn(s, { externalId: "csv:b", cardLast4: "2702", amountCents: 250 });

    const candidates = await s.as.query(api.legacyCards.listRelayCardCandidates, {});
    expect(candidates.length).toBe(1);
    const c = candidates[0];
    expect(c.last4).toBe("2702");
    expect(c.txnCount).toBe(3); // 1 fc + 2 csv
    expect(c.spentCents).toBe(2250); // 1500 + 500 + 250
  });
});

// ── people.cardEligible ──────────────────────────────────────────────────────

describe("people.cardEligible", () => {
  test("returns only @publicworship.life people", async () => {
    const s = await setupChapter(newT());
    await seedPerson(s, { name: "Eligible One", pwEmail: "one@publicworship.life" });
    await seedPerson(s, { name: "Eligible Two", pwEmail: "TWO@PublicWorship.Life" });
    await seedPerson(s, { name: "Outsider", pwEmail: "x@gmail.com" });
    await seedPerson(s, { name: "No Email", pwEmail: null });

    const rows = await s.as.query(api.people.cardEligible, {});
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["Eligible One", "Eligible Two"]);
    // Same read shape as people.list — includes the resolved imageUrl field.
    expect(rows[0]).toHaveProperty("imageUrl");
  });
});

// ── backfillLegacyCardAttribution ────────────────────────────────────────────

describe("backfillLegacyCardAttribution", () => {
  test("stamps cardLast4 + attributes to a legacy card, idempotently", async () => {
    const s = await setupChapter(newT());
    const holder = await seedPerson(s, {
      name: "Relay Holder",
      pwEmail: "relay@publicworship.life",
    });
    // A legacy card, and an OLD stripe_fc txn with the description in merchantName
    // but NO cardLast4 yet (predates the field).
    await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: holder,
        type: "physical",
        source: "legacy",
        last4: "2702",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "stripe_fc",
        flow: "outflow",
        amountCents: 1500,
        postedAt: Date.now(),
        merchantName: "COFFEE | **2702",
        status: "unreviewed",
        externalId: "stripe_fc:old_a",
        createdAt: Date.now(),
      }),
    );

    const first = await s.t.mutation(
      internal.stripeFinance.backfillLegacyCardAttribution,
      {},
    );
    expect(first.last4Set).toBe(1);
    expect(first.attributed).toBe(1);

    const after = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(after?.cardLast4).toBe("2702");
    expect(after?.personId).toBe(holder);

    // Idempotent: a second run changes nothing.
    const second = await s.t.mutation(
      internal.stripeFinance.backfillLegacyCardAttribution,
      {},
    );
    expect(second.last4Set).toBe(0);
    expect(second.attributed).toBe(0);
  });
});
