/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * `siteMap.ts` — first dedicated backend test file for the site-map domain
 * (prior coverage was incidental, inside `itemConvert.test.ts`/
 * `itemToVendorConvert.test.ts`). Covers `addMarker`/`updateMarker`/`get`/
 * `publicSiteMap`'s handling of the marker `size` field (#629).
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  const { t, chapterId, userId } = s;
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: `t-${Math.random().toString(36).slice(2)}`,
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Gala",
      eventDate: now,
      status: "planning",
      disabledCoreModules: [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("siteMap markers — size", () => {
  test("addMarker persists an optional size; get and publicSiteMap return it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const scope = { kind: "event" as const, eventId };

    const noSizeId = await s.as.mutation(api.siteMap.addMarker, {
      scope,
      x: 0.2,
      y: 0.2,
      label: "Water station",
    });
    const sizedId = await s.as.mutation(api.siteMap.addMarker, {
      scope,
      x: 0.4,
      y: 0.4,
      label: "Stage",
      size: 40,
    });

    const got = await s.as.query(api.siteMap.get, { scope });
    expect(got.markers.find((m: any) => m._id === noSizeId)?.size).toBeNull();
    expect(got.markers.find((m: any) => m._id === sizedId)?.size).toBe(40);

    const pub = await s.as.query(api.siteMap.publicSiteMap, { eventId });
    expect(pub.markers.find((m: any) => m.label === "Stage")?.size).toBe(40);
  });

  test("updateMarker patches size", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const scope = { kind: "event" as const, eventId };
    const markerId = await s.as.mutation(api.siteMap.addMarker, {
      scope,
      x: 0.5,
      y: 0.5,
    });

    await s.as.mutation(api.siteMap.updateMarker, { markerId, size: 30 });

    const got = await s.as.query(api.siteMap.get, { scope });
    expect(got.markers.find((m: any) => m._id === markerId)?.size).toBe(30);
  });
});
