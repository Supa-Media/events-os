/**
 * RECEIPTS TAB — Library section: every receipt document in the org, backed by
 * `api.receipts.listReceipts`. Filter chips (All / Unmatched / Matched /
 * Duplicates / Archived) are server-side, mirroring the Inbox section and
 * Reconcile's filter-pill idiom.
 *
 * A DATABASE VIEW, not a card wall (founder ask, 2026-07-24: "the receipt page
 * can also benefit from being more of a database view with actionable columns,
 * maybe make the rows taller so the receipt thumbnail can be seen"). Built on
 * the shared `DataGrid` shell + `GridHeaderCell`, so it reads as the same
 * system as Reconcile and the Giving grids rather than a third idiom. Columns
 * are drag-resizable and remembered per-browser via `useResizableColumns`,
 * exactly like the Reconcile grid.
 *
 * INSPECTING WITHOUT LEAVING THE LIST (same ask: "allow people to somehow
 * easily and quickly view and inspect receipts... I'm even thinking an on
 * hover expansion of the image"):
 *   - rows are tall enough to actually read the thumbnail,
 *   - HOVERING a thumbnail floats a large preview beside the cursor
 *     (`useHoverImagePreview`, web only — hover has no touch equivalent),
 *   - PRESSING the thumbnail opens the full `ImageLightbox` (works
 *     everywhere, and is the native path),
 *   - pressing anywhere else on the row opens the detail modal as before.
 *
 * The receipt LIBRARY IS ORG-WIDE (founder decision, 2026-07-24 — see
 * `schema/finances.ts`'s `chapterId` doc), so the Origin column is load-bearing:
 * it's what tells a bookkeeper whose receipt they're looking at now that
 * nothing is filtered out by chapter.
 */
import { Image, Pressable, Text, View } from "react-native";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  EmptyState,
  GridCell,
  GridContainer,
  GridHeaderCell,
  GridHeaderRow,
  GridRow,
  Icon,
  ImageLightbox,
  Pill,
  useHoverImagePreview,
  useResizableColumns,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { isReceiptExtractionActive } from "@events-os/shared";
import {
  formatCents,
  isPdfReceipt,
  isDocumentReceipt,
  senderClassLabel,
  senderClassTone,
  LIBRARY_FILTERS,
  type LibraryFilterKey,
  type ReceiptRow,
} from "./helpers";

const SOURCE_LABEL: Record<ReceiptRow["source"], string> = {
  email: "Emailed",
  upload: "Uploaded",
  sms: "Texted",
};

// Default column widths (px) — drag-resizable + remembered per browser, same
// mechanism as the Reconcile grid. `preview` is deliberately generous: the
// whole point of the taller rows is that the thumbnail is legible at a glance.
const DEFAULT_COLS = {
  preview: 84,
  amount: 108,
  date: 120,
  merchant: 190,
  origin: 180,
  tags: 150,
  status: 160,
} as const;
type ColKey = keyof typeof DEFAULT_COLS;
const LIBRARY_COLUMNS_STORAGE_KEY = "receipts-library-columns";
/** Tall enough to read a receipt thumbnail rather than guess at it. */
const ROW_HEIGHT = 76;

export function LibrarySection({
  filter,
  onFilterChange,
  onOpenReceipt,
}: {
  filter: LibraryFilterKey;
  onFilterChange: (f: LibraryFilterKey) => void;
  onOpenReceipt: (receiptId: Id<"receipts">) => void;
}) {
  const rows = useQuery(api.receipts.listReceipts, { filter });
  const byId = new Map<Id<"receipts">, ReceiptRow>((rows ?? []).map((r) => [r._id, r]));
  const { widths, startResize } = useResizableColumns<ColKey>(
    LIBRARY_COLUMNS_STORAGE_KEY,
    DEFAULT_COLS,
  );
  const { wrapperRef, onWrapperLayout, hoverProps, layer } = useHoverImagePreview();
  // The full-size viewer a thumbnail press opens (the native + click path).
  const [lightbox, setLightbox] = useState<{
    uri: string;
    caption?: string;
    isPdf?: boolean;
    isDocument?: boolean;
  } | null>(null);

  const tableWidth = (Object.values(widths) as number[]).reduce((sum, w) => sum + w, 0);

  return (
    // `relative` + the ref/layout pair anchor the floating hover preview, which
    // must live OUTSIDE the grid's horizontal ScrollView to escape its clipping.
    <View ref={wrapperRef} onLayout={onWrapperLayout} className="relative">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="font-display text-lg text-ink">Library</Text>
        {rows ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {rows.length} {rows.length === 1 ? "receipt" : "receipts"}
          </Text>
        ) : null}
      </View>

      <View className="mb-3 flex-row flex-wrap gap-2">
        {LIBRARY_FILTERS.map((f) => (
          <Pill key={f.key} label={f.label} selected={filter === f.key} onPress={() => onFilterChange(f.key)} />
        ))}
      </View>

      {rows === undefined ? (
        <View className="py-10">
          <EmptyState title="Loading receipts…" />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="image"
          title="No receipts yet"
          message="Upload one above, or ask the team to email receipts to receipts@publicworship.life."
        />
      ) : (
        <GridContainer width={tableWidth}>
          <GridHeaderRow>
            <GridHeaderCell label="" width={widths.preview} onResizeStart={startResize("preview")} />
            <GridHeaderCell label="Amount" width={widths.amount} onResizeStart={startResize("amount")} />
            <GridHeaderCell label="Date" width={widths.date} onResizeStart={startResize("date")} />
            <GridHeaderCell label="Merchant" width={widths.merchant} onResizeStart={startResize("merchant")} />
            <GridHeaderCell label="Origin" width={widths.origin} onResizeStart={startResize("origin")} />
            <GridHeaderCell label="Source" width={widths.tags} onResizeStart={startResize("tags")} />
            <GridHeaderCell label="Status" width={widths.status} onResizeStart={startResize("status")} />
          </GridHeaderRow>

          {rows.map((r, i) => (
            <ReceiptGridRow
              key={r._id}
              receipt={r}
              widths={widths}
              isLast={i === rows.length - 1}
              hoverProps={hoverProps}
              onOpenLightbox={setLightbox}
              onPress={() => onOpenReceipt(r._id)}
              onJumpToOriginal={
                r.duplicateOfReceiptId
                  ? () => onOpenReceipt(r.duplicateOfReceiptId as Id<"receipts">)
                  : undefined
              }
              original={r.duplicateOfReceiptId ? byId.get(r.duplicateOfReceiptId) : undefined}
            />
          ))}
        </GridContainer>
      )}

      {/* Floating hover preview — pointer-events:none, so hovering it can
          never steal the hover that's keeping it open. */}
      {layer}

      {lightbox ? (
        <ImageLightbox
          uri={lightbox.uri}
          caption={lightbox.caption}
          isPdf={lightbox.isPdf}
          isDocument={lightbox.isDocument}
          visible
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </View>
  );
}

function ReceiptGridRow({
  receipt,
  widths,
  isLast,
  hoverProps,
  onOpenLightbox,
  onPress,
  onJumpToOriginal,
  original,
}: {
  receipt: ReceiptRow;
  widths: Record<ColKey, number>;
  isLast: boolean;
  hoverProps: (uri: string | null | undefined) => object;
  onOpenLightbox: (v: {
    uri: string;
    caption?: string;
    isPdf?: boolean;
    isDocument?: boolean;
  }) => void;
  onPress: () => void;
  onJumpToOriginal?: () => void;
  original?: ReceiptRow;
}) {
  // Read-time clock for the in-flight badge below: it never has to TICK (the
  // row re-renders on every extraction state change — the query is reactive),
  // it just has to be current enough to apply the staleness rule.
  const now = Date.now();
  // No content-type from the backend — infer PDF from the filename extension
  // (see `helpers.ts#isPdfReceipt`'s doc; ONE definition shared with
  // `ReceiptDetailModal`).
  const isPdf = isPdfReceipt(receipt.filename);
  // An emailed receipt's `text/html` body is a DOCUMENT, not a photo —
  // `<Image>` can't decode it, so it takes the same framed treatment a PDF
  // does (see `isDocumentReceipt`).
  const isDoc = !isPdf && isDocumentReceipt(receipt.contentType);
  // A genuinely broken image URL (bad file, expired signed URL, ...) used to
  // just render nothing — now it degrades to the same icon treatment as "no
  // file" rather than silently blanking (mirrors `ReceiptDetailModal`'s
  // `imgFailed` state).
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = !!receipt.url && !isPdf && !isDoc && !imgFailed;
  // PDFs have no rendered preview to float (there's no persisted preview
  // image — see the PR's doc) — `null` uri makes `hoverProps` return no
  // handlers at all, so the hook's existing "nothing to show" path applies
  // instead of floating a blank white card.
  const hoverUri = isPdf || isDoc ? null : receipt.url;

  return (
    <GridRow
      onPress={onPress}
      isLast={isLast}
      accessibilityLabel={`Open receipt ${receipt.merchant ?? "unknown merchant"}`}
    >
      <GridCell width={widths.preview}>
        {/* Hover → float a big preview; press → full lightbox, keeping "look
            at this image" distinct from the row's "open the record". Nesting a
            Pressable inside a pressable row is the shape the old ReceiptCard
            already used (its duplicate-jump badge), so the responder system
            handles the inner press. When there's no image the Pressable is
            disabled and the press falls through to the row, which is the
            behavior you'd want anyway. */}
        <Pressable
          {...hoverProps(hoverUri)}
          onPress={() => {
            if (receipt.url) {
              onOpenLightbox({
                uri: receipt.url,
                caption: receipt.filename ?? undefined,
                isPdf,
                isDocument: isDoc,
              });
            }
          }}
          disabled={!receipt.url}
          accessibilityLabel={
            isPdf ? "View receipt PDF" : isDoc ? "View emailed receipt" : "View receipt image"
          }
          className="p-1.5"
          style={{ height: ROW_HEIGHT }}
        >
          <View
            className="h-full overflow-hidden rounded border border-border bg-sunken"
            style={{ width: widths.preview - 12 }}
          >
            {showImage ? (
              <Image
                // `showImage` already guarantees `receipt.url` is set — the
                // `?? undefined` is only to satisfy `ImageSourcePropType`,
                // which (unlike `ReceiptRow["url"]`) doesn't accept `null`.
                source={{ uri: receipt.url ?? undefined }}
                style={{ width: "100%", height: "100%" }}
                resizeMode="cover"
                onError={() => setImgFailed(true)}
              />
            ) : receipt.url && (isPdf || isDoc) ? (
              // Legible "this is a PDF, not a missing file" affordance — a
              // bare file-text icon reads identically to "no file at all",
              // which these two states must not.
              <View className="flex-1 items-center justify-center gap-0.5">
                <Icon name="file-text" size={16} color={colors.faint} />
                <Text className="text-2xs font-bold text-faint">
                  {isPdf ? "PDF" : "EMAIL"}
                </Text>
              </View>
            ) : (
              <View className="flex-1 items-center justify-center">
                <Icon name="file-text" size={18} color={colors.faint} />
              </View>
            )}
          </View>
        </Pressable>
      </GridCell>

      <GridCell width={widths.amount}>
        <Text className="px-2 py-1.5 text-sm font-semibold text-ink" numberOfLines={1}>
          {receipt.amountCents != null ? formatCents(receipt.amountCents) : "No amount"}
        </Text>
      </GridCell>

      <GridCell width={widths.date}>
        <Text className="px-2 py-1.5 text-xs text-muted" numberOfLines={1}>
          {receipt.receiptDate != null ? formatDate(receipt.receiptDate) : formatDate(receipt.createdAt)}
        </Text>
      </GridCell>

      <GridCell width={widths.merchant}>
        <View className="flex-1 px-2 py-1.5">
          <Text className="text-sm text-ink" numberOfLines={1}>
            {receipt.merchant ?? "Unknown merchant"}
          </Text>
          {receipt.filename ? (
            <Text className="text-2xs text-faint" numberOfLines={1}>
              {receipt.filename}
            </Text>
          ) : null}
        </View>
      </GridCell>

      {/* ORIGIN — load-bearing now that the library spans the whole org: it's
          how you tell your own chapter's receipt from someone else's. */}
      <GridCell width={widths.origin}>
        <View className="flex-1 px-2 py-1.5">
          <Text className="text-xs text-ink" numberOfLines={1}>
            {receipt.chapterName ?? "Unassigned"}
          </Text>
          {receipt.uploadedByName ? (
            <Text className="text-2xs text-faint" numberOfLines={1}>
              {receipt.uploadedByName}
            </Text>
          ) : null}
        </View>
      </GridCell>

      <GridCell width={widths.tags}>
        <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
          <Badge label={senderClassLabel(receipt.senderClass)} tone={senderClassTone(receipt.senderClass)} />
          <Badge label={SOURCE_LABEL[receipt.source]} tone="neutral" />
        </View>
      </GridCell>

      <GridCell width={widths.status}>
        <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
          {/* An in-flight read outranks both — a row that is being processed
              right now (or is queued behind a staggered batch) shouldn't read
              as a settled "Extraction failed" while that's still true. */}
          {isReceiptExtractionActive(receipt.extraction, now) ? (
            <Badge
              label={receipt.extraction?.status === "running" ? "Reading…" : "Queued"}
              tone="neutral"
              icon="refresh-cw"
            />
          ) : receipt.linkCount > 0 ? (
            <Text className="text-2xs font-semibold text-success">
              {receipt.linkCount} {receipt.linkCount === 1 ? "link" : "links"}
            </Text>
          ) : receipt.ocrError ? (
            <Badge label="Extraction failed" tone="danger" icon="alert-triangle" />
          ) : (
            <Text className="text-2xs text-faint">Unmatched</Text>
          )}
          {receipt.duplicateOfReceiptId ? (
            <Pressable onPress={onJumpToOriginal} hitSlop={4} className="flex-row items-center gap-1">
              <Badge label="DUPLICATE" tone="danger" icon="copy" />
              {original ? (
                <Text className="text-2xs text-faint" numberOfLines={1}>
                  of {original.merchant ?? formatCents(original.amountCents ?? 0)}
                </Text>
              ) : null}
            </Pressable>
          ) : receipt.softDuplicate ? (
            <Badge label="Possible duplicate" tone="warn" icon="alert-triangle" />
          ) : null}
          {receipt.archived ? <Badge label="Archived" tone="neutral" icon="archive" /> : null}
        </View>
      </GridCell>
    </GridRow>
  );
}
