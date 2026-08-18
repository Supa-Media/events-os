import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import { extractIncreaseCard } from "../increaseCardSync";
import type { Id } from "../_generated/dataModel";

/**
 * Cards created in the INCREASE DASHBOARD → `cards` rows (`increaseCardSync.ts`).
 *
 * The shapes here are grounded in real production objects, because the handoff
 * this work started from got two of them wrong: `cardholder_name` is null on
 * every live card (only `description` carries the name), and the email is at
 * `digital_wallet.email` — `cardholder` really is `{}`.
 *
 * What's covered:
 *  - shaping a raw card body, including the `cardholder_name` → `description`
 *    fallback and an absent digital wallet,
 *  - the wallet email resolving a holder through `personEmails` (the normalized
 *    copy — `people.pwEmail` is stored raw and would miss on case),
 *  - the `description` name fallback when no wallet email is present,
 *  - REFUSING to sync when either signal lands on two people, or on none,
 *  - a card on an account we don't hold,
 *  - idempotency across redelivery, and status mirroring only ever tightening,
 *  - a dry run reaching the same verdict as the commit that follows it, while
 *    writing nothing,
 *  - a card drawn on CENTRAL's own account scoping the row `"central"` even
 *    though its holder belongs to a chapter,
 *  - adopting the row `cards.ts#issueCard` is mid-way through writing, rather
 *    than racing it to a duplicate,
 *  - the 0078 back-link attaching an already-ingested orphan charge, and
 *    refusing across a scope boundary,
 *  - and the boundaries a CENTRAL-scoped card reaches once it exists: the
 *    holder actually seeing the charge, a manager being able to reach the
 *    card, and the personal-repayment conversion surviving a central charge.
 *    Every one of these was broken by the scope widening and invisible to
 *    tsc — the repayment insert was hidden behind an `as Id<"chapters">`.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT = "account_s7wmhffch25undolo09b";
const CENTRAL_ACCOUNT = "account_pcqy1jkrut1nuglqbebf";

/** A real production card body, trimmed to the fields we read. */
function cardBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "card",
    id: "card_glov69v9jshltwbywyw8",
    account_id: ACCOUNT,
    description: "Kansi Udochukwu",
    cardholder_name: null,
    last4: "6005",
    status: "active",
    digital_wallet: {
      email: "kansi@publicworship.life",
      phone: null,
      digital_card_profile_id: null,
    },
    ...over,
  };
}

async function seedAccount(
  s: ChapterSetup,
  increaseAccountId: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: scope,
      sandbox: false,
      increaseAccountId,
      onboardingStatus: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A roster person, optionally with a Public Worship address on the normalized
 *  `personEmails` ledger (which is what the resolver actually reads). */
async function seedPerson(
  s: ChapterSetup,
  name: string,
  pwEmail?: string,
): Promise<Id<"people">> {
  return await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      ...(pwEmail ? { pwEmail } : {}),
      createdAt: Date.now(),
    });
    if (pwEmail) {
      await ctx.db.insert("personEmails", {
        personId,
        email: pwEmail.trim().toLowerCase(),
        source: "pw",
        verified: true,
        addedAt: Date.now(),
      });
    }
    return personId;
  });
}

/** Mirrors `tests/cards.test.ts#grantRole`. */
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

function upsert(
  s: ChapterSetup,
  over: Partial<{
    increaseCardId: string;
    accountId: string;
    last4: string;
    status: string;
    description: string;
    walletEmail: string;
    dryRun: boolean;
  }> = {},
) {
  return s.t.mutation(internal.increaseCardSync.upsertIncreaseCard, {
    increaseCardId: "card_glov69v9jshltwbywyw8",
    accountId: ACCOUNT,
    last4: "6005",
    status: "active",
    description: "Kansi Udochukwu",
    walletEmail: "kansi@publicworship.life",
    ...over,
  });
}

async function allCards(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("cards").collect());
}

// ── shaping ──────────────────────────────────────────────────────────────────

describe("extractIncreaseCard", () => {
  test("reads the wallet email and falls back to description for the name", () => {
    const card = extractIncreaseCard(cardBody());
    expect(card).toMatchObject({
      increaseCardId: "card_glov69v9jshltwbywyw8",
      accountId: ACCOUNT,
      last4: "6005",
      status: "active",
      description: "Kansi Udochukwu",
      walletEmail: "kansi@publicworship.life",
    });
  });

  test("prefers cardholder_name when Increase actually sets it", () => {
    const card = extractIncreaseCard(
      cardBody({ cardholder_name: "K. Udochukwu" }),
    );
    expect(card?.description).toBe("K. Udochukwu");
  });

  test("tolerates a missing digital wallet and a blank description", () => {
    const card = extractIncreaseCard(
      cardBody({ digital_wallet: null, description: "   " }),
    );
    expect(card?.walletEmail).toBeUndefined();
    expect(card?.description).toBeUndefined();
  });

  test("rejects a body missing the fields attribution depends on", () => {
    expect(extractIncreaseCard({ id: "card_x" })).toBeNull();
    expect(extractIncreaseCard(cardBody({ account_id: 42 }))).toBeNull();
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe("resolving the cardholder", () => {
  test("the wallet email links the card to its person", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    const personId = await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    expect(await upsert(s)).toMatchObject({ result: "created" });

    const cards = await allCards(s);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      increaseCardId: "card_glov69v9jshltwbywyw8",
      cardholderPersonId: personId,
      chapterId: s.chapterId,
      last4: "6005",
      source: "increase",
      status: "active",
      type: "virtual",
    });
  });

  test("the email matches case-insensitively, as `personEmails` stores it", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    const personId = await seedPerson(s, "Kayla B", "Kaylamarieb@publicworship.life");

    expect(
      await upsert(s, {
        walletEmail: "KaylaMarieB@PublicWorship.life",
        description: "someone else entirely",
      }),
    ).toMatchObject({ result: "created" });

    expect((await allCards(s))[0].cardholderPersonId).toBe(personId);
  });

  test("an exact name match stands in when the card has no wallet email", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    // Card-eligible (a `@publicworship.life` address on file), but whoever
    // made the card in the dashboard left the digital wallet blank.
    const personId = await seedPerson(
      s,
      "Kansi Udochukwu",
      "kansi@publicworship.life",
    );

    expect(await upsert(s, { walletEmail: undefined })).toMatchObject({
      result: "created",
    });
    expect((await allCards(s))[0].cardholderPersonId).toBe(personId);
  });

  test("a name match on someone who could not hold a card is refused", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    // No `@publicworship.life` address — `issueCard` would refuse this person,
    // so a name match must not hand them a card either.
    await seedPerson(s, "Kansi Udochukwu");

    expect((await upsert(s, { walletEmail: undefined })).result).toBe(
      "unattributed",
    );
    expect(await allCards(s)).toHaveLength(0);
  });

  test("a placeholder or contact-only row never absorbs a card", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    const real = await seedPerson(
      s,
      "Kansi Udochukwu",
      "kansi@publicworship.life",
    );
    // A Template Crew stand-in and a donor contact row sharing the name would
    // otherwise read as ambiguity and block a legitimate sync.
    await run(s.t, async (ctx) => {
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Kansi Udochukwu",
        isPlaceholder: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Kansi Udochukwu",
        isContactOnly: true,
        createdAt: Date.now(),
      });
    });

    expect((await upsert(s, { walletEmail: undefined })).result).toBe(
      "created",
    );
    expect((await allCards(s))[0].cardholderPersonId).toBe(real);
  });

  test("an email on two people syncs NOTHING rather than picking one", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    // The duplicate-roster-row case production actually has today.
    await seedPerson(s, "Sarah A", "sarah@publicworship.life");
    await seedPerson(s, "Sarah B", "sarah@publicworship.life");

    const res = await upsert(s, {
      walletEmail: "sarah@publicworship.life",
      description: "Sarah A",
    });
    expect(res.result).toBe("unattributed");
    expect(res.detail).toContain("2 people");
    expect(await allCards(s)).toHaveLength(0);
  });

  test("a name on two people syncs nothing either", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Sam Twin");
    await seedPerson(s, "Sam Twin");

    const res = await upsert(s, {
      walletEmail: undefined,
      description: "Sam Twin",
    });
    expect(res.result).toBe("unattributed");
    expect(await allCards(s)).toHaveLength(0);
  });

  test("a card matching nobody syncs nothing", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Someone Else", "else@publicworship.life");

    expect((await upsert(s)).result).toBe("unattributed");
    expect(await allCards(s)).toHaveLength(0);
  });

  test("a near-miss name is not accepted — matching is exact, never fuzzy", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochuku"); // one letter short

    expect(
      (await upsert(s, { walletEmail: undefined })).result,
    ).toBe("unattributed");
    expect(await allCards(s)).toHaveLength(0);
  });
});

// ── scope ────────────────────────────────────────────────────────────────────

describe("scope", () => {
  test("a card on an account we don't hold is not synced", async () => {
    const s = await setupChapter(newT());
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    const res = await upsert(s, { accountId: "account_not_ours" });
    expect(res.result).toBe("unknown_account");
    expect(await allCards(s)).toHaveLength(0);
  });

  test("a card drawn on CENTRAL's account is scoped central, not its holder's chapter", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, CENTRAL_ACCOUNT, "central");
    // Kansi is a New York person; her card draws on central's own account.
    const personId = await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    expect(await upsert(s, { accountId: CENTRAL_ACCOUNT })).toMatchObject({
      result: "created",
    });
    const card = (await allCards(s))[0];
    expect(card.chapterId).toBe("central");
    expect(card.cardholderPersonId).toBe(personId);
  });
});

// ── idempotency + updates ────────────────────────────────────────────────────

describe("repeat delivery", () => {
  test("a redelivered card.created does not create a second row", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    expect((await upsert(s)).result).toBe("created");
    expect((await upsert(s)).result).toBe("updated");
    expect(await allCards(s)).toHaveLength(1);
  });

  test("card.updated mirrors a last4 change and a dashboard disable", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s);

    await upsert(s, { status: "disabled", last4: "1234" });
    const card = (await allCards(s))[0];
    expect(card.status).toBe("locked");
    expect(card.last4).toBe("1234");
  });

  test("Increase reporting `active` never clears a lock the OS applied", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s);

    // A receipt auto-lock / holder freeze, which Increase knows nothing about.
    const cardId = (await allCards(s))[0]._id;
    await run(s.t, (ctx) =>
      ctx.db.patch(cardId, { status: "locked", frozenByHolder: true }),
    );

    await upsert(s, { status: "active" });
    const card = (await allCards(s))[0];
    expect(card.status).toBe("locked");
    expect(card.frozenByHolder).toBe(true);
  });

  test("an unrecognized vendor status is not guessed at", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    expect((await upsert(s, { status: "pending_activation" })).result).toBe(
      "bad_status",
    );
    expect(await allCards(s)).toHaveLength(0);
  });
});

// ── dry run ──────────────────────────────────────────────────────────────────

describe("dry run", () => {
  test("reports what it would create without writing a row", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    expect(await upsert(s, { dryRun: true })).toMatchObject({
      result: "created",
    });
    expect(await allCards(s)).toHaveLength(0);

    // …and committing afterwards reaches the same verdict.
    expect((await upsert(s)).result).toBe("created");
    expect(await allCards(s)).toHaveLength(1);
  });

  test("leaves an existing row untouched", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s);

    expect(
      (await upsert(s, { status: "disabled", dryRun: true })).result,
    ).toBe("updated");
    expect((await allCards(s))[0].status).toBe("active");
  });

  test("still refuses an ambiguous card, and still writes nothing", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Sarah A", "sarah@publicworship.life");
    await seedPerson(s, "Sarah B", "sarah@publicworship.life");

    expect(
      (await upsert(s, { walletEmail: "sarah@publicworship.life", dryRun: true }))
        .result,
    ).toBe("unattributed");
    expect(await allCards(s)).toHaveLength(0);
  });
});

// ── the race against issueCard ───────────────────────────────────────────────

describe("racing cards.ts#issueCard", () => {
  test("adopts the row issueCard has not yet stamped, instead of duplicating it", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    const personId = await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");

    // `beginIssueCard` inserts first and stamps `increaseCardId` afterwards; the
    // webhook can land in the gap.
    const pendingId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        status: "active",
        monthlyCapCents: 50_000,
        createdAt: Date.now(),
      }),
    );

    expect((await upsert(s)).result).toBe("adopted");
    const cards = await allCards(s);
    expect(cards).toHaveLength(1);
    expect(cards[0]._id).toBe(pendingId);
    expect(cards[0].increaseCardId).toBe("card_glov69v9jshltwbywyw8");
    // The manager's intent on that row survives adoption.
    expect(cards[0].monthlyCapCents).toBe(50_000);
  });

  test("never adopts a legacy card — those have no Increase object to claim", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    const personId = await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        source: "legacy",
        last4: "8728",
        status: "active",
        createdAt: Date.now(),
      }),
    );

    expect((await upsert(s)).result).toBe("created");
    const cards = await allCards(s);
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.source === "legacy")?.increaseCardId).toBeUndefined();
  });
});

// ── 0078 back-link ───────────────────────────────────────────────────────────

describe("back-linking charges that ingested before the card was known", () => {
  async function seedOrphanCharge(
    s: ChapterSetup,
    scope: Id<"chapters"> | "central",
  ): Promise<Id<"transactions">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: scope,
        source: "increase_card",
        flow: "outflow",
        amountCents: 1427,
        currency: "usd",
        postedAt: Date.now(),
        merchantName: "AMAZON RETA* 5A0C91NA2",
        externalId: "transaction_b9yec0mm7qhvdsp8he7x",
        sourceAccountId: CENTRAL_ACCOUNT,
        cardPaymentId: "card_payment_d8oolpbc5rjuxzmth6nn",
        pending: false,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
  }

  test("attaches the charge to its card, and to the person who spent it", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, CENTRAL_ACCOUNT, "central");
    const personId = await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s, { accountId: CENTRAL_ACCOUNT });
    const txnId = await seedOrphanCharge(s, "central");

    const res = await s.t.mutation(
      internal.migrations["0078_link_orphan_increase_card_charges"]
        .applyCardLink,
      { transactionId: txnId, increaseCardId: "card_glov69v9jshltwbywyw8" },
    );
    expect(res.linked).toBe(true);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn).toMatchObject({ personId, cardLast4: "6005" });
    expect(txn?.cardId).toBeDefined();
  });

  test("refuses to attribute a charge to a card on a different book", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, ACCOUNT, s.chapterId);
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s); // card is chapter-scoped …
    const txnId = await seedOrphanCharge(s, "central"); // … charge is central

    const res = await s.t.mutation(
      internal.migrations["0078_link_orphan_increase_card_charges"]
        .applyCardLink,
      { transactionId: txnId, increaseCardId: "card_glov69v9jshltwbywyw8" },
    );
    expect(res.linked).toBe(false);
    expect(res.reason).toContain("scope");
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.personId).toBeUndefined();
  });

  test("is idempotent — a second pass leaves an already-linked charge alone", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, CENTRAL_ACCOUNT, "central");
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s, { accountId: CENTRAL_ACCOUNT });
    const txnId = await seedOrphanCharge(s, "central");

    const args = {
      transactionId: txnId,
      increaseCardId: "card_glov69v9jshltwbywyw8",
    };
    const ref =
      internal.migrations["0078_link_orphan_increase_card_charges"]
        .applyCardLink;
    expect((await s.t.mutation(ref, args)).linked).toBe(true);
    const second = await s.t.mutation(ref, args);
    expect(second.linked).toBe(false);
    expect(second.reason).toBe("already linked");
  });

  test("only unlinked increase_card charges are picked up as orphans", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, CENTRAL_ACCOUNT, "central");
    await seedPerson(s, "Kansi Udochukwu", "kansi@publicworship.life");
    await upsert(s, { accountId: CENTRAL_ACCOUNT });
    const orphanId = await seedOrphanCharge(s, "central");
    const linkedId = await seedOrphanCharge(s, "central");
    await s.t.mutation(
      internal.migrations["0078_link_orphan_increase_card_charges"]
        .applyCardLink,
      { transactionId: linkedId, increaseCardId: "card_glov69v9jshltwbywyw8" },
    );

    const orphans = await s.t.query(
      internal.migrations["0078_link_orphan_increase_card_charges"]
        .listOrphanCardCharges,
      {},
    );
    expect(orphans.map((o) => o.transactionId)).toEqual([orphanId]);
  });
});

// ── what the scope widening reaches ──────────────────────────────────────────

describe("a central-scoped card at the surfaces that assume a chapter", () => {
  /** Kansi's real shape: a New York person holding a card drawn on central. */
  async function centralCardHolder(s: ChapterSetup) {
    await seedAccount(s, CENTRAL_ACCOUNT, "central");
    const personId = await seedPerson(
      s,
      "Kansi Udochukwu",
      "kansi@publicworship.life",
    );
    // The holder is the signed-in caller — this is their own-charge surface.
    await run(s.t, (ctx) => ctx.db.patch(personId, { userId: s.userId }));
    await grantRole(s, personId, "manager");
    await upsert(s, { accountId: CENTRAL_ACCOUNT });
    const card = (await allCards(s))[0];
    return { personId, card };
  }

  test("the holder sees the charge in their own transactions", async () => {
    const s = await setupChapter(newT());
    const { personId, card } = await centralCardHolder(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: "central",
        source: "increase_card",
        flow: "outflow",
        amountCents: 1427,
        currency: "usd",
        postedAt: Date.now(),
        merchantName: "AMAZON RETA* 5A0C91NA2",
        externalId: "transaction_b9yec0mm7qhvdsp8he7x",
        cardId: card._id,
        personId,
        cardLast4: "6005",
        pending: false,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
    const rows = await s.as.query(api.finances.personTransactions, {});
    expect(rows.map((r) => r.amountCents)).toContain(1427);
  });

  test("another chapter's rows are still hidden — this is not a blanket relaxation", async () => {
    const s = await setupChapter(newT());
    const { personId } = await centralCardHolder(s);
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Philly",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: otherChapterId,
        source: "increase_card",
        flow: "outflow",
        amountCents: 9999,
        currency: "usd",
        postedAt: Date.now(),
        externalId: "transaction_other_chapter",
        personId,
        pending: false,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
    const rows = await s.as.query(api.finances.personTransactions, {});
    expect(rows.map((r) => r.amountCents)).not.toContain(9999);
  });

  test("the holder's chapter manager can reach the card", async () => {
    const s = await setupChapter(newT());
    const { card } = await centralCardHolder(s);
    // `requireOwnedCard` is the choke point every manager mutation shares;
    // reaching it at all is what was broken.
    const found = await run(s.t, async (ctx) => {
      const c = await ctx.db.get(card._id);
      const holder = await ctx.db.get(c!.cardholderPersonId);
      return c!.chapterId === "central" && holder!.chapterId === s.chapterId;
    });
    expect(found).toBe(true);

    const listed = await s.as.query(api.cards.listCards, {});
    expect(listed.map((c) => c.id)).toContain(card._id);
  });

  test("a central charge converts to a personal repayment without throwing", async () => {
    const s = await setupChapter(newT());
    const { personId, card } = await centralCardHolder(s);
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: "central",
        source: "increase_card",
        flow: "outflow",
        amountCents: 1427,
        currency: "usd",
        postedAt: Date.now(),
        externalId: "transaction_personal_central",
        cardId: card._id,
        personId,
        pending: false,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    // This is the insert that carried `txn.chapterId as Id<"chapters">` — a
    // cast that typechecked and would have thrown here at runtime.
    await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });

    const repayment = await run(s.t, (ctx) =>
      ctx.db
        .query("personalRepayments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .first(),
    );
    expect(repayment).toMatchObject({
      chapterId: "central",
      payerPersonId: personId,
      amountCents: 1427,
    });
  });
});
