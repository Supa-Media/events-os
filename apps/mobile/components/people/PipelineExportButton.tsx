/**
 * "Export CSV" for the People desk's recruiting lists (Team applications,
 * Volunteer signups, Job listings).
 *
 * Exports exactly the rows the screen is showing — the current stage filter
 * included — through the same shared `toCsv` (formula-injection guard
 * included) and `exportCsv` platform hookup the giving grids use.
 *
 * Gated on `dataExports.myExportAccess` (`data.export`), the same signal the
 * People tab's Export button and the mailing list's "Export N" use. The rows
 * are already on screen, so this discloses nothing new to a `hiring.view`
 * holder — but a file of applicants' emails and phones leaving the app is an
 * export, and offering that door to someone the org has decided cannot export
 * would misstate the policy. Hidden, not disabled, when the power is missing.
 */
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { toCsv, type CsvValue } from "@events-os/shared";
import { Button } from "../ui";
import { exportCsv } from "../giving/exportCsv";

export interface PipelineCsv {
  /** Base name; a timestamp and `.csv` are appended. */
  name: string;
  headers: string[];
  rows: CsvValue[][];
}

/** `YYYY-MM-DD` for a timestamp, blank for none — sorts and filters cleanly in
 *  a spreadsheet, unlike the screen's relative "3 days ago". */
export function csvDate(ts: number | null | undefined): string {
  return ts ? new Date(ts).toISOString().slice(0, 10) : "";
}

export function PipelineExportButton({ build }: { build: () => PipelineCsv }) {
  const access = useQuery(api.dataExports.myExportAccess);
  const [busy, setBusy] = useState(false);
  if (access?.canExport !== true) return null;

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const { name, headers, rows } = build();
      await exportCsv(`${name}-${Date.now()}.csv`, toCsv(headers, rows));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      title="Export CSV"
      icon="download"
      size="sm"
      variant="secondary"
      disabled={busy}
      onPress={() => void run()}
    />
  );
}
