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
 * — fine for this pane's original host, `explain.tsx`, which is itself gated
 * behind ledger-console access (never lower than a finance viewer, and a
 * finance viewer opening THEIR OWN chapter's month can be below bookkeeper —
 * see `requireLedgerConsole`). So the query is wrapped in its own small error
 * boundary: a FORBIDDEN here degrades to "open it from the record below"
 * instead of taking the whole panel down. The coding form underneath
 * (`FinishChargeSheetBody` → `CodingDocumentation` → `ReceiptCell`) already
 * handles that same access boundary today by staying inert until clicked, so
 * this is strictly no worse than the pre-panel behavior, just more visible.
 *
 * THE BOUNDARY IS KEYED BY `transactionId` (`ReceiptPane`'s render, below).
 * An error boundary's `state` survives ordinary re-renders — only a remount
 * clears it — so without a key, one 403'd row would leave every row selected
 * AFTER it stuck on "Couldn't load this receipt" too, even ones the caller
 * can perfectly well read: navigating past the bad row would never retry the
 * query for the next one. Keying by the transaction id forces React to
 * discard and recreate the boundary (and its state) on every row change, so
 * each row gets its own fresh attempt.
 *
 * ── `canViewList`: the SECOND host, `coding.tsx`'s "yours to code" list ──────
 * That list is `finances.personTransactions` — reachable by a cardholder with
 * NO finance seat at all, not just a below-bookkeeper viewer. For that caller,
 * an error boundary catching a per-row FORBIDDEN would still mean firing the
 * gated query on every receipted row before it fails — a 403 the caller was
 * never going to be allowed past, on every row, every time the panel opens.
 * So `coding.tsx` probes ONCE PER SCREEN, not per row (`receipts.canViewList`
 * — the non-throwing `has` form of the same `requireFinanceRole(bookkeeper)`
 * check `listForTransaction` itself runs) and threads the answer down as
 * `canViewList`. `false` skips the query entirely and renders the row's own
 * receipt STATE (attached / missing / exception) plus the SAME upload
 * affordance (`ReceiptCell`) `ChargeRow`/`CodingDocumentation` already show
 * that caller elsewhere on this exact screen — nothing new is exposed, the
 * fetched preview is just not attempted. Defaults to `true`, which is exactly
 * `explain.tsx`'s original behavior (always attempt the fetch, let the
 * boundary above catch the rare below-bookkeeper case) — that host never
 * needs to compute or pass this.
 *
 * ── More than one receipt, and taking one off ────────────────────────────────
 * Founder, 2026-10-24, looking at a storage-unit invoice attached to a Google
 * charge in this pane: "I need to be able to remove this attachment (I
 * uploaded it by mistake)… We also need to be able to attach more than one
 * receipt at a time." A charge can carry several receipts (`receiptLinks` is
 * many-to-many), so the pane pages through them, and under the frame offers
 * Remove (this receipt) and Add receipts (several files at once) — each drawn
 * only when `transactionReceipts.permissions` says the caller holds it.
 */
import { Component, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  useMutation,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Icon, FileViewerFrame, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { confirmAction } from "../../../lib/confirmAction";
import { useActionRunner } from "../../../lib/useActionToast";
import { ReceiptCell } from "../reconcile/ReconcileList";
import { ReceiptViewerModal } from "../receipts/ReceiptViewerModal";
import { pickReceiptFiles, uploadReceiptFile } from "../receipts/pickReceiptFiles";

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

/**
 * `canViewList === false`'s whole pane — no fetch attempted at all (see the
 * module doc's `canViewList` section). Shows the same STATE the row itself
 * already carries (`hasReceipt`/`hasApprovedException`, both denormalized —
 * no query needed to know them) and, when a receipt is genuinely missing, the
 * SAME `ReceiptCell` upload affordance `ChargeRow`/`CodingDocumentation`
 * render for this caller elsewhere on this screen (`libraryPicker={false}`,
 * matching `CodingDocumentation`'s own care — that picker's queries are
 * bookkeeper-gated too).
 *
 * DELIBERATELY does not render `ReceiptCell` for the ATTACHED case: that
 * variant's tap opens `ReceiptViewerModal`, which itself calls
 * `listForTransaction` — reintroducing, on a click, exactly the gated fetch
 * this whole pane exists to avoid firing at all. The "attached" state here is
 * inert text only; the record below (`FinishChargeSheetBody`) is where this
 * caller has always gone to work with a receipt they can't preview here.
 */
function UploadStateRegion({
  transactionId,
  hasReceipt,
  hasApprovedException,
}: {
  transactionId: Id<"transactions">;
  hasReceipt: boolean;
  hasApprovedException: boolean;
}) {
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const [viewerOpen, setViewerOpen] = useState(false);

  if (hasReceipt) {
    // The viewer reads through `useQueries` (a refusal costs only its own
    // contents), and `listForTransaction` admits the charge's own spender —
    // so this is where that caller sees, adds to, or removes their receipts.
    return (
      <View className="h-full w-full items-center justify-center gap-3 px-8 py-16">
        <Icon name="file" size={26} color={colors.faint} />
        <Text className="text-center text-sm font-semibold text-ink">
          Receipt attached
        </Text>
        <Button
          title="View or change receipts"
          size="sm"
          variant="secondary"
          icon="file"
          onPress={() => setViewerOpen(true)}
        />
        {viewerOpen ? (
          <ReceiptViewerModal
            transactionId={transactionId}
            readOnly
            onClose={() => setViewerOpen(false)}
          />
        ) : null}
      </View>
    );
  }
  if (hasApprovedException) {
    return (
      <NoReceiptState
        icon="edit-3"
        title="No receipt — documented by an approved exception"
        detail="See the exception's reason and any evidence in the record below."
      />
    );
  }
  return (
    <View className="h-full w-full items-center justify-center gap-3 px-8 py-16">
      <Icon name="file" size={26} color={colors.faint} />
      <Text className="text-center text-sm font-semibold text-ink">
        No receipt attached
      </Text>
      <Text className="text-center text-xs text-muted">
        Attach one below, or file an exception in the record below.
      </Text>
      <ReceiptCell
        hasReceipt={false}
        reminderStage="none"
        transactionId={transactionId}
        libraryPicker={false}
        onUpload={async (storageId, filename) => {
          await attachReceipt({
            transactionId,
            storageId,
            ...(filename ? { filename } : {}),
          });
        }}
        generateUploadUrl={generateUploadUrl}
      />
    </View>
  );
}

type ReceiptPermissions = FunctionReturnType<
  typeof api.transactionReceipts.permissions
>;

function LoadedReceipt({ transactionId }: { transactionId: Id<"transactions"> }) {
  const receipts = useQuery(api.receipts.listForTransaction, { transactionId });
  // Permissions read through `useQueries` so a refusal hides the buttons
  // rather than throwing into this pane's boundary.
  const request = useMemo<RequestForQueries>(
    () => ({
      perms: {
        query: api.transactionReceipts.permissions,
        args: { transactionId },
      },
    }),
    [transactionId],
  );
  const permsRaw = useQueries(request).perms;
  const perms =
    permsRaw instanceof Error
      ? undefined
      : (permsRaw as ReceiptPermissions | undefined);
  const [picked, setPicked] = useState(0);
  // Clamp: a receipt just removed can leave the index past the end.
  const index =
    receipts && receipts.length > 0 ? Math.min(picked, receipts.length - 1) : 0;
  const current = receipts?.[index];

  return (
    <View className="flex-1">
      {/* Near-opaque dark backdrop, matching `ReceiptViewerModal`'s own
          viewer — deliberately NOT the light `NoReceiptState` background: a
          photo or PDF page reads best against dark, the same reason the
          full-screen modal uses it. */}
      <View className="flex-1" style={{ backgroundColor: "rgba(20, 6, 6, 0.985)" }}>
        {receipts === undefined ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-sm text-raised/80">Loading…</Text>
          </View>
        ) : !current ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-center text-sm text-raised">
              No receipt is attached to this charge any more.
            </Text>
          </View>
        ) : (
          <FileViewerFrame
            // Keyed so paging to another receipt resets zoom and page.
            key={current._id}
            uri={current.url ?? ""}
            contentType={current.contentType}
            filename={current.filename}
            caption={
              receipts.length > 1
                ? `${current.filename ?? "Receipt"} (${index + 1} of ${receipts.length})`
                : (current.filename ?? undefined)
            }
          />
        )}
      </View>
      <ReceiptActions
        transactionId={transactionId}
        current={current ?? null}
        count={receipts?.length ?? 0}
        index={index}
        onIndex={setPicked}
        perms={perms}
      />
    </View>
  );
}

/** The strip under the big frame: page between receipts, remove this one,
 *  add more. Renders nothing a caller couldn't use. */
function ReceiptActions({
  transactionId,
  current,
  count,
  index,
  onIndex,
  perms,
}: {
  transactionId: Id<"transactions">;
  current: { _id: Id<"receipts">; filename: string | null } | null;
  count: number;
  index: number;
  onIndex: (i: number) => void;
  perms: ReceiptPermissions | undefined;
}) {
  const removeReceipt = useMutation(api.transactionReceipts.removeReceipt);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState(false);

  const canRemove = perms?.canRemove === true && current != null;
  const canAttach = perms?.canAttach === true;
  if (count <= 1 && !canRemove && !canAttach && !perms?.removeLockedByApproval) {
    return null;
  }

  function remove() {
    if (!current) return;
    const receiptId = current._id;
    confirmAction({
      title: "Remove this receipt?",
      message: `${current.filename ?? "This receipt"} comes off this charge. The file stays in the receipt library, so it can still be attached to the right charge.`,
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () => {
        setRemoving(true);
        void run(() => removeReceipt({ transactionId, receiptId }), {
          errorTitle: "Couldn't remove receipt",
        }).finally(() => setRemoving(false));
      },
    });
  }

  async function add() {
    const files = await pickReceiptFiles();
    if (files.length === 0) return;
    setAdding(true);
    try {
      for (const file of files) {
        const done = await run(
          async () => {
            const storageId = await uploadReceiptFile(file, generateUploadUrl);
            await attachReceipt({
              transactionId,
              storageId,
              ...(file.filename ? { filename: file.filename } : {}),
            });
            return true;
          },
          { errorTitle: "Couldn't attach receipt" },
        );
        if (!done) break;
      }
    } finally {
      setAdding(false);
    }
  }

  return (
    <View className="gap-2 border-t border-border bg-raised px-3 py-2">
      <View className="flex-row flex-wrap items-center gap-2">
        {count > 1 ? (
          <View className="flex-row items-center gap-1">
            <Pressable
              onPress={() => onIndex(Math.max(0, index - 1))}
              disabled={index === 0}
              accessibilityRole="button"
              accessibilityLabel="Previous receipt"
              hitSlop={6}
              className="rounded-md p-1 active:opacity-70 disabled:opacity-40"
            >
              <Icon name="chevron-left" size={16} color={colors.muted} />
            </Pressable>
            <Text className="text-xs text-muted">
              {index + 1} of {count}
            </Text>
            <Pressable
              onPress={() => onIndex(Math.min(count - 1, index + 1))}
              disabled={index >= count - 1}
              accessibilityRole="button"
              accessibilityLabel="Next receipt"
              hitSlop={6}
              className="rounded-md p-1 active:opacity-70 disabled:opacity-40"
            >
              <Icon name="chevron-right" size={16} color={colors.muted} />
            </Pressable>
          </View>
        ) : null}
        <View className="flex-1" />
        {canRemove ? (
          <Button
            title="Remove"
            size="sm"
            variant="danger"
            icon="x-circle"
            loading={removing}
            disabled={adding}
            onPress={remove}
          />
        ) : null}
        {canAttach ? (
          <Button
            title="Add receipts"
            size="sm"
            variant="secondary"
            icon="upload"
            loading={adding}
            disabled={removing}
            onPress={() => void add()}
          />
        ) : null}
      </View>
      {perms?.removeLockedByApproval ? (
        <Text className="text-2xs text-muted">
          Coding approved, so these receipts are locked. Ask a bookkeeper if
          one is wrong.
        </Text>
      ) : null}
      {toast ? <ToastView toast={toast} onDismiss={dismiss} /> : null}
    </View>
  );
}

export function ReceiptPane({
  transactionId,
  hasReceipt,
  hasApprovedException,
  canViewList = true,
}: {
  transactionId: Id<"transactions">;
  hasReceipt: boolean;
  hasApprovedException: boolean;
  /** Whether the caller may call `receipts.listForTransaction` at all — see
   *  the module doc's `canViewList` section. Defaults `true`: `explain.tsx`
   *  never passes this and keeps its exact original behavior. */
  canViewList?: boolean;
}) {
  if (!canViewList) {
    return (
      <View
        className="w-full overflow-hidden rounded-xl border border-border bg-sunken"
        style={{ height: 420 }}
      >
        <UploadStateRegion
          transactionId={transactionId}
          hasReceipt={hasReceipt}
          hasApprovedException={hasApprovedException}
        />
      </View>
    );
  }
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
