import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * The Mailchimp audience sync's Convex half — WHO ends up on the mailing list,
 * and what happens when Mailchimp tells us someone left.
 *
 * The pure payload-shaping half is covered in
 * `packages/shared/src/mailchimp.test.ts`. What's asserted here is the part
 * that can quietly mail the wrong people: eligibility. Every one of these
 * exclusions is a promise the org has made to a real person, and none of them
 * is visible in a code review of the payload builder.
 *
 * `collectChapterSlice` is the internal query the sync action reads through,
 * so asserting on it means asserting on exactly what would be pushed.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL, chapterName: "Brooklyn" });
}

/** Insert one person, returning their id. */
async function seedPerson(
  s: ChapterSetup,
  fields: Record<string, unknown>,
): Promise<string> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Person",
      status: "active",
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

/** The slice the sync action would push for this chapter. */
async function slice(s: ChapterSetup) {
  return await s.t.query(internal.mailchimpSync.collectChapterSlice, {
    chapterId: s.chapterId,
  });
}

describe("who lands on the Mailchimp audience", () => {
  test("a plain active person with an address is pushed, tagged with their chapter", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "Ada Lovelace", email: "ada@example.com" });

    const result = await slice(s);
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      email: "ada@example.com",
      chapterName: "Brooklyn",
      backer: "none",
      role: "contact",
    });
  });

  test("the address is normalized, so it joins the suppression ledger's key", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "Ada", email: "Ada@Example.COM" });

    const result = await slice(s);
    expect(result.members[0].email).toBe("ada@example.com");
  });

  test("marketingOptOut excludes the person entirely, and is counted", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "Opted Out", email: "no@example.com", marketingOptOut: true });

    const result = await slice(s);
    expect(result.members).toHaveLength(0);
    expect(result.optedOut).toBe(1);
  });

  test("a suppressed address is excluded even though the person never opted out", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "Bounced", email: "bounced@example.com" });
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "bounced@example.com",
        reason: "bounce",
        createdAt: Date.now(),
      }),
    );

    const result = await slice(s);
    expect(result.members).toHaveLength(0);
    expect(result.suppressed).toBe(1);
  });

  test("consentedAt NEVER resurrects a suppressed address", async () => {
    // The inverse of `tests/personConsent.test.ts`'s rule, asserted on this
    // path too: `schema/people.ts` is emphatic that recorded consent must not
    // be wired into send eligibility, and a new send-adjacent surface is
    // exactly where that rule would get quietly broken.
    const s = await asSuperuser(newT());
    await seedPerson(s, {
      name: "Consented",
      email: "consented@example.com",
      consentedAt: Date.now(),
      consentSource: "Contact Information form import, 2026-07",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "consented@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      }),
    );

    const result = await slice(s);
    expect(result.members).toHaveLength(0);
  });

  test("placeholder and inactive rows are not people and never sync", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "Placeholder", email: "p@example.com", isPlaceholder: true });
    await seedPerson(s, { name: "Inactive", email: "i@example.com", status: "inactive" });

    const result = await slice(s);
    expect(result.members).toHaveLength(0);
  });

  test("a person with no address at all is counted, not silently dropped", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "No Address" });

    const result = await slice(s);
    expect(result.members).toHaveLength(0);
    expect(result.noAddress).toBe(1);
  });

  test("a contact-only row IS included — the documented divergence from resolvePeople", async () => {
    // The legacy "people" audience source excludes contacts to preserve
    // pre-Phase-1 behavior. This is the org's actual mailing list, where a
    // donor or an event guest is precisely the point.
    const s = await asSuperuser(newT());
    await seedPerson(s, {
      name: "Guest Contact",
      email: "guest@example.com",
      isContactOnly: true,
    });

    const result = await slice(s);
    expect(result.members.map((m) => m.email)).toEqual(["guest@example.com"]);
  });
});

describe("merge-field derivation", () => {
  test("an active pledge makes someone an active backer", async () => {
    const s = await asSuperuser(newT());
    const personId = await seedPerson(s, { name: "Backer", email: "backer@example.com" });
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Backer",
        email: "backer@example.com",
        personId: personId as never,
        status: "active",
        lifetimeCents: 5000,
        giftCount: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("pledges", {
        scope: "central",
        donorId,
        status: "active",
        amountCents: 2500,
        origin: "stripe",
        createdAt: Date.now(),
      });
    });

    const result = await slice(s);
    expect(result.members[0].backer).toBe("active");
  });

  test("a pledge on file but none active reads as lapsed, not none", async () => {
    const s = await asSuperuser(newT());
    const personId = await seedPerson(s, { name: "Lapsed", email: "lapsed@example.com" });
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Lapsed",
        email: "lapsed@example.com",
        personId: personId as never,
        status: "active",
        lifetimeCents: 5000,
        giftCount: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("pledges", {
        scope: "central",
        donorId,
        status: "canceled",
        amountCents: 2500,
        origin: "stripe",
        createdAt: Date.now(),
      });
    });

    const result = await slice(s);
    expect(result.members[0].backer).toBe("lapsed");
  });

  test("team beats volunteer — one ROLE value, most specific wins", async () => {
    const s = await asSuperuser(newT());
    await seedPerson(s, {
      name: "Both",
      email: "both@example.com",
      isTeamMember: true,
      isVolunteer: true,
    });

    const result = await slice(s);
    expect(result.members[0].role).toBe("team");
  });
});

describe("the suppression pull-back from Mailchimp", () => {
  test("marking the mirror unsubscribed creates a row when none existed", async () => {
    const s = await asSuperuser(newT());
    await s.t.mutation(internal.mailchimpSync.markMirrorUnsubscribed, {
      email: "Gone@Example.com",
    });

    const rows = await run(s.t, (ctx) => ctx.db.query("mailchimpMembers").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "gone@example.com", status: "unsubscribed" });
  });

  test("an existing subscribed mirror row is flipped, not duplicated", async () => {
    const s = await asSuperuser(newT());
    await run(s.t, (ctx) =>
      ctx.db.insert("mailchimpMembers", {
        email: "gone@example.com",
        status: "subscribed",
        lastSyncedAt: Date.now(),
      }),
    );

    await s.t.mutation(internal.mailchimpSync.markMirrorUnsubscribed, {
      email: "gone@example.com",
    });

    const rows = await run(s.t, (ctx) => ctx.db.query("mailchimpMembers").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unsubscribed");
  });

  test("someone unsubscribed in Mailchimp stops being eligible for the next sync", async () => {
    // The whole point of the pull-back: the suppression ledger is shared, so
    // an unsubscribe in Mailchimp also silences event blasts.
    const s = await asSuperuser(newT());
    await seedPerson(s, { name: "Leaver", email: "leaver@example.com" });
    expect((await slice(s)).members).toHaveLength(1);

    await s.t.mutation(internal.emailSuppressions.recordSuppression, {
      email: "leaver@example.com",
      reason: "unsubscribe",
      note: "Mailchimp unsubscribe",
    });

    expect((await slice(s)).members).toHaveLength(0);
  });
});

describe("the mirror is what finds the leavers", () => {
  test("only subscribed rows come back — an already-unsubscribed row is not re-pushed", async () => {
    const s = await asSuperuser(newT());
    await run(s.t, async (ctx) => {
      await ctx.db.insert("mailchimpMembers", {
        email: "still@example.com",
        status: "subscribed",
        lastSyncedAt: Date.now(),
      });
      await ctx.db.insert("mailchimpMembers", {
        email: "already@example.com",
        status: "unsubscribed",
        lastSyncedAt: Date.now(),
      });
    });

    const mirror = await s.t.query(internal.mailchimpSync.listSubscribedMirror, {});
    expect(mirror.emails).toEqual(["still@example.com"]);
    expect(mirror.truncated).toBe(false);
  });
});
