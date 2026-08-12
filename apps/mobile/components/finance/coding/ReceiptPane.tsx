/**
 * THE RECEIPT, BIG — the workbench panel's lead element (`CodingWorkbenchPanel`,
 * `explain.tsx`).
 *
 * Founder, verbatim: "review needs to be able to quickly — click on the row,
 * okay, see the receipt, like big, really big, and able to view it, whether
 * it's PDF, whether it's an image... even the ability to just pinch on my
 * screen to be able to zoom into a particular section." This is that: the
 * SAME zoomable/pannable/paged frame `ReceiptViewerModal` opens
 * (`FileViewerFrame`, `../../ui/FileViewer.tsx`), just mounted inline instead
 * of behind a click and a modal — so it's already open when the row is
 * selected, not one more tap away.
 *
 * A charge with no receipt at all shows the EXCEPTION/no-receipt state, never
 * a broken frame — `hasReceipt`/`hasApprovedException` come straight off the
 * row (`txnSummary`), so that decision is made before any query resolves.
 *
 * `api.receipts.listForTransaction` is bookkeeper+ gated (`requireFinanceRole`)
 * — fine for this pane's only host today, `explain.tsx`, which is itself
 * gated behind ledger-console access (never lower than a finance viewer, and
 * a finance viewer opening THEIR OWN chapter's month can be below
 * bookkeeper — see `requireLedgerConsole`). So the query is wrapped in its
 * own small error boundary: a FORBIDDEN here degrades to "open it from the
 * record below" instead of taking the whole panel down. The coding form
 * underneath (`FinishChargeSheetBody` → `CodingDocumentation` → `ReceiptCell`)
 * already handles that same access boundary today by staying inert until
 * clicked, so this is strictly no worse than the pre-panel behavior, just
 * more visible.
 *
 * THE BOUNDARY IS KEYED BY `transactionId` (`ReceiptPane`'s render, below).
 * An error boundary's `state` survives ordinary re-renders — only a remount
 * clears it — so without a key, one 403'd row would leave every row selected
 * AFTER it stuck on "Couldn't load this receipt" too, even ones the caller
 * can perfectly well read: navigating past the bad row would never retry the
 * query for the next one. Keying by the transaction id forces React to
 * discard and recreate the boundary (and its state) on every row change, so
 * each row gets its own fresh attempt.
 */
import { Component, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon, FileViewerFrame } from "../../ui";
import { colors } from "../../../lib/theme";

/** Local, tiny error boundary — a FORBIDDEN/NOT_FOUND from the receipts query
 *  degrades this ONE pane, not the panel or the screen around it. Mirrors
 *  `components/finance/dashboard/parts.tsx#FinanceBoundary`, kept local
 *  rather than imported: that one's fallback assumes a full-screen layout,
 *  this one has to fit inside a fixed-height card — but it keeps the SAME
 *  "Check again" affordance (#657) rather than a dead-end message, for the
 *  same-row case: a transient failure (a dropped connection, a query that
 *  raced ahead of a permission grant) clears without navigating away and
 *  back, which is the only thing that would otherwise remount this boundary
 *  (see the module doc above on why the key matters). */
class ReceiptBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <View className="h-full w-full items-center justify-center gap-2 px-8 py-16">
          <Icon name="alert-triangle" size={26} color={colors.faint} />
          <Text className="text-center text-sm font-semibold text-ink">
            Couldn&apos;t load this receipt
          </Text>
          <Text className="text-center text-xs text-muted">
            Open it from the record below instead.
          </Text>
          <Pressable
            onPress={() => this.setState({ failed: false })}
            accessibilityRole="button"
            className="mt-1 active:opacity-70"
          >
            <Text className="text-xs font-semibold text-accent">Check again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

/** The three "nothing to render (yet)" states — light card, not the dark
 *  photo-viewing backdrop `LoadedReceipt` uses. Rendered by `ReceiptPane`
 *  itself in its OWN normal-background box, never nested inside the dark one,
 *  so the light-theme text this uses stays legible. */
function NoReceiptState({
  icon,
  title,
  detail,
}: {
  icon: "file" | "edit-3" | "alert-triangle";
  title: string;
  detail: string;
}) {
  return (
    <View className="h-full w-full items-center justify-center gap-2 px-8 py-16">
      <Icon name={icon} size={26} color={colors.faint} />
      <Text className="text-center text-sm font-semibold text-ink">{title}</Text>
      <Text className="text-center text-xs text-muted">{detail}</Text>
    </View>
  );
}

function LoadedReceipt({ transactionId }: { transactionId: Id<"transactions"> }) {
  const receipts = useQuery(api.receipts.listForTransaction, { transactionId });
  const [index] = useState(0);

  // Near-opaque dark backdrop, matching `ReceiptViewerModal`'s own viewer —
  // deliberately NOT the light `NoReceiptState` background: a photo or PDF
  // page reads best against dark, the same reason the full-screen modal uses
  // it. Only mounted here, once there's real image content to show against it.
  return (
    <View className="flex-1" style={{ backgroundColor: "rgba(20, 6, 6, 0.985)" }}>
      {receipts === undefined ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-raised/80">Loading…</Text>
        </View>
      ) : !receipts[index] ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-raised">
            The row says a receipt is attached, but it couldn&apos;t be found.
            Open it from the record below.
          </Text>
        </View>
      ) : (
        <FileViewerFrame
          uri={receipts[index].url ?? ""}
          contentType={receipts[index].contentType}
          filename={receipts[index].filename}
          caption={
            receipts.length > 1
              ? `${receipts[index].filename ?? "Receipt"} (1 of ${receipts.length})`
              : (receipts[index].filename ?? undefined)
          }
        />
      )}
    </View>
  );
}

export function ReceiptPane({
  transactionId,
  hasReceipt,
  hasApprovedException,
}: {
  transactionId: Id<"transactions">;
  hasReceipt: boolean;
  hasApprovedException: boolean;
}) {
  return (
    <View
      className="w-full overflow-hidden rounded-xl border border-border bg-sunken"
      style={{ height: 420 }}
    >
      {hasReceipt ? (
        // Keyed by transactionId — see the module doc above on why an
        // unkeyed boundary here would latch a 403 across row navigation.
        <ReceiptBoundary key={transactionId}>
          <LoadedReceipt transactionId={transactionId} />
        </ReceiptBoundary>
      ) : hasApprovedException ? (
        <NoReceiptState
          icon="edit-3"
          title="No receipt — documented by an approved exception"
          detail="See the exception's reason and any evidence in the record below."
        />
      ) : (
        <NoReceiptState
          icon="file"
          title="No receipt attached"
          detail="Attach one, or file an exception, in the record below."
        />
      )}
    </View>
  );
}
