/**
 * ExportJobRow — one export job, rendered honestly per status. The four
 * non-negotiables from the feature spec all live here:
 *
 *  - `truncated: true` on a file is never rendered as a clean success — it
 *    gets its own loud warning line, every time.
 *  - a non-empty `omittedSectionIds` says WHICH column groups were left out
 *    and WHY (lack of giving/finance reach), not just that the file is
 *    narrower than ticked.
 *  - every ready file shows its row count, and the job shows the date links
 *    stop working.
 *  - `failed` shows the real error; `expired` explains the files were
 *    purged (the job ROW is the permanent audit record — see
 *    `schema/dataExports.ts`) and offers to re-run.
 *
 * Downloading: web triggers a real download via a throwaway anchor element
 * created (and immediately removed) imperatively inside an event handler —
 * never mounted in the JSX tree, so there is no raw DOM node in the RN
 * component tree to crash native (mirrors the existing
 * `components/giving/exportCsv.ts` precedent). Native opens the storage URL
 * with `Linking.openURL` — the established pattern for a stored file
 * elsewhere in this app; `expo-file-system`/`expo-sharing` are not
 * installed and this file doesn't add them. Either path calls
 * `recordExportDownload` once the file is actually handed to the user, not
 * merely displayed.
 */
import { useState } from "react";
import { ActivityIndicator, Linking, Platform, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  EXPORT_DATASETS,
  EXPORT_MAX_ROWS,
  isExportDatasetId,
  type ExportDatasetId,
  type ExportJobStatus,
} from "@events-os/shared";
import { Badge, type BadgeTone, Button, Card, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { formatDate, formatDateTime } from "../../lib/format";
import { alertError } from "../../lib/errors";

/** The job shape both `listExportJobs` and `getExportJob` return, per the
 *  backend contract — fields this UI renders, not the whole stored row (the
 *  job also carries a `progress` cursor and `chunkStorageIds` this screen has
 *  no business touching). */
export interface ExportJobSummary {
  _id: Id<"exportJobs">;
  status: ExportJobStatus;
  error?: string;
  datasetIds: string[];
  totalRows: number;
  omittedSectionIds: string[];
  requestedByLabel: string;
  createdAt: number;
  expiresAt?: number;
}

export interface ExportJobFile {
  datasetId: string;
  fileName: string;
  rowCount: number;
  byteSize: number;
  truncated: boolean;
  url: string | null;
}

const STATUS_LABEL: Record<ExportJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
};

const STATUS_TONE: Record<ExportJobStatus, BadgeTone> = {
  queued: "neutral",
  running: "info",
  ready: "success",
  failed: "danger",
  expired: "neutral",
};

const SECTION_DEFS = new Map<string, { label: string; requires: string }>();
for (const ds of Object.values(EXPORT_DATASETS)) {
  for (const sec of ds.sections) SECTION_DEFS.set(sec.id, { label: sec.label, requires: sec.requires });
}

function omissionReason(requires: string): string {
  if (requires === "giving.view") return "needs development-desk access";
  if (requires === "finance.view") return "needs a finance role";
  return "needs more access";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function datasetLabel(id: string): string {
  return isExportDatasetId(id) ? EXPORT_DATASETS[id].label : id;
}

/** Imperative, web-only download — see the module doc for why this never
 *  renders a `<a>` in JSX. */
async function downloadExportFile(url: string, fileName: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof document === "undefined") return;
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return;
  }
  await Linking.openURL(url);
}

export function ExportJobRow({
  job,
  onRerun,
}: {
  job: ExportJobSummary;
  /** Re-run: hands back the job's dataset ids so the picker can be
   *  re-opened prefilled — the job's own `sectionIds`/`filters` aren't part
   *  of the documented summary shape, so re-run intentionally restarts the
   *  section/filter choices rather than assuming fields that may not be
   *  there. */
  onRerun?: (datasetIds: ExportDatasetId[]) => void;
}) {
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const detail = useQuery(
    api.dataExports.getExportJob,
    job.status === "ready" ? { jobId: job._id } : "skip",
  );
  const recordDownload = useMutation(api.dataExports.recordExportDownload);

  async function handleDownload(f: ExportJobFile) {
    if (!f.url) return;
    setDownloadingKey(f.datasetId);
    try {
      await downloadExportFile(f.url, f.fileName);
      await recordDownload({ jobId: job._id });
    } catch (err) {
      alertError(err);
    } finally {
      setDownloadingKey(null);
    }
  }

  function handleRerun() {
    if (!onRerun) return;
    onRerun(job.datasetIds.filter(isExportDatasetId));
  }

  return (
    <Card>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge label={STATUS_LABEL[job.status]} tone={STATUS_TONE[job.status]} />
            <Text className="flex-shrink text-xs text-muted" numberOfLines={1}>
              {job.datasetIds.map(datasetLabel).join(", ")}
            </Text>
          </View>
          <Text className="mt-1 text-2xs text-faint">
            Requested by {job.requestedByLabel} · {formatDateTime(job.createdAt)}
          </Text>
        </View>
        {job.status === "queued" || job.status === "running" ? (
          <ActivityIndicator color={colors.accent} />
        ) : null}
      </View>

      {job.status === "queued" || job.status === "running" ? (
        <Text className="mt-2 text-xs text-muted">
          Walking the data — this can take a while for a large chapter or a
          full-org central export. This row updates itself; no need to reload.
        </Text>
      ) : null}

      {job.status === "failed" ? (
        <Text className="mt-3 text-sm text-danger">
          {job.error ?? "This export failed for an unknown reason."}
        </Text>
      ) : null}

      {job.status === "expired" ? (
        <View className="mt-3">
          <Text className="text-sm text-muted">
            The files were purged{job.expiresAt ? ` on ${formatDate(job.expiresAt)}` : ""} —
            exports only stay downloadable for a short window, because they're
            the densest personal data the app produces. This record stays as
            the audit trail of who extracted what; re-run it for a fresh file.
          </Text>
          {onRerun ? (
            <Button
              title="Re-run this export"
              icon="refresh-cw"
              size="sm"
              variant="secondary"
              className="mt-2 self-start"
              onPress={handleRerun}
            />
          ) : null}
        </View>
      ) : null}

      {job.status === "ready" ? (
        <View className="mt-3">
          {job.omittedSectionIds.length > 0 ? (
            <View className="mb-3 flex-row items-start gap-2 rounded-md border border-warn bg-warn-bg px-3 py-2">
              <Icon name="alert-triangle" size={13} color={colors.warn} />
              <Text className="flex-1 text-xs text-warn">
                Left out for lack of access:{" "}
                {job.omittedSectionIds
                  .map((id) => {
                    const def = SECTION_DEFS.get(id);
                    return def ? `${def.label} (${omissionReason(def.requires)})` : id;
                  })
                  .join(", ")}
                . The file has fewer columns than were ticked.
              </Text>
            </View>
          ) : null}

          {detail === undefined ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <>
              {(detail.files as ExportJobFile[]).map((f, i: number) => (
                <View
                  key={f.datasetId}
                  className={`flex-row items-center justify-between py-2 ${i === 0 ? "" : "border-t border-border"}`}
                >
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-semibold text-ink">{datasetLabel(f.datasetId)}</Text>
                    <Text className="text-xs text-muted">
                      {f.rowCount.toLocaleString()} rows · {formatBytes(f.byteSize)}
                    </Text>
                    {f.truncated ? (
                      <Text className="mt-1 text-2xs font-semibold text-warn">
                        Cut at {EXPORT_MAX_ROWS.toLocaleString()} rows — this file is
                        INCOMPLETE, not a clean export.
                      </Text>
                    ) : null}
                  </View>
                  <Button
                    title="Download"
                    icon="download"
                    size="sm"
                    variant="secondary"
                    disabled={!f.url}
                    loading={downloadingKey === f.datasetId}
                    onPress={() => void handleDownload(f)}
                  />
                </View>
              ))}
              <Text className="mt-2 text-2xs text-faint">
                {job.totalRows.toLocaleString()} total row{job.totalRows === 1 ? "" : "s"}
                {job.expiresAt ? ` · links stop working on ${formatDate(job.expiresAt)}` : ""}
              </Text>
            </>
          )}
        </View>
      ) : null}
    </Card>
  );
}
