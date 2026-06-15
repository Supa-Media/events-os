/**
 * Shared seed helpers + types.
 *
 * Typed loosely (`ctx: any`) so this file doesn't depend on Convex's generated
 * types — it's pure helper code, not a registered function. Used by the seed
 * mutations in `seed.ts` and the builder logic in `lib/seed/templates.ts`.
 */
import { Id } from "../../_generated/dataModel";
import { DEFAULT_COLUMNS, type ModuleKey } from "@events-os/shared";

export interface ItemRow {
  title: string;
  offsetDays?: number;
  offsetMinutes?: number;
  // Role KEY (resolved to the template's own templateRoles id at insert time).
  role?: string;
  status?: string;
  fields?: Record<string, unknown>;
}

/** Insert a template module's default columns; `hideKeys` start hidden. */
export async function seedTemplateCols(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  module: ModuleKey,
  hideKeys: string[] = [],
) {
  const defaults = DEFAULT_COLUMNS[module] ?? [];
  for (let i = 0; i < defaults.length; i++) {
    const c = defaults[i];
    await ctx.db.insert("templateColumns", {
      eventTypeId,
      module,
      key: c.key,
      label: c.label,
      kind: c.kind,
      type: c.type,
      options: c.options,
      config: c.config,
      isVisible: hideKeys.includes(c.key) ? false : c.isVisible,
      order: i,
    });
  }
}

/** Insert a template module's base item rows, resolving each row's role KEY to
 *  the template's own templateRoles id. */
export async function addTemplateItems(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  module: ModuleKey,
  rows: ItemRow[],
  roleIdByKey: Record<string, Id<"templateRoles">>,
) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await ctx.db.insert("templateItems", {
      eventTypeId,
      module,
      title: r.title,
      order: i,
      offsetDays: r.offsetDays,
      offsetMinutes: r.offsetMinutes,
      roleId: r.role ? roleIdByKey[r.role] : undefined,
      status: r.status,
      fields: r.fields,
    });
  }
}

/** Last 10 digits of a phone number (drops country code + formatting). */
export function phoneKey(phone?: string): string {
  if (!phone) return "";
  const d = phone.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}
