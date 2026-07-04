/**
 * Pure helpers shared by the day-panel field chips ({@link FieldChips}) and the
 * editors they open ({@link FieldEditor}) — reading a chip column's value off an
 * item, deciding whether it's worth a chip, and formatting its compact label.
 */
import type { AnchorRect } from "../../ui/useAnchor";
import {
  asArray,
  type CalendarColumn,
  type ScheduleItem,
  type SelectOption,
} from "./config";

export type EventRole = { _id: string; label: string };
export type EditTarget = { column: CalendarColumn; anchor?: AnchorRect };

/** Read a chip column's logical value off the item (promoted field or bag). */
export function valueOf(item: ScheduleItem, column: CalendarColumn): unknown {
  if (column.key === "owner") return item.ownerPersonId ?? null;
  if (column.key === "role") return item.roleId ?? null;
  return item.fields?.[column.key] ?? null;
}

/** Whether the column has anything worth showing as a chip. */
export function hasValue(item: ScheduleItem, column: CalendarColumn): boolean {
  // The owner chip also shows a role-inherited owner, not just an explicit one.
  if (column.key === "owner") return item.owner != null;
  const v = valueOf(item, column);
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

/** Compact display text for a chip (multiselects collapse past two values). */
export function chipText(
  item: ScheduleItem,
  column: CalendarColumn,
  roles: EventRole[],
): { text: string; color?: string | null } {
  const v = valueOf(item, column);
  const opts = (column.options ?? []) as SelectOption[];
  switch (column.type) {
    case "select": {
      const o = opts.find((x) => x.value === v);
      return { text: o?.label ?? String(v ?? ""), color: o?.color };
    }
    case "multiselect": {
      const values = asArray(v);
      const labels = values.map(
        (x) => opts.find((o) => o.value === x)?.label ?? x,
      );
      const text =
        labels.length <= 2
          ? labels.join(" · ")
          : `${labels[0]} +${labels.length - 1}`;
      return { text, color: opts.find((o) => o.value === values[0])?.color };
    }
    case "role": {
      const label =
        roles.find((r) => r._id === v)?.label ?? item.roleLabel ?? "";
      return { text: label };
    }
    case "currency":
      return { text: v != null ? `$${v}` : "" };
    default:
      return { text: String(v ?? "") };
  }
}
