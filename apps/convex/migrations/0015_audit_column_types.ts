import type { QueryCtx } from "../_generated/server";
import type { Migration } from "./index";
import { COLUMN_TYPES } from "@events-os/shared";

/**
 * REPORT-ONLY audit: grid column `type` values outside the canonical
 * `COLUMN_TYPES` set (packages/shared).
 *
 * The grid `type`/`config` validators are deliberately loose today
 * (`type: v.string()`, `config: v.any()`), and a later Deploy C will tighten
 * `type` to a union of `COLUMN_TYPES` literals. Before that can land safely, we
 * need to know whether any existing template/event column carries an
 * out-of-vocabulary `type`. This scans both column tables and REPORTS the
 * offenders — it does NOT mutate anything (the optional `fixColumnTypes`
 * entrypoint in `migrations.ts` coerces them when we choose to).
 *
 * Run via `runPending` records its findings in the migration ledger `result`.
 * A clean report (`offenders: []`) is the green light for the Deploy C
 * validator tightening.
 */

export interface ColumnTypeAuditReport {
  scannedTemplateColumns: number;
  scannedEventColumns: number;
  /** Distinct out-of-vocabulary `type` values found, with counts. */
  unknownTypes: Record<string, number>;
  /** First offenders (bounded, for triage) with enough to locate them. */
  offenders: Array<{
    table: "templateColumns" | "eventColumns";
    columnId: string;
    module: string;
    key: string;
    type: string;
  }>;
}

const KNOWN = new Set<string>(COLUMN_TYPES);
/** Cap the sample list so a pathological dataset can't bloat the ledger row. */
const MAX_OFFENDERS = 100;

export async function scanColumnTypes(
  ctx: QueryCtx,
): Promise<ColumnTypeAuditReport> {
  const unknownTypes: Record<string, number> = {};
  const offenders: ColumnTypeAuditReport["offenders"] = [];

  const templateColumns = await ctx.db.query("templateColumns").collect();
  const eventColumns = await ctx.db.query("eventColumns").collect();

  const record = (
    table: "templateColumns" | "eventColumns",
    col: { _id: unknown; module: string; key: string; type: string },
  ) => {
    if (KNOWN.has(col.type)) return;
    unknownTypes[col.type] = (unknownTypes[col.type] ?? 0) + 1;
    if (offenders.length < MAX_OFFENDERS) {
      offenders.push({
        table,
        columnId: String(col._id),
        module: col.module,
        key: col.key,
        type: col.type,
      });
    }
  };

  for (const c of templateColumns) record("templateColumns", c);
  for (const c of eventColumns) record("eventColumns", c);

  return {
    scannedTemplateColumns: templateColumns.length,
    scannedEventColumns: eventColumns.length,
    unknownTypes,
    offenders,
  };
}

export const auditColumnTypes: Migration = {
  name: "0015_audit_column_types",
  // A read-only scan; MutationCtx satisfies the QueryCtx reader signature. The
  // returned report is recorded in the ledger `result` (no data is changed).
  run: (ctx) => scanColumnTypes(ctx),
};
