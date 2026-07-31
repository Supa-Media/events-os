/**
 * The Export screen — pick a scope, tick the datasets you need (plus, for
 * People, optional column sections and simple filters), run the export, then
 * download the finished files from the job list below. See
 * `@events-os/shared#dataExport`'s module doc for the shape this whole
 * feature is built on: ONE WIDE FLAT FILE PER DATASET (founder decision,
 * 2026-07-31) — never a zip, never a relational bundle, so this screen and
 * `components/export/*` (the picker, the job list, one job row) never say
 * "download as .zip" or imply the files join back together.
 *
 * Reachable from three entry points this PR also adds: the Donors/Gifts
 * "Full export" buttons (which deep-link `?scope=` from wherever the caller
 * already was) and the People tab's "Export" button (`?dataset=people`) —
 * see those files' own comments. Every one of those entry points is itself
 * gated on `myExportAccess.canExport`, mirroring the gate here: a caller who
 * somehow lands on this route without export access sees a flat "access
 * needed" state, never the picker.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { isExportDatasetId, type ExportDatasetId } from "@events-os/shared";
import { EmptyState, Narrow, Screen } from "../../components/ui";
import {
  ExportPicker,
  type ExportRequestArgs,
  type ExportScopeOption,
  type MobileExportScope,
} from "../../components/export/ExportPicker";
import { ExportJobList } from "../../components/export/ExportJobList";
import { errorMessage } from "../../lib/errors";

export default function ExportsScreen() {
  const access = useQuery(api.dataExports.myExportAccess);

  if (access === undefined) return <Screen loading />;
  if (!access.canExport || access.scopes.length === 0) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Export access needed"
            message="Data export is its own power, separate from viewing a desk. Ask your Executive Director, Financial Manager, Development Director, Marketing Director, Expansion Director, or (for your own chapter) your Chapter Director to grant it."
          />
        </Narrow>
      </Screen>
    );
  }
  return <ExportsBody scopes={access.scopes} />;
}

function ExportsBody({ scopes }: { scopes: ExportScopeOption[] }) {
  // `?scope=` (from a giving-desk deep link) and `?dataset=` (from a
  // dataset-specific entry point, e.g. People's "Export") prefill the
  // picker; both are optional and fall back sensibly when absent or bogus.
  const params = useLocalSearchParams<{ scope?: string; dataset?: string }>();

  const initialScope = useMemo<MobileExportScope>(() => {
    const match = scopes.find((s) => s.scope === params.scope);
    return (match ?? scopes[0]).scope;
  }, [params.scope, scopes]);
  const initialDatasetIds = useMemo<ExportDatasetId[] | undefined>(() => {
    return params.dataset && isExportDatasetId(params.dataset) ? [params.dataset] : undefined;
  }, [params.dataset]);

  const [scope, setScope] = useState<MobileExportScope>(initialScope);
  // Bumped whenever the picker should reset to a clean slate (after a
  // successful submit) or reload with new prefilled datasets (a job row's
  // "Re-run") — `ExportPicker` only reads `initialDatasetIds` at mount, so a
  // `key` change is how the parent forces that.
  const [pickerKey, setPickerKey] = useState(0);
  const [prefillDatasetIds, setPrefillDatasetIds] = useState(initialDatasetIds);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const requestExport = useMutation(api.dataExports.requestExport);

  async function handleSubmit(args: ExportRequestArgs) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await requestExport(args);
      setPrefillDatasetIds(undefined);
      setPickerKey((k) => k + 1); // fresh, empty picker for the next request
    } catch (err) {
      setSubmitError(errorMessage(err, "Couldn't start the export — try again."));
    } finally {
      setSubmitting(false);
    }
  }

  function handleRerun(datasetIds: ExportDatasetId[]) {
    setSubmitError(null);
    setPrefillDatasetIds(datasetIds);
    setPickerKey((k) => k + 1);
  }

  return (
    <Screen>
      <Narrow>
        <Text className="mb-1 font-display text-2xl text-ink">Export data</Text>
        <Text className="mb-5 text-sm text-muted">
          Pick a scope and the datasets you need below, then download the
          finished files from the job list once they're ready. Every dataset
          you tick lands as its own self-contained spreadsheet.
        </Text>

        <ExportPicker
          key={pickerKey}
          scopes={scopes}
          scope={scope}
          onScopeChange={setScope}
          onSubmit={handleSubmit}
          submitting={submitting}
          submitError={submitError}
          initialDatasetIds={prefillDatasetIds}
        />

        <View className="mt-6">
          <ExportJobList scope={scope} onRerun={handleRerun} />
        </View>
      </Narrow>
    </Screen>
  );
}
