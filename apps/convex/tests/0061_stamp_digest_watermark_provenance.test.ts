/**
 * Migration 0061 — label every EXISTING giving-notification watermark as a
 * digest run's, because that is where all of them came from.
 *
 * The bug it removes is specific and it emails real people: an unflagged
 * watermark reads as a synthetic BOUNDARY, so a rule caught MID-DRAIN gets the
 * trailing-period floor for one tick, re-reads from a period back, matches the
 * same first 750 gifts, and mails a byte-identical duplicate digest before its
 * own next claim stamps the flag. It self-heals and never skips a gift, which
 * is why this is a one-patch-per-row migration rather than anything cleverer.
 */
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runStampDigestWatermarkProvenance } from "../migrations/0061_stamp_digest_watermark_provenance";
import { digestWindowStart } from "../lib/givingNotificationRules";

const NOW = Date.parse("2026-08-10T12:00:00Z"); // Monday 08:00 EDT
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedRule(
  s: ChapterSetup,
  over: Record<string, unknown> = {},
): Promise<Id<"givingNotificationRules">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("givingNotificationRules", {
      name: "Weekly roundup",
      recipients: ["dev@publicworship.life"],
      cadence: "weekly",
      scope: "all",
      isActive: true,
      createdBy: s.userId,
      createdAt: NOW - 200 * DAY_MS,
      updatedAt: NOW - 200 * DAY_MS,
      ...over,
    } as never),
  );
}

describe("0061 — stamping watermark provenance", () => {
  test("a legacy watermark is labelled as a run's", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const ruleId = await seedRule(s, { lastSentAt: NOW - 3 * DAY_MS });

    const out = await run(t, (ctx) => runStampDigestWatermarkProvenance(ctx));
    expect(out).toMatchObject({ patched: 1, skipped: 0 });

    const row = await run(t, (ctx) => ctx.db.get(ruleId));
    expect(row?.watermarkFromRun).toBe(true);
    // The watermark itself is untouched — this labels, it never moves money
    // marks.
    expect(row?.lastSentAt).toBe(NOW - 3 * DAY_MS);
  });

  test("a rule that has never reported is left alone", async () => {
    // It needs nothing: `digestWindowStart`'s never-reported case already
    // gives it exactly one trailing period, flag or no flag.
    const t = newT();
    const s = await setupChapter(t);
    const ruleId = await seedRule(s);

    const out = await run(t, (ctx) => runStampDigestWatermarkProvenance(ctx));
    expect(out).toMatchObject({ patched: 0, skipped: 1 });

    const row = await run(t, (ctx) => ctx.db.get(ruleId));
    expect(row?.watermarkFromRun).toBeUndefined();
  });

  test("it stops the duplicate digest a mid-drain rule would have mailed", async () => {
    // The whole point, asserted through the function that decides the window
    // rather than through the field. A bookmark six hours into a daily period,
    // unflagged, reaches a WHOLE DAY back — over every gift the cut digest
    // just reported. Flagged, it resumes exactly where it stopped.
    const t = newT();
    const s = await setupChapter(t);
    const bookmark = NOW - 6 * 60 * 60 * 1000;
    const ruleId = await seedRule(s, {
      cadence: "daily",
      lastSentAt: bookmark,
      // A cut run clears the day mark so the drain continues on the next tick.
      lastRunDayKey: undefined,
    });

    const before = await run(t, (ctx) => ctx.db.get(ruleId));
    expect(digestWindowStart(before!, NOW)).toBe(NOW - DAY_MS);

    await run(t, (ctx) => runStampDigestWatermarkProvenance(ctx));

    const after = await run(t, (ctx) => ctx.db.get(ruleId));
    expect(digestWindowStart(after!, NOW)).toBe(bookmark);
  });

  test("re-running touches nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedRule(s, { lastSentAt: NOW - 3 * DAY_MS });
    await seedRule(s, { lastSentAt: undefined });

    await run(t, (ctx) => runStampDigestWatermarkProvenance(ctx));
    const second = await run(t, (ctx) => runStampDigestWatermarkProvenance(ctx));
    // Both rows now fall out: one already flagged, one with no watermark.
    expect(second).toMatchObject({ patched: 0, skipped: 2 });
  });

  test("it never CLEARS a flag — a rule resumed after the migration is safe", async () => {
    // The migration is ledgered and fires once, so this can't happen in
    // practice. Asserted anyway because "additive-only" is the property that
    // makes that guarantee unnecessary rather than load-bearing.
    const t = newT();
    const s = await setupChapter(t);
    const ruleId = await seedRule(s, {
      lastSentAt: NOW - DAY_MS,
      watermarkFromRun: true,
    });
    await run(t, (ctx) => runStampDigestWatermarkProvenance(ctx));
    const row = await run(t, (ctx) => ctx.db.get(ruleId));
    expect(row?.watermarkFromRun).toBe(true);
  });
});
