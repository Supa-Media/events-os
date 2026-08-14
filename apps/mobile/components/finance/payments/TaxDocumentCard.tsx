/**
 * FINANCES · PAYMENTS · The tax document, kept shut.
 *
 * A W-9 has a Social Security or EIN printed on it. This card therefore shows
 * METADATA ONLY — which form, its filename, when it arrived, which tax year —
 * and never the file. `api.contractorPayments.get` doesn't even return the
 * storage id, so there is nothing here that COULD be rendered inline.
 *
 * Opening it is a separate, deliberate press that calls
 * `api.contractorPayments.viewTaxDocument` — a MUTATION, not a query, precisely
 * so that every view writes an audit row before the URL exists. The screen says
 * that out loud next to the button: when the gate is a role rather than a named
 * person, the log is what makes the access answerable afterwards, and someone
 * about to open a stranger's SSN should know their name is going in a ledger.
 *
 * The button only renders when `canViewTaxDoc` — the caller's own answer from
 * the server (`hasContractorTaxDocView`), never a rank this screen re-derives.
 */
import { Text, View } from "react-native";
import {
  CONTRACTOR_TAX_DOC_KIND_LABELS,
  type ContractorTaxDocKind,
} from "@events-os/shared";
import { Badge, Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import type { ContractorTaxDocument } from "./helpers";

type Props = {
  taxDocument: ContractorTaxDocument | null;
  canViewTaxDoc: boolean;
  /** Calls `viewTaxDocument` and opens the returned URL. */
  onOpen: () => void;
  opening: boolean;
};

export function TaxDocumentCard({
  taxDocument,
  canViewTaxDoc,
  onOpen,
  opening,
}: Props) {
  if (!taxDocument) {
    return (
      <View className="mb-3 rounded-lg border border-border bg-raised px-4 py-3">
        <View className="flex-row items-center gap-2">
          <Icon name="file-text" size={14} color={colors.muted} />
          <Text className="flex-1 text-sm text-muted">
            No tax form on file yet — the contractor uploads it from their link.
          </Text>
        </View>
      </View>
    );
  }

  const kindLabel =
    CONTRACTOR_TAX_DOC_KIND_LABELS[taxDocument.kind as ContractorTaxDocKind] ??
    taxDocument.kind.toUpperCase();

  return (
    <View className="mb-3 rounded-lg border border-border bg-raised px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Icon name="file-text" size={14} color={colors.muted} />
        <Text className="text-sm font-semibold text-ink">{kindLabel}</Text>
        <Badge label="On file" tone="success" icon="check" />
        {taxDocument.isForeign ? (
          <Badge label="Foreign payee" tone="warn" icon="alert-triangle" />
        ) : null}
      </View>

      <Text className="mt-1.5 text-xs text-muted" numberOfLines={1}>
        {taxDocument.fileName}
      </Text>
      <Text className="mt-0.5 text-xs text-muted">
        Filed {formatDate(taxDocument.uploadedAt)} · tax year{" "}
        {taxDocument.taxYear}
      </Text>

      {canViewTaxDoc ? (
        <>
          <Button
            title={`Open the ${kindLabel}`}
            icon="external-link"
            variant="secondary"
            size="sm"
            className="mt-2.5 self-start"
            loading={opening}
            onPress={onOpen}
          />
          <Text className="mt-1.5 text-2xs text-faint">
            This form has a tax ID number on it. Opening it is recorded in the
            audit trail with your name and the time.
          </Text>
        </>
      ) : (
        <Text className="mt-2 text-2xs text-faint">
          You can see that the form is on file, but not open it.
        </Text>
      )}
    </View>
  );
}
