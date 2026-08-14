/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { DAY_MS } from "@events-os/shared";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api, internal } from "../_generated/api";
import { chaseOutstandingFor } from "../finances";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * THE CODING CHASE — its population, and the precedence of its scopings.
 *
 * Two things are pinned here, and they are the two things the feature is:
 *
 *  1. THE POPULATION IS A UNION. Everything owing a CODING, plus anything
 *     owing only a RECEIPT. The second half is what makes retiring
 *     `/finances/receipt-chase` safe — pre-policy history owes no coding and
 *     can still be missing its document — so a regression that drops it would
 *     silently stop chasing rows nothing else chases.
 *  2. SELECTION > FILTERS + SEARCH > EVERYTHING THEY OWE. The founder's whole
 *     reason for wanting the chase in the grid: *"they'd know there's no way
 *     this person can code these two transactions, but they can code these
 *     three."* Getting the order wrong means the button asks for something
 *     other than what the manager was looking at.
 *
 * And the guarantee that makes the scoping safe to accept from a client: the
 * ids are INTERSECTED, never followed. `getCodingChaseTargets` re-derives
 * eligibility and the recipient per row, so no id list can make somebody get
 * chased for a row that owes nothing, or aim a chase at the wrong person.
 *
 * `codingReminders.test.ts` covers the label vocabulary and the automated
 * digest; `receiptChase.test.ts` covers the fee carve-out at the predicate.
 */

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manager Mo",
      pwEmail: "mo@publicworship.life",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
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

/** A finance BOOKKEEPER — full run of the Book, and deliberately not this. */
async function asBookkeeper(s: ChapterSetup): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Book Keeper",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "bookkeeper",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/** Arm the coding policy `sinceDaysAgo` days back, so a fixture aged less than
 *  that is POST-policy (owes a coding) and one aged more is PRE-policy
 *  (grandfathered — owes a receipt and nothing else). */
async function armCodingPolicy(
  s: ChapterSetup,
  sinceDaysAgo = 30,
): Promise<void> {
  const patch = {
    codingRequiredSinceMs: Date.now() - sinceDaysAgo * DAY_MS,
    codingConversionSinceMs: Date.now() - sinceDaysAgo * DAY_MS,
    updatedAt: Date.now(),
  };
  await run(s.t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) await ctx.db.patch(existing._id, patch);
    else
      await ctx.db.insert("financeSettings", { sandboxMode: false, ...patch });
  });
}

async function seedCardholder(
  s: ChapterSetup,
  name: string,
  opts: { pwEmail?: string } = {},
): Promise<{ personId: Id<"people">; cardId: Id<"cards"> }> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      pwEmail: opts.pwEmail,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const cardId = await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId: personId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
  return { personId, cardId };
}

async function seedCharge(
  s: ChapterSetup,
  opts: {
    cardId?: Id<"cards">;
    ageDays?: number;
    amountCents?: number;
    merchantName?: string;
    receiptStorageId?: Id<"_storage">;
    codingState?: "submitted" | "changes_requested" | "approved";
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    isPersonal?: boolean;
  },
): Promise<Id<"transactions">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 4200,
      postedAt: now - (opts.ageDays ?? 0) * DAY_MS,
      merchantName: opts.merchantName ?? "Delta",
      cardId: opts.cardId,
      receiptStorageId: opts.receiptStorageId,
      codingState: opts.codingState,
      isPersonal: opts.isPersonal,
      status: opts.status ?? "unreviewed",
      createdAt: now,
    }),
  );
}

/** Every charge the chase resolved, flattened — the assertion most of these
 *  tests actually want ("who was asked for what"). */
function chargesOf(
  targets: Array<{
    cardholderName: string;
    charges: Array<{ merchantName: string | null }>;
  }>,
): string[] {
  return targets
    .flatMap((t) => t.charges.map((c) => c.merchantName ?? "?"))
    .sort();
}

// ── 1. THE POPULATION ────────────────────────────────────────────────────────
describe("chaseOutstandingFor — the union, at the predicate", () => {
  /** A minimal spend row. Only the fields the chase predicates read matter;
   *  the rest of the document is irrelevant to them, which is the point of
   *  testing the predicate rather than only the query. */
  const spend = (
    over: Partial<Doc<"transactions">> = {},
  ): Doc<"transactions"> =>
    ({
      _id: "t1" as Id<"transactions">,
      _creationTime: 0,
      chapterId: "c1" as Id<"chapters">,
      source: "manual",
      flow: "outflow",
      amountCents: 1000,
      postedAt: 2_000,
      status: "unreviewed",
      createdAt: 0,
      ...over,
    }) as Doc<"transactions">;

  // The policy date sits between the two ages used below: `postedAt: 2000` is
  // POST-policy, `postedAt: 500` is PRE-policy history.
  const SINCE = 1_000;

  test("a post-policy charge with nothing on it owes both", () => {
    expect(chaseOutstandingFor(spend(), SINCE)).toBe(
      "needs coding and a receipt",
    );
  });

  test("a receipt alone does not settle it — the coding is still owed", () => {
    const documented = spend({ receiptStorageId: "s1" as Id<"_storage"> });
    expect(chaseOutstandingFor(documented, SINCE)).toBe("needs coding");
  });

  test("an approved coding settles it", () => {
    const done = spend({
      receiptStorageId: "s1" as Id<"_storage">,
      codingState: "approved",
    });
    expect(chaseOutstandingFor(done, SINCE)).toBeNull();
  });

  // ── THE HALF THAT LETS THE RECEIPT CHASE RETIRE ────────────────────────────
  test("PRE-POLICY history owes a receipt and nothing more — and is still chased", () => {
    const historical = spend({ postedAt: 500 });
    // Grandfathered by `codingRequiredSinceMs`, so it owes no coding at all.
    // If the chase were keyed on the coding debt alone this row would fall out
    // of every surface at once — nothing else chases it — which is exactly the
    // regression retiring `/finances/receipt-chase` would otherwise cause.
    expect(chaseOutstandingFor(historical, SINCE)).toBe("needs a receipt");
  });

  test("pre-policy history WITH a receipt owes nothing", () => {
    const settled = spend({
      postedAt: 500,
      receiptStorageId: "s1" as Id<"_storage">,
    });
    expect(chaseOutstandingFor(settled, SINCE)).toBeNull();
  });

  test("an approved receipt exception is documentation, pre- and post-policy", () => {
    const excepted = spend({
      postedAt: 500,
      approvedReceiptExceptionId: "e1" as Id<"receiptExceptions">,
    });
    expect(chaseOutstandingFor(excepted, SINCE)).toBeNull();
  });

  test("a closed row has nobody left to chase", () => {
    expect(
      chaseOutstandingFor(spend({ status: "reconciled" }), SINCE),
    ).toBeNull();
    expect(
      chaseOutstandingFor(spend({ status: "excluded" }), SINCE),
    ).toBeNull();
  });

  test("a personal charge is a debt to collect, not an account to write", () => {
    expect(chaseOutstandingFor(spend({ isPersonal: true }), SINCE)).toBeNull();
  });

  test("a sent-back coding outranks everything the row also owes", () => {
    const sentBack = spend({ codingState: "changes_requested" });
    expect(chaseOutstandingFor(sentBack, SINCE)).toBe(
      "sent back — needs your edit",
    );
  });
});

// ── 2. THE SCOPING PRECEDENCE ────────────────────────────────────────────────
describe("getCodingChaseTargets — selection > filters + search > everything owed", () => {
  /**
   * Two cardholders, five chaseable charges between them. The same fixture
   * answers every precedence question below, which is the point: each test
   * changes only the SCOPE it sends and asserts what came back.
   */
  async function fixture() {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const ada = await seedCardholder(s, "Ada", {
      pwEmail: "ada@publicworship.life",
    });
    const bo = await seedCardholder(s, "Bo", {
      pwEmail: "bo@publicworship.life",
    });

    const adaHotel = await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Hilton",
      amountCents: 30_000,
    });
    const adaCoffee = await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Blue Bottle",
      amountCents: 900,
    });
    // Documented but uncoded — invisible to a documentation-only chase, and the
    // reason "coding includes receipts" has to run in that direction too.
    const adaFlight = await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Delta",
      amountCents: 45_000,
      receiptStorageId: await storeBlob(s.t),
    });
    const boLumber = await seedCharge(s, {
      cardId: bo.cardId,
      merchantName: "Home Depot",
      amountCents: 12_000,
    });
    const boPaint = await seedCharge(s, {
      cardId: bo.cardId,
      merchantName: "Sherwin Williams",
      amountCents: 3_000,
      // Already reviewed — so a `to_review` filter must exclude it.
      status: "categorized",
    });
    return { s, ada, bo, adaHotel, adaCoffee, adaFlight, boLumber, boPaint };
  }

  test("nothing narrowed: everyone, everything they owe", async () => {
    const { s } = await fixture();
    const targets = await s.as.query(
      internal.finances.getCodingChaseTargets,
      {},
    );
    expect(targets.map((t) => t.cardholderName).sort()).toEqual(["Ada", "Bo"]);
    expect(chargesOf(targets)).toEqual([
      "Blue Bottle",
      "Delta",
      "Hilton",
      "Home Depot",
      "Sherwin Williams",
    ]);
  });

  test("a personId picks one band out of whatever the scope left", async () => {
    const { s, ada } = await fixture();
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      personId: ada.personId,
    });
    expect(targets).toHaveLength(1);
    expect(chargesOf(targets)).toEqual(["Blue Bottle", "Delta", "Hilton"]);
  });

  test("FILTERS narrow it — the grid's own predicates, not a second copy", async () => {
    const { s } = await fixture();
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      filters: ["to_review"],
    });
    // Bo's paint is `categorized`, so it leaves the view AND leaves the chase.
    expect(chargesOf(targets)).toEqual([
      "Blue Bottle",
      "Delta",
      "Hilton",
      "Home Depot",
    ]);
  });

  test("SEARCH narrows it, over the whole book", async () => {
    const { s } = await fixture();
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      search: "delta",
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].cardholderName).toBe("Ada");
    expect(chargesOf(targets)).toEqual(["Delta"]);
  });

  test("SELECTION WINS over the filters — exactly the ticked rows", async () => {
    const { s, adaHotel, boLumber } = await fixture();
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      // A filter that would have excluded neither, and a search that would have
      // excluded both — the selection ignores both because it is narrower and
      // was made by a human pointing at rows.
      filters: ["to_review"],
      search: "sherwin",
      selectedIds: [adaHotel, boLumber],
    });
    expect(chargesOf(targets)).toEqual(["Hilton", "Home Depot"]);
  });

  test("selection + personId: that person's share of the ticked rows", async () => {
    const { s, ada, adaHotel, adaCoffee, boLumber } = await fixture();
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      personId: ada.personId,
      selectedIds: [adaHotel, adaCoffee, boLumber],
    });
    expect(targets).toHaveLength(1);
    expect(chargesOf(targets)).toEqual(["Blue Bottle", "Hilton"]);
  });

  test("an EMPTY selection is not a selection — it falls through to the view", async () => {
    const { s } = await fixture();
    // The grid ships `selectedIds` only when something is ticked, but an empty
    // array must never read as "chase nothing": that would make the button
    // silently do nothing on every unticked grid.
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      selectedIds: [],
      search: "delta",
    });
    expect(chargesOf(targets)).toEqual(["Delta"]);
  });

  test("a scope that matches nothing chaseable resolves to no targets, not to everyone", async () => {
    const { s } = await fixture();
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      search: "a merchant nobody used",
    });
    expect(targets).toEqual([]);
  });
});

// ── 3. THE IDS ARE INTERSECTED, NEVER FOLLOWED ───────────────────────────────
describe("getCodingChaseTargets — what a client id list cannot do", () => {
  test("it cannot make somebody get chased for a row that owes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const ada = await seedCardholder(s, "Ada", {
      pwEmail: "ada@publicworship.life",
    });
    const settled = await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Settled",
      receiptStorageId: await storeBlob(s.t),
      codingState: "approved",
    });
    const closed = await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Closed",
      status: "reconciled",
    });

    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      selectedIds: [settled, closed],
    });
    // Both rows exist, both are in the book, both were explicitly asked for —
    // and neither owes anything, so nobody is mailed. Eligibility is the
    // server's question and the answer does not depend on the request.
    expect(targets).toEqual([]);
  });

  test("it cannot reach a row in another book", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const ada = await seedCardholder(s, "Ada", {
      pwEmail: "ada@publicworship.life",
    });
    await seedCharge(s, { cardId: ada.cardId, merchantName: "Hilton" });
    // A chaseable row that belongs to CENTRAL's book, not this chapter's.
    const centralRow = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: "central",
        source: "manual",
        flow: "outflow",
        amountCents: 5_000,
        postedAt: Date.now(),
        merchantName: "Central spend",
        cardId: ada.cardId,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      selectedIds: [centralRow],
    });
    // The scan only ever loads the ONE book the gate authorized, so an id from
    // anywhere else simply never appears in it.
    expect(targets).toEqual([]);
  });

  test("the recipient comes from the row, never from the request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const ada = await seedCardholder(s, "Ada", {
      pwEmail: "ada@publicworship.life",
    });
    const bo = await seedCardholder(s, "Bo", {
      pwEmail: "bo@publicworship.life",
    });
    const adaHotel = await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Hilton",
    });

    // Ask for Ada's charge while naming Bo. There is no combination of args
    // that mails Bo about a charge that isn't his — `personId` FILTERS the
    // resolved bands, it never assigns one.
    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {
      personId: bo.personId,
      selectedIds: [adaHotel],
    });
    expect(targets).toEqual([]);
  });
});

// ── 4. WHO MAY CHASE, AND WHO HAS NOWHERE TO BE CHASED ───────────────────────
describe("getCodingChaseTargets — the gate and the edges", () => {
  test("a bookkeeper cannot chase (lib/chaseAccess.ts#requireCodingChase)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asBookkeeper(s);
    await expect(
      s.as.query(internal.finances.getCodingChaseTargets, {}),
    ).rejects.toThrow();
  });

  test("no email on file is REPORTED, not skipped — the manager gets the name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    // Deliberately no `pwEmail`/`email`.
    const unreachable = await seedCardholder(s, "No Address");
    await seedCharge(s, { cardId: unreachable.cardId, merchantName: "Hilton" });

    const targets = await s.as.query(
      internal.finances.getCodingChaseTargets,
      {},
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].cardholderName).toBe("No Address");
    // `email: null` is what `cards.sendCodingChase` turns into
    // `outcome:"no_email"` — a named line in the manager's result summary,
    // rather than a person who quietly never appears.
    expect(targets[0].email).toBeNull();
  });

  test("a spend row with no cardholder is skipped — there is nobody to mail", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    // No `cardId`, no `personId`: a bank withdrawal. It IS chaseable (the grid
    // shows it under Unattributed and it owes the treasurer a statement), but
    // it owes it to nobody with an inbox.
    await seedCharge(s, { merchantName: "ATM withdrawal" });

    const targets = await s.as.query(
      internal.finances.getCodingChaseTargets,
      {},
    );
    expect(targets).toEqual([]);
  });

  test("charges come back biggest first, so the email leads with the one worth reading", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const ada = await seedCardholder(s, "Ada", {
      pwEmail: "ada@publicworship.life",
    });
    await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Small",
      amountCents: 500,
    });
    await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Big",
      amountCents: 90_000,
    });
    await seedCharge(s, {
      cardId: ada.cardId,
      merchantName: "Middling",
      amountCents: 4_000,
    });

    const targets = await s.as.query(
      internal.finances.getCodingChaseTargets,
      {},
    );
    expect(targets[0].charges.map((c) => c.merchantName)).toEqual([
      "Big",
      "Middling",
      "Small",
    ]);
  });
});

// ── 5. THE EMAIL ─────────────────────────────────────────────────────────────
describe("the chase email itself", () => {
  const realFetch = globalThis.fetch;

  test("asks for the coding, gives both reasons, and links to /code", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      await asManager(s);
      const ada = await seedCardholder(s, "Ada", {
        pwEmail: "ada@publicworship.life",
      });
      const hotel = await seedCharge(s, {
        cardId: ada.cardId,
        merchantName: "Hilton",
        amountCents: 30_000,
      });
      await seedCharge(s, {
        cardId: ada.cardId,
        merchantName: "Blue Bottle",
        amountCents: 900,
      });

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      // Scoped to ONE of her two charges — the founder's case, end to end.
      const out = await s.as.action(api.cards.sendCodingChase, {
        selectedIds: [hotel],
      });
      expect(out.results).toHaveLength(1);
      expect(out.results[0].outcome).toBe("sent");
      // The narrowing reached the email, not just the query.
      expect(out.results[0].chargeCount).toBe(1);

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("ada@publicworship.life");
      expect(sent[0].subject).toContain("Code your $300.00 at Hilton charge");
      // The button, to the cardholder's own list — no finance seat required.
      expect(sent[0].html).toMatch(
        /href="https:\/\/app\.publicworship\.life\/code\?filter=uncoded"/,
      );
      // BOTH reasons, in the founder's own framing.
      expect(sent[0].html).toContain("taxable income");
      expect(sent[0].html).toContain("public ledger");
      // And the charge she was NOT chased about stays out of it.
      expect(sent[0].html).not.toContain("Blue Bottle");
    } finally {
      globalThis.fetch = realFetch;
      process.env.APP_URL = prevAppUrl;
      process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("nothing to chase sends nothing at all", async () => {
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      await asManager(s);
      const ada = await seedCardholder(s, "Ada", {
        pwEmail: "ada@publicworship.life",
      });
      await seedCharge(s, {
        cardId: ada.cardId,
        merchantName: "Settled",
        receiptStorageId: await storeBlob(s.t),
        codingState: "approved",
      });

      const sent: unknown[] = [];
      globalThis.fetch = (async () => {
        sent.push(1);
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      const out = await s.as.action(api.cards.sendCodingChase, {});
      // No targets, no email, and — crucially — no rate-limit slot consumed, so
      // a manager who presses Chase on an already-clear view can still chase
      // for real the moment something lands.
      expect(out.results).toEqual([]);
      expect(sent).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});
