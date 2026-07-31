/**
 * ExportJobList — every export job at a scope, newest first
 * (`api.dataExports.listExportJobs`). A job row never disappears once it
 * exists, even after its files expire — the row IS the audit trail (see
 * `schema/dataExports.ts`'s module doc) — so this list is also, in effect,
 * "who has extracted data from this scope, and when".
 */
import { ActivityIndicator, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { ExportDatasetId } from "@events-os/shared";
import { EmptyState, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";
import { ExportJobRow, type ExportJobSummary } from "./ExportJobRow";
import type { MobileExportScope } from "./ExportPicker";

export function ExportJobList({
  scope,
  onRerun,
}: {
  scope: MobileExportScope;
  /** Bubbled up from a row's "Re-run" — lets the screen re-open the picker
   *  prefilled with that job's datasets. */
  onRerun?: (datasetIds: ExportDatasetId[]) => void;
}) {
  const jobs = useQuery(api.dataExports.listExportJobs, { scope });

  return (
    <View>
      <SectionHeader title="Recent exports" />
      {jobs === undefined ? (
        <View className="items-center justify-center py-10">
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : jobs.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="No exports yet"
          message="Run your first export above — it appears here as it runs, and stays listed (as the audit record) even after its files expire."
        />
      ) : (
        <View className="gap-3">
          {(jobs as ExportJobSummary[]).map((job) => (
            <ExportJobRow key={job._id} job={job} onRerun={onRerun} />
          ))}
        </View>
      )}
    </View>
  );
}
