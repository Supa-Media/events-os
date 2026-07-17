/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The ad-hoc "Blank event" creation path — fixes the live blocker where the
 * New Event screen's Create button stayed disabled (`!selectedId`) forever
 * unless a real template was picked, with no way to plan a one-off event
 * on the fly (owner spec: "I shouldn't need [a template] for an event I'm
 * planning on the fly").
 *
 * `events.createFromTemplate`'s `eventTypeId` is now optional; omitting it
 * resolves (get-or-creates, idempotently) the chapter's "Blank event"
 * template via `getOrCreateBlankTemplate` — a real `eventTypes` row with zero
 * roles/items/columns/modules, so the SAME templating engine
 * (`instantiateEvent`) that powers every named template also powers the
 * ad-hoc path; the blank template's emptiness is what makes the clone a
 * no-op. Money-attribution (#202) plumbing is untouched — it operates on
 * `eventType.chapterId` regardless of which template resolved it.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantFinanceRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: scope === "central" ? "central" : s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

async function eventBudget(s: ChapterSetup, eventId: Id<"events">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
      .first(),
  );
}

describe("events.createFromTemplate — ad-hoc Blank event (no eventTypeId)", () => {
  test("creates an event with zero cloned roles/items — the 'no pre-filled tasks or roles' contract", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Pop-up Prayer Night",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(event?.name).toBe("Pop-up Prayer Night");
    expect(event?.chapterId).toBe(s.chapterId);

    const items = await run(s.t, (ctx) =>
      ctx.db.query("eventItems").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect(),
    );
    expect(items).toHaveLength(0);
    const roles = await run(s.t, (ctx) =>
      ctx.db.query("eventRoles").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect(),
    );
    expect(roles).toHaveLength(0);
    const columns = await run(s.t, (ctx) =>
      ctx.db.query("eventColumns").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect(),
    );
    expect(columns).toHaveLength(0);
  });

  test("get-or-creates ONE blank template per chapter — idempotent across repeated ad-hoc creations", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);

    const first = (await s.as.mutation(api.events.createFromTemplate, {
      name: "First ad-hoc",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;
    const second = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Second ad-hoc",
      eventDate: tsInMonth(2026, 9),
    })) as Id<"events">;

    const firstEvent = await run(s.t, (ctx) => ctx.db.get(first));
    const secondEvent = await run(s.t, (ctx) => ctx.db.get(second));
    expect(firstEvent?.eventTypeId).toBe(secondEvent?.eventTypeId);

    const blankTemplates = await run(s.t, (ctx) =>
      ctx.db
        .query("eventTypes")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(blankTemplates.filter((t) => t.isBlank === true)).toHaveLength(1);
  });

  test("is hidden from templates.list (never surfaces as a manageable template)", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    await s.as.mutation(api.events.createFromTemplate, {
      name: "Ad-hoc",
      eventDate: tsInMonth(2026, 8),
    });

    const list = await s.as.query(api.templates.list, {});
    expect(list.find((t) => t.name === "Blank event")).toBeUndefined();
  });

  test("the blank template can't be edited or archived (BLANK_TEMPLATE guard, mirrors PLATFORM_TEMPLATE)", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Ad-hoc",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;
    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    const blankTemplateId = event!.eventTypeId as Id<"eventTypes">;

    await expect(
      s.as.mutation(api.templates.update, {
        eventTypeId: blankTemplateId,
        name: "Renamed",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.templates.archive, { eventTypeId: blankTemplateId }),
    ).rejects.toThrow(ConvexError);
  });

  test("budget/scope plumbing (#202) works identically for a blank event: central-seat creator defaults to Central", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Central ad-hoc",
      eventDate: tsInMonth(2026, 8),
      budget: 500,
    })) as Id<"events">;

    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(event?.chapterId).toBe(s.chapterId); // event ROW stays home
    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe("central");

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.scope).toBe("central");
  });

  test("budget/scope plumbing (#202) works identically for a blank event: explicit chapter override", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "bookkeeper", "central");

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Chapter-attributed ad-hoc",
      eventDate: tsInMonth(2026, 8),
      budget: 250,
      scope: "chapter",
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe(s.chapterId);
    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.scope).toBe(s.chapterId);
  });

  test("a chapter-only creator's blank event defaults to their own chapter (unchanged default)", async () => {
    const s = await setupChapter(newT());
    const personId = await seedSelfPerson(s);
    await grantFinanceRole(s, personId, "manager", "chapter");

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Local ad-hoc",
      eventDate: tsInMonth(2026, 8),
      budget: 100,
    })) as Id<"events">;

    const budget = await eventBudget(s, eventId);
    expect(budget?.chapterId).toBe(s.chapterId);
  });
});
