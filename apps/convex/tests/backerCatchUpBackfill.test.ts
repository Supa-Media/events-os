import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { BACKER_UNIT_CENTS } from "@events-os/shared";
import { renderBackerWelcomeEmail } from "../lib/backerWelcomeEmail";

/**
 * THE CATCH-UP SWEEP — a mass mailing to real donors.
 *
 * That is the whole reason this suite exists, and what it holds down:
 *
 *  1. A DRY RUN TOUCHES NOTHING. No stamp, no send, and the count it reports
 *     is the count a real run would mail.
 *  2. NOBODY IS THANKED TWICE. The claim is transactional, so a second run —
 *     or a run restarted after a crash — mails nobody.
 *  3. THE ALREADY-WELCOMED ARE SKIPPED. A pledge with `announcedAt` got the
 *     live welcome; catching it up would be apologising for something that
 *     didn't happen.
 *  4. THE GONE ARE LEFT ALONE. Cancelled and paused pledges get nothing.
 *  5. IT DOES NOT TOUCH THE DIGEST AXIS. `announcedAt` stays absent, so a
 *     backfill of two hundred people cannot be reported to the development
 *     team as two hundred NEW backers this week.
 *  6. THE COPY IS TRUE FOR SOMEBODY WHO'S BEEN GIVING FOR A YEAR.
 */

async function seedPledge(
  s: ChapterSetup,
  over: Partial<Doc<"pledges">> & { email?: string | null } = {},
): Promise<Id<"pledges">> {
  const { email, ...pledgeOver } = over;
  return run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope: s.chapterId,
      kind: "individual",
      name: "Ada Backer",
      ...(email === null ? {} : { email: email ?? "ada@example.com" }),
      status: "active",
      lifetimeCents: 60_000,
      giftCount: 12,
      source: "map",
      createdAt: Date.now(),
    });
    return ctx.db.insert("pledges", {
      donorId,
      scope: s.chapterId,
      amountCents: BACKER_UNIT_CENTS,
      status: "active",
      origin: "stripe",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_x",
      startedAt: Date.parse("2025-03-04T12:00:00Z"),
      createdAt: Date.parse("2025-03-04T12:00:00Z"),
      ...pledgeOver,
    });
  });
}

const pledgeRow = (s: ChapterSetup, id: Id<"pledges">) =>
  run(s.t, (ctx) => ctx.db.get(id));

describe("the dry run", () => {
  test("reports the backlog and changes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const a = await seedPledge(s);
    const b = await seedPledge(s, { amountCents: 3000 });

    const result = await t.action(
      internal.backerCatchUpBackfill.backfillBackerCatchUp,
      {},
    );
    expect(result.eligible).toBe(2);
    expect(result.claimed).toBe(0);
    expect(result.delivered).toBe(0);
    expect(result.isDone).toBe(true);

    // Nothing stamped: a dry run must be re-runnable forever.
    expect((await pledgeRow(s, a))?.catchUpSentAt).toBeUndefined();
    expect((await pledgeRow(s, b))?.catchUpSentAt).toBeUndefined();
  });
});

describe("who is eligible", () => {
  test("active and past_due are in; canceled, paused and incomplete are not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPledge(s, { status: "active" });
    await seedPledge(s, { status: "past_due" });
    await seedPledge(s, { status: "canceled", canceledAt: Date.now() });
    await seedPledge(s, { status: "paused" });
    await seedPledge(s, { status: "incomplete" });

    const result = await t.action(
      internal.backerCatchUpBackfill.backfillBackerCatchUp,
      {},
    );
    expect(result.scanned).toBe(5);
    expect(result.eligible).toBe(2);
  });

  test("a pledge that already got the live welcome is skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPledge(s, { announcedAt: Date.now() });
    await seedPledge(s);

    const result = await t.action(
      internal.backerCatchUpBackfill.backfillBackerCatchUp,
      {},
    );
    expect(result.eligible).toBe(1);
  });

  test("a donor with no email is skipped, and not claimed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedPledge(s, { email: null });

    const result = await t.action(
      internal.backerCatchUpBackfill.backfillBackerCatchUp,
      { execute: true },
    );
    expect(result.eligible).toBe(0);
    // Left unclaimed on purpose: a donor who gains an address later is still
    // reachable by a re-run.
    expect((await pledgeRow(s, id))?.catchUpSentAt).toBeUndefined();
  });
});

describe("executing", () => {
  test("stamps every eligible row and never mails the same person twice", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const a = await seedPledge(s);
    const b = await seedPledge(s, { amountCents: 2500 });

    const first = await t.action(
      internal.backerCatchUpBackfill.backfillBackerCatchUp,
      { execute: true },
    );
    expect(first.eligible).toBe(2);
    expect(first.claimed).toBe(2);
    expect((await pledgeRow(s, a))?.catchUpSentAt).toBeGreaterThan(0);
    expect((await pledgeRow(s, b))?.catchUpSentAt).toBeGreaterThan(0);

    // A SECOND RUN — the restarted-after-a-crash case — claims nobody.
    const second = await t.action(
      internal.backerCatchUpBackfill.backfillBackerCatchUp,
      { execute: true },
    );
    expect(second.eligible).toBe(0);
    expect(second.claimed).toBe(0);
  });

  test("the digest axis is untouched, so nobody is re-reported as NEW", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedPledge(s);

    await t.action(internal.backerCatchUpBackfill.backfillBackerCatchUp, {
      execute: true,
    });

    // This is the bug the separate stamp exists to prevent: had the sweep
    // reused `announcedAt`, the weekly digest would announce every backfilled
    // backer as a brand-new signup.
    const row = await pledgeRow(s, id);
    expect(row?.announcedAt).toBeUndefined();
    expect(row?.catchUpSentAt).toBeGreaterThan(0);
  });

  test("the desk is told nothing — no signup notifications are scheduled", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("givingNotificationRules", {
        name: "Every gift",
        recipients: ["desk@publicworship.life"],
        cadence: "immediate",
        scope: "all",
        isActive: true,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await seedPledge(s);

    await t.action(internal.backerCatchUpBackfill.backfillBackerCatchUp, {
      execute: true,
    });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((r) => r.name.endsWith("notifyBackerSignup")),
    ).toHaveLength(0);
  });
});

describe("the claim", () => {
  test("returns true exactly once, and refuses an already-welcomed pledge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fresh = await seedPledge(s);
    const welcomed = await seedPledge(s, { announcedAt: Date.now() });

    expect(
      await t.mutation(internal.backerCatchUpBackfill.markBackerCatchUpSent, {
        pledgeId: fresh,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.backerCatchUpBackfill.markBackerCatchUpSent, {
        pledgeId: fresh,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.backerCatchUpBackfill.markBackerCatchUpSent, {
        pledgeId: welcomed,
      }),
    ).toBe(false);
  });
});

describe("the catch-up copy", () => {
  const payload = {
    kind: "catch_up" as const,
    name: "Ada Lovelace",
    monthlyCents: 5000,
    chapterName: "New York",
    isBacker: true,
    backingSince: Date.parse("2025-03-04T12:00:00Z"),
    givePageUrl: null,
    portalUrl: "https://publicworship.life/backer",
  };

  test("says we're late instead of claiming they just signed up", () => {
    const { subject, html } = renderBackerWelcomeEmail(payload);
    expect(subject).toBe("Thank you for backing New York");
    expect(html).toContain("since March 2025");
    expect(html).toContain("we never sent you a proper thank-you");
    // The three sentences that would be false for a year-old backer.
    expect(html).not.toContain("You just became");
    expect(html).not.toContain("starting today");
    expect(html).not.toContain("Your first month has been received");
  });

  test("names the amount without implying anything changes", () => {
    const { html } = renderBackerWelcomeEmail(payload);
    expect(html).toContain("$50.00 a month");
    expect(html).toContain("Nothing about it changes because of this email");
  });

  test("points at the portal, which is the actual news", () => {
    const { html } = renderBackerWelcomeEmail(payload);
    expect(html).toContain("See everything you've given");
    expect(html).toContain("https://publicworship.life/backer");
  });

  test("holds the vocabulary under the $50 floor", () => {
    const { subject, html } = renderBackerWelcomeEmail({
      ...payload,
      monthlyCents: 2000,
      isBacker: false,
    });
    expect(subject).toBe("Thank you for backing New York");
    expect(html).toContain("giving monthly to");
    expect(html).toContain("Monthly givers are the reason");
  });

  test("degrades without a start date or a chapter", () => {
    const { html } = renderBackerWelcomeEmail({
      ...payload,
      chapterName: null,
      backingSince: undefined,
    });
    expect(html).toContain("Public Worship");
    expect(html).not.toContain("since undefined");
    expect(html).not.toContain("since ,");
  });

  test("the live welcome is unchanged", () => {
    const { subject, html } = renderBackerWelcomeEmail({
      name: "Ada",
      monthlyCents: 5000,
      chapterName: "New York",
      isBacker: true,
      givePageUrl: null,
      portalUrl: null,
    });
    expect(subject).toBe("You're a backer of New York 🎉");
    expect(html).toContain("You just became a");
    expect(html).toContain("starting today");
    expect(html).not.toContain("we never sent you");
  });
});
