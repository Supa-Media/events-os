import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * The email suppression ledger's ADMIN surface (`emailSuppressions.ts`).
 *
 * Before this, suppression was a one-way door: nothing could remove a row, so
 * a single wrong bounce killed a good address permanently and invisibly. These
 * tests pin the three things that fixed that — a gated un-suppress that really
 * re-enables delivery, a manual suppress that makes the long-declared
 * `"manual"` reason real, and an audit row naming the human behind each.
 *
 * "Re-enables delivery" is asserted through `audiences.previewAudience` on
 * purpose: that's the same resolver a real send resolves its recipients with,
 * so a passing assertion here means mail would actually go out again — not
 * merely that a row disappeared.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";
const READER = "reader@example.com";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

/** One mailable person — the address these tests suppress and resurrect. */
async function seedReader(s: ChapterSetup): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Riley Reader",
      email: READER,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** What a real send would resolve for the "everyone on the roster" audience. */
async function audiencePreview(s: ChapterSetup) {
  return s.as.query(api.audiences.previewAudience, {
    scope: "central",
    source: "people",
    filters: {},
  });
}

async function auditRows(s: ChapterSetup) {
  return run(s.t, (ctx) => ctx.db.query("emailSuppressionAudit").collect());
}

describe("suppressEmail (the 'manual' reason finally has a writer)", () => {
  test("suppresses an address, records reason 'manual', and audits the actor", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedReader(s);
    expect((await audiencePreview(s)).count).toBe(1);

    const result = await s.as.mutation(api.emailSuppressions.suppressEmail, {
      email: "  Reader@Example.com  ",
      note: "Asked us to stop at the door",
    });
    expect(result).toEqual({ email: READER, alreadySuppressed: false });

    const rows = await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect());
    expect(rows).toHaveLength(1);
    // Normalized on the way in, so the ledger stays findable and comparable.
    expect(rows[0].email).toBe(READER);
    expect(rows[0].reason).toBe("manual");
    expect(rows[0].note).toBe("Asked us to stop at the door");

    const preview = await audiencePreview(s);
    expect(preview.count).toBe(0);
    expect(preview.excludedSuppressed).toBe(1);

    const audit = await auditRows(s);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      email: READER,
      action: "suppressed",
      reason: "manual",
      actorUserId: s.userId,
    });
  });

  test("is idempotent and keeps the ORIGINAL reason (a complaint doesn't become 'manual')", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: READER,
        reason: "complaint",
        createdAt: Date.now(),
      }),
    );
    const result = await s.as.mutation(api.emailSuppressions.suppressEmail, {
      email: READER,
    });
    expect(result.alreadySuppressed).toBe(true);

    const rows = await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("complaint");
    // The attempt is still audited — "we thought we'd suppressed this" is a
    // question the trail should be able to answer.
    expect((await auditRows(s)).map((r) => r.action)).toEqual(["suppressed"]);
  });

  test("rejects a malformed address rather than creating an un-findable row", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await expect(
      s.as.mutation(api.emailSuppressions.suppressEmail, { email: "not-an-email" }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect())).toEqual(
      [],
    );
  });
});

describe("unsuppressEmail (the door back out)", () => {
  test("a wrongly-bounced address is delivered to again, and the cleared reason is audited", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedReader(s);
    // The exact failure the audit found: one bounce (here, a hard one) took a
    // good address out of circulation with no way back.
    await s.t.mutation(internal.emailSuppressions.recordSuppression, {
      email: READER,
      reason: "bounce",
    });
    expect((await audiencePreview(s)).count).toBe(0);

    const result = await s.as.mutation(api.emailSuppressions.unsuppressEmail, {
      email: READER,
      note: "Mailbox was full; confirmed working",
    });
    expect(result).toEqual({ email: READER, wasSuppressed: true });

    // The row is gone, so every reader of the ledger (audience resolution,
    // the pre-send recheck, the blast audience) sees a mailable address.
    expect(await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect())).toEqual(
      [],
    );
    expect(
      await s.t.query(internal.emailSuppressions.isEmailSuppressed, { email: READER }),
    ).toBe(false);
    const preview = await audiencePreview(s);
    expect(preview.count).toBe(1);
    expect(preview.excludedSuppressed).toBe(0);

    const audit = await auditRows(s);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      email: READER,
      action: "unsuppressed",
      // Captured BEFORE the delete — un-suppressing a complaint is a
      // materially riskier call than un-suppressing a soft bounce, and after
      // the delete nothing would say which this was.
      reason: "bounce",
      actorUserId: s.userId,
      note: "Mailbox was full; confirmed working",
    });
  });

  test("an address that isn't suppressed is a no-op — no audit noise", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const result = await s.as.mutation(api.emailSuppressions.unsuppressEmail, {
      email: READER,
    });
    expect(result).toEqual({ email: READER, wasSuppressed: false });
    expect(await auditRows(s)).toEqual([]);
  });

  test("un-suppressing then re-suppressing leaves one row and a full trail", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await s.as.mutation(api.emailSuppressions.suppressEmail, { email: READER });
    await s.as.mutation(api.emailSuppressions.unsuppressEmail, { email: READER });
    await s.as.mutation(api.emailSuppressions.suppressEmail, { email: READER });
    expect(await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect())).toHaveLength(
      1,
    );
    expect((await auditRows(s)).map((r) => r.action)).toEqual([
      "suppressed",
      "unsuppressed",
      "suppressed",
    ]);
  });
});

describe("the admin surface is gated", () => {
  test("a caller without campaigns access can neither suppress, un-suppress, nor read the ledger", async () => {
    const t = newT();
    const s = await setupChapter(t); // an ordinary member
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: READER,
        reason: "bounce",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.emailSuppressions.suppressEmail, { email: "x@example.com" }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.emailSuppressions.unsuppressEmail, { email: READER }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.query(api.emailSuppressions.getSuppressionSummary, {}),
    ).rejects.toBeInstanceOf(ConvexError);
    // Nothing was un-suppressed by the attempt.
    expect(await run(s.t, (ctx) => ctx.db.query("emailSuppressions").collect())).toHaveLength(
      1,
    );
  });
});

describe("getSuppressionSummary makes the scan cap observable", () => {
  async function seedSuppressions(s: ChapterSetup, n: number): Promise<void> {
    await run(s.t, async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("emailSuppressions", {
          email: `bounced${i}@example.com`,
          reason: "bounce",
          createdAt: Date.now() + i,
        });
      }
    });
  }

  test("reports the count and a clean bill of health under the cap", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedSuppressions(s, 3);
    const summary = await s.as.query(api.emailSuppressions.getSuppressionSummary, {});
    expect(summary.count).toBe(3);
    expect(summary.truncated).toBe(false);
    expect(summary.recent).toHaveLength(3);
    expect(summary.recent[0].reason).toBe("bounce");
  });

  test("flags a TRUNCATED scan — past the cap, addresses silently become mailable again", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedSuppressions(s, 5);
    // `scanLimit` probes the exact behaviour the real 50,000-row cap has,
    // without materializing 50,000 rows. The point isn't the number — it's
    // that hitting it is now reported instead of silently dropping
    // suppressions on the floor.
    const summary = await s.as.query(api.emailSuppressions.getSuppressionSummary, {
      scanLimit: 2,
    });
    expect(summary.count).toBe(2);
    expect(summary.limit).toBe(2);
    expect(summary.truncated).toBe(true);
  });

  test("scanLimit can only ever SHRINK the scan, never raise the real cap", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedSuppressions(s, 2);
    const summary = await s.as.query(api.emailSuppressions.getSuppressionSummary, {
      scanLimit: 10_000_000,
    });
    expect(summary.limit).toBe(50_000);
    expect(summary.truncated).toBe(false);
  });
});
