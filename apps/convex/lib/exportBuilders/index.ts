/**
 * Builder registry — the one place `ExportDatasetId` meets its implementation.
 *
 * `getExportBuilder` is the ONLY way the runner reaches a builder. Keeping the
 * lookup here (rather than a switch in the runner) means adding a dataset is:
 * write the builder, add it to its module's array, add the id to
 * `EXPORT_DATASET_IDS` in `@events-os/shared`. The completeness test below is
 * what stops the third step from being forgotten.
 */
import { EXPORT_DATASET_IDS, type ExportDatasetId } from "@events-os/shared";
import type { ExportBuilder } from "./types";
import { peopleBuilders } from "./people";
import { formSubmissionsBuilders } from "./formSubmissions";
import { eventsAndParticipationBuilders } from "./eventsAndParticipation";
import { workBuilders } from "./work";
import { givingBuilders } from "./giving";
import { financeBuilders } from "./finance";
import { academyBuilders } from "./academy";

const ALL_BUILDERS: readonly ExportBuilder[] = [
  ...peopleBuilders,
  ...formSubmissionsBuilders,
  ...eventsAndParticipationBuilders,
  ...workBuilders,
  ...givingBuilders,
  ...financeBuilders,
  ...academyBuilders,
];

const BY_ID = new Map<string, ExportBuilder>(
  ALL_BUILDERS.map((b) => [b.datasetId, b]),
);

/** The builder for a dataset, or `null` if none is registered.
 *
 *  Returning null rather than throwing is deliberate: a job row persists the
 *  dataset ids it was created with FOREVER (it's an audit record), so a job
 *  from before a dataset was retired must still be readable. The runner turns
 *  a null into a skipped file with a recorded reason, not a crash. */
export function getExportBuilder(datasetId: string): ExportBuilder | null {
  return BY_ID.get(datasetId) ?? null;
}

/** Dataset ids declared in shared that have no builder yet. Asserted empty by
 *  `tests/dataExports.test.ts` — this is what makes "the picker offers a
 *  dataset that produces an empty file" impossible to ship. */
export function unimplementedDatasetIds(): ExportDatasetId[] {
  return EXPORT_DATASET_IDS.filter((id) => !BY_ID.has(id));
}

/** Builders registered under an id that shared doesn't declare (a typo, or a
 *  dataset removed from the registry but not from its module). */
export function orphanBuilderIds(): string[] {
  const declared = new Set<string>(EXPORT_DATASET_IDS);
  return [...BY_ID.keys()].filter((id) => !declared.has(id));
}
