/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `cards.createMyCard` — a member creates their OWN Increase card from My Card,
 * no request or approval (founder call, 2026-10-02). Covers: a seatless member
 * gets a card; a Relay-only holder gets a SEPARATE Increase card (the Relay row
 * is untouched); a second tap returns the same card; the email-eligibility and
 * Academy-prerequisite gates still apply. Runs without `INCREASE_API_KEY`, so
 * the card is the degraded (no Increase id) row — the gate is what's tested.
 */

async function seedMe(
  s: ChapterSetup,
  // `null` seeds someone with no `@publicworship.life` email.
  pwEmail: string | null = "me@publicworship.life",
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Carolyn",
      userId: s.userId,
      isTeamMember: true,
      pwEmail: pwEmail ?? undefined,
      createdAt: Date.now(),
    }),
  );
}

async function cardsOf(s: ChapterSetup, personId: Id<"people">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", personId))
      .collect(),
  );
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof ConvexError) {
      return (err as ConvexError<{ code?: string }>).data.code ?? "ConvexError";
    }
    throw err;
  }
}

describe("createMyCard", () => {
  test("a member with no finance seat creates their own virtual card", async () => {
    const s = await setupChapter(newT());
    const me = await seedMe(s);

    const card = await s.as.action(api.cards.createMyCard, {});
    expect(card.cardholderPersonId).toBe(me);
    expect(card.type).toBe("virtual");
    expect(card.status).toBe("active");
    expect(card.monthlyCapCents).toBeNull();
    expect((await cardsOf(s, me)).length).toBe(1);
  });

  test("a Relay-only holder gets a separate Increase card; the Relay row is untouched", async () => {
    const s = await setupChapter(newT());
    const me = await seedMe(s);
    const relayId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: me,
        type: "physical",
        source: "legacy",
        last4: "1467",
        status: "locked",
        createdAt: Date.now(),
      }),
    );

    const card = await s.as.action(api.cards.createMyCard, {});
    expect(card.id).not.toBe(relayId);
    const rows = await cardsOf(s, me);
    expect(rows.length).toBe(2);
    const relay = rows.find((r) => r._id === relayId)!;
    expect(relay.source).toBe("legacy");
    expect(relay.last4).toBe("1467");
    expect(relay.increaseCardId).toBeUndefined();
  });

  test("a second tap returns the same card instead of minting another", async () => {
    const s = await setupChapter(newT());
    const me = await seedMe(s);

    const first = await s.as.action(api.cards.createMyCard, {});
    const second = await s.as.action(api.cards.createMyCard, {});
    expect(second.id).toBe(first.id);
    expect((await cardsOf(s, me)).length).toBe(1);
  });

  test("still refuses someone without a @publicworship.life email", async () => {
    const s = await setupChapter(newT());
    const me = await seedMe(s, null);

    expect(await errorCode(s.as.action(api.cards.createMyCard, {}))).toBe(
      "NOT_CARD_ELIGIBLE",
    );
    expect((await cardsOf(s, me)).length).toBe(0);
  });

  test("still refuses while the Academy prerequisite is unfinished", async () => {
    const s = await setupChapter(newT());
    const me = await seedMe(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: false,
        cardPrerequisiteCourseSlug: "finances-for-everyone",
        updatedAt: Date.now(),
      }),
    );

    expect(await errorCode(s.as.action(api.cards.createMyCard, {}))).toBe(
      "CARD_PREREQUISITE_INCOMPLETE",
    );
    expect((await cardsOf(s, me)).length).toBe(0);
  });

  test("refuses a caller with no roster profile", async () => {
    const s = await setupChapter(newT());
    expect(await errorCode(s.as.action(api.cards.createMyCard, {}))).toBe(
      "NO_PERSON",
    );
  });
});
