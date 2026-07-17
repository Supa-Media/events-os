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

/**
 * Content-mutation guard — closes a gap an adversarial review caught: the
 * original fix only blocked `templates.update`/`templates.archive` from
 * touching the Blank (or a platform) template. The actual per-row CONTENT
 * mutations (add/edit/delete/reorder a role, column, item, module, or
 * placeholder-crew row) went through `requireEventType` alone, which only
 * checks chapter ownership — NOT the `isPlatform`/`isBlank` invariant. A
 * direct API call (never offered by the UI, but not stopped by the mutation
 * either) could permanently pollute the "must stay empty" Blank template,
 * breaking the "no pre-filled tasks or roles" contract for every future
 * ad-hoc event in the chapter.
 *
 * Fix: `lib/context.ts` gained `assertTemplateManaged` (the guard predicate,
 * extracted from `templates.ts`'s former local `requireUserManaged` — same
 * isPlatform + isBlank checks, now shared) and `requireManagedEventType`
 * (`requireEventType` + the guard, in one call). Every template-CONTENT
 * write across roles.ts / columns.ts / items.ts / modules.ts /
 * templatePeople.ts now calls one of the two before writing. This also
 * closes the pre-existing `isPlatform` gap on every one of these endpoints
 * (they previously let a direct call edit the Academy's platform templates
 * too) — one shared helper fixed both invariants at every entry point.
 */
describe("template-content mutations reject the Blank (and platform) template", () => {
  async function blankTemplateId(s: ChapterSetup): Promise<Id<"eventTypes">> {
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Ad-hoc",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;
    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    return event!.eventTypeId as Id<"eventTypes">;
  }

  test("roles.createForTemplate rejects", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    await expect(
      s.as.mutation(api.roles.createForTemplate, {
        eventTypeId: blankId,
        label: "Sneaky Role",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("roles.updateTemplateRole / deleteTemplateRole reject a row planted directly on the blank template", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    // Bypass the (now-guarded) mutation to plant a row directly, the way a
    // pre-fix bug — or any other future write path — could have left one.
    const roleId = await run(s.t, (ctx) =>
      ctx.db.insert("templateRoles", {
        eventTypeId: blankId,
        key: "planted",
        label: "Planted",
        order: 0,
        isArchived: false,
      }),
    );
    await expect(
      s.as.mutation(api.roles.updateTemplateRole, { roleId, label: "Renamed" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.roles.deleteTemplateRole, { roleId }),
    ).rejects.toThrow(ConvexError);
  });

  test("roles.reorderTemplateRoles skips (throws on) a row belonging to the blank template", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    const roleId = await run(s.t, (ctx) =>
      ctx.db.insert("templateRoles", {
        eventTypeId: blankId,
        key: "planted",
        label: "Planted",
        order: 0,
        isArchived: false,
      }),
    );
    await expect(
      s.as.mutation(api.roles.reorderTemplateRoles, { orderedIds: [roleId] }),
    ).rejects.toThrow(ConvexError);
  });

  test("columns.addColumn rejects", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    await expect(
      s.as.mutation(api.columns.addColumn, {
        eventTypeId: blankId,
        module: "planning_doc",
        label: "Sneaky Column",
        type: "text",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("items.addTemplateItem rejects", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    await expect(
      s.as.mutation(api.items.addTemplateItem, {
        eventTypeId: blankId,
        module: "planning_doc",
        title: "Sneaky Item",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("modules.createCustomForTemplate rejects", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    await expect(
      s.as.mutation(api.modules.createCustomForTemplate, {
        eventTypeId: blankId,
        label: "Sneaky Module",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("modules.toggleCoreForTemplate rejects", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    await expect(
      s.as.mutation(api.modules.toggleCoreForTemplate, {
        eventTypeId: blankId,
        key: "planning_doc",
        enabled: false,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("templatePeople.create rejects", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const blankId = await blankTemplateId(s);
    await expect(
      s.as.mutation(api.templatePeople.create, {
        eventTypeId: blankId,
        name: "Sneaky Volunteer",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the same guard also closes the pre-existing isPlatform gap on every one of these endpoints", async () => {
    const s = await setupChapter(newT());
    const userId = s.userId;
    const platformId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Academy Platform Template",
        slug: "academy-platform",
        isPlatform: true,
        version: 1,
        isArchived: false,
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.roles.createForTemplate, {
        eventTypeId: platformId,
        label: "Sneaky Role",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.columns.addColumn, {
        eventTypeId: platformId,
        module: "planning_doc",
        label: "Sneaky Column",
        type: "text",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.items.addTemplateItem, {
        eventTypeId: platformId,
        module: "planning_doc",
        title: "Sneaky Item",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.modules.createCustomForTemplate, {
        eventTypeId: platformId,
        label: "Sneaky Module",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.templatePeople.create, {
        eventTypeId: platformId,
        name: "Sneaky Volunteer",
      }),
    ).rejects.toThrow(ConvexError);
  });
});

/**
 * Readiness rings — a second adversarial-review gap: a fresh blank event left
 * all 5 ready-gated core modules (comms, permits, run_of_show,
 * volunteer_expectations, supplies) ACTIVE with zero items. Two independent
 * mechanisms in `phaseReadinessBundle` (apps/convex/lib/readiness.ts) then
 * each manufactured a false "0%, not ready yet" instead of "—" (nothing to
 * measure) — see PHASE_KEYS' doc comment in @events-os/shared: "A phase with
 * no items anywhere is null (rendered "—")":
 *
 *  1. Module "ready" gates (MODULE_READY_PHASE) count as a measurable
 *     pre-plan/planning unit whenever their module is ACTIVE — regardless of
 *     item count. That's INTENTIONAL for a template someone deliberately
 *     configured (readiness.test.ts's supplies fixture explicitly marks the
 *     gate ready to neutralize it, proving the dilution is by design) — but
 *     wrong for the Blank template, where nothing was deliberately
 *     configured. Fix: `getOrCreateBlankTemplate` now disables exactly the
 *     gated core modules by default (`BLANK_TEMPLATE_DISABLED_CORE_MODULES`);
 *     they're one "+Area" tap away the moment a workstream genuinely applies.
 *  2. Separately, every ACTIVE module with a `defaultOwnerRoleKey` (core
 *     modules always have one) counted as a pre-plan "assign this module's
 *     owner role" unit — even when the event has NO role at that key to
 *     assign (a blank event clones zero `eventRoles`). An unmeetable check is
 *     not a "0%, please do this" debt, it's "—, nothing to measure until a
 *     role exists" — a general correctness fix (`lib/readiness.ts`'s
 *     `ownerTotal` loop now skips a module whose owner key has no matching
 *     `eventRoles` row), not blank-specific, but the blank event's zero roles
 *     is what actually exercises it.
 *
 * Together: prePlan's only remaining sources (marked-cell check-offs, role-
 * assignment, gates) and planning's only remaining sources (item averages,
 * gates) are ALL empty for a fresh blank event → both null. dayOf/post were
 * already null (no gate maps to either, per MODULE_READY_PHASE).
 */
describe("readiness rings — blank events read — (null), not 0%", () => {
  test("a fresh blank event: all four phases are null (unmeasured)", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Fresh ad-hoc",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const detail = await s.as.query(api.events.get, { eventId });
    expect(detail?.phases.prePlan).toBeNull();
    expect(detail?.phases.planning).toBeNull();
    expect(detail?.phases.dayOf).toBeNull();
    expect(detail?.phases.post).toBeNull();
  });

  test("the blank template disables exactly the 5 ready-gated core modules; Tasks + Debrief stay active", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      name: "Fresh ad-hoc",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;
    const event = await run(s.t, (ctx) => ctx.db.get(eventId));
    const disabled = new Set(event?.disabledCoreModules ?? []);
    for (const key of [
      "comms",
      "permits",
      "run_of_show",
      "volunteer_expectations",
      "supplies",
    ]) {
      expect(disabled.has(key)).toBe(true);
    }
    expect(disabled.has("planning_doc")).toBe(false);
    expect(disabled.has("retro")).toBe(false);
  });

  test("a NAMED template's event is unchanged: still reads 0% (not null) with zero items — the gate/owner checks are real work there", async () => {
    const s = await setupChapter(newT());
    await seedSelfPerson(s);
    const eventTypeId = (await s.as.mutation(api.eventTypes.create, {
      name: "Real Template",
    })) as Id<"eventTypes">;
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Real event, no items yet",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const detail = await s.as.query(api.events.get, { eventId });
    // Every core module is active by default and DEFAULT_ROLES seeded roles
    // matching every module's owner key — so both mechanisms are REAL,
    // measurable, unmet work here, unlike the blank template.
    expect(detail?.phases.prePlan).toBe(0);
    expect(detail?.phases.planning).toBe(0);
  });
});
