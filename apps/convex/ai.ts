/**
 * AI assistant spine — queries + mutations (NO "use node"; the network/LLM work
 * lives in `aiActions.ts`).
 *
 * This is the reusable backbone behind the in-app assistant:
 *   - `aiThreads` / `aiMessages` — a Notion-AI-style conversation per event;
 *     reasoning + tool calls stream in as rows so the panel renders reactively.
 *   - `aiRuns`    — one assistant turn (running / done / error / reverted).
 *   - `aiChanges` — a per-run log of every edit, so any turn is one-click revertible.
 *   - `aiUsage`   — token + dollar accounting for the rolling budget windows.
 *
 * Budgets are dollar caps over a rolling 30-day window, applied per user, per
 * chapter, and org-wide ("deployment = one org"). With free models spend is $0,
 * so caps never trip — the plumbing stays for the day we re-add paid models.
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  requireUserId,
  requireChapterId,
  getChapterIdOrNull,
  requireInChapter,
} from "./lib/context";
import { isSuperuser } from "./lib/superuser";
import {
  AI_BUDGETS,
  AI_BUDGET_WINDOW_MS,
  AI_MODELS,
  CORE_MODULES,
  DAY_MS,
  DEFAULT_AI_MODEL,
  DEFAULT_CUSTOM_COLUMNS,
  DEFAULT_COLUMNS,
  computeDueDate,
  DAY_OFFSET_MODULES,
  eventWindowFor,
  isCompleteStatus,
  isFreeModelSlug,
  isOverChatBudget,
  offsetDaysBetween,
  overBudgetScope,
  tNotation,
  type ModuleKey,
  type ModuleOverride,
  type SelectOption,
} from "@events-os/shared";
import { eventActiveModules } from "./lib/templates";
import { phaseReadiness, statusColumnFor } from "./lib/readiness";
import { toKey } from "./roles";

/** Round a USD amount to whole cents. */
function toCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

// ── Internal: context the action needs (reads ctx.db) ────────────────────────
/** The caller's userId + chapterId, resolved inside a query the action calls. */
export const myContext = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const chapterId = await requireChapterId(ctx);
    return {
      userId: userId as Id<"users">,
      chapterId: chapterId as Id<"chapters">,
    };
  },
});

/**
 * A compact snapshot of an event the agent reasons over: every item (with its
 * id, module, title, status, role, owner, cost, notes), plus the vocab it needs
 * to make valid edits (each module's column option-sets, the chapter's roles,
 * and the roster). Re-fetched every turn, so the agent always sees live state.
 */
export const eventContext = internalQuery({
  args: { eventId: v.id("events"), chapterId: v.id("chapters") },
  handler: async (ctx, { eventId, chapterId }) => {
    const event = await ctx.db.get(eventId);
    // TENANT BOUNDARY: this is an internal fn reachable from an action that
    // accepts an arbitrary eventId arg. We MUST confirm the event belongs to
    // the caller's chapter (threaded in from myContext) — otherwise any
    // authenticated user could read another chapter's event by passing its id.
    // Mirror docs.forAi: return null on missing OR cross-chapter.
    if (!event || event.chapterId !== chapterId) return null;

    const people = (
      await ctx.db
        .query("people")
        .withIndex("by_chapter", (q: any) => q.eq("chapterId", event.chapterId))
        .collect()
    ).map((p: any) => ({ id: p._id, name: p.name }));
    const personName = new Map(people.map((p) => [String(p.id), p.name]));

    // Roles come with the name of the person currently holding each (or null),
    // so the agent can see role coverage without a readiness call.
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const personByRoleId = new Map<string, string>(
      assignments.map((a: any) => [String(a.roleId), String(a.personId)]),
    );
    const roles = (
      await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    )
      .sort((a: any, b: any) => a.order - b.order)
      .map((r: any) => ({
        id: r._id,
        key: r.key,
        label: r.label,
        person:
          personName.get(personByRoleId.get(String(r._id)) ?? "") ?? null,
      }));

    // The event's resolved active modules (workstreams) — core + custom — with
    // each one's owner role and ready flag, so the agent can reason about (and
    // edit) workstream setup, not just items.
    const readyByKey = new Map<string, boolean>(
      (event.moduleReadiness ?? []).map((r: any) => [r.key, r.ready]),
    );
    const modules = (await eventActiveModules(ctx, event)).map((m: any) => ({
      key: m.key as string,
      label: m.label as string,
      surface: m.surface as string,
      ownerRoleKey: (m.ownerRoleKey ?? null) as string | null,
      ready: readyByKey.get(m.key) === true,
    }));

    const columns = await ctx.db
      .query("eventColumns")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    // Per-module: the select/status options agents may assign by value.
    const optionsByModule: Record<string, Record<string, string[]>> = {};
    for (const c of columns) {
      if (Array.isArray(c.options) && c.options.length) {
        (optionsByModule[c.module] ??= {})[c.key] = c.options.map(
          (o: any) => o.value,
        );
      }
    }

    const rawItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    const roleLabel = new Map(roles.map((r) => [String(r.id), r.label]));
    const items = rawItems
      .sort((a: any, b: any) => a.order - b.order)
      .map((it: any) => ({
        id: it._id,
        module: it.module,
        title: it.title,
        status: it.status ?? null,
        role: it.roleId ? (roleLabel.get(String(it.roleId)) ?? null) : null,
        offsetDays: it.offsetDays ?? null,
        source: it.fields?.source ?? null,
        container: it.fields?.container ?? null,
        cost: it.fields?.cost ?? null,
        notes: it.fields?.notes ?? null,
        hasPhoto: !!it.fields?.photo,
      }));

    return {
      event: {
        id: event._id,
        name: event.name,
        date: event.eventDate,
        budget: event.budget ?? null,
        status: event.status as string,
        location: event.location ?? null,
      },
      roles,
      people,
      modules,
      optionsByModule,
      items,
    };
  },
});

/** One item + which columns its module shows — for the per-row Autofill button. */
export const itemForAutofill = internalQuery({
  args: { itemId: v.id("eventItems"), chapterId: v.id("chapters") },
  handler: async (ctx, { itemId, chapterId }) => {
    const item = await ctx.db.get(itemId);
    // TENANT BOUNDARY: itemId is an arbitrary arg from an action. Confirm the
    // item is in the caller's chapter before returning anything about it —
    // otherwise Autofill could read/enrich another chapter's item. Return null
    // on missing OR cross-chapter (the action surfaces "Item not found").
    if (!item || item.chapterId !== chapterId) return null;
    const cols = await ctx.db
      .query("eventColumns")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", item.eventId).eq("module", item.module),
      )
      .collect();
    return {
      eventId: item.eventId as Id<"events">,
      title: item.title,
      module: item.module,
      fields: (item.fields ?? {}) as Record<string, any>,
      columnKeys: cols
        .filter((c: any) => c.isVisible)
        .map((c: any) => c.key as string),
    };
  },
});

// ── Internal: run lifecycle ──────────────────────────────────────────────────
export const startRun = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    userId: v.id("users"),
    feature: v.string(),
    eventId: v.optional(v.id("events")),
    threadId: v.optional(v.id("aiThreads")),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("aiRuns", {
      chapterId: args.chapterId,
      userId: args.userId,
      feature: args.feature,
      eventId: args.eventId,
      threadId: args.threadId,
      model: args.model,
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: Date.now(),
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("reverted"),
    ),
    itemsTouched: v.number(),
    costUsd: v.number(),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    await ctx.db.patch(runId, patch);
  },
});

export const logUsage = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    userId: v.id("users"),
    runId: v.optional(v.id("aiRuns")),
    threadId: v.optional(v.id("aiThreads")),
    feature: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedTokens: v.optional(v.number()),
    costUsd: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("aiUsage", { ...args, createdAt: Date.now() });
  },
});

// ── Internal: thread messages (the stream the panel renders) ─────────────────
/** Append a message to a thread (auto-incrementing order) and bump the thread. */
export const appendMessage = internalMutation({
  args: {
    threadId: v.id("aiThreads"),
    runId: v.optional(v.id("aiRuns")),
    kind: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("reasoning"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("error"),
    ),
    text: v.optional(v.string()),
    toolName: v.optional(v.string()),
    toolArgs: v.optional(v.any()),
    toolOk: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError({ code: "NOT_FOUND", message: "Thread gone." });
    const last = await ctx.db
      .query("aiMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", args.threadId))
      .order("desc")
      .first();
    const order = (last?.order ?? -1) + 1;
    const id = await ctx.db.insert("aiMessages", {
      threadId: args.threadId,
      chapterId: thread.chapterId,
      runId: args.runId,
      kind: args.kind,
      text: args.text,
      toolName: args.toolName,
      toolArgs: args.toolArgs,
      toolOk: args.toolOk,
      order,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
    return id;
  },
});

// ── Internal: revertible item edits (the agent's write tools) ────────────────
/** The promoted item fields the agent may set directly (not in the `fields` bag). */
const PROMOTED_KEYS = [
  "title",
  "status",
  "roleId",
  "ownerPersonId",
  "offsetDays",
  "offsetMinutes",
] as const;

/**
 * Apply a multi-field patch to an event item and log every change for revert.
 * Promoted fields are logged by name; custom fields under "fields.<key>". When
 * `offsetDays` changes on a day-offset module, the due date is re-derived.
 */
export const applyItemPatch = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    itemId: v.id("eventItems"),
    chapterId: v.id("chapters"),
    promoted: v.optional(v.record(v.string(), v.any())),
    fields: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, { runId, itemId, chapterId, promoted, fields }) => {
    const item = await ctx.db.get(itemId);
    // TENANT BOUNDARY: a write tool reachable from an action with an arbitrary
    // itemId. Refuse to patch an item that isn't in the caller's chapter — a
    // cross-tenant id must NOT be editable. Throw (not silent return) so a
    // mismatch surfaces loudly rather than masquerading as a no-op success.
    if (!item) return;
    if (item.chapterId !== chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Item is not in your chapter.",
      });
    }
    const event = await ctx.db.get(item.eventId);
    if (!event) return;

    const patch: Record<string, any> = {};

    for (const [key, after] of Object.entries(promoted ?? {})) {
      if (!(PROMOTED_KEYS as readonly string[]).includes(key)) continue;
      const before = (item as any)[key] ?? undefined;
      const value = after ?? undefined;
      patch[key] = value;
      await ctx.db.insert("aiChanges", {
        runId,
        chapterId: item.chapterId,
        eventId: item.eventId,
        itemId,
        key,
        before,
        after: value,
      });
      if (key === "offsetDays" && isDayOffsetModule(item.module)) {
        patch.dueDate =
          value === undefined ? undefined : computeDueDate(event.eventDate, value);
      }
    }

    if (fields && Object.keys(fields).length) {
      const merged = { ...(item.fields ?? {}) };
      for (const [key, after] of Object.entries(fields)) {
        const before = merged[key];
        if (after === null || after === undefined) delete merged[key];
        else merged[key] = after;
        await ctx.db.insert("aiChanges", {
          runId,
          chapterId: item.chapterId,
          eventId: item.eventId,
          itemId,
          key: `fields.${key}`,
          before,
          after: after ?? undefined,
        });
      }
      patch.fields = merged;
    }

    if (Object.keys(patch).length) await ctx.db.patch(itemId, patch);
  },
});

/** Create a new event item and log it as a revertible creation (Undo deletes it). */
export const createItem = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    module: v.string(),
    title: v.string(),
    status: v.optional(v.string()),
    roleId: v.optional(v.id("eventRoles")),
    offsetDays: v.optional(v.number()),
    fields: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    // TENANT BOUNDARY: eventId is an arbitrary arg from an action. Refuse to
    // create an item under an event that isn't in the caller's chapter — a
    // cross-tenant id must NOT be writable. Throw so the mismatch is loud.
    if (!event) return null;
    if (event.chapterId !== args.chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Event is not in your chapter.",
      });
    }
    const siblings = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", args.eventId).eq("module", args.module),
      )
      .collect();
    const order = siblings.reduce((m: number, it: any) => Math.max(m, it.order), -1) + 1;
    const dueDate =
      isDayOffsetModule(args.module) && args.offsetDays !== undefined
        ? computeDueDate(event.eventDate, args.offsetDays)
        : undefined;
    const itemId = await ctx.db.insert("eventItems", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      module: args.module,
      title: args.title,
      order,
      offsetDays: args.offsetDays,
      dueDate,
      status: args.status,
      roleId: args.roleId,
      fields: args.fields,
    });
    await ctx.db.insert("aiChanges", {
      runId: args.runId,
      chapterId: event.chapterId,
      eventId: args.eventId,
      itemId,
      key: "__created",
      before: undefined,
      after: null,
    });
    return itemId;
  },
});

/** Store a fetched photo on an item and log the change (Undo clears it). */
export const setItemPhoto = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    itemId: v.id("eventItems"),
    chapterId: v.id("chapters"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { runId, itemId, chapterId, storageId }) => {
    const item = await ctx.db.get(itemId);
    // TENANT BOUNDARY: itemId is an arbitrary arg from an action. Refuse to
    // attach a photo to an item outside the caller's chapter — a cross-tenant
    // id must NOT be writable. Throw so the mismatch is loud, not a silent skip.
    if (!item) return;
    if (item.chapterId !== chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Item is not in your chapter.",
      });
    }
    const before = item.fields?.photo;
    await ctx.db.patch(itemId, {
      fields: { ...(item.fields ?? {}), photo: storageId },
    });
    await ctx.db.insert("aiChanges", {
      runId,
      chapterId: item.chapterId,
      eventId: item.eventId,
      itemId,
      key: "fields.photo",
      before,
      after: storageId,
    });
  },
});

// ── Internal: planning-agent tools (readiness, roles, crew, workstreams) ─────
// Every function below is reachable from the assistant action with arbitrary
// ids, so each one re-checks the tenant boundary exactly like applyItemPatch:
// missing → null/no-op, cross-chapter → throw FORBIDDEN.

/** Load an event iff it's in the caller's chapter (null missing, throw cross). */
async function eventInChapter(
  ctx: any,
  eventId: Id<"events">,
  chapterId: Id<"chapters">,
) {
  const event = await ctx.db.get(eventId);
  if (!event) return null;
  if (event.chapterId !== chapterId) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Event is not in your chapter.",
    });
  }
  return event;
}

/** Load a person iff they're in the caller's chapter (throw on cross-chapter). */
async function personInChapter(
  ctx: any,
  personId: Id<"people">,
  chapterId: Id<"chapters">,
) {
  const person = await ctx.db.get(personId);
  if (!person) return null;
  if (person.chapterId !== chapterId) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Person is not in your chapter.",
    });
  }
  return person;
}

function isCoreModuleKey(key: string): boolean {
  return CORE_MODULES.some((m) => m.key === key);
}

/**
 * Upsert a core-module override's ownerRoleKey, dropping overrides that no
 * longer carry any value. Mirrors modules.setOwnerForEvent's private helpers
 * (`setOverrideOwner`/`upsertOverride`) — kept byte-compatible so agent edits
 * and UI edits produce identical override rows.
 */
function upsertOwnerOverride(
  overrides: ModuleOverride[] | undefined,
  key: string,
  ownerRoleKey: string | undefined,
): ModuleOverride[] {
  const list = [...(overrides ?? [])];
  const idx = list.findIndex((o) => o.key === key);
  const next = { ...(idx >= 0 ? list[idx] : { key }), ownerRoleKey };
  const isEmpty = next.label === undefined && next.ownerRoleKey === undefined;
  if (idx >= 0) {
    if (isEmpty) list.splice(idx, 1);
    else list[idx] = next;
  } else if (!isEmpty) {
    list.push(next);
  }
  return list;
}

/** How many titles a readiness list carries before truncating to a count. */
const READINESS_TITLE_CAP = 12;

/**
 * The agent's situational-awareness read (`get_readiness`): one compact object
 * with everything the playbook's "briefing first" behavior needs — phase
 * scores, T-window, role/owner coverage, at-risk items, the owner-chain
 * dead-ends, placeholder crew, and engagement confirmation counts.
 */
export const readinessSummary = internalQuery({
  args: { eventId: v.id("events"), chapterId: v.id("chapters") },
  handler: async (ctx, { eventId, chapterId }) => {
    const event = await ctx.db.get(eventId);
    // TENANT BOUNDARY: reads mirror eventContext — null on missing OR cross-chapter.
    if (!event || event.chapterId !== chapterId) return null;
    const now = Date.now();

    // Phase scores (the same math the event screen shows), as 0-100 ints.
    const phaseScores = await phaseReadiness(ctx, event);
    const phases = Object.fromEntries(
      Object.entries(phaseScores).map(([k, s]) => [
        k,
        s == null ? null : Math.round(s * 100),
      ]),
    );

    const daysToEvent = offsetDaysBetween(now, event.eventDate);
    const window = eventWindowFor(daysToEvent);

    // Role coverage.
    const roles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const assignedRoleIds = new Set(assignments.map((a: any) => String(a.roleId)));
    const personByRoleId = new Map<string, Id<"people">>(
      assignments.map((a: any) => [String(a.roleId), a.personId]),
    );
    const roleByKey = new Map(roles.map((r: any) => [r.key as string, r]));
    const unassignedRoles = roles
      .filter((r: any) => !assignedRoleIds.has(String(r._id)))
      .map((r: any) => r.label as string);

    // Workstream (module) owner coverage + ready flags.
    const resolved = await eventActiveModules(ctx, event);
    const workstreamsMissingOwner: string[] = [];
    const ownerPersonByModule = new Map<string, Id<"people"> | undefined>();
    for (const m of resolved) {
      const role: any = m.ownerRoleKey ? roleByKey.get(m.ownerRoleKey) : null;
      const personId = role ? personByRoleId.get(String(role._id)) : undefined;
      ownerPersonByModule.set(m.key, personId);
      if (!personId) workstreamsMissingOwner.push(m.label);
    }
    const readyByKey = new Map<string, boolean>(
      (event.moduleReadiness ?? []).map((r: any) => [r.key, r.ready]),
    );
    const workstreamReadiness = resolved.map((m: any) => ({
      workstream: m.label as string,
      key: m.key as string,
      ready: readyByKey.get(m.key) === true,
    }));

    // Item sweep across grid workstreams: overdue / due within 3 days /
    // owner-chain dead-ends, incomplete items only.
    const soonCutoff = now + 3 * DAY_MS;
    const overdue: string[] = [];
    const dueSoon: string[] = [];
    const unowned: string[] = [];
    let overdueCount = 0;
    let dueSoonCount = 0;
    let unownedCount = 0;
    for (const m of resolved) {
      if (m.surface !== "grid") continue;
      const items = await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", m.key),
        )
        .collect();
      const statusCol = await statusColumnFor(ctx, eventId, m.key);
      const options = statusCol?.options as SelectOption[] | undefined;
      for (const it of items) {
        if (statusCol && isCompleteStatus(options, it.status)) continue;
        const title = `${m.label}: ${it.title || "Untitled"}`;
        if (it.dueDate != null) {
          if (it.dueDate < now) {
            overdueCount++;
            if (overdue.length < READINESS_TITLE_CAP) overdue.push(title);
          } else if (it.dueDate <= soonCutoff) {
            dueSoonCount++;
            if (dueSoon.length < READINESS_TITLE_CAP) dueSoon.push(title);
          }
        }
        // Owner chain: row owner → row's role's person → workstream owner's
        // person. A dead-end here falls through to the event owner — which is
        // exactly the "unowned work" the playbook wants surfaced by T-10.
        const resolvedOwner =
          it.ownerPersonId ??
          (it.roleId ? personByRoleId.get(String(it.roleId)) : undefined) ??
          ownerPersonByModule.get(m.key);
        if (!resolvedOwner) {
          unownedCount++;
          if (unowned.length < READINESS_TITLE_CAP) unowned.push(title);
        }
      }
    }

    // Crew: engagement confirmation counts + placeholder people still engaged.
    const engagements = await ctx.db
      .query("engagements")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const engagementStatus = { invited: 0, confirmed: 0, declined: 0 };
    const placeholders: string[] = [];
    for (const e of engagements) {
      if (e.status in engagementStatus) {
        engagementStatus[e.status as keyof typeof engagementStatus]++;
      }
      const person = await ctx.db.get(e.personId as Id<"people">);
      if (person?.isPlaceholder === true && !placeholders.includes(person.name)) {
        placeholders.push(person.name);
      }
    }

    return {
      event: {
        name: event.name,
        status: event.status as string,
        date: new Date(event.eventDate).toISOString(),
      },
      daysToEvent,
      tWindow: `${tNotation(daysToEvent)} — ${window.label} (${window.range})`,
      phases,
      unassignedRoles,
      workstreamsMissingOwner,
      workstreamReadiness,
      items: {
        overdue: { count: overdueCount, titles: overdue },
        dueInNext3Days: { count: dueSoonCount, titles: dueSoon },
        unowned: { count: unownedCount, titles: unowned },
      },
      crew: {
        engagementStatus,
        placeholdersStillEngaged: placeholders,
      },
    };
  },
});

/**
 * Delete an event item (the `remove_item` tool), revertibly: the full item
 * snapshot is logged as a `__deleted` change whose `before` holds the row, and
 * `revertAiRun` re-inserts it on Undo — the delete-side sibling of the
 * `__created` marker. Mirrors the canonical `items.removeEventItem`, which
 * cascades nothing (an event item owns no child rows), so a plain delete is
 * the whole job.
 */
export const removeItem = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    itemId: v.id("eventItems"),
    chapterId: v.id("chapters"),
  },
  handler: async (ctx, { runId, itemId, chapterId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return null;
    if (item.chapterId !== chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Item is not in your chapter.",
      });
    }
    // Snapshot everything except the system fields, so revert can re-insert.
    const { _id, _creationTime, ...snapshot } = item as any;
    await ctx.db.insert("aiChanges", {
      runId,
      chapterId: item.chapterId,
      eventId: item.eventId,
      itemId,
      key: "__deleted",
      before: snapshot,
      after: undefined,
    });
    await ctx.db.delete(itemId);
    return itemId;
  },
});

/**
 * Put a person in an event role (the `assign_role` tool). Mirrors
 * roleAssignments.assign's upsert semantics: one person per role — any
 * existing assignment rows for the role are replaced.
 */
export const assignRole = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    roleId: v.id("eventRoles"),
    personId: v.id("people"),
  },
  handler: async (ctx, { eventId, chapterId, roleId, personId }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    const role = await ctx.db.get(roleId);
    if (!role || role.eventId !== eventId) return null;
    const person = await personInChapter(ctx, personId, chapterId);
    if (!person) return null;

    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q: any) =>
        q.eq("eventId", eventId).eq("roleId", roleId),
      )
      .collect();
    for (const a of existing) await ctx.db.delete(a._id);

    return await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: event.chapterId,
      roleId,
      personId,
      createdAt: Date.now(),
    });
  },
});

/** Clear a role's assignment (the `unassign_role` tool). Mirrors roleAssignments.unassign. */
export const unassignRole = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    roleId: v.id("eventRoles"),
  },
  handler: async (ctx, { eventId, chapterId, roleId }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q: any) =>
        q.eq("eventId", eventId).eq("roleId", roleId),
      )
      .collect();
    for (const a of existing) await ctx.db.delete(a._id);
    return eventId;
  },
});

const engagementTypeV = v.union(v.literal("volunteer"), v.literal("paid"));
const engagementStatusV = v.union(
  v.literal("invited"),
  v.literal("confirmed"),
  v.literal("declined"),
);

/**
 * Engage a person on the event (the `add_engagement` tool). Mirrors
 * engagements.add (status starts "invited"; paid engagements seed
 * paymentStatus "unpaid"), plus an optional call time set on creation.
 * Refuses a duplicate engagement for the same person so the agent is steered
 * to update_engagement instead.
 */
export const addEngagement = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    personId: v.id("people"),
    type: engagementTypeV,
    teams: v.optional(v.array(v.string())),
    service: v.optional(v.string()),
    callTime: v.optional(v.string()),
    amountUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const event = await eventInChapter(ctx, args.eventId, args.chapterId);
    if (!event) return null;
    const person = await personInChapter(ctx, args.personId, args.chapterId);
    if (!person) return null;

    const existing = await ctx.db
      .query("engagements")
      .withIndex("by_event", (q: any) => q.eq("eventId", args.eventId))
      .collect();
    if (existing.some((e: any) => String(e.personId) === String(args.personId))) {
      return { alreadyEngaged: true as const };
    }

    const engagementId = await ctx.db.insert("engagements", {
      chapterId: event.chapterId,
      eventId: args.eventId,
      personId: args.personId,
      type: args.type,
      teams: args.teams,
      service: args.service,
      status: "invited",
      callTime: args.callTime,
      amountUsd: args.type === "paid" ? args.amountUsd : undefined,
      paymentStatus: args.type === "paid" ? ("unpaid" as const) : undefined,
      createdAt: Date.now(),
    });
    return { alreadyEngaged: false as const, engagementId };
  },
});

/**
 * Update a person's engagement on the event (the `update_engagement` tool),
 * located by person. Mirrors engagements.update's semantics — including the
 * volunteer↔paid flip clearing/seeding payment fields.
 */
export const updateEngagement = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    personId: v.id("people"),
    type: v.optional(engagementTypeV),
    teams: v.optional(v.union(v.array(v.string()), v.null())),
    service: v.optional(v.union(v.string(), v.null())),
    status: v.optional(engagementStatusV),
    callTime: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { eventId, chapterId, personId, ...patch }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    const eng = (
      await ctx.db
        .query("engagements")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    ).find((e: any) => String(e.personId) === String(personId));
    if (!eng) return null;

    const fields: Record<string, unknown> = {};
    if (patch.type !== undefined) {
      fields.type = patch.type;
      // Mirror engagements.update: leaving paid clears payment fields;
      // entering paid seeds unpaid.
      if (patch.type === "volunteer") {
        fields.amountUsd = undefined;
        fields.paymentStatus = undefined;
      } else if (eng.paymentStatus === undefined) {
        fields.paymentStatus = "unpaid";
      }
    }
    if (patch.teams !== undefined) fields.teams = patch.teams ?? undefined;
    if (patch.service !== undefined) fields.service = patch.service ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.callTime !== undefined) fields.callTime = patch.callTime ?? undefined;
    await ctx.db.patch(eng._id, fields);
    return eng._id;
  },
});

/**
 * Add a person to the chapter roster (the `add_person` tool), with the same
 * defaults people.create applies: unvetted, active.
 */
export const addPerson = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, { chapterId, name, email, phone }) => {
    return await ctx.db.insert("people", {
      chapterId,
      name,
      email,
      phone,
      vettingStatus: "unvetted",
      status: "active",
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/**
 * Set (or clear) a workstream's owner role (the `set_workstream_owner` tool).
 * Mirrors modules.setOwnerForEvent: core modules write a coreModuleOverrides
 * delta; custom modules patch their eventModules row.
 */
export const setModuleOwner = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    key: v.string(),
    ownerRoleKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { eventId, chapterId, key, ownerRoleKey }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    const next = ownerRoleKey ?? undefined;
    if (isCoreModuleKey(key)) {
      await ctx.db.patch(eventId, {
        coreModuleOverrides: upsertOwnerOverride(
          event.coreModuleOverrides,
          key,
          next,
        ),
      });
      return eventId;
    }
    const row = await ctx.db
      .query("eventModules")
      .withIndex("by_event_key", (q: any) =>
        q.eq("eventId", eventId).eq("key", key),
      )
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, { ownerRoleKey: next });
    return eventId;
  },
});

/**
 * Toggle a CORE workstream on/off for the event (the `toggle_workstream`
 * tool). Mirrors modules.toggleCoreForEvent, including re-seeding a grid
 * core's default columns when re-enabling one that never had any. Custom event
 * modules have no enabled flag (they're created/deleted instead), so a custom
 * key returns null and the tool surfaces that.
 */
export const toggleModule = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    key: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { eventId, chapterId, key, enabled }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    if (!isCoreModuleKey(key)) return null;
    const disabled = new Set<string>(event.disabledCoreModules ?? []);
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    await ctx.db.patch(eventId, { disabledCoreModules: Array.from(disabled) });
    if (enabled) {
      // Mirror modules.ensureEventCoreColumns: a re-enabled grid core with no
      // columns yet gets its defaults seeded.
      const def = CORE_MODULES.find((m) => m.key === key);
      if (def && def.surface === "grid") {
        const existing = await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", eventId).eq("module", key),
          )
          .first();
        if (!existing) {
          const defaults = DEFAULT_COLUMNS[key as ModuleKey] ?? [];
          for (let i = 0; i < defaults.length; i++) {
            const c = defaults[i];
            await ctx.db.insert("eventColumns", {
              eventId,
              module: key,
              key: c.key,
              label: c.label,
              kind: c.kind,
              type: c.type,
              options: c.options,
              config: c.config,
              isVisible: c.isVisible,
              order: i,
            });
          }
        }
      }
    }
    return eventId;
  },
});

/**
 * Create a custom workstream on the event (the `create_custom_workstream`
 * tool). Mirrors modules.createCustomForEvent — unique key derived from the
 * label, default custom columns seeded — plus the optional offset mode the
 * canonical mutation hardcodes to "none".
 */
export const createCustomModule = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    label: v.string(),
    ownerRoleKey: v.optional(v.string()),
    offsetMode: v.optional(
      v.union(v.literal("none"), v.literal("days"), v.literal("minutes")),
    ),
  },
  handler: async (ctx, { eventId, chapterId, label, ownerRoleKey, offsetMode }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    const rows = await ctx.db
      .query("eventModules")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    // Mirror modules.uniqueKey: never collide with a core key or a sibling.
    const base = toKey(label) || "module";
    const used = new Set(rows.map((r: any) => r.key as string));
    if (isCoreModuleKey(base)) used.add(base);
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}_${i}`;

    const order =
      rows.reduce((m: number, r: any) => Math.max(m, r.order), -1) + 1;
    await ctx.db.insert("eventModules", {
      eventId,
      key,
      label,
      ownerRoleKey,
      offsetMode: offsetMode ?? "none",
      order,
    });
    for (let i = 0; i < DEFAULT_CUSTOM_COLUMNS.length; i++) {
      const c = DEFAULT_CUSTOM_COLUMNS[i];
      await ctx.db.insert("eventColumns", {
        eventId,
        module: key,
        key: c.key,
        label: c.label,
        kind: c.kind,
        type: c.type,
        options: c.options,
        config: c.config,
        isVisible: c.isVisible,
        order: i,
      });
    }
    return { key };
  },
});

/**
 * Move the event date (the `reschedule_event` tool). Mirrors
 * events.reschedule — patch the date, re-derive every day-offset item's due
 * date — then runs the playbook's feasibility check: how many still-incomplete
 * items now have a due date in the past.
 */
export const rescheduleEvent = internalMutation({
  args: {
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    eventDate: v.number(),
  },
  handler: async (ctx, { eventId, chapterId, eventDate }) => {
    const event = await eventInChapter(ctx, eventId, chapterId);
    if (!event) return null;
    await ctx.db.patch(eventId, { eventDate, updatedAt: Date.now() });

    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const now = Date.now();
    const optionsByModule = new Map<string, SelectOption[] | undefined>();
    let shifted = 0;
    let pastDueCount = 0;
    const pastDueTitles: string[] = [];
    for (const it of items) {
      if (
        !DAY_OFFSET_MODULES.includes(it.module as ModuleKey) ||
        it.offsetDays === undefined
      )
        continue;
      const dueDate = computeDueDate(eventDate, it.offsetDays);
      await ctx.db.patch(it._id, { dueDate });
      shifted++;
      if (dueDate < now) {
        if (!optionsByModule.has(it.module)) {
          const col = await statusColumnFor(ctx, eventId, it.module);
          optionsByModule.set(
            it.module,
            col?.options as SelectOption[] | undefined,
          );
        }
        if (!isCompleteStatus(optionsByModule.get(it.module), it.status)) {
          pastDueCount++;
          if (pastDueTitles.length < READINESS_TITLE_CAP)
            pastDueTitles.push(it.title || "Untitled");
        }
      }
    }
    return { shifted, pastDueCount, pastDueTitles };
  },
});

// ── Public: assistant threads ────────────────────────────────────────────────
/** The most recent thread for an event, creating one if none exists. */
export const ensureThread = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const existing = await ctx.db
      .query("aiThreads")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .order("desc")
      .first();
    if (existing) return existing._id;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      eventId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Start a fresh thread for an event (the "New chat" button). */
export const newThread = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      eventId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** The most recent thread for a How-To doc, creating one if none exists. */
export const ensureDocThread = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    await requireInChapter(ctx, chapterId, doc, "Doc");
    const existing = await ctx.db
      .query("aiThreads")
      .withIndex("by_doc", (q: any) => q.eq("docId", docId))
      .order("desc")
      .first();
    if (existing) return existing._id;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      docId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Start a fresh thread for a How-To doc (the "New chat" button). */
export const newDocThread = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    await requireInChapter(ctx, chapterId, doc, "Doc");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      docId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Messages in a thread, oldest-first — the panel's reactive feed. */
export const listMessages = query({
  args: { threadId: v.optional(v.id("aiThreads")) },
  handler: async (ctx, { threadId }) => {
    if (!threadId) return [];
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.chapterId !== chapterId) return [];
    return (
      await ctx.db
        .query("aiMessages")
        .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);
  },
});

// ── Public: budget status ────────────────────────────────────────────────────
/**
 * Windowed AI spend for the caller's user, chapter, and the whole org, vs. the
 * configured caps. `over` names the first scope (if any) at/over its cap.
 */
export const budgetStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const chapterId = await getChapterIdOrNull(ctx);
    const since = Date.now() - AI_BUDGET_WINDOW_MS;

    const userRows = await ctx.db
      .query("aiUsage")
      .withIndex("by_user_time", (q: any) =>
        q.eq("userId", userId).gte("createdAt", since),
      )
      .collect();
    const userSpent = userRows.reduce((s, r) => s + r.costUsd, 0);

    const chapterRows = chapterId
      ? await ctx.db
          .query("aiUsage")
          .withIndex("by_chapter_time", (q: any) =>
            q.eq("chapterId", chapterId).gte("createdAt", since),
          )
          .collect()
      : [];
    const chapterSpent = chapterRows.reduce((s, r) => s + r.costUsd, 0);

    // Org = the whole deployment: every usage row in the window.
    const orgRows = await ctx.db
      .query("aiUsage")
      .filter((q: any) => q.gte(q.field("createdAt"), since))
      .collect();
    const orgSpent = orgRows.reduce((s, r) => s + r.costUsd, 0);

    const over = overBudgetScope({
      user: userSpent,
      chapter: chapterSpent,
      org: orgSpent,
    });

    return {
      user: { spent: toCents(userSpent), cap: AI_BUDGETS.perUserUsd },
      chapter: { spent: toCents(chapterSpent), cap: AI_BUDGETS.perChapterUsd },
      org: { spent: toCents(orgSpent), cap: AI_BUDGETS.orgUsd },
      over,
    };
  },
});

// ── Public: AI model config (active model + superuser gate) ───────────────────
/**
 * The deployment-wide active AI model, the full model menu, and whether the
 * caller is a superuser (so the client can show an editable picker). The active
 * model lives in the singleton `aiSettings` row; it falls back to
 * `DEFAULT_AI_MODEL` if unset or pointing at a model that no longer exists.
 */
export const aiConfig = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    activeModel: string;
    isSuperuser: boolean;
    models: Array<{ slug: string; label: string }>;
  }> => {
    const settings = await ctx.db.query("aiSettings").first();
    const stored = settings?.activeModel;
    const activeModel =
      stored && AI_MODELS[stored] ? stored : DEFAULT_AI_MODEL;
    return {
      activeModel,
      isSuperuser: await isSuperuser(ctx),
      models: Object.values(AI_MODELS).map((m) => ({
        slug: m.slug,
        label: m.label,
      })),
    };
  },
});

/**
 * Set the deployment-wide active AI model. Superuser-only; rejects unknown
 * slugs. Upserts the singleton `aiSettings` row.
 */
export const setActiveModel = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!(await isSuperuser(ctx))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only superusers can change the AI model.",
      });
    }
    if (!AI_MODELS[slug]) {
      throw new ConvexError({ code: "BAD_MODEL", message: "Unknown model." });
    }
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.query("aiSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        activeModel: slug,
        updatedBy,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("aiSettings", {
        activeModel: slug,
        updatedBy,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ── Per-chat model + spend limit ─────────────────────────────────────────────
/** A single chat's lifetime spend = sum of every usage row billed to it. */
async function sumThreadSpend(
  ctx: any,
  threadId: Id<"aiThreads">,
): Promise<number> {
  const rows = await ctx.db
    .query("aiUsage")
    .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
    .collect();
  return rows.reduce((s: number, r: any) => s + r.costUsd, 0);
}

/**
 * The model + spend-cap the ACTION needs to run a turn on a thread, resolved in
 * the caller's auth context. Returns null on a missing/cross-chapter thread so
 * the action refuses to run. `model` is the chat's override or the deployment
 * default; `spentUsd` is this chat's lifetime spend (for the per-chat cap).
 */
export const threadRunContext = internalQuery({
  args: { threadId: v.id("aiThreads"), chapterId: v.id("chapters") },
  handler: async (ctx, { threadId, chapterId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.chapterId !== chapterId) return null;
    const settings = await ctx.db.query("aiSettings").first();
    const deploymentDefault =
      settings?.activeModel && AI_MODELS[settings.activeModel]
        ? settings.activeModel
        : DEFAULT_AI_MODEL;
    return {
      model: thread.model ?? deploymentDefault,
      spendLimitUsd: thread.spendLimitUsd ?? null,
      spentUsd: await sumThreadSpend(ctx, threadId),
    };
  },
});

/**
 * Everything the assistant panel needs to render its per-chat model + budget
 * controls: the chat's active model (its override, else the deployment default),
 * its spend cap and lifetime spend, whether that cap is already hit, and whether
 * the caller is a superuser (so paid models + the cap editor are offered).
 */
export const threadAiSettings = query({
  args: { threadId: v.optional(v.id("aiThreads")) },
  handler: async (ctx, { threadId }) => {
    const superuser = await isSuperuser(ctx);
    const settings = await ctx.db.query("aiSettings").first();
    const deploymentDefault =
      settings?.activeModel && AI_MODELS[settings.activeModel]
        ? settings.activeModel
        : DEFAULT_AI_MODEL;

    if (!threadId) {
      return {
        model: deploymentDefault,
        isCustomModel: false,
        deploymentDefault,
        spendLimitUsd: null as number | null,
        spentUsd: 0,
        overLimit: false,
        isSuperuser: superuser,
      };
    }
    const chapterId = await getChapterIdOrNull(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread || !chapterId || thread.chapterId !== chapterId) {
      return {
        model: deploymentDefault,
        isCustomModel: false,
        deploymentDefault,
        spendLimitUsd: null as number | null,
        spentUsd: 0,
        overLimit: false,
        isSuperuser: superuser,
      };
    }
    const spentUsd = await sumThreadSpend(ctx, threadId);
    return {
      model: thread.model ?? deploymentDefault,
      isCustomModel: !!thread.model,
      deploymentDefault,
      spendLimitUsd: thread.spendLimitUsd ?? null,
      spentUsd: toCents(spentUsd),
      overLimit: isOverChatBudget(spentUsd, thread.spendLimitUsd ?? null),
      isSuperuser: superuser,
    };
  },
});

/**
 * Persist a chat's model override (or clear it → null). Called by the
 * `setThreadModel` ACTION, which has already fetched the slug's pricing and
 * enforced "paid models are superuser-only" — this internal write just records
 * the vetted choice, so it takes no auth decision of its own.
 */
export const persistThreadModel = internalMutation({
  args: {
    threadId: v.id("aiThreads"),
    chapterId: v.id("chapters"),
    model: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { threadId, chapterId, model }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Chat not found.",
      });
    }
    await ctx.db.patch(threadId, {
      model: model ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Set (or clear, with null) a chat's hard spend cap. Superuser-only: a spend
 * limit is only meaningful once a paid model is in play, and only superusers can
 * put a chat on a paid model. A negative cap is rejected; 0 means "no more
 * spend" (freezes the chat).
 */
export const setThreadSpendLimit = mutation({
  args: { threadId: v.id("aiThreads"), limitUsd: v.union(v.number(), v.null()) },
  handler: async (ctx, { threadId, limitUsd }) => {
    if (!(await isSuperuser(ctx))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only super admins can set a chat spend limit.",
      });
    }
    if (limitUsd != null && (!Number.isFinite(limitUsd) || limitUsd < 0)) {
      throw new ConvexError({
        code: "BAD_LIMIT",
        message: "Spend limit must be zero or a positive dollar amount.",
      });
    }
    const chapterId = await requireChapterId(ctx);
    const thread = await ctx.db.get(threadId);
    await requireInChapter(ctx, chapterId, thread, "Chat");
    await ctx.db.patch(threadId, {
      spendLimitUsd: limitUsd ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── Public: list runs (for the Undo UI) ──────────────────────────────────────
/** Recent agent runs in the caller's chapter, with change counts for Undo. */
export const listRuns = query({
  args: { eventId: v.optional(v.id("events")) },
  handler: async (ctx, { eventId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const runs = (
      await ctx.db
        .query("aiRuns")
        .withIndex("by_chapter_time", (q: any) =>
          q.eq("chapterId", chapterId),
        )
        .order("desc")
        .take(40)
    )
      .filter((r: any) => (eventId ? r.eventId === eventId : true))
      .slice(0, 20);

    return await Promise.all(
      runs.map(async (run: any) => {
        const changes = await ctx.db
          .query("aiChanges")
          .withIndex("by_run", (q: any) => q.eq("runId", run._id))
          .collect();
        return {
          ...run,
          changeCount: changes.length,
          revertableCount: changes.filter((c: any) => c.revertedAt == null)
            .length,
        };
      }),
    );
  },
});

// ── Public: revert a run ──────────────────────────────────────────────────────
/**
 * Undo every not-yet-reverted change of a run, in reverse insertion order:
 *   - "__created"    → delete the item the run created.
 *   - "__deleted"    → re-insert the item from the snapshot in `before`.
 *   - "fields.<key>" → restore the custom-field value in the `fields` bag.
 *   - promoted field → restore the top-level field (re-deriving due date).
 * A field edit is only restored if the item's current value still equals what
 * the agent set (`after`), so manual edits made since aren't clobbered.
 */
export const revertAiRun = mutation({
  args: { runId: v.id("aiRuns") },
  handler: async (ctx, { runId }) => {
    const chapterId = await requireChapterId(ctx);
    const run = await ctx.db.get(runId);
    await requireInChapter(ctx, chapterId, run, "AI run");

    const changes = (
      await ctx.db
        .query("aiChanges")
        .withIndex("by_run", (q: any) => q.eq("runId", runId))
        .collect()
    )
      .filter((c: any) => c.revertedAt == null)
      .reverse();

    let reverted = 0;
    let skipped = 0;
    for (const change of changes) {
      const item = await ctx.db.get(change.itemId);

      if (change.key === "__created") {
        // Created by the run → undo means delete (if still present).
        if (item) await ctx.db.delete(change.itemId);
        await ctx.db.patch(change._id, { revertedAt: Date.now() });
        reverted++;
        continue;
      }

      if (change.key === "__deleted") {
        // Deleted by the run → undo means re-insert the snapshot. The row gets
        // a fresh id (Convex ids can't be reused), which is fine — nothing else
        // in this run's change log points at a row it deleted.
        if (change.before && typeof change.before === "object") {
          await ctx.db.insert("eventItems", change.before);
          reverted++;
        } else {
          skipped++;
        }
        await ctx.db.patch(change._id, { revertedAt: Date.now() });
        continue;
      }

      if (!item) {
        skipped++;
        continue;
      }

      if (change.key.startsWith("fields.")) {
        const key = change.key.slice("fields.".length);
        const current = item.fields?.[key];
        if (current !== change.after) {
          skipped++;
          continue;
        }
        const fields = { ...(item.fields ?? {}) };
        if (change.before === undefined) delete fields[key];
        else fields[key] = change.before;
        await ctx.db.patch(change.itemId, { fields });
      } else {
        // Promoted top-level field.
        const current = (item as any)[change.key] ?? undefined;
        if (current !== change.after) {
          skipped++;
          continue;
        }
        const patch: Record<string, any> = { [change.key]: change.before };
        if (change.key === "offsetDays") {
          const event = await ctx.db.get(item.eventId);
          patch.dueDate =
            event && isDayOffsetModule(item.module) && change.before != null
              ? computeDueDate(event.eventDate, change.before)
              : undefined;
        }
        await ctx.db.patch(change.itemId, patch);
      }

      await ctx.db.patch(change._id, { revertedAt: Date.now() });
      reverted++;
    }

    await ctx.db.patch(runId, { status: "reverted" });
    return { reverted, skipped };
  },
});
