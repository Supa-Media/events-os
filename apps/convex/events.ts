/**
 * Events — dated instances of an event type.
 *
 * The core object the app revolves around. Created from a template by cloning
 * its columns + items as snapshots (so later template edits never disrupt an
 * in-flight event). Day-offset modules back-calculate every item's due date from
 * the single event date; moving the date shifts the whole timeline.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  computeDueDate,
  computeReadiness,
  isCompleteStatus,
  itemScore,
  itemPhase,
  currentPhase,
  DAY_MS,
  DAY_OFFSET_MODULES,
  MODULE_LABELS,
  MODULE_READY_PHASE,
  type ModuleKey,
  type PhaseKey,
  type PhaseScores,
  type SelectOption,
} from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import {
  instantiateEvent,
  eventActiveModules,
  getPersonForUser,
} from "./lib/templates";
import { phaseReadiness } from "./lib/readiness";
import { paidTotalForEvent } from "./engagements";

const statusUnion = v.union(
  v.literal("planning"),
  v.literal("ready"),
  v.literal("completed"),
  v.literal("cancelled"),
);

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/**
 * Per-event readiness off the planning-doc module: complete items / total,
 * using that event's planning-doc status column to decide "complete".
 */
async function eventReadiness(ctx: any, eventId: Id<"events">) {
  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", "planning_doc"),
    )
    .collect();
  const statusCol = await ctx.db
    .query("eventColumns")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", "planning_doc"),
    )
    .filter((q: any) => q.eq(q.field("key"), "status"))
    .first();
  const opts = statusCol?.options;
  const total = items.length;
  const done = items.filter((it: any) => isCompleteStatus(opts, it.status)).length;
  return { total, done, readiness: computeReadiness(total, done) };
}

/**
 * The current phase's score as a 0–100 integer (or null when that phase has no
 * items to measure), for pipeline cards. "Current" is by date — see
 * `currentPhase`. Returns the label too so the card can show "Planning · 60%".
 */
function currentPhasePct(
  phases: PhaseScores,
  eventDate: number,
  now: number,
): { phase: string; pct: number | null } {
  const phase = currentPhase(eventDate, now);
  const score = phases[phase];
  return { phase, pct: score == null ? null : Math.round(score * 100) };
}

/**
 * THE TEMPLATING ENGINE. Snapshot a template into a live event: clone its
 * columns onto the event, then clone its items (back-calculating due dates for
 * day-offset modules). Supplies items keep their template's acquisition status,
 * which IS the "what do we still need" reset; tasks/comms start at their status
 * column's first option.
 */
export const createFromTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.string(),
    eventDate: v.number(),
    location: v.optional(v.string()),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const eventType = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, eventType, "Event type");

    return await instantiateEvent(ctx, {
      eventType,
      chapterId: chapterId as Id<"chapters">,
      userId: userId as Id<"users">,
      name: args.name,
      eventDate: args.eventDate,
      location: args.location,
      budget: args.budget,
    });
  },
});

/** List chapter events (default upcoming) with readiness + task counts. */
export const list = query({
  args: {
    scope: v.optional(v.union(v.literal("upcoming"), v.literal("all"))),
  },
  handler: async (ctx, { scope }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const now = Date.now();
    const all = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const filtered =
      scope === "all"
        ? all
        : all.filter(
            (e: any) => e.eventDate >= now && e.status !== "cancelled",
          );

    const enriched = await Promise.all(
      filtered.map(async (event: any) => {
        const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
        const r = await eventReadiness(ctx, event._id);
        return {
          ...event,
          eventTypeName: eventType?.name ?? "Unknown",
          readiness: r.readiness,
          taskTotal: r.total,
          taskDone: r.done,
        };
      }),
    );
    return enriched.sort((a, b) => a.eventDate - b.eventDate);
  },
});

/** Fetch a single event plus its event-type name + readiness. */
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
    const r = await eventReadiness(ctx, eventId);
    const phases = await phaseReadiness(ctx, event);

    // Roll up every item's `cost` field against the event budget.
    const allItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const itemCost = allItems.reduce((sum: number, it: any) => {
      const c = Number(it.fields?.cost);
      return sum + (Number.isFinite(c) ? c : 0);
    }, 0);
    // Paid vendors count against the budget too.
    const paidVendorCost = await paidTotalForEvent(ctx, eventId);
    const budgetSpent = itemCost + paidVendorCost;
    const budget = event.budget ?? 0;
    const budgetPct = budget > 0 ? Math.round((budgetSpent / budget) * 100) : 0;

    // Resolve the accountable owner (a person) for display.
    let owner: { _id: Id<"people">; name: string } | null = null;
    if (event.ownerPersonId) {
      const person = await ctx.db.get(event.ownerPersonId as Id<"people">);
      if (person) owner = { _id: person._id, name: person.name };
    }

    return {
      event,
      eventTypeName: eventType?.name ?? "Unknown",
      // Resolved active modules (core + custom) from the EVENT's own deltas.
      modules: await eventActiveModules(ctx, event),
      moduleReadiness: event.moduleReadiness ?? [],
      owner,
      readiness: r.readiness,
      // Four phase scores (0..1 or null), the new headline readiness signal.
      phases,
      taskTotal: r.total,
      taskDone: r.done,
      budgetSpent,
      budgetPct,
    };
  },
});

/**
 * Per-module rollup for the event overview: for each module the event type has
 * switched on, how many items it has, how many are complete (via that module's
 * status column, when it has one), and the next upcoming due date among the
 * incomplete ones. Powers the overview's per-module cards so the accountable
 * owner can scan progress without opening every tab. Read-only.
 */
export const moduleSummaries = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    // Grid modules only — site_map (and any non-grid surface) has no items.
    const resolved = await eventActiveModules(ctx, event);
    const modules = resolved
      .filter((m) => m.surface === "grid")
      .map((m) => m.key);
    const now = Date.now();

    return await Promise.all(
      modules.map(async (module) => {
        const items = await ctx.db
          .query("eventItems")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", eventId).eq("module", module),
          )
          .collect();
        const statusCol = await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", eventId).eq("module", module),
          )
          .filter((q: any) => q.eq(q.field("key"), "status"))
          .first();
        const opts = statusCol?.options;
        const hasStatus = !!statusCol;
        const total = items.length;
        const done = hasStatus
          ? items.filter((it: any) => isCompleteStatus(opts, it.status)).length
          : 0;
        // Next upcoming due date among still-incomplete, dated items.
        const nextDueDate = items
          .filter(
            (it: any) =>
              it.dueDate != null &&
              it.dueDate >= now &&
              (!hasStatus || !isCompleteStatus(opts, it.status)),
          )
          .map((it: any) => it.dueDate as number)
          .sort((a: number, b: number) => a - b)[0] ?? null;
        return {
          module,
          total,
          done,
          hasStatus,
          readiness: computeReadiness(total, done),
          nextDueDate,
        };
      }),
    );
  },
});

/**
 * The current user's owned work on an event — drives the Overview "Me view"
 * filter. Returns the module keys whose resolved owner person IS the caller
 * (ownerRoleKey → eventRoles role → roleAssignments person), plus a flat list of
 * the caller's tasks across all modules. A task is "yours" when its
 * `ownerPersonId` is you, OR it has no owner and its `roleId`'s assignment
 * resolves to you. If the caller has no roster person in this chapter (so they
 * can't own anything), both arrays come back empty.
 */
export const myWork = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) {
      return { ownedModuleKeys: [], tasks: [], myTeams: [], teamItemIds: [] };
    }

    const me = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    if (!me) return { ownedModuleKeys: [], tasks: [], myTeams: [], teamItemIds: [] };

    // Event roles + their assignments, so we can resolve a role → its person.
    const eventRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    // roleId (eventRoles id) → assigned personId.
    const personByRoleId = new Map<string, Id<"people">>(
      assignments.map((a: any) => [String(a.roleId), a.personId as Id<"people">]),
    );
    // role KEY → roleId, to resolve a module's ownerRoleKey to a role.
    const roleIdByKey = new Map<string, string>(
      eventRoles.map((r: any) => [r.key as string, String(r._id)]),
    );

    // Modules whose resolved owner person is the caller.
    const resolved = await eventActiveModules(ctx, event);
    const ownedModuleKeys: string[] = [];
    // Custom-module labels (core labels come from MODULE_LABELS).
    const labelByKey = new Map<string, string>(
      resolved.map((m) => [m.key, m.label]),
    );
    for (const m of resolved) {
      const roleId = m.ownerRoleKey
        ? roleIdByKey.get(m.ownerRoleKey)
        : undefined;
      if (!roleId) continue;
      const personId = personByRoleId.get(roleId);
      if (personId && String(personId) === String(me)) {
        ownedModuleKeys.push(m.key);
      }
    }

    // Tasks: yours by direct owner, or by role assignment when unowned.
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const tasks = items
      .filter((it: any) => {
        if (it.ownerPersonId) return String(it.ownerPersonId) === String(me);
        if (it.roleId) {
          const personId = personByRoleId.get(String(it.roleId));
          return personId != null && String(personId) === String(me);
        }
        return false;
      })
      .map((it: any) => ({
        itemId: it._id as Id<"eventItems">,
        module: it.module as string,
        moduleLabel:
          MODULE_LABELS[it.module as ModuleKey] ??
          labelByKey.get(it.module) ??
          it.module,
        title: it.title as string,
        dueDate: (it.dueDate ?? null) as number | null,
        status: (it.status ?? null) as string | null,
      }));

    // My team(s) on this event (Crew & Expectations is team work — I should see
    // my team's tasks even if I don't own them). Engagements carry `teams`.
    const engagements = await ctx.db
      .query("engagements")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const myTeamSet = new Set<string>();
    for (const e of engagements) {
      if (String(e.personId) !== String(me)) continue;
      for (const t of (e.teams ?? []) as string[]) myTeamSet.add(t);
    }
    const myTeams = [...myTeamSet];
    // volunteer_expectations items tagged with one of my teams.
    const teamItemIds = items
      .filter(
        (it: any) =>
          it.module === "volunteer_expectations" &&
          typeof it.fields?.team === "string" &&
          myTeamSet.has(it.fields.team),
      )
      .map((it: any) => it._id as Id<"eventItems">);

    return { ownedModuleKeys, tasks, myTeams, teamItemIds };
  },
});

/**
 * "What's next" — the CURRENT USER's focused action list on this event.
 *
 * Two groups instead of dumping every incomplete item by phase:
 *
 *   yours      — incomplete things the caller OWNS, always shown (no date gate).
 *                Item owner = `ownerPersonId === me`, or the item's `roleId`
 *                resolves to me. PLUS, only when the caller is the EVENT owner,
 *                the setup lines (assign roles / module owners). PLUS unchecked
 *                pre-plan cells on items the caller owns.
 *   overseeing — incomplete things the caller OVERSEES but doesn't own at the row
 *                level, shown ONLY when AT RISK (due soon or overdue). "Oversees"
 *                = the caller owns the item's module (via its owner role) OR the
 *                caller is the event owner.
 *
 * Every incomplete grid item gets an EFFECTIVE DUE of `item.dueDate ?? eventDate`
 * (day-of/undated items fall back to the event date). Risk is computed from now:
 *   overdue — effectiveDue is before the start of today.
 *   soon    — not overdue AND effectiveDue is on/before the end of tomorrow.
 *   null    — otherwise.
 *
 * A `TodoAction.tab` is the event tab to jump to (a module key, or "crew" for the
 * volunteer_expectations module); omitted for the role/owner setup lines.
 */
export const todos = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    type Risk = "overdue" | "soon" | null;
    type TodoAction = {
      id: string;
      label: string;
      tab?: string;
      risk: Risk;
      due?: number | null;
      phase: PhaseKey;
      // For Overseeing rows: who's actually responsible (the item/module owner).
      owner?: string;
    };
    const empty: { yours: TodoAction[]; overseeing: TodoAction[] } = {
      yours: [],
      overseeing: [],
    };
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return empty;

    const me = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    if (!me) return empty;
    const iAmEventOwner =
      !!event.ownerPersonId && String(event.ownerPersonId) === String(me);

    // ── Risk: effective due (item.dueDate ?? eventDate) vs today/tomorrow. ──
    const now = Date.now();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfTomorrow = new Date(now);
    endOfTomorrow.setHours(23, 59, 59, 999);
    endOfTomorrow.setTime(endOfTomorrow.getTime() + DAY_MS);
    const computeRisk = (effectiveDue: number): Risk => {
      if (effectiveDue < startOfToday.getTime()) return "overdue";
      if (effectiveDue <= endOfTomorrow.getTime()) return "soon";
      return null;
    };
    const riskRank = (r: Risk) => (r === "overdue" ? 0 : r === "soon" ? 1 : 2);

    const tabForModule = (k: string) =>
      k === "volunteer_expectations" ? "crew" : k;

    // Grid modules only — non-grid surfaces (site_map) have no status'd items.
    const resolved = await eventActiveModules(ctx, event);
    const gridModules = resolved.filter((m) => m.surface === "grid");
    const labelByKey = new Map(resolved.map((m) => [m.key, m.label]));
    const moduleLabel = (k: string) =>
      MODULE_LABELS[k as ModuleKey] ?? labelByKey.get(k) ?? k;

    // ── Roles + assignments: resolve role → person and module → owner person. ──
    const eventRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const assignedRoleIds = new Set(assignments.map((a: any) => String(a.roleId)));
    const roleByKey = new Map(eventRoles.map((r: any) => [r.key, r]));
    // roleId (eventRoles id) → assigned personId.
    const personByRoleId = new Map<string, Id<"people">>(
      assignments.map((a: any) => [String(a.roleId), a.personId as Id<"people">]),
    );

    // Cached personId → display name (for "Overseeing" owner labels).
    const nameByPerson = new Map<string, string>();
    const personName = async (
      pid?: Id<"people"> | null,
    ): Promise<string | undefined> => {
      if (!pid) return undefined;
      const key = String(pid);
      if (nameByPerson.has(key)) return nameByPerson.get(key);
      const p = await ctx.db.get(pid);
      const name = (p?.name as string | undefined) ?? undefined;
      if (name) nameByPerson.set(key, name);
      return name;
    };

    // Modules I own (my person resolves to the module's owner role), plus the
    // person who owns each module (for "Overseeing" owner labels).
    const iOwnModule = new Map<string, boolean>();
    const modulePerson = new Map<string, Id<"people"> | undefined>();
    for (const m of resolved) {
      const role: any = m.ownerRoleKey ? roleByKey.get(m.ownerRoleKey) : null;
      const personId = role ? personByRoleId.get(String(role._id)) : undefined;
      iOwnModule.set(m.key, personId != null && String(personId) === String(me));
      modulePerson.set(m.key, personId);
    }

    const yours: TodoAction[] = [];
    const overseeing: TodoAction[] = [];

    // ── Setup lines: caller-is-event-owner only, front of `yours`. ──
    if (iAmEventOwner) {
      const totalRoles = eventRoles.length;
      const assignedRoles = eventRoles.filter((r: any) =>
        assignedRoleIds.has(String(r._id)),
      ).length;
      if (totalRoles > 0 && assignedRoles < totalRoles) {
        yours.push({
          id: "roles",
          label: "Assign roles (" + assignedRoles + "/" + totalRoles + ")",
          risk: null,
          phase: "prePlan",
        });
      }
      let ownerTotal = 0;
      let ownerDone = 0;
      for (const m of resolved) {
        if (!m.ownerRoleKey) continue;
        ownerTotal += 1;
        const role: any = roleByKey.get(m.ownerRoleKey);
        if (role && assignedRoleIds.has(String(role._id))) ownerDone += 1;
      }
      if (ownerTotal > 0 && ownerDone < ownerTotal) {
        yours.push({
          id: "owners",
          label: "Assign module owners (" + ownerDone + "/" + ownerTotal + ")",
          risk: null,
          phase: "prePlan",
        });
      }
    }

    // ── Per grid module: incomplete items + the caller's pre-plan cells. ──
    // `mi` tracks module order; item `order` keeps rows stable within a module.
    for (let mi = 0; mi < gridModules.length; mi++) {
      const m = gridModules[mi];
      const iOwnThisModule = iOwnModule.get(m.key) ?? false;
      const items = (
        await ctx.db
          .query("eventItems")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", eventId).eq("module", m.key),
          )
          .collect()
      ).sort((a: any, b: any) => a.order - b.order);

      const columns = await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", m.key),
        )
        .collect();
      const colLabelByKey = new Map<string, string>(
        columns.map((c: any) => [c.key as string, c.label as string]),
      );
      const statusCol = columns.find((c: any) => c.key === "status");
      const statusOptions = statusCol?.options as SelectOption[] | undefined;

      for (let ii = 0; ii < items.length; ii++) {
        const it = items[ii];
        // Skip complete items (in-progress 0.5 still counts as outstanding).
        if (itemScore(statusOptions, it.status) >= 1) continue;

        const title = (it.title as string) || "Untitled";
        // Am I the row-level owner of this item?
        const iOwnItem = it.ownerPersonId
          ? String(it.ownerPersonId) === String(me)
          : it.roleId
            ? String(personByRoleId.get(String(it.roleId)) ?? "") === String(me)
            : false;

        // Effective due → risk. Day-of/undated items fall back to event date.
        const effectiveDue = (it.dueDate ?? event.eventDate) as number;
        const risk = computeRisk(effectiveDue);
        const phase = itemPhase({
          module: m.key,
          offsetDays: it.offsetDays,
          offsetMinutes: it.offsetMinutes,
        });

        // Sort key keeps module order then item order stable within a risk tier.
        const sortKey = mi * 100000 + ii;

        if (iOwnItem) {
          // Mine — always shown, regardless of risk.
          yours.push({
            id: it._id as string,
            label: moduleLabel(m.key) + ": " + title,
            tab: tabForModule(m.key),
            risk,
            due: effectiveDue,
            phase,
            // @ts-expect-error transient sort field, stripped before return
            _sort: sortKey,
          });

          // Pre-plan cells on items I own → "Fill out <col> for <title>".
          const marked = (it.prePlanColumns ?? []) as string[];
          if (marked.length > 0) {
            const checked = new Set((it.prePlanChecked ?? []) as string[]);
            for (const colKey of marked) {
              if (checked.has(colKey)) continue;
              const columnLabel = colLabelByKey.get(colKey) ?? colKey;
              yours.push({
                id: it._id + ":" + colKey,
                label: 'Fill out ' + columnLabel + ' for "' + title + '"',
                tab: tabForModule(m.key),
                risk: null,
                phase: "prePlan",
                // @ts-expect-error transient sort field, stripped before return
                _sort: sortKey,
              });
            }
          }
        } else if ((iOwnThisModule || iAmEventOwner) && risk !== null) {
          // Not mine, but I oversee it — only surface when at risk. Show whoever
          // is responsible: the row owner, else the item's role assignee, else
          // the module owner.
          const ownerPid =
            (it.ownerPersonId as Id<"people"> | undefined) ??
            (it.roleId ? personByRoleId.get(String(it.roleId)) : undefined) ??
            modulePerson.get(m.key);
          overseeing.push({
            id: it._id as string,
            label: moduleLabel(m.key) + ": " + title,
            tab: tabForModule(m.key),
            risk,
            due: effectiveDue,
            phase,
            owner: await personName(ownerPid),
            // @ts-expect-error transient sort field, stripped before return
            _sort: sortKey,
          });
        }
        // else: caller neither owns nor oversees → skip.
      }
    }

    // ── "Mark module as ready" gates: one per active module that has a ready
    // gate and isn't ready yet. Phase per the product spec: comms/permits are
    // pre-plan; run_of_show/site_map/crew(volunteer_expectations)/supplies are
    // planning. planning_doc and retro have no ready gate. The caller sees it in
    // `yours` if they own the module, else `overseeing` (event owner) when at
    // risk — same ownership rule as items. ──
    const readyByKey = new Map<string, boolean>(
      (event.moduleReadiness ?? []).map((r: any) => [
        r.key as string,
        r.ready as boolean,
      ]),
    );
    for (let mi = 0; mi < resolved.length; mi++) {
      const m = resolved[mi];
      const phase = MODULE_READY_PHASE[m.key];
      if (!phase) continue;
      if (readyByKey.get(m.key) === true) continue;

      const effectiveDue = event.eventDate as number;
      const risk = computeRisk(effectiveDue);
      const iOwnThisModule = iOwnModule.get(m.key) ?? false;
      // Ready gates sort after items within a tier (high base sort key).
      const sortKey = 10_000_000 + mi;
      const action = {
        id: "ready:" + m.key,
        label:
          "Review & update " +
          moduleLabel(m.key) +
          " — meet with team if needed, mark ready once solidified",
        tab: tabForModule(m.key),
        risk,
        due: effectiveDue,
        phase,
        _sort: sortKey,
      } as TodoAction & { _sort: number };

      if (iOwnThisModule) {
        yours.push(action);
      } else if (iAmEventOwner && risk !== null) {
        action.owner = await personName(modulePerson.get(m.key));
        overseeing.push(action);
      }
    }

    // Order each group: overdue → soon → rest, then stable by module/item order.
    // Setup lines (no `_sort`) sort to the front (sortKey -1) within their tier.
    const order = (list: TodoAction[]) =>
      list
        .map((a, idx) => ({ a, idx }))
        .sort((x, y) => {
          const rr = riskRank(x.a.risk) - riskRank(y.a.risk);
          if (rr !== 0) return rr;
          const sx = (x.a as any)._sort ?? -1;
          const sy = (y.a as any)._sort ?? -1;
          if (sx !== sy) return sx - sy;
          return x.idx - y.idx;
        })
        .map(({ a }) => {
          const { _sort, ...rest } = a as any;
          return rest as TodoAction;
        });

    return { yours: order(yours), overseeing: order(overseeing) };
  },
});

/**
 * PUBLIC, no-auth volunteer briefing for an event — reachable by share link.
 *
 * Intentionally public-by-link: it does NOT call requireChapterId/requireUserId,
 * so a logged-out caller can load it. It returns a sanitized, volunteer-facing
 * payload ONLY — teams, their expectations, and who's on each team. No payment,
 * vendor, or budget ($) information is ever included.
 */
export const publicCrew = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) return null;

    // Team options come from the volunteer_expectations "team" column.
    const teamCol = await ctx.db
      .query("eventColumns")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", eventId).eq("module", "volunteer_expectations"),
      )
      .filter((q: any) => q.eq(q.field("key"), "team"))
      .first();
    const teamOptions: { value: string; label: string; color?: string | null }[] =
      teamCol?.options ?? [];
    const knownTeams = new Set(teamOptions.map((o) => o.value));

    // Expectations = volunteer_expectations items, grouped by fields.team.
    const expectationItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", eventId).eq("module", "volunteer_expectations"),
      )
      .collect();
    const toExpectation = (it: any) => ({
      title: it.title ?? "",
      details:
        typeof it.fields?.details === "string" ? it.fields.details : null,
    });

    // People = volunteer engagements, person name resolved, grouped by team.
    const volunteers = await ctx.db
      .query("engagements")
      .withIndex("by_event_type", (q: any) =>
        q.eq("eventId", eventId).eq("type", "volunteer"),
      )
      .collect();
    const people = await Promise.all(
      volunteers.map(async (e: any) => {
        const person = await ctx.db.get(e.personId as Id<"people">);
        return {
          teams: Array.isArray(e.teams) ? (e.teams as string[]) : [],
          name: person?.name ?? "Unknown",
          callTime: e.callTime ?? null,
          status: e.status ?? null,
        };
      }),
    );

    const teams = teamOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
      color: opt.color ?? null,
      expectations: expectationItems
        .filter((it: any) => it.fields?.team === opt.value)
        .map(toExpectation),
      people: people
        .filter((p) => p.teams.includes(opt.value))
        .map(({ name, callTime, status }) => ({ name, callTime, status })),
    }));

    // Anything whose team isn't a known option → the unassigned bucket.
    const unassigned = {
      expectations: expectationItems
        .filter((it: any) => {
          const t = it.fields?.team;
          return typeof t !== "string" || !t || !knownTeams.has(t);
        })
        .map(toExpectation),
      people: people
        .filter((p) => !p.teams.some((t) => knownTeams.has(t)))
        .map(({ name, callTime, status }) => ({ name, callTime, status })),
    };

    return {
      name: event.name,
      eventDate: event.eventDate,
      location: event.location ?? null,
      teams,
      unassigned,
    };
  },
});

/** Move an event's date and re-derive every day-offset item's due date. */
export const reschedule = mutation({
  args: { eventId: v.id("events"), eventDate: v.number() },
  handler: async (ctx, { eventId, eventDate }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, { eventDate, updatedAt: Date.now() });
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) {
      if (isDayOffsetModule(it.module) && it.offsetDays !== undefined) {
        await ctx.db.patch(it._id, {
          dueDate: computeDueDate(eventDate, it.offsetDays),
        });
      }
    }
    return eventId;
  },
});

/** Edit an event's top-level fields (name, location, budget, owner). */
export const updateDetails = mutation({
  args: {
    eventId: v.id("events"),
    name: v.optional(v.string()),
    location: v.optional(v.union(v.string(), v.null())),
    budget: v.optional(v.union(v.number(), v.null())),
    ownerPersonId: v.optional(v.union(v.id("people"), v.null())),
  },
  handler: async (ctx, { eventId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    if (patch.ownerPersonId) {
      const person = await ctx.db.get(patch.ownerPersonId);
      await requireInChapter(ctx, chapterId, person, "Person");
    }
    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.location !== undefined) fields.location = patch.location ?? undefined;
    if (patch.budget !== undefined) fields.budget = patch.budget ?? undefined;
    if (patch.ownerPersonId !== undefined)
      fields.ownerPersonId = patch.ownerPersonId ?? undefined;
    await ctx.db.patch(eventId, fields);
    return eventId;
  },
});

/** Set an event's lifecycle status. */
export const setStatus = mutation({
  args: { eventId: v.id("events"), status: statusUnion },
  handler: async (ctx, { eventId, status }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, { status, updatedAt: Date.now() });
    return eventId;
  },
});

/** Delete an event and all its columns, items, and role assignments. */
export const remove = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");

    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) await ctx.db.delete(it._id);

    const cols = await ctx.db
      .query("eventColumns")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const c of cols) await ctx.db.delete(c._id);

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const a of assignments) await ctx.db.delete(a._id);

    const eventRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const r of eventRoles) await ctx.db.delete(r._id);

    const eventModules = await ctx.db
      .query("eventModules")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const m of eventModules) await ctx.db.delete(m._id);

    await ctx.db.delete(eventId);
    return eventId;
  },
});

/** Upcoming events with readiness + blocker count, for the pipeline dashboard. */
export const pipeline = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const now = Date.now();
    const all = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const upcoming = all.filter(
      (e: any) => e.eventDate >= now && e.status !== "cancelled",
    );

    const enriched = await Promise.all(
      upcoming.map(async (event: any) => {
        const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
        const items = await ctx.db
          .query("eventItems")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", event._id).eq("module", "planning_doc"),
          )
          .collect();
        const statusCol = await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", event._id).eq("module", "planning_doc"),
          )
          .filter((q: any) => q.eq(q.field("key"), "status"))
          .first();
        const opts = statusCol?.options;
        const total = items.length;
        const done = items.filter((it: any) =>
          isCompleteStatus(opts, it.status),
        ).length;
        const blockerCount = items.filter(
          (it: any) =>
            !isCompleteStatus(opts, it.status) &&
            it.dueDate !== undefined &&
            it.dueDate < now,
        ).length;
        // Phase readiness → the card's current-phase label + number.
        const phases = await phaseReadiness(ctx, event);
        const current = currentPhasePct(phases, event.eventDate, now);
        return {
          ...event,
          eventTypeName: eventType?.name ?? "Unknown",
          readiness: computeReadiness(total, done),
          phases,
          currentPhase: current.phase,
          currentPhasePct: current.pct,
          taskTotal: total,
          taskDone: done,
          blockerCount,
        };
      }),
    );
    return enriched.sort((a, b) => a.eventDate - b.eventDate);
  },
});

/** Mobile day-of view: event, run-of-show, role holders, and tasks. */
export const dayOf = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);

    const runOfShow = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", "run_of_show"),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);

    const eventRoles = (
      await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const roles = await Promise.all(
      eventRoles.map(async (role: any) => {
        const assignment = assignments.find((a: any) => a.roleId === role._id);
        const person = assignment ? await ctx.db.get(assignment.personId) : null;
        return {
          roleId: role._id as Id<"eventRoles">,
          roleLabel: role.label ?? "Unknown role",
          person: person ? { _id: person._id, name: person.name } : null,
        };
      }),
    );

    // Day-of view shows only what's imminent: tasks from T-2 onwards (and any
    // undated tasks). Earlier prep tasks (T-14, T-7…) are hidden here.
    const tasks = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", "planning_doc"),
        )
        .collect()
    )
      .filter((t: any) => t.offsetDays == null || t.offsetDays >= -2)
      .sort((a: any, b: any) => (a.dueDate ?? 0) - (b.dueDate ?? 0));

    return {
      event,
      eventTypeName: eventType?.name ?? "Unknown",
      runOfShow,
      roles,
      tasks,
    };
  },
});
