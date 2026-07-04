/**
 * Container logic for the Module Calendar — one hook so the view stays a thin
 * layout. Owns the module query, option-set resolution, day bucketing, the
 * month/selection/compose state, and every mutation (status cycling, inline copy
 * edits, and creating an item on the selected day). Generic over the module via
 * its {@link ModuleCalendarConfig}.
 */
import { useMemo, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  startOfDay,
  computeDueDate,
  offsetDaysBetween,
  commsTimingLabel,
  groupByDay,
  soonestUpcoming,
} from "@events-os/shared";
import { formatDate } from "../../../lib/format";
import {
  WIDE,
  MONTHS,
  chipColumns,
  type CalendarColumn,
  type ModuleCalendarConfig,
  type ScheduleItem,
  type SelectOption,
} from "./config";

/** A transient "Moved to …" confirmation with a one-tap Undo. */
export type UndoToast = { message: string; undo: () => void };

export type OptionSet = { list: SelectOption[]; map: Map<string, SelectOption> };

export function useModuleCalendar({
  eventId,
  eventDate,
  config,
  filterItemIds,
}: {
  eventId: string;
  eventDate: number;
  config: ModuleCalendarConfig;
  filterItemIds?: Set<string> | null;
}) {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const data = useQuery(api.items.listForEventModule, {
    eventId: eventId as Id<"events">,
    module: config.module,
  });
  const roles = useQuery(api.roles.listForEvent, {
    eventId: eventId as Id<"events">,
  });
  const setItemStatus = useMutation(api.items.setStatus);
  const addItem = useMutation(api.items.addEventItem);
  const updateItem = useMutation(api.items.updateEventItem);
  const setOwner = useMutation(api.items.assignOwner);

  const today = startOfDay(Date.now());
  const eventDay = startOfDay(eventDate);

  // Resolve option lists/maps + labels for every field this module references,
  // from the event's own columns (template authors can edit the sets).
  const { optionSets, columnLabel, statusOpts, statusMap } = useMemo(() => {
    const columns = data?.columns ?? [];
    const optionsOf = (key: string): SelectOption[] =>
      (columns.find((c) => c.key === key)?.options as SelectOption[] | undefined) ?? [];
    const toSet = (opts: SelectOption[]): OptionSet => ({
      list: opts,
      map: new Map(opts.map((o) => [o.value, o] as const)),
    });
    const fieldKeys = Array.from(
      new Set([
        ...(config.badgeField ? [config.badgeField] : []),
        ...config.metaFields,
        ...config.composerFields,
      ]),
    );
    const sets: Record<string, OptionSet> = {};
    for (const key of fieldKeys) sets[key] = toSet(optionsOf(key));
    const status = optionsOf("status");
    return {
      optionSets: sets,
      columnLabel: (key: string): string =>
        columns.find((c) => c.key === key)?.label ?? key,
      statusOpts: status,
      statusMap: new Map(status.map((o) => [o.value, o] as const)),
    };
  }, [data?.columns, config]);

  // Filter (Me view) → split scheduled items (have a due day) from unscheduled
  // ones (no offset yet), then bucket the scheduled by day.
  const items = useMemo(() => {
    const all = data?.items ?? [];
    return filterItemIds ? all.filter((i) => filterItemIds.has(i._id)) : all;
  }, [data?.items, filterItemIds]);

  const { byDay, scheduled, unscheduled } = useMemo(() => {
    const withDue = items
      .filter((i) => i.offsetDays != null)
      .map((i) => ({ item: i, due: computeDueDate(eventDate, i.offsetDays as number) }));
    const m = groupByDay(withDue, (x) => x.due);
    for (const arr of m.values()) arr.sort((a, b) => a.item.order - b.item.order);
    return {
      byDay: m,
      scheduled: withDue,
      unscheduled: items.filter((i) => i.offsetDays == null),
    };
  }, [items, eventDate]);

  // Open on the soonest upcoming item (or the event's month), and select it.
  const seed = useMemo(() => {
    const next = soonestUpcoming(scheduled, (x) => x.due, Date.now());
    return next?.due ?? eventDate;
  }, [scheduled, eventDate]);

  const [view, setView] = useState(() => {
    const d = new Date(seed);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selected, setSelected] = useState(() => startOfDay(seed));
  const [composing, setComposing] = useState(false);

  const step = (delta: number) => {
    const m = view.month + delta;
    setView({
      year: view.year + Math.floor(m / 12),
      month: ((m % 12) + 12) % 12,
    });
  };
  const goToEvent = () => {
    const d = new Date(eventDate);
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(eventDay);
  };
  const goToday = () => {
    const d = new Date();
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(today);
  };
  const openComposeOn = (dayMs: number) => {
    setSelected(startOfDay(dayMs));
    setComposing(true);
  };

  // The columns a day-panel card offers as editable field chips, plus the badge
  // field's own column so the channel badges can edit themselves.
  const columns = data?.columns ?? [];
  const chipCols = useMemo(
    () => chipColumns(columns, config),
    [columns, config],
  );
  const badgeColumn = config.badgeField
    ? columns.find((c) => c.key === config.badgeField)
    : undefined;

  // ── Undo toast — every reschedule confirms and offers a one-tap revert ──────
  const [undoToast, setUndoToast] = useState<UndoToast | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoToast(null);
  };
  const showUndo = (message: string, undo: () => void) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoToast({ message, undo });
    undoTimer.current = setTimeout(() => setUndoToast(null), 5000);
  };

  /**
   * Move an item to a new signed offset (null unschedules). Keeps the panel on
   * the item — selection follows it to its new day — and arms the Undo toast.
   */
  const reschedule = (item: ScheduleItem, offsetDays: number | null) => {
    const prev = item.offsetDays ?? null;
    if (prev === offsetDays) return;
    const itemId = item._id as Id<"eventItems">;
    void updateItem({ itemId, offsetDays });

    const restore = () => {
      void updateItem({ itemId, offsetDays: prev });
      if (prev != null) setSelected(startOfDay(computeDueDate(eventDate, prev)));
      setUndoToast(null);
    };
    if (offsetDays != null) {
      const due = startOfDay(computeDueDate(eventDate, offsetDays));
      setSelected(due);
      showUndo(
        `Moved to ${formatDate(due)} · ${commsTimingLabel(offsetDays)}`,
        restore,
      );
    } else {
      showUndo("Unscheduled", restore);
    }
  };

  // ── Move mode — "pick a day on the calendar", the drag-free reschedule ──────
  const [moving, setMoving] = useState<ScheduleItem | null>(null);
  const startMove = (item: ScheduleItem) => setMoving(item);
  const cancelMove = () => setMoving(null);
  const completeMove = (dayMs: number) => {
    if (!moving) return;
    reschedule(moving, offsetDaysBetween(eventDate, dayMs));
    setMoving(null);
  };

  // Set an item's status from the card's status picker (null clears).
  const setStatus = (item: ScheduleItem, status: string | null) => {
    void setItemStatus({ itemId: item._id as Id<"eventItems">, status });
  };

  // Persist a field-chip edit: system columns patch their promoted field, custom
  // columns merge into the fields bag (null deletes the key server-side).
  const saveField = (item: ScheduleItem, column: CalendarColumn, value: unknown) => {
    const itemId = item._id as Id<"eventItems">;
    if (column.key === "owner") {
      void setOwner({ itemId, personId: (value as Id<"people"> | null) ?? null });
    } else if (column.key === "role") {
      void updateItem({ itemId, roleId: (value as Id<"eventRoles"> | null) ?? null });
    } else {
      void updateItem({ itemId, fields: { [column.key]: value ?? null } });
    }
  };

  // Persist an inline copy/body edit for a single item.
  const saveCopy = (item: ScheduleItem, copy: string) => {
    void updateItem({
      itemId: item._id as Id<"eventItems">,
      fields: { [config.copyField]: copy },
    });
  };

  // Persist an inline rename from the day panel.
  const saveTitle = (item: ScheduleItem, title: string) => {
    void updateItem({ itemId: item._id as Id<"eventItems">, title });
  };

  // Create an item on the selected day; its offset is derived from how far that
  // day sits from the event, so it lands where the table expects.
  const createItem = async (payload: {
    title: string;
    copy: string;
    groups: Record<string, string[]>;
  }) => {
    const fields: Record<string, unknown> = {};
    for (const [key, values] of Object.entries(payload.groups)) {
      if (values.length) fields[key] = values;
    }
    if (payload.copy.trim()) fields[config.copyField] = payload.copy.trim();
    await addItem({
      eventId: eventId as Id<"events">,
      module: config.module,
      title: payload.title.trim(),
      offsetDays: offsetDaysBetween(eventDate, selected),
      status: statusOpts[0]?.value,
      fields,
    });
    setComposing(false);
  };

  const selectedTiming = `${MONTHS[new Date(selected).getMonth()]} ${new Date(
    selected,
  ).getDate()} · ${commsTimingLabel(offsetDaysBetween(eventDate, selected))}`;

  return {
    loading: data === undefined,
    wide,
    today,
    eventDay,
    view,
    selected,
    setSelected,
    composing,
    setComposing,
    items,
    byDay,
    unscheduled,
    optionSets,
    columnLabel,
    statusOpts,
    statusMap,
    chipCols,
    badgeColumn,
    roles: roles ?? [],
    daysAway: offsetDaysBetween(today, eventDate),
    selectedTiming,
    step,
    goToEvent,
    goToday,
    openComposeOn,
    setStatus,
    saveField,
    reschedule,
    moving,
    startMove,
    cancelMove,
    completeMove,
    undoToast,
    dismissUndo,
    saveCopy,
    saveTitle,
    createItem,
  };
}
