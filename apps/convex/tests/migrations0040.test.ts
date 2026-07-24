/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  runMigrateLegacyAudiences,
  runMigrateLegacyAudiencesPage,
} from "../migrations/0040_migrate_legacy_audiences";
import { resolveAudienceRecipients } from "../lib/audienceResolve";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0040 — legacy "people"/"donors" audiences → `person_filters`;
 * "guests" audiences are deliberately left unmigrated (see the migration's
 * own doc). Deterministic, auto-registered, idempotent.
 *
 * hotfix 0037-single-paginate sweep (2026-07-24): this file's own doc used to
 * claim a single `.paginate()` call, but the implementation wrapped it in a
 * `for(;;)` loop that called `.paginate()` again whenever `audiences` didn't
 * fit in one page — the same bug class as `0037`/`0039`, just never exercised
 * in prod (this migration sits after `0039` in the registry, and `0039`
 * itself was crashing first). Now fixed the same way: one page per call, a
 * scheduler continuation for the rest. The "single paginate per call" test
 * below exercises that the ONLY way that actually catches a regression:
 * separate `run()` calls (each its own execution) threading `continueCursor`,
 * forced across pages via a `pageSize` override.
 */

async function seedAudience(
  s: ChapterSetup,
  opts: {
    source: "guests" | "donors" | "people" | "person_filters";
    scope?: Id<"chapters"> | "central";
    filters?: Record<string, unknown>;
  },
): Promise<Id<"audiences">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("audiences", {
      scope: opts.scope ?? "central",
      name: `Aud ${opts.source}`,
      source: opts.source,
      filters: opts.filters ?? {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function getAudience(s: ChapterSetup, id: Id<"audiences">): Promise<Doc<"audiences">> {
  return run(s.t, (ctx) => ctx.db.get(id)) as Promise<Doc<"audiences">>;
}

describe("migration 0040 — migrate legacy audiences to person_filters", () => {
  test("'people' source becomes person_filters {teamOnly: true}, preserving chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, {
      source: "people",
      filters: { chapterId: s.chapterId },
    });

    const result = await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    expect(result.migratedFromPeople).toBe(1);

    const audience = await getAudience(s, id);
    expect(audience.source).toBe("person_filters");
    expect(audience.filters).toEqual({ chapterId: s.chapterId, teamOnly: true });
  });

  test("'donors' source with a real criterion carries it over untouched (no sentinel)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, {
      source: "donors",
      filters: { donorStatus: "active", gaveWithinDays: 30 },
    });

    const result = await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    expect(result.migratedFromDonors).toBe(1);

    const audience = await getAudience(s, id);
    expect(audience.source).toBe("person_filters");
    expect(audience.filters).toEqual({ donorStatus: "active", gaveWithinDays: 30 });
  });

  test("'donors' source with NO criterion gets the giftCountMin:0 sentinel (preserves 'every donor')", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, { source: "donors", filters: {} });

    await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    const audience = await getAudience(s, id);
    expect(audience.source).toBe("person_filters");
    expect(audience.filters).toEqual({ giftCountMin: 0 });
  });

  test("semantic preservation: a migrated 'donors' audience resolves to the SAME recipients as before migration", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A prospect donor (giftCount 0) — the case that would be silently
    // dropped without the giftCountMin:0 sentinel. `email` is set on the
    // PERSON row too (not just the donor row) — real donor creation writes
    // through to `personEmails` (`lib/givingDonors.ts#linkDonorToPerson`),
    // and `resolvePersonFilters` resolves a matched person's address via
    // `resolveSendAddress` (the person's OWN chosen address), not the raw
    // donor row's email — so the test seeds the person realistically instead
    // of bypassing that write-through the way a raw `ctx.db.insert` would.
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Prospect",
        email: "prospect@example.com",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Prospect",
        email: "prospect@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: Date.now(),
      }),
    );
    const id = await seedAudience(s, { source: "donors", scope: s.chapterId, filters: {} });

    const before = await run(s.t, (ctx) =>
      resolveAudienceRecipients(ctx, { scope: s.chapterId, source: "donors", filters: {} }),
    );
    expect(before.recipients.map((r) => r.email)).toEqual(["prospect@example.com"]);

    await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    const migrated = await getAudience(s, id);
    const after = await run(s.t, (ctx) => resolveAudienceRecipients(ctx, migrated));
    expect(after.recipients.map((r) => r.email)).toEqual(["prospect@example.com"]);
  });

  test("'guests' source is deliberately left unmigrated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, { source: "guests", filters: {} });

    const result = await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    expect(result.skippedGuests).toBe(1);

    const audience = await getAudience(s, id);
    expect(audience.source).toBe("guests");
  });

  test("a row already person_filters is left untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, { source: "person_filters", filters: { teamOnly: true } });

    const result = await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    expect(result.alreadyPersonFilters).toBe(1);

    const audience = await getAudience(s, id);
    expect(audience.filters).toEqual({ teamOnly: true });
  });

  test("idempotent: a second run touches nothing further", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedAudience(s, { source: "people", filters: {} });
    await seedAudience(s, { source: "donors", filters: { donorStatus: "active" } });
    await seedAudience(s, { source: "guests", filters: {} });

    const first = await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    expect(first.migratedFromPeople).toBe(1);
    expect(first.migratedFromDonors).toBe(1);
    expect(first.skippedGuests).toBe(1);

    const second = await run(s.t, (ctx) => runMigrateLegacyAudiences(ctx));
    expect(second.migratedFromPeople).toBe(0);
    expect(second.migratedFromDonors).toBe(0);
    expect(second.alreadyPersonFilters).toBe(2); // the two now-migrated rows
    expect(second.skippedGuests).toBe(1); // still deliberately skipped every run
  });

  /**
   * hotfix 0037-single-paginate sweep: drives `runMigrateLegacyAudiencesPage`
   * the way the scheduler continuation does in production — separate `run()`
   * calls (each its own execution) threading `continueCursor` — forced across
   * THREE pages via `pageSize: 1`, and asserts every row is eventually
   * migrated with never more than one `.paginate()` per call.
   */
  test("runner invocation pattern: single paginate per call across pages", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const peopleId = await seedAudience(s, { source: "people", filters: {} });
    const donorsId = await seedAudience(s, { source: "donors", filters: { donorStatus: "active" } });
    const guestsId = await seedAudience(s, { source: "guests", filters: {} });

    const call1 = await run(s.t, (ctx) => runMigrateLegacyAudiencesPage(ctx, null, 1));
    expect(call1.scanned).toBe(1);
    expect(call1.isDone).toBe(false);
    expect(call1.continueCursor).toBeTruthy();

    const call2 = await run(s.t, (ctx) =>
      runMigrateLegacyAudiencesPage(ctx, call1.continueCursor, 1),
    );
    expect(call2.scanned).toBe(1);
    expect(call2.isDone).toBe(false);

    const call3 = await run(s.t, (ctx) =>
      runMigrateLegacyAudiencesPage(ctx, call2.continueCursor, 1),
    );
    expect(call3.scanned).toBe(1);
    expect(call3.isDone).toBe(true);
    expect(call3.continueCursor).toBeNull();

    expect(call1.migratedFromPeople + call2.migratedFromPeople + call3.migratedFromPeople).toBe(1);
    expect(call1.migratedFromDonors + call2.migratedFromDonors + call3.migratedFromDonors).toBe(1);
    expect(call1.skippedGuests + call2.skippedGuests + call3.skippedGuests).toBe(1);

    expect((await getAudience(s, peopleId)).source).toBe("person_filters");
    expect((await getAudience(s, donorsId)).source).toBe("person_filters");
    expect((await getAudience(s, guestsId)).source).toBe("guests");
  });
});
