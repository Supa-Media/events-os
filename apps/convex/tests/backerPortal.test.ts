import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { BACKER_UNIT_CENTS } from "@events-os/shared";
import {
  hasBackerModule,
  hashPortalCode,
  normalizePortalEmail,
  type BackerSession,
} from "../lib/backerAccess";
import {
  checkAmountChange,
  parseMonthlyAmountCents,
  PLEDGE_FLOOR_CENTS,
} from "../givingPledges";
import {
  renderBackerPortal,
  renderBackerSignIn,
  type PortalView,
} from "../lib/backerPortalPage";
import { renderPaymentFailedEmail } from "../lib/backerPortalEmails";

/**
 * THE BACKER PORTAL — a page a stranger can reach that shows one person's
 * complete giving history.
 *
 * That sentence is the whole reason this suite is shaped the way it is. Five
 * things it holds down, each of which is a real incident if it flips:
 *
 *  1. A SESSION IS THE ONLY KEY. No email in a body, no id in a query string.
 *     The billing-portal resolver in particular used to take `{email, chapterId}`
 *     from anybody — that hole is closed here and must stay closed.
 *  2. ONE PERSON'S SESSION CANNOT REACH ANOTHER'S PLEDGE, whatever id is
 *     posted, and the refusal says the same thing either way so it can't be
 *     used to test whether an id exists.
 *  3. THE SIGN-IN IS NOT AN ORACLE. An address we know and one we've never seen
 *     get identical answers.
 *  4. THE $50 RATCHET HOLDS. A backer cannot quietly drop below the floor that
 *     makes them one — the owner's rule, and the reason amount changes are ours
 *     rather than Stripe's.
 *  5. NOTHING PRIVATE RENDERS UNAUTHENTICATED, and what does render is escaped.
 */

async function makeSession(
  s: ChapterSetup,
  email: string,
  token: string,
  overrides: { expiresAt?: number } = {},
): Promise<Id<"backerPortalSessions">> {
  const { hashSessionToken } = await import("../lib/backerAccess");
  return run(s.t, (ctx) =>
    ctx.db.insert("backerPortalSessions", {
      tokenHash: hashSessionToken(token),
      email: normalizePortalEmail(email),
      expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
}

/** A donor + an active pledge in the chapter, the shape a real backer has. */
async function seedBacker(
  s: ChapterSetup,
  email: string,
  amountCents = BACKER_UNIT_CENTS,
): Promise<{ donorId: Id<"donors">; pledgeId: Id<"pledges"> }> {
  return run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: "Ada Backer",
      email: normalizePortalEmail(email),
      status: "active",
      lifetimeCents: amountCents,
      giftCount: 1,
      firstGiftAt: Date.now() - 1000,
      source: "map",
      createdAt: Date.now(),
    });
    const pledgeId = await ctx.db.insert("pledges", {
      donorId,
      scope: s.chapterId,
      amountCents,
      status: "active",
      origin: "stripe",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      startedAt: Date.now() - 1000,
      createdAt: Date.now() - 1000,
    });
    return { donorId, pledgeId };
  });
}

function sessionLike(over: Partial<BackerSession> = {}): BackerSession {
  return {
    sessionId: "s1" as Id<"backerPortalSessions">,
    email: "ada@example.com",
    donorIds: [],
    scopes: [],
    name: "Ada",
    isBacker: false,
    inGrace: false,
    pledges: [],
    ...over,
  };
}

// ── The module gate ─────────────────────────────────────────────────────────

describe("hasBackerModule", () => {
  test("your own record is open to any signed-in giver; the org's side isn't", () => {
    const giver = sessionLike();
    expect(hasBackerModule(giver, "giving")).toBe(true);
    expect(hasBackerModule(giver, "backing")).toBe(true);
    expect(hasBackerModule(giver, "books")).toBe(false);
    expect(hasBackerModule(giver, "health")).toBe(false);
    expect(hasBackerModule(giver, "events")).toBe(false);
    expect(hasBackerModule(giver, "people")).toBe(false);
  });

  test("an active backer sees the org's side", () => {
    const backer = sessionLike({ isBacker: true });
    for (const m of ["giving", "backing", "books", "health", "events", "people"] as const) {
      expect(hasBackerModule(backer, m)).toBe(true);
    }
  });

  test("the grace window keeps a lapsed backer in, and it is a REAL window", () => {
    expect(hasBackerModule(sessionLike({ inGrace: true }), "books")).toBe(true);
    expect(hasBackerModule(sessionLike({ inGrace: false }), "books")).toBe(false);
  });
});

// ── The sign-in ─────────────────────────────────────────────────────────────

describe("requestCode", () => {
  test("answers identically for a known and an unknown address", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "known@example.com");

    const known = await t.mutation(internal.backerPortal.requestCode, {
      email: "known@example.com",
      clientIp: "1.1.1.1",
    });
    const unknown = await t.mutation(internal.backerPortal.requestCode, {
      email: "stranger@example.com",
      clientIp: "1.1.1.2",
    });
    expect(known).toEqual({ sent: true });
    expect(unknown).toEqual(known);

    // A code row is written either way — the ONLY difference is whether an
    // email is scheduled, which is invisible from outside.
    const rows = await run(s.t, (ctx) =>
      ctx.db.query("backerPortalCodes").collect(),
    );
    expect(rows).toHaveLength(2);
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.filter((r) => r.name.endsWith("sendPortalCode"))).toHaveLength(
      1,
    );
  });

  test("a second request inside a minute does not re-send", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "known@example.com");
    await t.mutation(internal.backerPortal.requestCode, {
      email: "known@example.com",
      clientIp: "1.1.1.1",
    });
    await t.mutation(internal.backerPortal.requestCode, {
      email: "known@example.com",
      clientIp: "1.1.1.1",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.filter((r) => r.name.endsWith("sendPortalCode"))).toHaveLength(
      1,
    );
  });

  test("an address that isn't one is refused", async () => {
    const t = newT();
    await setupChapter(t);
    await expect(
      t.mutation(internal.backerPortal.requestCode, {
        email: "not-an-email",
        clientIp: "1.1.1.9",
      }),
    ).rejects.toThrow();
  });
});

describe("verifyCode", () => {
  async function seedCode(
    s: ChapterSetup,
    email: string,
    code: string,
    over: { expiresAt?: number; attempts?: number } = {},
  ) {
    await run(s.t, (ctx) =>
      ctx.db.insert("backerPortalCodes", {
        email: normalizePortalEmail(email),
        codeHash: hashPortalCode(email, code),
        expiresAt: over.expiresAt ?? Date.now() + 60_000,
        attempts: over.attempts ?? 0,
        lastSentAt: Date.now(),
        createdAt: Date.now(),
      }),
    );
  }

  test("a correct code mints a session and is spent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCode(s, "ada@example.com", "123456");

    const result = await t.mutation(internal.backerPortal.verifyCode, {
      email: "ada@example.com",
      code: "123456",
      clientIp: "2.2.2.2",
    });
    expect(result.ok).toBe(true);
    const token = result.ok ? result.token : "";
    expect(token).toHaveLength(32);

    const sessions = await run(s.t, (ctx) =>
      ctx.db.query("backerPortalSessions").collect(),
    );
    expect(sessions).toHaveLength(1);
    // Only the HASH is stored — a database dump is not a set of live sign-ins.
    expect(JSON.stringify(sessions[0])).not.toContain(token);

    // The code is gone, so the same email can't be replayed.
    const codes = await run(s.t, (ctx) =>
      ctx.db.query("backerPortalCodes").collect(),
    );
    expect(codes).toHaveLength(0);
  });

  test("a wrong code COMMITS its attempt — five of them spend the row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCode(s, "ada@example.com", "123456");

    // Five wrong guesses — the whole budget. Each RETURNS rather than throwing, which is the only
    // reason the counter survives: a thrown mutation rolls its own writes back,
    // and this guard would then never fire once. Asserted on the stored row,
    // not on the return value, because the stored row is the thing that was
    // silently not happening.
    for (let i = 1; i <= 5; i++) {
      const res = await t.mutation(internal.backerPortal.verifyCode, {
        email: "ada@example.com",
        code: "999999",
        clientIp: "2.2.2.3",
      });
      expect(res.ok).toBe(false);
      const [row] = await run(s.t, (ctx) =>
        ctx.db.query("backerPortalCodes").collect(),
      );
      expect(row.attempts).toBe(i);
    }

    // Five failures is the budget, so the SIXTH attempt finds a spent row —
    // and even a CORRECT code is refused there, so guessing can't be resumed
    // by getting lucky at the end.
    await expect(
      t.mutation(internal.backerPortal.verifyCode, {
        email: "ada@example.com",
        code: "123456",
        clientIp: "2.2.2.3",
      }),
    ).rejects.toThrow(/too many tries/i);

    // The spent row is LEFT IN PLACE, not deleted — a delete inside a throwing
    // branch rolls back with the throw and would be a lie in the source. It is
    // inert either way: every further guess hits the same refusal, and asking
    // for a fresh code overwrites it.
    const [spent] = await run(s.t, (ctx) =>
      ctx.db.query("backerPortalCodes").collect(),
    );
    expect(spent.attempts).toBe(5);
  });

  test("an expired code is refused and cleared", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCode(s, "ada@example.com", "123456", { expiresAt: Date.now() - 1 });
    await expect(
      t.mutation(internal.backerPortal.verifyCode, {
        email: "ada@example.com",
        code: "123456",
        clientIp: "2.2.2.4",
      }),
    ).rejects.toThrow();
  });
});

// ── The payload, and who it belongs to ──────────────────────────────────────

describe("portalPayload", () => {
  test("renders the signed-in person's own record", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { donorId } = await seedBacker(s, "ada@example.com");
    await run(s.t, (ctx) =>
      ctx.db.insert("gifts", {
        donorId,
        scope: s.chapterId,
        amountCents: 5000,
        currency: "usd",
        receivedAt: Date.now() - 5000,
        method: "stripe",
        createdAt: Date.now() - 5000,
      }),
    );
    await makeSession(s, "ada@example.com", "tok_ada");

    const view = await t.query(internal.backerPortal.portalPayload, {
      token: "tok_ada",
    });
    expect(view.email).toBe("ada@example.com");
    expect(view.isBacker).toBe(true);
    expect(view.pledges).toHaveLength(1);
    expect(view.pledges[0].amountCents).toBe(BACKER_UNIT_CENTS);
    expect(view.pledges[0].manageable).toBe(true);
    expect(view.history).toHaveLength(1);
    expect(view.history[0].amountCents).toBe(5000);
  });

  test("an expired session is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "ada@example.com");
    await makeSession(s, "ada@example.com", "tok_old", {
      expiresAt: Date.now() - 1,
    });
    await expect(
      t.query(internal.backerPortal.portalPayload, { token: "tok_old" }),
    ).rejects.toThrow();
  });

  test("an unknown token is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBacker(s, "ada@example.com");
    await expect(
      t.query(internal.backerPortal.portalPayload, { token: "nope" }),
    ).rejects.toThrow();
  });

  test("a giver with no pledge still sees their own giving", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "One Time",
        email: "once@example.com",
        status: "active",
        lifetimeCents: 10_000,
        giftCount: 1,
        source: "manual",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("gifts", {
        donorId,
        scope: s.chapterId,
        amountCents: 10_000,
        currency: "usd",
        receivedAt: Date.now(),
        method: "check",
        createdAt: Date.now(),
      }),
    );
    await makeSession(s, "once@example.com", "tok_once");

    const view = await t.query(internal.backerPortal.portalPayload, {
      token: "tok_once",
    });
    expect(view.isBacker).toBe(false);
    expect(view.pledges).toHaveLength(0);
    expect(view.history).toHaveLength(1);
    // The org's side stays shut for a non-backer.
    expect(view.ladder).toBeNull();
    expect(view.upcoming).toEqual([]);
  });
});

// ── Somebody else's pledge ──────────────────────────────────────────────────

describe("a session cannot reach another person's pledge", () => {
  test("the billing-portal resolver refuses, in the same words as a missing id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const mine = await seedBacker(s, "ada@example.com");
    const theirs = await seedBacker(s, "bob@example.com");
    await makeSession(s, "ada@example.com", "tok_ada");

    // My own pledge resolves.
    await expect(
      t.query(internal.givingPledges.portalCustomerForSession, {
        sessionToken: "tok_ada",
        pledgeId: mine.pledgeId,
      }),
    ).resolves.toBe("cus_test");

    // Bob's does not — and the message is the same one a nonexistent id gets,
    // so this can't be used to probe which ids are real.
    const stolen = t.query(internal.givingPledges.portalCustomerForSession, {
      sessionToken: "tok_ada",
      pledgeId: theirs.pledgeId,
    });
    await expect(stolen).rejects.toThrow(ConvexError);
    await expect(stolen).rejects.toThrow(
      /couldn't find that monthly gift on your record/i,
    );
  });

  test("no session, no answer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const mine = await seedBacker(s, "ada@example.com");
    await expect(
      t.query(internal.givingPledges.portalCustomerForSession, {
        sessionToken: "",
        pledgeId: mine.pledgeId,
      }),
    ).rejects.toThrow(/sign-in has expired/i);
  });
});

// ── The $50 ratchet ─────────────────────────────────────────────────────────

describe("checkAmountChange", () => {
  test("a backer cannot drop below the backer floor", () => {
    const verdict = checkAmountChange(BACKER_UNIT_CENTS, 3000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain("$50.00");
      // And it points at the door that IS open, so the rule isn't a trap.
      expect(verdict.message).toContain("Stop my monthly gift");
    }
  });

  test("a backer can go up, and can sit exactly on the floor", () => {
    expect(checkAmountChange(BACKER_UNIT_CENTS, 10_000).ok).toBe(true);
    expect(checkAmountChange(10_000, BACKER_UNIT_CENTS).ok).toBe(true);
  });

  test("someone below the floor moves freely below it", () => {
    // A $30/month giver is a real, supported thing — the ratchet only holds
    // people who are already backers.
    expect(checkAmountChange(3000, 2000).ok).toBe(true);
    expect(checkAmountChange(3000, BACKER_UNIT_CENTS).ok).toBe(true);
  });

  test("the pledge floor still applies to everybody", () => {
    expect(checkAmountChange(3000, PLEDGE_FLOOR_CENTS - 1).ok).toBe(false);
    expect(checkAmountChange(3000, 0).ok).toBe(false);
  });

  test("no-op changes are refused rather than billed", () => {
    expect(checkAmountChange(5000, 5000).ok).toBe(false);
  });
});

describe("parseMonthlyAmountCents", () => {
  test("reads money the way people type it", () => {
    expect(parseMonthlyAmountCents("50")).toBe(5000);
    expect(parseMonthlyAmountCents("$50")).toBe(5000);
    expect(parseMonthlyAmountCents(" 1,200 ")).toBe(120_000);
    expect(parseMonthlyAmountCents("12.50")).toBe(1250);
    expect(parseMonthlyAmountCents(".50")).toBe(50);
  });

  test("integer arithmetic, so a half-cent can't round the wrong way", () => {
    // `Math.round(1.005 * 100)` is 100 in binary floating point — a cent short.
    expect(parseMonthlyAmountCents("1.005")).toBe(101);
  });

  test("refuses what isn't an amount", () => {
    for (const bad of ["", "abc", "-50", ".", "50.00.00"]) {
      expect(() => parseMonthlyAmountCents(bad)).toThrow();
    }
  });
});

// ── The pages ───────────────────────────────────────────────────────────────

function viewLike(over: Partial<PortalView> = {}): PortalView {
  return {
    email: "ada@example.com",
    name: "Ada Lovelace",
    isBacker: true,
    inGrace: false,
    pledges: [
      {
        pledgeId: "p1",
        amountCents: 5000,
        status: "active",
        scopeLabel: "New York",
        startedAt: Date.parse("2026-03-04T12:00:00Z"),
        currentPeriodEnd: Date.parse("2026-09-12T12:00:00Z"),
        isBacker: true,
        manageable: true,
        givePath: "/give/new-york",
      },
    ],
    lifetimeCents: 41_200,
    giftCount: 9,
    firstGiftAt: Date.parse("2026-03-04T12:00:00Z"),
    history: [
      {
        giftId: "g1",
        amountCents: 5000,
        receivedAt: Date.parse("2026-08-12T12:00:00Z"),
        methodLabel: "Chapter OS",
        scopeLabel: "New York",
        isRecurring: true,
        coveredFees: false,
        reversed: false,
      },
    ],
    ladder: null,
    upcoming: [],
    siteBase: "https://publicworship.life",
    ...over,
  };
}

describe("the sign-in page", () => {
  test("asks for an email and nothing else", () => {
    const html = renderBackerSignIn();
    expect(html).toContain("See your giving.");
    expect(html).toContain("/api/backer/code");
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });
});

describe("the portal page", () => {
  test("leads with the backing and shows the giving", () => {
    const html = renderBackerPortal(viewLike());
    expect(html).toContain("Hi, Ada.");
    expect(html).toContain("$50.00");
    expect(html).toContain("New York");
    expect(html).toContain("Change amount");
    expect(html).toContain("Stop my monthly gift");
    expect(html).toContain("$412.00");
  });

  test("a past-due pledge leads with the banner, not the hero", () => {
    const html = renderBackerPortal(
      viewLike({
        pledges: [{ ...viewLike().pledges[0], status: "past_due" }],
      }),
    );
    const bannerAt = html.indexOf("Your last payment didn't go through");
    const heroAt = html.indexOf("Your giving to");
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(heroAt);
    expect(html).toContain("Past due");
  });

  test("an imported pledge says so instead of offering a button that fails", () => {
    const html = renderBackerPortal(
      viewLike({
        pledges: [{ ...viewLike().pledges[0], manageable: false }],
      }),
    );
    expect(html).toContain("billed on our old platform");
    expect(html).not.toContain("Change amount");
  });

  test("a giver with no pledge is invited, not scolded", () => {
    const html = renderBackerPortal(viewLike({ pledges: [], isBacker: false }));
    expect(html).toContain("not giving monthly yet");
    expect(html).toContain("Back a city");
  });

  test("a reversed gift is struck through, in place", () => {
    const html = renderBackerPortal(
      viewLike({
        history: [
          { ...viewLike().history[0], reversed: true },
        ],
      }),
    );
    expect(html).toContain("row reversed");
    expect(html).toContain("Returned by your bank");
  });

  test("a donor name is escaped, never rendered", () => {
    const html = renderBackerPortal(
      viewLike({ name: "<script>alert(1)</script>" }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the ladder names the distance in backers", () => {
    const html = renderBackerPortal(
      viewLike({
        ladder: {
          scopeLabel: "New York",
          backerCount: 17,
          nextAt: 25,
          nextLabel: "+Eden",
          nextCommitment: "Eden every month",
          rungs: [
            { minBackers: 10, label: "WWS", commitment: "a monthly night", reached: true },
            { minBackers: 25, label: "+Eden", commitment: "Eden every month", reached: false },
          ],
        },
      }),
    );
    expect(html).toContain("17 of 25 backers");
    expect(html).toContain("Eden every month");
  });
});

describe("the payment-failed email", () => {
  test("says nothing is cancelled, and offers the one button that fixes it", () => {
    const { subject, html } = renderPaymentFailedEmail({
      firstName: "Ada",
      monthlyCents: 5000,
      chapterName: "New York",
      portalUrl: "https://publicworship.life/backer",
    });
    expect(subject).toBe("Your monthly gift to New York didn't go through");
    expect(html).toContain("Ada, your card was declined.");
    expect(html).toContain("Nothing has been cancelled");
    expect(html).toContain("https://publicworship.life/backer");
    // The register: it must not read as an accusation or a demand.
    expect(html).not.toMatch(/action required|immediately|failure to/i);
  });

  test("degrades to a reply-to-us sentence with no portal url", () => {
    const { html } = renderPaymentFailedEmail({
      firstName: "friend",
      monthlyCents: 2500,
      chapterName: null,
      portalUrl: null,
    });
    expect(html).toContain("Reply to this email");
    expect(html).toContain("Public Worship");
  });
});
