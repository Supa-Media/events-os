/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runReleaseLegacyCardAutolocks } from "../migrations/0064_release_legacy_card_autolocks";
import type { Id } from "../_generated/dataModel";

/**
 * Migration 0064 — release the receipt auto-locks the sweep wrongly applied to
 * legacy (Relay) cards. See the migration's module doc for why they were never
 * enforceable in the first place.
 */

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      createdAt: Date.now(),
    }),
  );
}

async function seedCard(
  s: ChapterSetup,
  cardholderPersonId: Id<"people">,
  opts: {
    source?: "increase" | "legacy";
    status: "active" | "locked" | "canceled";
    receiptGraceEndsAt?: number;
  },
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId,
      type: "physical",
      source: opts.source,
      status: opts.status,
      receiptGraceEndsAt: opts.receiptGraceEndsAt,
      createdAt: Date.now(),
    }),
  );
}

describe("0064_release_legacy_card_autolocks", () => {
  test("releases a legacy AUTO-lock, leaves every other lock alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, "Holder");
    const stamp = Date.now() - 1000;

    // The bug's signature: legacy + locked + a grace stamp.
    const falseLock = await seedCard(s, holder, {
      source: "legacy",
      status: "locked",
      receiptGraceEndsAt: stamp,
    });
    // Legacy, locked, NO stamp — a deliberate human lock. Equally
    // unenforceable, but it records an intent someone expressed, so reversing
    // it silently would be its own surprise.
    const manualLegacyLock = await seedCard(s, holder, {
      source: "legacy",
      status: "locked",
    });
    // An Increase card auto-locked for the same reason — this one is REAL and
    // must survive untouched.
    const realLock = await seedCard(s, holder, {
      status: "locked",
      receiptGraceEndsAt: stamp,
    });
    const activeLegacy = await seedCard(s, holder, {
      source: "legacy",
      status: "active",
    });

    const result = await run(s.t, (ctx) => runReleaseLegacyCardAutolocks(ctx));
    expect(result).toEqual({ released: 1, manualLocksLeft: 1 });

    const released = await run(s.t, (ctx) => ctx.db.get(falseLock));
    expect(released?.status).toBe("active");
    expect(released?.receiptGraceEndsAt).toBeUndefined();

    expect((await run(s.t, (ctx) => ctx.db.get(manualLegacyLock)))?.status).toBe(
      "locked",
    );
    const untouched = await run(s.t, (ctx) => ctx.db.get(realLock));
    expect(untouched?.status).toBe("locked");
    expect(untouched?.receiptGraceEndsAt).toBe(stamp);
    expect((await run(s.t, (ctx) => ctx.db.get(activeLegacy)))?.status).toBe(
      "active",
    );
  });

  test("is idempotent — a second run releases nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, "Holder");
    await seedCard(s, holder, {
      source: "legacy",
      status: "locked",
      receiptGraceEndsAt: Date.now() - 1000,
    });

    const first = await run(s.t, (ctx) => runReleaseLegacyCardAutolocks(ctx));
    expect(first.released).toBe(1);
    const second = await run(s.t, (ctx) => runReleaseLegacyCardAutolocks(ctx));
    expect(second).toEqual({ released: 0, manualLocksLeft: 0 });
  });
});
