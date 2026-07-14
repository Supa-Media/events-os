import { describe, expect, test } from "vitest";
import {
  PERMIT_STATUS_OPTIONS,
  PARTIAL_STATUS_VALUES,
  countPermitBlockers,
  isCompleteStatus,
  permitDeniedWithoutFallback,
} from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import { runPermitsStatesAndFallback } from "../migrations/0020_permits_states_and_fallback";
import type { Id } from "../_generated/dataModel";

/**
 * Permits v1 — the two new states (denied/waived), the jurisdiction + fallback
 * columns, the denied-without-fallback guardrail (shared helper + pipeline
 * blocker), and the 0020 migration (option merge + column add, idempotent).
 */

// ── States ───────────────────────────────────────────────────────────────────
describe("permit status options", () => {
  test("denied + waived are present with the right isComplete flags", () => {
    const byValue = new Map(PERMIT_STATUS_OPTIONS.map((o) => [o.value, o]));
    expect(byValue.has("denied")).toBe(true);
    expect(byValue.has("waived")).toBe(true);
    // denied is NOT complete (it's the guardrail trigger); waived IS complete.
    expect(isCompleteStatus(PERMIT_STATUS_OPTIONS, "denied")).toBe(false);
    expect(isCompleteStatus(PERMIT_STATUS_OPTIONS, "waived")).toBe(true);
    // approved stays complete.
    expect(isCompleteStatus(PERMIT_STATUS_OPTIONS, "approved")).toBe(true);
  });

  test("final option order is exactly the six permit states", () => {
    expect(PERMIT_STATUS_OPTIONS.map((o) => o.value)).toEqual([
      "not_needed",
      "to_apply",
      "submitted",
      "approved",
      "denied",
      "waived",
    ]);
  });

  test("neither denied nor waived is a partial-credit value", () => {
    expect(PARTIAL_STATUS_VALUES.has("denied")).toBe(false);
    expect(PARTIAL_STATUS_VALUES.has("waived")).toBe(false);
    // The existing in-flight states are untouched.
    expect(PARTIAL_STATUS_VALUES.has("to_apply")).toBe(true);
    expect(PARTIAL_STATUS_VALUES.has("submitted")).toBe(true);
  });
});

// ── Blocker helper (shared) ──────────────────────────────────────────────────
describe("permitDeniedWithoutFallback / countPermitBlockers", () => {
  test("denied + empty/whitespace fallback is a blocker", () => {
    expect(permitDeniedWithoutFallback({ status: "denied" })).toBe(true);
    expect(
      permitDeniedWithoutFallback({ status: "denied", fields: {} }),
    ).toBe(true);
    expect(
      permitDeniedWithoutFallback({ status: "denied", fields: { fallback: "" } }),
    ).toBe(true);
    expect(
      permitDeniedWithoutFallback({
        status: "denied",
        fields: { fallback: "   " },
      }),
    ).toBe(true);
  });

  test("denied WITH a fallback is NOT a blocker", () => {
    expect(
      permitDeniedWithoutFallback({
        status: "denied",
        fields: { fallback: "Move to the backup park" },
      }),
    ).toBe(false);
  });

  test("non-denied statuses are never blockers", () => {
    expect(permitDeniedWithoutFallback({ status: "to_apply" })).toBe(false);
    expect(permitDeniedWithoutFallback({ status: "approved" })).toBe(false);
    expect(permitDeniedWithoutFallback({ status: undefined })).toBe(false);
  });

  test("countPermitBlockers tallies only denied-without-fallback rows", () => {
    expect(
      countPermitBlockers([
        { status: "denied" }, // blocker
        { status: "denied", fields: { fallback: "plan B" } }, // not
        { status: "approved" }, // not
        { status: "denied", fields: { fallback: " " } }, // blocker
      ]),
    ).toBe(2);
  });
});

// ── Fresh-event columns ──────────────────────────────────────────────────────
describe("fresh permits grid columns", () => {
  test("a new event's permits grid has jurisdiction + fallback + denied/waived options", async () => {
    const t = newT();
    const { as } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Outdoor Worship",
    })) as Id<"eventTypes">;
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Outdoor Worship — August",
      eventDate: new Date(2026, 7, 1, 18, 0).getTime(),
    })) as Id<"events">;

    const cols = await run(t, async (ctx) =>
      ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "permits"),
        )
        .collect(),
    );
    const jurisdiction = cols.find((c) => c.key === "jurisdiction");
    const fallback = cols.find((c) => c.key === "fallback");
    expect(jurisdiction?.type).toBe("text");
    expect(jurisdiction?.kind).toBe("custom");
    expect(fallback?.type).toBe("longtext");
    expect(fallback?.kind).toBe("custom");

    const status = cols.find((c) => c.key === "status");
    const values = (status?.options as { value: string }[]).map((o) => o.value);
    expect(values).toContain("denied");
    expect(values).toContain("waived");
  });
});

// ── Pipeline blocker wiring ──────────────────────────────────────────────────
describe("events.pipeline permit blockers", () => {
  /** Create an operational, upcoming event and return its id + chapter. */
  async function makeEvent(t: ReturnType<typeof newT>) {
    const { as, chapterId } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Fest",
    })) as Id<"eventTypes">;
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Fest — future",
      eventDate: Date.now() + 30 * 24 * 3600 * 1000,
    })) as Id<"events">;
    return { as, chapterId, eventId };
  }

  async function addPermit(
    t: ReturnType<typeof newT>,
    chapterId: Id<"chapters">,
    eventId: Id<"events">,
    status: string,
    fields?: Record<string, unknown>,
  ) {
    return run(t, (ctx) =>
      ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "permits",
        title: `Permit ${status}`,
        order: 0,
        status,
        fields,
      }),
    );
  }

  function blockerFor(pipeline: any[], eventId: Id<"events">): number {
    const row = pipeline.find((e) => String(e._id) === String(eventId));
    expect(row).toBeDefined();
    return row.blockerCount as number;
  }

  test("denied + empty fallback increments blockerCount; a fallback clears it", async () => {
    const t = newT();
    const { as, chapterId, eventId } = await makeEvent(t);

    // Baseline: no permit blockers.
    let pipeline = await as.query(api.events.pipeline, {});
    const base = blockerFor(pipeline, eventId);

    // Denied with no fallback → +1.
    const deniedId = await addPermit(t, chapterId, eventId, "denied");
    pipeline = await as.query(api.events.pipeline, {});
    expect(blockerFor(pipeline, eventId)).toBe(base + 1);

    // Write a fallback → back to baseline.
    await run(t, (ctx) =>
      ctx.db.patch(deniedId, { fields: { fallback: "Use the indoor hall" } }),
    );
    pipeline = await as.query(api.events.pipeline, {});
    expect(blockerFor(pipeline, eventId)).toBe(base);
  });

  test("approved / to_apply permits never add a blocker", async () => {
    const t = newT();
    const { as, chapterId, eventId } = await makeEvent(t);
    const base = blockerFor(await as.query(api.events.pipeline, {}), eventId);

    await addPermit(t, chapterId, eventId, "approved");
    await addPermit(t, chapterId, eventId, "to_apply");
    expect(blockerFor(await as.query(api.events.pipeline, {}), eventId)).toBe(
      base,
    );
  });
});

// ── Migration 0020 ───────────────────────────────────────────────────────────
describe("0020 permits states + fallback backfill", () => {
  const OLD_OPTIONS = [
    { value: "not_needed", label: "Not needed", color: "gray" },
    { value: "to_apply", label: "To apply", color: "red", isComplete: false },
    { value: "submitted", label: "Submitted", color: "amber" },
    { value: "approved", label: "Approved", color: "green", isComplete: true },
  ];

  /** Seed a permits template + event grid on the OLD options, no new columns. */
  async function seedLegacyPermitGrids(
    t: ReturnType<typeof newT>,
    statusOptions: any[] = OLD_OPTIONS,
  ) {
    const { chapterId, userId } = await setupChapter(t);
    return run(t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId,
        name: "Legacy",
        slug: `legacy-permit-${now}`,
        version: 1,
        isArchived: false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Legacy Event",
        eventDate: now,
        status: "planning",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const legacyCols = [
        { key: "title", label: "Permit", kind: "system" as const, type: "text" as const, order: 0 },
        { key: "status", label: "Status", kind: "system" as const, type: "status" as const, options: statusOptions, order: 1 },
        { key: "notes", label: "Notes", kind: "custom" as const, type: "longtext" as const, order: 2 },
      ];
      for (const c of legacyCols) {
        await ctx.db.insert("templateColumns", {
          eventTypeId,
          module: "permits",
          isVisible: true,
          ...c,
        });
        await ctx.db.insert("eventColumns", {
          eventId,
          module: "permits",
          isVisible: true,
          ...c,
        });
      }
      return { eventTypeId, eventId };
    });
  }

  async function readPermitCols(
    t: ReturnType<typeof newT>,
    eventTypeId: Id<"eventTypes">,
    eventId: Id<"events">,
  ) {
    return run(t, async (ctx) => ({
      template: await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("module", "permits"),
        )
        .collect(),
      event: await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "permits"),
        )
        .collect(),
    }));
  }

  test("merges denied/waived into status options and adds jurisdiction/fallback", async () => {
    const t = newT();
    const { eventTypeId, eventId } = await seedLegacyPermitGrids(t);

    const res = await run(t, (ctx) => runPermitsStatesAndFallback(ctx));
    expect(res.statusColumnsMerged).toBe(2); // template + event status columns
    expect(res.templateColumnsAdded).toBe(2); // jurisdiction + fallback
    expect(res.eventColumnsAdded).toBe(2);

    const { template, event } = await readPermitCols(t, eventTypeId, eventId);
    for (const cols of [template, event]) {
      const status = cols.find((c) => c.key === "status")!;
      const values = (status.options as { value: string }[]).map((o) => o.value);
      // Old options preserved + order, new two appended at the tail.
      expect(values).toEqual([
        "not_needed",
        "to_apply",
        "submitted",
        "approved",
        "denied",
        "waived",
      ]);
      const jurisdiction = cols.find((c) => c.key === "jurisdiction")!;
      const fallback = cols.find((c) => c.key === "fallback")!;
      expect(jurisdiction.type).toBe("text");
      expect(fallback.type).toBe("longtext");
      // New columns land at the tail (after the existing max order).
      expect(jurisdiction.order).toBeGreaterThan(2);
      expect(fallback.order).toBeGreaterThan(jurisdiction.order);
    }
  });

  test("is idempotent: a second run merges nothing and adds no columns", async () => {
    const t = newT();
    const { eventTypeId, eventId } = await seedLegacyPermitGrids(t);
    await run(t, (ctx) => runPermitsStatesAndFallback(ctx));

    const res2 = await run(t, (ctx) => runPermitsStatesAndFallback(ctx));
    expect(res2.statusColumnsMerged).toBe(0);
    expect(res2.templateColumnsAdded).toBe(0);
    expect(res2.eventColumnsAdded).toBe(0);

    const { event } = await readPermitCols(t, eventTypeId, eventId);
    // No duplicate options or columns.
    const status = event.find((c) => c.key === "status")!;
    const values = (status.options as { value: string }[]).map((o) => o.value);
    expect(values.filter((v) => v === "denied")).toHaveLength(1);
    expect(values.filter((v) => v === "waived")).toHaveLength(1);
    expect(event.filter((c) => c.key === "jurisdiction")).toHaveLength(1);
    expect(event.filter((c) => c.key === "fallback")).toHaveLength(1);
  });

  test("preserves an author's custom option + order, appending only the new two", async () => {
    const t = newT();
    // Author dropped `not_needed`, reordered, and added a custom `expedited`.
    const custom = [
      { value: "to_apply", label: "To apply", color: "red", isComplete: false },
      { value: "expedited", label: "Expedited", color: "purple" },
      { value: "approved", label: "Approved", color: "green", isComplete: true },
    ];
    const { eventTypeId, eventId } = await seedLegacyPermitGrids(t, custom);

    await run(t, (ctx) => runPermitsStatesAndFallback(ctx));
    const { event } = await readPermitCols(t, eventTypeId, eventId);
    const status = event.find((c) => c.key === "status")!;
    const values = (status.options as { value: string }[]).map((o) => o.value);
    expect(values).toEqual([
      "to_apply",
      "expedited",
      "approved",
      "denied",
      "waived",
    ]);
  });
});
