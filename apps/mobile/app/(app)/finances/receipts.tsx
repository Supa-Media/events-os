/**
 * RECEIPTS — the receipt CRM home: "all receipts represented." Consumes the
 * `apps/convex/receipts.ts` module (+ `receiptInbox.ts`'s
 * `dismissInboundReceipt`) as-is — this screen owns no new backend surface.
 *
 * Three pieces, top to bottom:
 *  - `UploadZone` — mass upload (the owner's backfill workflow).
 *  - `InboxSection` — every inbound email still needing a look
 *    (`listInboundQueue`).
 *  - `LibrarySection` — every receipt document, filterable
 *    (`listReceipts`).
 * Tapping any receipt thumbnail across either section opens
 * `ReceiptDetailModal`, keyed by `receiptId` so switching receipts (e.g. via
 * a "duplicate of" jump) remounts its local edit state cleanly.
 *
 * Seat-gated like `reconcile.tsx`: real finance seats
 * (`financeRoles.mySeats`), never the old admin/lead org-tier check — a
 * no-seat member sees a friendly wall instead of mounting queries that would
 * throw (`requireFinanceRole` needs bookkeeper+ on every read here).
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { EmptyState, FULL_WIDTH, Narrow, Screen, ToastView } from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { UploadZone } from "../../../components/finance/receiptsTab/UploadZone";
import { InboxSection } from "../../../components/finance/receiptsTab/InboxSection";
import { LibrarySection } from "../../../components/finance/receiptsTab/LibrarySection";
import { ReceiptDetailModal } from "../../../components/finance/receiptsTab/ReceiptDetailModal";
import type { LibraryFilterKey } from "../../../components/finance/receiptsTab/helpers";

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Receipts is restricted"
      message="Only finance managers and bookkeepers can manage the receipt library."
    />
  );
}

export default function ReceiptsScreen() {
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (seats === undefined) return <Screen loading />;

  if (seats.length === 0) {
    return (
      <Screen>
        <Narrow>
          <NoFinanceAccess />
        </Narrow>
      </Screen>
    );
  }

  return (
    <FinanceBoundary fallback={<NoFinanceAccess />}>
      <ReceiptsBody />
    </FinanceBoundary>
  );
}

function ReceiptsBody() {
  const { run, toast, dismiss } = useActionRunner();
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilterKey>("all");
  const [openReceiptId, setOpenReceiptId] = useState<Id<"receipts"> | null>(null);

  return (
    <>
      <Screen maxWidth={FULL_WIDTH}>
        <Narrow>
          <View className="mb-1 flex-row items-baseline gap-2">
            <Text className="font-display text-2xl text-ink">Receipts</Text>
          </View>
          <Text className="mb-4 text-sm text-muted">
            Every receipt the chapter has — emailed to receipts@reply.publicworship.life
            or uploaded here — in one library. Review the inbox, match a receipt to a
            charge, or backfill a batch below.
          </Text>

          <View className="mb-4">
            <UploadZone run={run} onOpenReceipt={setOpenReceiptId} />
            <InboxSection run={run} onOpenReceipt={setOpenReceiptId} />
            <LibrarySection
              filter={libraryFilter}
              onFilterChange={setLibraryFilter}
              onOpenReceipt={setOpenReceiptId}
            />
          </View>
        </Narrow>
      </Screen>

      {openReceiptId ? (
        <ReceiptDetailModal
          key={openReceiptId}
          receiptId={openReceiptId}
          onClose={() => setOpenReceiptId(null)}
          onOpenReceipt={setOpenReceiptId}
          run={run}
        />
      ) : null}

      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
