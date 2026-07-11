import { describe, expect, test } from "vitest";
import { DAY_MS } from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Event → template sync (templateSync.ts + the provenance link):
 *   - `instantiateEvent` stamps `sourceTemplateItemId` on every cloned item
 *   - `diffEventAgainstTemplate` reports structural divergence only (never
 *     status/owner state)
 *   - `promoteFromEvent` promotes structure, strips state, backfills
 *     provenance, remaps roles by stable key, and bumps the template version
 *     exactly once per batch.
 */

const EVENT_DATE = new Date("2026-08-01T18:00:00").getTime();

/**
 * A default template (seeded roles + default columns) with one planning task
 * ("Book the venue", T-14, held by Event Lead) plus a live event cloned from it.
 */
async function setupTemplateAndEvent(t: ReturnType<typeof newT>) {
  const chapter = await setupChapter(t);
  const { as } = chapter;

  const eventTypeId = (await as.mutation(api.eventTypes.create, {
    name: "Worship Night",
  })) as Id<"eventTypes">;
  const eventLeadRoleId = await run(t, async (ctx) => {
    const role = await ctx.db
      .query("templateRoles")
      .withIndex("by_template_key", (q) =>
        q.eq("eventTypeId", eventTypeId).eq("key", "event_lead"),
      )
      .unique();
    return role!._id;
  });
  const templateItemId = (await as.mutation(api.items.addTemplateItem, {
    eventTypeId,
    module: "planning_doc",
    title: "Book the venue",
    offsetDays: -14,
    roleId: eventLeadRoleId,
    fields: { details: "Call the parks department" },
  })) as Id<"templateItems">;

  const eventId = (await as.mutation(api.events.createFromTemplate, {
    eventTypeId,
    name: "Worship Night — August",
    eventDate: EVENT_DATE,
  })) as Id<"events">;

  return { ...chapter, eventTypeId, eventLeadRoleId, templateItemId, eventId };
}

/** The event's clone of a template item, found by provenance. */
async function cloneOf(
  t: ReturnType<typeof newT>,
  eventId: Id<"events">,
  templateItemId: Id<"templateItems">,
): Promise<Doc<"eventItems">> {
  const item = await run(t, async (ctx) => {
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    return items.find((i) => i.sourceTemplateItemId === templateItemId) ?? null;
  });
  expect(item).not.toBeNull();
  return item!;
}

async function templateVersion(
  t: ReturnType<typeof newT>,
  eventTypeId: Id<"eventTypes">,
): Promise<number> {
  const et = await run(t, (ctx) => ctx.db.get(eventTypeId));
  return et!.version;
}

describe("instantiateEvent provenance", () => {
  test("cloning a template stamps sourceTemplateItemId on every event item", async () => {
    const t = newT();
    const { eventId, templateItemId } = await setupTemplateAndEvent(t);

    const items = await run(t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.sourceTemplateItemId).toBeDefined();
    expect(items.map((i) => i.sourceTemplateItemId)).toContain(templateItemId);
  });
});

describe("templateSync.diffEventAgainstTemplate", () => {
  test("a fresh clone has no divergence", async () => {
    const t = newT();
    const { as, eventId } = await setupTemplateAndEvent(t);
    const diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    expect(diff.items).toEqual([]);
    expect(diff.modules).toEqual([]);
    expect(diff.columns).toEqual([]);
  });

  test("detects new + modified (title/offset) items and ignores status/owner state", async () => {
    const t = newT();
    const { as, chapterId, eventId, templateItemId } =
      await setupTemplateAndEvent(t);

    // A brand-new event-only item.
    await as.mutation(api.items.addEventItem, {
      eventId,
      module: "planning_doc",
      title: "Charge the battery",
      offsetDays: -1,
    });

    // Structural edits to the cloned item: title + offset…
    const clone = await cloneOf(t, eventId, templateItemId);
    await as.mutation(api.items.updateEventItem, {
      itemId: clone._id,
      title: "Book the venue + rain backup",
      offsetDays: -21,
    });
    // …and STATE edits that must NOT show up in the diff: status + owner.
    await as.mutation(api.items.setStatus, {
      itemId: clone._id,
      status: "done",
    });
    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId,
        name: "Volunteer",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await as.mutation(api.items.assignOwner, { itemId: clone._id, personId });

    const diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });

    const added = diff.items.filter((i) => i.kind === "new_in_event");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      module: "planning_doc",
      title: "Charge the battery",
    });

    const modified = diff.items.filter((i) => i.kind === "modified");
    expect(modified).toHaveLength(1);
    expect(modified[0]).toMatchObject({
      templateItemId,
      confidence: "exact",
    });
    const fields = modified[0].changes.map((c) => c.field).sort();
    // Exactly the structural edits — no status/owner/prePlan/dueDate noise.
    expect(fields).toEqual(["offsetDays", "title"]);
    expect(modified[0].changes).toContainEqual({
      field: "offsetDays",
      before: -14,
      after: -21,
    });
    expect(modified[0].changes).toContainEqual({
      field: "title",
      before: "Book the venue",
      after: "Book the venue + rain backup",
    });
  });

  test("a deleted clone reports removed_in_event; unlinked title matches are low-confidence", async () => {
    const t = newT();
    const { as, eventId, templateItemId } = await setupTemplateAndEvent(t);

    const clone = await cloneOf(t, eventId, templateItemId);
    // Simulate a pre-provenance event: strip the link and diverge on offset.
    await run(t, (ctx) =>
      ctx.db.patch(clone._id, {
        sourceTemplateItemId: undefined,
        offsetDays: -7,
        dueDate: EVENT_DATE - 7 * DAY_MS,
      }),
    );
    let diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    const modified = diff.items.filter((i) => i.kind === "modified");
    expect(modified).toHaveLength(1);
    expect(modified[0]).toMatchObject({ templateItemId, confidence: "low" });

    // Now actually delete the clone → the template row shows as removed.
    await as.mutation(api.items.removeEventItem, { itemId: clone._id });
    diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    expect(diff.items).toEqual([
      {
        kind: "removed_in_event",
        templateItemId,
        module: "planning_doc",
        title: "Book the venue",
      },
    ]);
  });

  test("event-only custom modules and diverged columns are reported", async () => {
    const t = newT();
    const { as, eventId } = await setupTemplateAndEvent(t);

    await as.mutation(api.modules.createCustomForEvent, {
      eventId,
      label: "Load In",
    });
    // Diverge a column definition on the event (extra status option).
    const statusCol = await run(t, async (ctx) => {
      const cols = await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "planning_doc"),
        )
        .collect();
      return cols.find((c) => c.key === "status")!;
    });
    await as.mutation(api.columns.updateEventColumn, {
      columnId: statusCol._id,
      options: [
        ...(statusCol.options ?? []),
        { value: "blocked", label: "Blocked", color: "red" },
      ],
    });

    const diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    expect(diff.modules).toEqual([
      { kind: "new_workstream", moduleKey: "load_in", label: "Load In" },
    ]);
    expect(diff.columns).toHaveLength(1);
    expect(diff.columns[0]).toMatchObject({
      kind: "column_change",
      change: "modified",
      module: "planning_doc",
      key: "status",
    });
  });
});

describe("templateSync.promoteFromEvent", () => {
  test("add_item promotes structure, strips state, derives the offset, backfills provenance, and bumps version once per batch", async () => {
    const t = newT();
    const { as, chapterId, eventId, eventTypeId } =
      await setupTemplateAndEvent(t);

    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId,
        name: "Volunteer",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    // Two event-only items, loaded with every kind of state that must be
    // stripped. The first has a dueDate but NO offset → offset gets derived.
    const [itemA, itemB] = await run(t, async (ctx) => {
      const a = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Charge the battery",
        order: 100,
        dueDate: EVENT_DATE - 2 * DAY_MS,
        ownerPersonId: personId,
        status: "done",
        prePlanColumns: ["details"],
        prePlanChecked: ["details"],
        fields: { details: "Both packs", notes: "Spare cables too", cost: 42 },
      });
      const b = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Print signage",
        order: 101,
        offsetDays: -3,
        status: "in_progress",
      });
      return [a, b];
    });

    const versionBefore = await templateVersion(t, eventTypeId);
    const result = await as.mutation(api.templateSync.promoteFromEvent, {
      eventId,
      promotions: [
        { kind: "add_item", eventItemId: itemA },
        { kind: "add_item", eventItemId: itemB },
      ],
    });
    expect(result.applied).toHaveLength(2);

    // Exactly ONE version bump for the whole batch.
    expect(await templateVersion(t, eventTypeId)).toBe(versionBefore + 1);

    const promotedA = await run(t, (ctx) =>
      ctx.db.get(result.applied[0].templateItemId as Id<"templateItems">),
    );
    expect(promotedA).toMatchObject({
      eventTypeId,
      module: "planning_doc",
      title: "Charge the battery",
      // Derived from dueDate vs the event date (T-2).
      offsetDays: -2,
      // State reset/stripped: module default status, no cost, no pre-plan ticks.
      status: "not_started",
      prePlanColumns: ["details"],
      fields: { details: "Both packs", notes: "Spare cables too" },
    });
    expect(promotedA!.fields).not.toHaveProperty("cost");
    expect(promotedA).not.toHaveProperty("ownerPersonId");
    expect(promotedA).not.toHaveProperty("prePlanChecked");

    // Two add_items into the same module within one batch keep appending:
    // strictly increasing order values, after the existing template rows.
    const promotedB = await run(t, (ctx) =>
      ctx.db.get(result.applied[1].templateItemId as Id<"templateItems">),
    );
    expect(promotedB!.order).toBeGreaterThan(promotedA!.order);

    // Provenance backfilled → the follow-up diff is clean again.
    const eventItemA = await run(t, (ctx) => ctx.db.get(itemA));
    expect(eventItemA!.sourceTemplateItemId).toBe(promotedA!._id);
    const diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    expect(diff.items).toEqual([]);
  });

  test("role references remap event→template by stable key, creating missing roles", async () => {
    const t = newT();
    const { as, chapterId, eventId, eventTypeId, eventLeadRoleId } =
      await setupTemplateAndEvent(t);

    const [existingRoleItem, newRoleItem] = await run(t, async (ctx) => {
      const roles = await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect();
      const eventLead = roles.find((r) => r.key === "event_lead")!;
      // A role the EVENT added that the template doesn't have.
      const batteryCaptain = await ctx.db.insert("eventRoles", {
        eventId,
        key: "battery_captain",
        label: "Battery Captain",
        order: roles.length,
      });
      const a = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Confirm permits",
        order: 100,
        offsetDays: -10,
        roleId: eventLead._id,
      });
      const b = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Charge the battery",
        order: 101,
        offsetDays: -1,
        roleId: batteryCaptain,
      });
      return [a, b];
    });

    const result = await as.mutation(api.templateSync.promoteFromEvent, {
      eventId,
      promotions: [
        { kind: "add_item", eventItemId: existingRoleItem },
        { kind: "add_item", eventItemId: newRoleItem },
      ],
    });

    // Existing key → remapped to the template's own role row (no duplicate).
    const promotedExisting = await run(t, (ctx) =>
      ctx.db.get(result.applied[0].templateItemId as Id<"templateItems">),
    );
    expect(promotedExisting!.roleId).toBe(eventLeadRoleId);

    // New key → a template role was created and the item points at it.
    const promotedNew = await run(t, (ctx) =>
      ctx.db.get(result.applied[1].templateItemId as Id<"templateItems">),
    );
    const templateRoles = await run(t, (ctx) =>
      ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
        .collect(),
    );
    const created = templateRoles.find((r) => r.key === "battery_captain");
    expect(created).toMatchObject({
      label: "Battery Captain",
      isArchived: false,
    });
    expect(templateRoles.filter((r) => r.key === "event_lead")).toHaveLength(1);
    expect(promotedNew!.roleId).toBe(created!._id);
  });

  test("update_item patches the template source with structural changes only", async () => {
    const t = newT();
    const { as, eventId, templateItemId } = await setupTemplateAndEvent(t);

    const clone = await cloneOf(t, eventId, templateItemId);
    await as.mutation(api.items.updateEventItem, {
      itemId: clone._id,
      title: "Book the venue + rain backup",
      offsetDays: -21,
      fields: { details: "Call parks AND the rain venue" },
    });
    await as.mutation(api.items.setStatus, { itemId: clone._id, status: "done" });

    await as.mutation(api.templateSync.promoteFromEvent, {
      eventId,
      promotions: [{ kind: "update_item", eventItemId: clone._id }],
    });

    const templateItem = await run(t, (ctx) => ctx.db.get(templateItemId));
    expect(templateItem).toMatchObject({
      title: "Book the venue + rain backup",
      offsetDays: -21,
      fields: { details: "Call parks AND the rain venue" },
    });
    // Status stayed template-side state, untouched by the event's "done".
    expect(templateItem!.status).toBeUndefined();

    // And the diff is clean afterwards.
    const diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    expect(diff.items).toEqual([]);
  });

  test("a batch whose only entry no-ops (state-only edits → empty patch) does not bump the version", async () => {
    const t = newT();
    const { as, eventId, eventTypeId, templateItemId } =
      await setupTemplateAndEvent(t);

    // A STATE-only edit on the clone: no structural divergence, so the
    // update_item promotion has nothing to patch onto the template.
    const clone = await cloneOf(t, eventId, templateItemId);
    await as.mutation(api.items.setStatus, { itemId: clone._id, status: "done" });

    const versionBefore = await templateVersion(t, eventTypeId);
    const result = await as.mutation(api.templateSync.promoteFromEvent, {
      eventId,
      promotions: [{ kind: "update_item", eventItemId: clone._id }],
    });

    // Nothing was written → nothing applied, and NO version bump.
    expect(result.applied).toEqual([]);
    expect(await templateVersion(t, eventTypeId)).toBe(versionBefore);
  });

  test("add_module + column promotions copy workstreams and column defs to the template", async () => {
    const t = newT();
    const { as, eventId, eventTypeId } = await setupTemplateAndEvent(t);

    await as.mutation(api.modules.createCustomForEvent, {
      eventId,
      label: "Load In",
    });
    const statusCol = await run(t, async (ctx) => {
      const cols = await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "planning_doc"),
        )
        .collect();
      return cols.find((c) => c.key === "status")!;
    });
    await as.mutation(api.columns.updateEventColumn, {
      columnId: statusCol._id,
      options: [
        ...(statusCol.options ?? []),
        { value: "blocked", label: "Blocked", color: "red" },
      ],
    });

    await as.mutation(api.templateSync.promoteFromEvent, {
      eventId,
      promotions: [
        { kind: "add_module", moduleKey: "load_in" },
        { kind: "column", module: "planning_doc", key: "status" },
      ],
    });

    const { templateModules, templateColumns } = await run(t, async (ctx) => ({
      templateModules: await ctx.db
        .query("templateModules")
        .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
        .collect(),
      templateColumns: await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId))
        .collect(),
    }));
    expect(templateModules).toHaveLength(1);
    expect(templateModules[0]).toMatchObject({
      key: "load_in",
      label: "Load In",
      isActive: true,
    });
    // The new workstream brought its column set along…
    expect(
      templateColumns.filter((c) => c.module === "load_in").length,
    ).toBeGreaterThan(0);
    // …and the diverged planning_doc status options landed on the template.
    const promotedStatus = templateColumns.find(
      (c) => c.module === "planning_doc" && c.key === "status",
    );
    expect(promotedStatus!.options?.map((o) => o.value)).toContain("blocked");

    const diff = await as.query(api.templateSync.diffEventAgainstTemplate, {
      eventId,
    });
    expect(diff.modules).toEqual([]);
    expect(diff.columns).toEqual([]);
  });
});
