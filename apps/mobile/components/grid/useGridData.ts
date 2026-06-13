/**
 * Grid data adapter — one uniform interface over the template and event item
 * APIs, so the EditableGrid component is written once and works in both modes.
 *
 * Template mode reads/writes `templateColumns` + `templateItems`; event mode
 * reads/writes `eventColumns` + `eventItems`. The grid never sees the difference.
 */
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { DAY_OFFSET_MODULES, type ModuleKey } from "@events-os/shared";

export type GridMode = "template" | "event";

export interface GridColumn {
  _id: string;
  module: string;
  key: string;
  label: string;
  kind: "system" | "custom";
  type: string;
  options?: Array<{ value: string; label: string; color?: string; isComplete?: boolean }>;
  config?: Record<string, unknown>;
  isVisible: boolean;
  order: number;
  width?: number;
}

export interface GridItem {
  _id: string;
  module: string;
  title: string;
  order: number;
  offsetDays?: number;
  offsetMinutes?: number;
  dueDate?: number;
  roleId?: string | null;
  ownerPersonId?: string | null;
  status?: string | null;
  fields?: Record<string, any>;
  // Event-side resolved joins:
  roleLabel?: string | null;
  owner?: { _id: string; name: string } | null;
}

/** The logical value backing a column for an item (promoted field or bag entry). */
export function cellValue(column: GridColumn, item: GridItem, module: ModuleKey): any {
  switch (column.key) {
    case "title":
      return item.title;
    case "status":
      return item.status ?? null;
    case "role":
      return item.roleId ?? null;
    case "owner":
      return item.ownerPersonId ?? null;
    case "offset":
      return DAY_OFFSET_MODULES.includes(module)
        ? item.offsetDays
        : item.offsetMinutes;
    case "due_date":
      return item.dueDate;
    default:
      return item.fields?.[column.key];
  }
}

/** Translate a column + new value into a mutation patch (promoted field or bag). */
export function buildPatch(
  column: GridColumn,
  value: any,
  module: ModuleKey,
): Record<string, any> {
  switch (column.key) {
    case "title":
      return { title: value ?? "" };
    case "status":
      return { status: value ?? null };
    case "role":
      return { roleId: value ?? null };
    case "owner":
      return { ownerPersonId: value ?? null };
    case "offset":
      return DAY_OFFSET_MODULES.includes(module)
        ? { offsetDays: value }
        : { offsetMinutes: value };
    case "due_date":
      return {}; // computed, read-only
    default:
      return { fields: { [column.key]: value } };
  }
}

export interface GridData {
  loading: boolean;
  columns: GridColumn[];
  items: GridItem[];
  summary?: { total: number; complete: number; readiness: number };
  updateItem: (itemId: string, patch: Record<string, any>) => Promise<any>;
  addItem: (initial?: Record<string, any>) => Promise<any>;
  removeItem: (itemId: string) => Promise<any>;
  reorder: (orderedIds: string[]) => Promise<any>;
  // Column ops (template mode mutates the template schema; event mode tweaks the
  // event's own column snapshot — visibility/order only).
  addColumn: (args: { label: string; type: string; options?: any[] }) => Promise<any>;
  updateColumn: (columnId: string, patch: Record<string, any>) => Promise<any>;
  removeColumn: (columnId: string) => Promise<any>;
  reorderColumns: (orderedIds: string[]) => Promise<any>;
  setColumnVisible: (columnId: string, isVisible: boolean) => Promise<any>;
}

export function useGridData(
  mode: GridMode,
  parentId: string,
  module: ModuleKey,
): GridData {
  const isTemplate = mode === "template";

  const tplData = useQuery(
    api.items.listForTemplate,
    isTemplate ? { eventTypeId: parentId as any, module } : "skip",
  );
  const evtData = useQuery(
    api.items.listForEventModule,
    isTemplate ? "skip" : { eventId: parentId as any, module },
  );

  const updateTpl = useMutation(api.items.updateTemplateItem);
  const updateEvt = useMutation(api.items.updateEventItem);
  const addTpl = useMutation(api.items.addTemplateItem);
  const addEvt = useMutation(api.items.addEventItem);
  const removeTpl = useMutation(api.items.removeTemplateItem);
  const removeEvt = useMutation(api.items.removeEventItem);
  const reorderTpl = useMutation(api.items.reorderTemplateItems);
  const reorderEvt = useMutation(api.items.reorderEventItems);

  const addColTpl = useMutation(api.columns.addColumn);
  const updateColTpl = useMutation(api.columns.updateColumn);
  const removeColTpl = useMutation(api.columns.removeColumn);
  const reorderColTpl = useMutation(api.columns.reorderColumns);
  const reorderColEvt = useMutation(api.columns.reorderEventColumns);
  const setColVisEvt = useMutation(api.columns.setEventColumnVisibility);

  const data: any = isTemplate ? tplData : evtData;

  return {
    loading: data === undefined,
    columns: data?.columns ?? [],
    items: data?.items ?? [],
    summary: data?.summary,
    updateItem: (itemId, patch) =>
      isTemplate
        ? updateTpl({ itemId: itemId as any, ...patch })
        : updateEvt({ itemId: itemId as any, ...patch }),
    addItem: (initial = {}) =>
      isTemplate
        ? addTpl({ eventTypeId: parentId as any, module, ...initial })
        : addEvt({ eventId: parentId as any, module, ...initial }),
    removeItem: (itemId) =>
      isTemplate
        ? removeTpl({ itemId: itemId as any })
        : removeEvt({ itemId: itemId as any }),
    reorder: (orderedIds) =>
      isTemplate
        ? reorderTpl({ eventTypeId: parentId as any, module, orderedIds: orderedIds as any })
        : reorderEvt({ eventId: parentId as any, module, orderedIds: orderedIds as any }),
    addColumn: ({ label, type, options }) =>
      addColTpl({ eventTypeId: parentId as any, module, label, type, options }),
    updateColumn: (columnId, patch) =>
      updateColTpl({ columnId: columnId as any, ...patch }),
    removeColumn: (columnId) => removeColTpl({ columnId: columnId as any }),
    reorderColumns: (orderedIds) =>
      isTemplate
        ? reorderColTpl({ eventTypeId: parentId as any, module, orderedIds: orderedIds as any })
        : reorderColEvt({ eventId: parentId as any, module, orderedIds: orderedIds as any }),
    setColumnVisible: (columnId, isVisible) =>
      isTemplate
        ? updateColTpl({ columnId: columnId as any, isVisible })
        : setColVisEvt({ columnId: columnId as any, isVisible }),
  };
}
