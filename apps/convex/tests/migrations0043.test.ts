/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { runSplitPersonNamesPage } from "../migrations/0043_split_person_names";
import { composeName, nameHalvesPatch, splitPersonName } from "@events-os/shared";

/**
 * Migration 0043 — structured-name backfill: firstName/lastName stamped where
 * `name` splits unambiguously (exactly two tokens — the ONE rule in
 * `@events-os/shared#names`), ambiguous names left unset and counted, already-split
 * rows never overwritten (a hand-corrected split must survive a re-run).
 */

async function seedPerson(
  s: ChapterSetup,
  opts: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      status: "active",
      createdAt: Date.now(),
      ...opts,
    }),
  );
}

describe("@events-os/shared#names — the one splitting rule", () => {
  test("two tokens split; everything else refuses; compose round-trips", () => {
    expect(splitPersonName("Shante Evans")).toEqual({ firstName: "Shante", lastName: "Evans" });
    expect(splitPersonName("  Bree   Hill  ")).toEqual({ firstName: "Bree", lastName: "Hill" });
    expect(splitPersonName("Cher")).toBeNull();
    expect(splitPersonName("Ama (Gina) Oppong Asante")).toBeNull();
    expect(splitPersonName("Mary Jo Van Der Berg")).toBeNull();
    expect(splitPersonName("   ")).toBeNull();
    expect(composeName("Shante", "Evans")).toBe("Shante Evans");
    expect(composeName("Cher", undefined)).toBe("Cher");
    // A rename patch clears halves on an ambiguous new name.
    expect(nameHalvesPatch("Ama (Gina) Oppong Asante")).toEqual({
      firstName: undefined,
      lastName: undefined,
    });
  });
});

describe("0043 — backfill", () => {
  test("splits unambiguous names, counts ambiguous ones, never overwrites an existing split", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const clean = await seedPerson(s, { name: "Shante Evans" });
    const single = await seedPerson(s, { name: "Cher" });
    const multi = await seedPerson(s, { name: "Ama (Gina) Oppong Asante" });
    // Hand-corrected split that the raw name would never produce — must survive.
    const corrected = await seedPerson(s, {
      name: "Mary Jo Van Der Berg",
      firstName: "Mary Jo",
      lastName: "Van Der Berg",
    });

    const result = await run(s.t, (ctx) => runSplitPersonNamesPage(ctx, null));
    // setupChapter seeds its own roster row(s) — assert on our four exactly.
    expect(result.split).toBeGreaterThanOrEqual(1);
    expect(result.skippedAmbiguous).toBeGreaterThanOrEqual(2);
    expect(result.skippedAlreadySplit).toBeGreaterThanOrEqual(1);
    expect(result.isDone).toBe(true);

    expect(await run(s.t, (ctx) => ctx.db.get(clean))).toMatchObject({
      firstName: "Shante",
      lastName: "Evans",
      name: "Shante Evans",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(single)))!.firstName).toBeUndefined();
    expect((await run(s.t, (ctx) => ctx.db.get(multi)))!.firstName).toBeUndefined();
    expect(await run(s.t, (ctx) => ctx.db.get(corrected))).toMatchObject({
      firstName: "Mary Jo",
      lastName: "Van Der Berg",
    });

    // Idempotent: a second run splits nothing new.
    const second = await run(s.t, (ctx) => runSplitPersonNamesPage(ctx, null));
    expect(second.split).toBe(0);
  });

  test("a forced page boundary continues the scan", async () => {
    const t = newT();
    const s = await setupChapter(t);
    for (let i = 0; i < 3; i++) await seedPerson(s, { name: `Person Number${i}` });
    const first = await run(s.t, (ctx) => runSplitPersonNamesPage(ctx, null, 2));
    expect(first.isDone).toBe(false);
    const second = await run(s.t, (ctx) => runSplitPersonNamesPage(ctx, first.continueCursor, 2));
    // Between the two pages every seeded row was visited.
    expect(first.scanned + second.scanned).toBeGreaterThanOrEqual(3);
  });
});
