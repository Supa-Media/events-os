import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import {
  backerAnnualCents,
  ruleMatchesBackerSignup,
  shouldSendDigest,
} from "../lib/givingNotificationRules";
import {
  newBackerHeadline,
  renderBackerSignupEmail,
  renderDigestEmail,
  type DigestPendingGift,
  type NotificationBacker,
} from "../lib/givingNotificationEmails";
import { renderBackerWelcomeEmail } from "../lib/backerWelcomeEmail";
import { collectWindowBackers } from "../givingNotificationDigests";

/**
 * BECOMING A BACKER IS AN EVENT, not a $50 gift that happens to recur.
 *
 * Five things this suite exists to hold down, each of which is silent in
 * production if it flips:
 *
 *  1. THE BACKER HEARS FROM US, EXACTLY ONCE. The welcome is claimed on a
 *     one-time stamp, and BOTH Stripe events that can mean "they're a backer
 *     now" go through that claim — in either order, since Stripe guarantees no
 *     order. Two welcomes is a bug; zero is the bug this feature was written to
 *     fix.
 *  2. THE FIRST CYCLE IS A WELCOME, NOT A RECEIPT — and the second cycle IS a
 *     receipt. Never both on the same cycle.
 *  3. A SIGNUP IS WEIGHED AT ITS ANNUAL VALUE. A $50/mo pledge clears a $500
 *     rule, because it is a $600 commitment. That is the whole of the owner's
 *     ask and it is one predicate.
 *  4. AN IMPORT NEVER MAILS. Pledges written by an import carry no
 *     `announcedAt` and no path backfills one.
 *  5. THE VOCABULARY HOLDS. Under the $50 backer floor the emails say "monthly
 *     giver", because the org's public backer count does too.
 */

const MON_8AM_ET = Date.parse("2026-08-10T12:00:00Z");

async function pledgeRow(s: ChapterSetup, pledgeId: Id<"pledges">) {
  return run(s.t, (ctx) => ctx.db.get(pledgeId));
}

/** Prepare a pledge through the public path, without activating it. */
async function preparePledge(
  s: ChapterSetup,
  amountCents: number,
  email: string,
): Promise<Id<"pledges">> {
  const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
    chapterId: s.chapterId,
    amountCents,
    name: "Ada Backer",
    email,
  });
  return prepared.pledgeId as Id<"pledges">;
}

/** An immediate rule watching every book, with an optional floor. */
async function immediateRule(
  s: ChapterSetup,
  minAmountCents?: number,
): Promise<Id<"givingNotificationRules">> {
  return run(s.t, async (ctx) =>
    ctx.db.insert("givingNotificationRules", {
      name: "Big gifts",
      recipients: ["desk@publicworship.life"],
      cadence: "immediate",
      ...(minAmountCents === undefined ? {} : { minAmountCents }),
      scope: "all",
      isActive: true,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Every scheduled function currently queued, by the name of the function. */
async function scheduledNames(s: ChapterSetup): Promise<string[]> {
  const rows = await run(s.t, (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return rows.map((r) => r.name);
}

function ruleLike(
  over: Partial<Doc<"givingNotificationRules">> = {},
): Pick<
  Doc<"givingNotificationRules">,
  "isActive" | "scope" | "minAmountCents"
> {
  return { isActive: true, scope: "all", ...over } as Pick<
    Doc<"givingNotificationRules">,
    "isActive" | "scope" | "minAmountCents"
  >;
}

function sampleBacker(
  over: Partial<NotificationBacker> = {},
): NotificationBacker {
  return {
    pledgeId: "p1",
    monthlyCents: 5000,
    annualCents: 60_000,
    startedAt: MON_8AM_ET,
    scopeLabel: "New York",
    isFirstPledge: true,
    isBacker: true,
    donor: {
      donorId: "d1",
      name: "Ada Backer",
      email: "ada@example.com",
      lifetimeCents: 5000,
      giftCount: 1,
      isFirstGift: true,
      url: "https://publicworship.life/os/giving/donor/d1",
    },
    ...over,
  };
}

// ── The floor: a backer is weighed at what they commit over a year ──────────

describe("ruleMatchesBackerSignup", () => {
  test("tests the floor against the ANNUAL commitment, not the monthly amount", () => {
    const rule = ruleLike({ minAmountCents: 50_000 }); // $500 and up
    // $50/mo is $600 a year — over the floor, and the whole point of the
    // feature. Tested at $50 it would have failed.
    expect(
      ruleMatchesBackerSignup(rule, {
        scope: "central",
        amountCents: 5000,
      } as Doc<"pledges">),
    ).toBe(true);
    // $40/mo is $480 a year — genuinely under a $500 floor.
    expect(
      ruleMatchesBackerSignup(rule, {
        scope: "central",
        amountCents: 4000,
      } as Doc<"pledges">),
    ).toBe(false);
    // INCLUSIVE, like the gift floor: exactly $500/yr clears a $500 rule.
    expect(
      ruleMatchesBackerSignup(ruleLike({ minAmountCents: 50_000 }), {
        scope: "central",
        amountCents: 50_000 / 12,
      } as Doc<"pledges">),
    ).toBe(backerAnnualCents(50_000 / 12) >= 50_000);
  });

  test("still respects scope and the active flag", () => {
    const signup = { scope: "central", amountCents: 5000 } as Doc<"pledges">;
    expect(ruleMatchesBackerSignup(ruleLike({ isActive: false }), signup)).toBe(
      false,
    );
    expect(
      ruleMatchesBackerSignup(
        ruleLike({ scope: "chapter1" as Id<"chapters"> }),
        signup,
      ),
    ).toBe(false);
    expect(ruleMatchesBackerSignup(ruleLike({ scope: "central" }), signup)).toBe(
      true,
    );
  });

  test("backerAnnualCents is twelve months of integer cents", () => {
    expect(backerAnnualCents(5000)).toBe(60_000);
    expect(backerAnnualCents(500)).toBe(6000);
  });
});

// ── The claim: one welcome per backer, whichever event arrives first ─────────

describe("the backer announcement claim", () => {
  test("checkout activation stamps announcedAt and schedules the welcome", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await preparePledge(s, 5000, "ada@example.com");
    expect((await pledgeRow(s, pledgeId))?.announcedAt).toBeUndefined();

    await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(pledgeId),
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });

    expect((await pledgeRow(s, pledgeId))?.announcedAt).toBeGreaterThan(0);
    expect(await scheduledNames(s)).toContain(
      "givingPledges:sendBackerWelcomeEmail",
    );
  });

  test("a redelivered activation does NOT welcome them twice", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await preparePledge(s, 5000, "ada@example.com");

    const activate = () =>
      t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
        pledgeId: String(pledgeId),
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      });
    await activate();
    const stamped = (await pledgeRow(s, pledgeId))?.announcedAt;
    await activate();

    // The stamp is untouched, and there is exactly one welcome queued.
    expect((await pledgeRow(s, pledgeId))?.announcedAt).toBe(stamped);
    const welcomes = (await scheduledNames(s)).filter((n) =>
      n.endsWith("sendBackerWelcomeEmail"),
    );
    expect(welcomes).toHaveLength(1);
  });

  test("invoice.paid arriving FIRST wins the claim, and the later activation adds nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await preparePledge(s, 5000, "ada@example.com");
    // Link the subscription without going through activation, so the invoice
    // resolves but the pledge has never been announced — the shape the
    // out-of-order recovery path lands in.
    await run(s.t, (ctx) =>
      ctx.db.patch(pledgeId, { stripeSubscriptionId: "sub_race" }),
    );

    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_race",
      invoiceId: "in_1",
      amountPaidCents: 5000,
      attemptRecovery: false,
    });
    const stamped = (await pledgeRow(s, pledgeId))?.announcedAt;
    expect(stamped).toBeGreaterThan(0);

    await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(pledgeId),
      stripeCustomerId: "cus_race",
      stripeSubscriptionId: "sub_race",
    });

    expect((await pledgeRow(s, pledgeId))?.announcedAt).toBe(stamped);
    const names = await scheduledNames(s);
    expect(names.filter((n) => n.endsWith("sendBackerWelcomeEmail"))).toHaveLength(
      1,
    );
    // And NO receipt for that first cycle — the welcome is the email.
    expect(names.filter((n) => n.endsWith("sendPledgeReceiptEmail"))).toHaveLength(
      0,
    );
  });
});

// ── First cycle is a welcome; every cycle after it is a receipt ──────────────

describe("the first cycle's email", () => {
  test("cycle one sends no receipt, cycle two does", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await preparePledge(s, 5000, "ada@example.com");
    await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(pledgeId),
      stripeCustomerId: "cus_2",
      stripeSubscriptionId: "sub_2",
    });

    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_2",
      invoiceId: "in_1",
      amountPaidCents: 5000,
    });
    let names = await scheduledNames(s);
    expect(names.filter((n) => n.endsWith("sendPledgeReceiptEmail"))).toHaveLength(
      0,
    );
    expect(names.filter((n) => n.endsWith("sendBackerWelcomeEmail"))).toHaveLength(
      1,
    );

    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_2",
      invoiceId: "in_2",
      amountPaidCents: 5000,
    });
    names = await scheduledNames(s);
    expect(names.filter((n) => n.endsWith("sendPledgeReceiptEmail"))).toHaveLength(
      1,
    );
    // Still exactly one welcome, ever.
    expect(names.filter((n) => n.endsWith("sendBackerWelcomeEmail"))).toHaveLength(
      1,
    );
  });
});

// ── The desk's notification ─────────────────────────────────────────────────

describe("the desk's new-backer notification", () => {
  test("a $50/mo signup fires a rule with a $500 floor", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await immediateRule(s, 50_000); // $500 and up
    const pledgeId = await preparePledge(s, 5000, "ada@example.com");

    await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(pledgeId),
      stripeCustomerId: "cus_3",
      stripeSubscriptionId: "sub_3",
    });

    expect(await scheduledNames(s)).toContain(
      "givingNotifications:notifyBackerSignup",
    );
  });

  test("a $40/mo signup does not — $480 a year is under a $500 floor", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await immediateRule(s, 50_000);
    const pledgeId = await preparePledge(s, 4000, "small@example.com");

    await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(pledgeId),
      stripeCustomerId: "cus_4",
      stripeSubscriptionId: "sub_4",
    });

    const names = await scheduledNames(s);
    expect(names).not.toContain("givingNotifications:notifyBackerSignup");
    // The BACKER still hears from us — their welcome never depended on a rule.
    expect(names).toContain("givingPledges:sendBackerWelcomeEmail");
  });

  test("the payload names the donor, both figures, and the book", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await immediateRule(s);
    const pledgeId = await preparePledge(s, 5000, "ada@example.com");
    await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(pledgeId),
      stripeCustomerId: "cus_5",
      stripeSubscriptionId: "sub_5",
    });

    const targets = await t.query(
      internal.givingNotifications.backerSignupTargets,
      { pledgeId },
    );
    expect(targets).not.toBeNull();
    expect(targets!.backer.monthlyCents).toBe(5000);
    expect(targets!.backer.annualCents).toBe(60_000);
    expect(targets!.backer.isBacker).toBe(true);
    expect(targets!.backer.isFirstPledge).toBe(true);
    expect(targets!.backer.scopeLabel).toBe("New York");
    expect(targets!.sends.map((x) => x.to)).toEqual(["desk@publicworship.life"]);
  });
});

// ── An import is not news ───────────────────────────────────────────────────

describe("imported pledges", () => {
  test("a pledge written directly by an import is never announced", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await immediateRule(s);

    const pledgeId = await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Legacy Backer",
        email: "legacy@example.com",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        source: "givebutter-import",
        createdAt: Date.now(),
      });
      return ctx.db.insert("pledges", {
        donorId,
        scope: s.chapterId,
        amountCents: 5000,
        status: "active",
        origin: "imported",
        startedAt: Date.parse("2024-01-01T00:00:00Z"),
        createdAt: Date.now(),
      });
    });

    expect((await pledgeRow(s, pledgeId))?.announcedAt).toBeUndefined();
    expect(await scheduledNames(s)).toHaveLength(0);
    // And it is invisible to a digest window, because the window ranges on
    // `announcedAt` — which an import never writes.
    const found = await run(s.t, (ctx) =>
      collectWindowBackers(ctx, ruleLike(), 0, Date.now() + 1),
    );
    expect(found).toHaveLength(0);
  });
});

// ── The digest window over new backers ──────────────────────────────────────

describe("collectWindowBackers", () => {
  test("ranges on announcedAt, honours the annual floor, and skips other books", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Ada",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        source: "manual",
        createdAt: Date.now(),
      }),
    );
    const insert = (amountCents: number, announcedAt: number) =>
      run(s.t, (ctx) =>
        ctx.db.insert("pledges", {
          donorId,
          scope: s.chapterId,
          amountCents,
          status: "active",
          origin: "stripe",
          announcedAt,
          createdAt: announcedAt,
        }),
      );

    await insert(5000, 1000); // in window, $600/yr
    await insert(600, 1100); // in window, $72/yr — under a $500 floor
    await insert(5000, 5000); // after the window closes

    // No floor: both in-window rows.
    expect(
      await run(s.t, (ctx) => collectWindowBackers(ctx, ruleLike(), 500, 2000)),
    ).toHaveLength(2);
    // $500 floor, tested annually: only the $50/mo one.
    expect(
      await run(s.t, (ctx) =>
        collectWindowBackers(ctx, ruleLike({ minAmountCents: 50_000 }), 500, 2000),
      ),
    ).toHaveLength(1);
    // The bound is EXCLUSIVE at `since` and inclusive at `until`.
    expect(
      await run(s.t, (ctx) => collectWindowBackers(ctx, ruleLike(), 1000, 2000)),
    ).toHaveLength(1);
    // A rule scoped to another book sees nothing.
    const otherChapter = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Elsewhere",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    expect(
      await run(s.t, (ctx) =>
        collectWindowBackers(ctx, ruleLike({ scope: otherChapter }), 500, 2000),
      ),
    ).toHaveLength(0);
  });
});

// ── "Did anything happen?" ──────────────────────────────────────────────────

describe("shouldSendDigest counts a signup as something happening", () => {
  test("a daily with no gifts but one new backer is SENT", () => {
    expect(shouldSendDigest("daily", 0)).toBe(false);
    expect(shouldSendDigest("daily", 1)).toBe(true);
  });
});

// ── The templates ───────────────────────────────────────────────────────────

describe("renderBackerSignupEmail", () => {
  test("leads with the monthly figure and names the annual one", () => {
    const { subject, html } = renderBackerSignupEmail({
      ruleName: "Big gifts",
      backer: sampleBacker(),
    });
    expect(subject).toBe(
      "New backer: Ada Backer — $50.00/mo ($600.00 a year) — New York",
    );
    expect(html).toContain("Someone just became a backer");
    expect(html).toContain("$50.00/mo");
    expect(html).toContain("$600.00 over the year ahead");
    expect(html).toContain("it is not money that has arrived");
    expect(html).toContain("Their first monthly pledge");
    expect(html).toContain("Big gifts");
  });

  test("under the $50 floor it says monthly giver, not backer", () => {
    const { subject, html } = renderBackerSignupEmail({
      ruleName: "Everything",
      backer: sampleBacker({
        monthlyCents: 1000,
        annualCents: 12_000,
        isBacker: false,
      }),
    });
    expect(subject).toContain("New monthly giver: Ada Backer");
    expect(subject).not.toContain("New backer:");
    expect(html).toContain("Someone just started giving monthly");
    expect(html).toContain("Not yet — under the $50/mo backer floor");
  });

  test("a donor name can't run away with the subject line", () => {
    const { subject } = renderBackerSignupEmail({
      ruleName: "r",
      backer: sampleBacker({
        donor: { ...sampleBacker().donor, name: "A".repeat(500) },
      }),
    });
    expect(subject.length).toBeLessThan(200);
  });

  test("HTML in a donor name is escaped, not rendered", () => {
    const { html } = renderBackerSignupEmail({
      ruleName: "r",
      backer: sampleBacker({
        donor: {
          ...sampleBacker().donor,
          name: "<script>alert(1)</script>",
          url: null,
        },
      }),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderBackerWelcomeEmail", () => {
  test("thanks them by first name and states the monthly amount", () => {
    const { subject, html } = renderBackerWelcomeEmail({
      name: "Ada Lovelace",
      monthlyCents: 5000,
      chapterName: "New York",
      isBacker: true,
      givePageUrl: "https://publicworship.life/give/new-york",
      portalUrl: "https://publicworship.life/backer",
    });
    expect(subject).toBe("You're a backer of New York 🎉");
    expect(html).toContain("Thank you, Ada.");
    expect(html).toContain("backer of New York");
    expect(html).toContain("$50.00 a month");
    expect(html).toContain("keep you in the loop");
    expect(html).toContain("https://publicworship.life/give/new-york");
  });

  test("NEVER quotes the annual figure at the donor", () => {
    const { html } = renderBackerWelcomeEmail({
      name: "Ada",
      monthlyCents: 5000,
      chapterName: "New York",
      isBacker: true,
      givePageUrl: null,
      portalUrl: "https://publicworship.life/backer",
    });
    // $600.00 is the number the DESK weighs a signup by. Saying it back to the
    // person reads as an invoice for eleven payments they haven't made.
    expect(html).not.toContain("$600.00");
  });

  test("degrades without a chapter or a public page", () => {
    const { subject, html } = renderBackerWelcomeEmail({
      name: "   ",
      monthlyCents: 2500,
      chapterName: null,
      isBacker: false,
      givePageUrl: null,
      portalUrl: "https://publicworship.life/backer",
    });
    expect(subject).toBe("You're giving monthly to Public Worship 🎉");
    expect(html).toContain("Thank you, friend.");
    expect(html).toContain("giving monthly to Public Worship");
    // No button, rather than a dead link.
    expect(html).not.toContain("See what");
  });

  test("a donor name is escaped", () => {
    const { html } = renderBackerWelcomeEmail({
      name: "<b>Ada</b>",
      monthlyCents: 5000,
      chapterName: "<script>x</script>",
      isBacker: true,
      givePageUrl: null,
      portalUrl: "https://publicworship.life/backer",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
  });
});

// ── The digest section ──────────────────────────────────────────────────────

const NO_PENDING = {
  pendingCents: 0,
  pendingCount: 0,
  pending: [] as DigestPendingGift[],
  pendingOmittedCount: 0,
};

function digestPayload(over: Record<string, unknown> = {}) {
  return {
    ruleName: "Weekly",
    cadence: "weekly" as const,
    scopeLabel: "All books",
    periodStart: MON_8AM_ET - 7 * 24 * 60 * 60 * 1000,
    periodEnd: MON_8AM_ET,
    totalCents: 0,
    giftCount: 0,
    largest: null,
    byScope: [],
    byMethod: [],
    byType: [],
    gifts: [],
    omittedCount: 0,
    countTruncated: false,
    newBackers: [] as NotificationBacker[],
    newBackerOmittedCount: 0,
    newBackerMonthlyCents: 0,
    newBackerAnnualCents: 0,
    ...NO_PENDING,
    ...over,
  };
}

describe("the digest's new-backer section", () => {
  test("a period with no gifts but two backers is NOT reported as nothing", () => {
    const { subject, html } = renderDigestEmail(
      digestPayload({
        newBackers: [sampleBacker(), sampleBacker({ pledgeId: "p2" })],
        newBackerMonthlyCents: 10_000,
        newBackerAnnualCents: 120_000,
      }),
    );
    expect(subject).toBe(
      "2 new backers ($100.00/mo), no gifts this week — All books",
    );
    expect(html).not.toContain("That's the whole report");
    expect(html).toContain("2 new backers");
    expect(html).toContain("$100.00 a month");
    expect(html).toContain("$1,200.00 over a year");
  });

  test("the signup figures are stated as NOT part of the total", () => {
    const { subject, html } = renderDigestEmail(
      digestPayload({
        totalCents: 25_000,
        giftCount: 2,
        gifts: [],
        newBackers: [sampleBacker()],
        newBackerMonthlyCents: 5000,
        newBackerAnnualCents: 60_000,
      }),
    );
    expect(subject).toContain("$250.00 from 2 gifts");
    expect(subject).toContain("1 new backer ($50.00/mo)");
    expect(html).toContain("separate from the total above and is NOT added to it");
  });

  test("a sub-floor pledge widens the heading rather than mislabelling it", () => {
    const payload = {
      newBackers: [sampleBacker(), sampleBacker({ pledgeId: "p2", isBacker: false })],
      newBackerOmittedCount: 0,
    };
    expect(newBackerHeadline(payload)).toBe("2 new monthly givers");
    expect(
      newBackerHeadline({ newBackers: [sampleBacker()], newBackerOmittedCount: 0 }),
    ).toBe("1 new backer");
    const { html } = renderDigestEmail(
      digestPayload({ ...payload, newBackerMonthlyCents: 6000 }),
    );
    expect(html).toContain("2 new monthly givers");
    expect(html).toContain("under the $50 backer floor");
  });

  test("an empty period still reports nothing, on both cadences", () => {
    expect(renderDigestEmail(digestPayload()).subject).toBe(
      "No giving this week — All books",
    );
    expect(renderDigestEmail(digestPayload()).html).toContain(
      "That's the whole report",
    );
  });
});

// ── The end-to-end shape ────────────────────────────────────────────────────

describe("a signup can never cost the money that caused it", () => {
  test("the gift, the pledge and the counters survive a failing mailer", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await immediateRule(s);
      const pledgeId = await preparePledge(s, 5000, "ada@example.com");
      await t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
        pledgeId: String(pledgeId),
        stripeCustomerId: "cus_6",
        stripeSubscriptionId: "sub_6",
      });
      await t.mutation(internal.givingPledges.recordPledgeInvoice, {
        subscriptionId: "sub_6",
        invoiceId: "in_1",
        amountPaidCents: 5000,
      });

      // Drain every scheduled send. No RESEND key is configured in tests, so
      // each one degrades to a logged no-op — the failure mode this asserts
      // against.
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const pledge = await pledgeRow(s, pledgeId);
      expect(pledge?.status).toBe("active");
      expect(pledge?.announcedAt).toBeGreaterThan(0);
      const gifts = await run(s.t, (ctx) =>
        ctx.db
          .query("gifts")
          .withIndex("by_pledge", (q) => q.eq("pledgeId", pledgeId))
          .collect(),
      );
      expect(gifts).toHaveLength(1);
      expect(gifts[0]?.amountCents).toBe(5000);
      const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
      expect(chapter?.backerCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
