/**
 * Service Catalog shape + grouping helpers shared by the mobile pickers
 * (`ServiceOptionsPicker` / `ServiceCatalogManageModal` in `components/ui`),
 * the People grid's `SkillsCell`, and `TargetingBuilder`'s "has service"
 * condition row. Pure logic, no React — kept here so it's unit-testable
 * without a component-rendering harness (this package's `jest.config.js`
 * only runs `*.test.ts`, not `*.test.tsx` — there is no React Testing
 * Library / render harness installed for `apps/mobile`).
 *
 * Mirrors `apps/convex/serviceOptions.ts#list`'s shape exactly: an array of
 * top-level rows, each with a nested `children` array. The `label` field is
 * ALREADY the display string ("Parent" for a top-level row, "Parent:Child"
 * for a child) — computed server-side, never re-derived here. The colon is
 * DISPLAY ONLY; `name` on the wire is always the bare segment (never a colon
 * or comma — `serviceOptions.ts#create`/`rename` reject those).
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";

export type ServiceCatalogTree = FunctionReturnType<typeof api.serviceOptions.list>;
export type ServiceCatalogParent = ServiceCatalogTree[number];

/** One selectable row, parent or child, flattened out of the tree in display
 *  order (each parent immediately followed by its own children). */
export type FlatServiceOption = {
  _id: Id<"serviceOptions">;
  /** Bare name at this level ("Tenor"), never the "Parent:Child" label. */
  name: string;
  /** "Parent" for a top-level row, "Parent:Child" for a child — pre-computed
   *  server-side (`serviceOptions.ts#list`), never re-derived here. */
  label: string;
  isActive: boolean;
  isCentral: boolean;
  usageCount: number;
  /** Undefined for a top-level row; the parent's id for a child. */
  parentId: Id<"serviceOptions"> | undefined;
};

/** Flatten the parent/children tree into one ordered list — the shape every
 *  picker/manage screen actually renders (a flat, checkable/editable list),
 *  parents immediately followed by their own children. */
export function flattenServiceCatalog(tree: ServiceCatalogTree): FlatServiceOption[] {
  const out: FlatServiceOption[] = [];
  for (const parent of tree) {
    out.push({
      _id: parent._id,
      name: parent.name,
      label: parent.label,
      isActive: parent.isActive,
      isCentral: parent.isCentral,
      usageCount: parent.usageCount,
      parentId: undefined,
    });
    for (const child of parent.children) {
      out.push({
        _id: child._id,
        name: child.name,
        label: child.label,
        isActive: child.isActive,
        isCentral: child.isCentral,
        usageCount: child.usageCount,
        parentId: parent._id,
      });
    }
  }
  return out;
}

/** id -> display label, for resolving a person's/condition's stored ids into
 *  chips/text without re-fetching or re-deriving the "Parent:Child" format. */
export function buildServiceLabelMap(
  tree: ServiceCatalogTree,
): Map<Id<"serviceOptions">, string> {
  const map = new Map<Id<"serviceOptions">, string>();
  for (const row of flattenServiceCatalog(tree)) map.set(row._id, row.label);
  return map;
}

/** The ids of every top-level row that has at least one child — "picking
 *  this matches everyone under it too" only applies to these (a childless
 *  top-level row IS the whole match set, same as a leaf). */
export function parentIdsWithChildren(tree: ServiceCatalogTree): Set<Id<"serviceOptions">> {
  const set = new Set<Id<"serviceOptions">>();
  for (const parent of tree) {
    if (parent.children.length > 0) set.add(parent._id);
  }
  return set;
}

/** The top-level rows only — "which parent should a new option nest under?"
 *  (one level of nesting only, mirrors `serviceOptions.ts#create`'s rule). */
export function topLevelServiceOptions(
  tree: ServiceCatalogTree,
): { _id: Id<"serviceOptions">; name: string }[] {
  return tree.map((p) => ({ _id: p._id, name: p.name }));
}
