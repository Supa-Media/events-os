/**
 * Export builders for the Work datasets: `tasks` (this app's `eventItems` —
 * there is no separate `tasks` table) and `projects`.
 *
 * See `./types.ts` for the one-`.paginate()`-per-`page()` rule this follows.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  isCompleteStatus,
  isoDateOrBlank,
  type CsvColumn,
  type CsvValue,
  type SelectOption,
} from "@events-os/shared";
import { statusColumnFor } from "../readiness";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

const EMPTY_PAGE: ExportPage = { rows: [], cursor: null, isDone: true };

async function namesFor(
  ctx: QueryCtx,
  ids: Iterable<Id<"people"> | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set([...ids].filter((id): id is Id<"people"> => !!id))) {
    const person = await ctx.db.get(id);
    if (person) names.set(id, person.name);
  }
  return names;
}

// ── tasks (eventItems) ──────────────────────────────────────────────────────

const TASK_COLUMNS: CsvColumn[] = [
  { key: "item_id", label: "Item ID" },
  { key: "title", label: "Title" },
  { key: "module", label: "Module" },
  { key: "event_id", label: "Event ID" },
  { key: "event_name", label: "Event name" },
  { key: "owner_person_id", label: "Owner ID" },
  { key: "owner_name", label: "Owner name" },
  { key: "role", label: "Role" },
  { key: "due_date", label: "Due date" },
  { key: "status", label: "Status" },
];

const tasksBuilder: ExportBuilder = {
  datasetId: "tasks",
  async columns(): Promise<CsvColumn[]> {
    return TASK_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    if (bctx.chapterId === null) return EMPTY_PAGE;
    const chapterId = bctx.chapterId;
    const { from, to } = bctx.filters;

    const result = await ctx.db
      .query("eventItems")
      .withIndex("by_chapter_and_dueDate", (q) => {
        const withChapter = q.eq("chapterId", chapterId);
        const withFrom = from !== undefined ? withChapter.gte("dueDate", from) : withChapter;
        return to !== undefined ? withFrom.lte("dueDate", to) : withFrom;
      })
      .paginate({ numItems, cursor });

    const page = result.page;

    // `activeOnly` drops completed items. "Complete" is the exact rule the
    // rest of the app uses (`lib/readiness.ts`): an item's `status` matches a
    // value on its (event, module) status column flagged `isComplete`. Resolve
    // that column ONCE per distinct (eventId, module) pair on this page — a
    // bounded, indexed `by_event_module` lookup, never a second `.paginate()`.
    const statusColumns = new Map<string, Doc<"eventColumns"> | null>();
    if (bctx.filters.activeOnly) {
      const pairs = new Set(page.map((it) => `${it.eventId}:${it.module}`));
      for (const pair of pairs) {
        const [eventId, module] = [pair.slice(0, pair.indexOf(":")), pair.slice(pair.indexOf(":") + 1)];
        statusColumns.set(
          pair,
          await statusColumnFor(ctx, eventId as Id<"events">, module),
        );
      }
    }
    const kept = bctx.filters.activeOnly
      ? page.filter((it) => {
          const col = statusColumns.get(`${it.eventId}:${it.module}`);
          const options = col?.options as SelectOption[] | undefined;
          return !isCompleteStatus(options, it.status);
        })
      : page;

    const eventIds = [...new Set(kept.map((it) => it.eventId))];
    const eventNames = new Map<string, string>();
    for (const id of eventIds) {
      const event = await ctx.db.get(id);
      if (event) eventNames.set(id, event.name);
    }

    const ownerNames = await namesFor(ctx, kept.map((it) => it.ownerPersonId));

    const roleIds = [
      ...new Set(kept.map((it) => it.roleId).filter((id): id is Id<"eventRoles"> => !!id)),
    ];
    const roleLabels = new Map<string, string>();
    for (const id of roleIds) {
      const role = await ctx.db.get(id);
      if (role) roleLabels.set(id, role.label);
    }

    const rows: Record<string, CsvValue>[] = kept.map((it) => ({
      item_id: it._id,
      title: it.title,
      module: it.module,
      event_id: it.eventId,
      event_name: eventNames.get(it.eventId) ?? "",
      owner_person_id: it.ownerPersonId ?? "",
      owner_name: it.ownerPersonId ? (ownerNames.get(it.ownerPersonId) ?? "") : "",
      role: it.roleId ? (roleLabels.get(it.roleId) ?? "") : "",
      due_date: isoDateOrBlank(it.dueDate),
      status: it.status ?? "",
    }));

    return { rows, cursor: result.continueCursor, isDone: result.isDone };
  },
};

// ── projects ─────────────────────────────────────────────────────────────────

const PROJECT_COLUMNS: CsvColumn[] = [
  { key: "project_id", label: "Project ID" },
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
  { key: "owner_person_id", label: "Owner ID" },
  { key: "owner_name", label: "Owner name" },
  { key: "parent_project_id", label: "Parent project ID" },
  { key: "parent_project_name", label: "Parent project name" },
  { key: "start_date", label: "Start date" },
  { key: "deadline", label: "Deadline" },
];

const projectsBuilder: ExportBuilder = {
  datasetId: "projects",
  async columns(): Promise<CsvColumn[]> {
    return PROJECT_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    if (bctx.chapterId === null) return EMPTY_PAGE;
    const chapterId = bctx.chapterId;

    const result = await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .paginate({ numItems, cursor });

    // `activeOnly` drops finished work — `status: "done"` is this table's
    // terminal literal (PROJECT_STATUSES), the same shape as `events`'
    // "drops cancelled" and tasks' "drops completed".
    const kept = bctx.filters.activeOnly
      ? result.page.filter((p) => p.status !== "done")
      : result.page;

    const ownerNames = await namesFor(ctx, kept.map((p) => p.ownerPersonId));

    const parentIds = [
      ...new Set(kept.map((p) => p.parentProjectId).filter((id): id is Id<"projects"> => !!id)),
    ];
    const parentNames = new Map<string, string>();
    for (const id of parentIds) {
      const parent = await ctx.db.get(id);
      if (parent) parentNames.set(id, parent.name);
    }

    const rows: Record<string, CsvValue>[] = kept.map((p) => ({
      project_id: p._id,
      name: p.name,
      status: p.status,
      owner_person_id: p.ownerPersonId ?? "",
      owner_name: p.ownerPersonId ? (ownerNames.get(p.ownerPersonId) ?? "") : "",
      parent_project_id: p.parentProjectId ?? "",
      parent_project_name: p.parentProjectId ? (parentNames.get(p.parentProjectId) ?? "") : "",
      start_date: isoDateOrBlank(p.startDate),
      deadline: isoDateOrBlank(p.deadline),
    }));

    return { rows, cursor: result.continueCursor, isDone: result.isDone };
  },
};

export const workBuilders: ExportBuilder[] = [tasksBuilder, projectsBuilder];
