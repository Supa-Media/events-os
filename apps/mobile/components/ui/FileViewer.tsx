/**
 * FILE VIEWER — the ONE way a stored file is looked at, everywhere.
 *
 * Every receipt surface opens this: the "Attached" chip (Reconcile,
 * Transaction Detail, My transactions, the Money view), the receipts library
 * and its detail modal, the inbox queue, the receipt-suggestion strip, and
 * receipt-exception evidence. One component, one behaviour.
 *
 * WHAT IT REPLACES, and why each of those was a real complaint:
 *
 *  - `ReceiptViewerModal` had NO viewer at all. Tapping a receipt called
 *    `Linking.openURL` — on web, a new browser tab. Even a plain photo left
 *    the app ("having to open up in another site"). A PDF got a broken
 *    `<Image>` first, then the same new tab.
 *  - `ImageLightbox` opened in place but handed documents to an `<iframe>`:
 *    the browser's own PDF plugin, with its own toolbar, its own zoom, and a
 *    fresh download on every mount ("PDF views not reloading"). An image and
 *    a PDF behaved like two different products.
 *  - Nothing anywhere had zoom, so a phone photo of a thermal receipt — the
 *    single most common case — could not actually be read.
 *
 * THE MODEL: everything becomes a bitmap and goes through the SAME zoomable,
 * pannable pane. A photo is a bitmap already; a PDF page is rendered to one
 * (`lib/pdfPages`, using the `pdfjs-dist` that was already in this package).
 * So zoom, pan, fit and reset work identically no matter what the reviewer
 * tapped, and paging through a multi-page PDF happens in place.
 *
 * WHAT KIND OF FILE IS IT: `@events-os/shared#receiptFileKind` — the single
 * detector, keyed on the stored content type with the filename as fallback.
 * Never the URL: a Convex storage URL carries no extension (that assumption
 * is what made receipt-exception evidence render blank 100% of the time).
 *
 * FAILING VISIBLY: `"unknown"` renders optimistically as an image, because
 * that is what an unlabelled receipt almost always is. If that decode fails —
 * or a PDF won't render, or we're on native where there is no canvas — the
 * pane shows an explicit state saying so, with an action to open/download the
 * original. There is no path here that produces a blank box.
 *
 * NATIVE: PDFs and HTML documents can't be rendered inline (no canvas, no
 * iframe), so they get that same explicit state plus "Open". Images —
 * including everything `"unknown"` — zoom and pan on native exactly as on web.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { receiptFileKind } from "@events-os/shared";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";
import { renderPdfPage, supportsInlinePdf, type PdfPage } from "../../lib/pdfPages";
import { sniffFileKind, type SniffedKind } from "../../lib/sniffFile";
import {
  clampPage,
  clampZoom,
  MIN_ZOOM,
  stepZoom,
} from "../../lib/pdfPages.shared";

/** How long a double-press window is, for tap-to-zoom. */
const DOUBLE_PRESS_MS = 280;
/** What a double-press zooms TO, when starting from fit. */
const DOUBLE_PRESS_ZOOM = 2.5;

export function FileViewer({
  uri,
  visible,
  onClose,
  caption,
  contentType,
  filename,
}: {
  uri: string;
  visible: boolean;
  onClose: () => void;
  /** Shown at the top — usually the filename, or what this file IS (e.g.
   *  "Evidence of purchase — not a receipt"). */
  caption?: string;
  /** The STORED content type (`_storage`), straight off the receipt row. The
   *  primary signal for how to render — see `receiptFileKind`. */
  contentType?: string | null;
  /** The original filename. The fallback signal, and the download name. */
  filename?: string | null;
}) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* Near-opaque on purpose. A translucent backdrop let the list behind
          show through the receipt, which is exactly the wrong thing when the
          job is READING a document — and an explicit rgba beats a Tailwind
          opacity modifier here, which resolved much lighter than /95 suggests. */}
      <View className="flex-1" style={{ backgroundColor: "rgba(20, 6, 6, 0.985)" }}>
        <FileViewerFrame
          uri={uri}
          onClose={onClose}
          caption={caption}
          contentType={contentType}
          filename={filename}
        />
      </View>
    </Modal>
  );
}

/**
 * THE FRAME — toolbar + zoomable pane, with no opinion about what hosts it.
 * `FileViewer` above mounts this inside its full-screen `Modal`, unchanged
 * from before this was split out. `ReceiptPane` (the coding workbench panel,
 * `explain.tsx`) mounts the SAME frame inline, big, beside the coding form —
 * no modal, so the list stays visible and clickable beside it (the founder's
 * own words: "rather than a modal that... blocks your ability to... click
 * quickly on other things"). One implementation of zoom/pan/paging/PDF/pinch,
 * so a receipt behaves identically wherever it's opened from.
 */
export function FileViewerFrame({
  uri,
  onClose,
  caption,
  contentType,
  filename,
}: {
  uri: string;
  /** Omit for an inline/embedded host with no "this" to close — hides the ×
   *  button and the Esc shortcut. `FileViewer`'s Modal always passes one. */
  onClose?: () => void;
  caption?: string;
  contentType?: string | null;
  filename?: string | null;
}) {
  const declared = useMemo(
    () => receiptFileKind({ contentType, filename }),
    [contentType, filename],
  );
  // What the file's own BYTES turned out to be, once an optimistic image
  // render has failed and `ImagePane` has gone and looked. It overrides the
  // declared kind — the bytes are never wrong — and it is held HERE rather
  // than inside the image pane so a rescued PDF gets the real PDF branch,
  // with its page controls and its zoom-driven re-render, instead of a
  // one-page copy nested inside a pane that can't page.
  const [sniffed, setSniffed] = useState<SniffedKind | null>(null);
  const kind = sniffed ?? declared;

  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);

  // A different file (a new row selected in the panel, or a re-open of the
  // modal) starts from fit, page one — a viewer that remembers the last
  // receipt's zoom is disorienting on the next one.
  useEffect(() => {
    setZoom(MIN_ZOOM);
    setPage(1);
    setPageCount(1);
    setSniffed(null);
  }, [uri]);

  const zoomBy = useCallback((direction: 1 | -1) => {
    setZoom((z) => stepZoom(z, direction));
  }, []);

  const goToPage = useCallback(
    (next: number) => setPage((p) => clampPage(next, pageCount) || p),
    [pageCount],
  );

  // ── Keyboard, on web. Esc closes (modal host only), +/-/0 zoom, ←/→ page.
  // RN-Web's `<Modal>` does not wire Esc itself, and a viewer a reviewer has
  // to reach for the mouse to dismiss is exactly the friction this whole
  // change is about. Guarded against a focused text input so the SAME
  // shortcuts don't hijack typing in the coding form sitting right below this
  // frame in the panel host (`-`/`0`/arrows are all things a person types
  // into a note or a headcount field). ──
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof document === "undefined") return;
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      if (e.key === "Escape") return onClose?.();
      if (e.key === "+" || e.key === "=") return zoomBy(1);
      if (e.key === "-" || e.key === "_") return zoomBy(-1);
      if (e.key === "0") return setZoom(MIN_ZOOM);
      if (e.key === "ArrowRight") return setPage((p) => clampPage(p + 1, pageCount));
      if (e.key === "ArrowLeft") return setPage((p) => clampPage(p - 1, pageCount));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, zoomBy, pageCount]);

  const multiPage = kind === "pdf" && pageCount > 1;

  return (
    <>
      {/* Toolbar. Always present, for every file kind — the reviewer should
          not have to work out which controls this particular file got. */}
      <View className="flex-row items-center gap-2 px-4 pb-3 pt-5">
        <Text className="flex-1 text-sm text-raised/80" numberOfLines={1}>
          {caption ?? filename ?? ""}
        </Text>

        {multiPage ? (
          <View className="mr-1 flex-row items-center gap-1">
            <ToolbarButton
              icon="chevron-left"
              label="Previous page"
              disabled={page <= 1}
              onPress={() => goToPage(page - 1)}
            />
            <Text className="min-w-[68px] text-center text-xs text-raised/80">
              Page {page} of {pageCount}
            </Text>
            <ToolbarButton
              icon="chevron-right"
              label="Next page"
              disabled={page >= pageCount}
              onPress={() => goToPage(page + 1)}
            />
          </View>
        ) : null}

        <ToolbarButton
          icon="zoom-out"
          label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onPress={() => zoomBy(-1)}
        />
        <Pressable
          onPress={() => setZoom(MIN_ZOOM)}
          accessibilityRole="button"
          accessibilityLabel="Reset zoom"
          className="rounded-md px-1.5 py-1 active:opacity-70"
        >
          <Text className="min-w-[44px] text-center text-xs font-semibold text-raised">
            {Math.round(zoom * 100)}%
          </Text>
        </Pressable>
        <ToolbarButton icon="zoom-in" label="Zoom in" onPress={() => zoomBy(1)} />
        <ToolbarButton
          icon="download"
          label="Download original"
          onPress={() => void Linking.openURL(uri)}
        />
        {onClose ? (
          <ToolbarButton icon="x" label="Close" size={22} onPress={onClose} />
        ) : null}
      </View>

      <ZoomPane zoom={zoom} onZoom={setZoom}>
        {kind === "pdf" ? (
          <PdfPane
            uri={uri}
            page={page}
            zoom={zoom}
            onPageCount={setPageCount}
            filename={filename}
          />
        ) : kind === "document" ? (
          <DocumentPane uri={uri} caption={caption ?? filename ?? "Receipt"} />
        ) : kind === "missing" ? (
          <Unrenderable
            uri={uri}
            title="This file couldn't be loaded"
            detail="It may have been deleted, or the connection dropped. The receipt record itself is unchanged."
          />
        ) : (
          <ImagePane
            uri={uri}
            caption={caption ?? filename ?? "Receipt"}
            onSniffed={setSniffed}
          />
        )}
      </ZoomPane>
    </>
  );
}

function ToolbarButton({
  icon,
  label,
  onPress,
  disabled,
  size = 18,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      className={`rounded-md p-1 ${disabled ? "opacity-30" : "active:opacity-70"}`}
    >
      <Icon name={icon} size={size} color={colors.raised} />
    </Pressable>
  );
}

/**
 * The zoom/pan surface — deliberately built from a nested pair of plain
 * `ScrollView`s and an explicitly-sized child, with NO gesture library.
 *
 * `react-native-gesture-handler` and `reanimated` are both in this package, so
 * a pinch-to-zoom worklet was available; this doesn't use one. Scroll-to-pan
 * behaves identically on web and native, is driveable by a trackpad, a
 * touchscreen, a scroll wheel and a keyboard alike, and — the deciding factor
 * — is testable in a browser, which an RNGH pan gesture is not. The zoom
 * controls in the toolbar are the primary affordance; wheel and double-press
 * are accelerants on top of them, never the only way in.
 *
 * Sizes are explicit NUMBERS from `onLayout`, never percentages: a percentage
 * child inside a nested RN-Web ScrollView resolves against the wrong box.
 */
function ZoomPane({
  zoom,
  onZoom,
  children,
}: {
  zoom: number;
  onZoom: (next: number) => void;
  children: React.ReactNode;
}) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const hostRef = useRef<View | null>(null);
  const lastPressAt = useRef(0);

  // Ctrl/⌘ + wheel zooms, the convention every document viewer uses. RN-Web
  // exposes no `onWheel`, so this attaches a real DOM listener to the host
  // node (the same escape hatch the codebase uses for other web-only DOM
  // events). `passive: false` so `preventDefault` actually stops the browser
  // from zooming the whole page underneath us.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = hostRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onZoom(clampZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    }
    node.addEventListener("wheel", onWheel as EventListener, { passive: false });
    return () => node.removeEventListener("wheel", onWheel as EventListener);
  }, [zoom, onZoom]);

  function handlePress() {
    const now = Date.now();
    const isDouble = now - lastPressAt.current < DOUBLE_PRESS_MS;
    lastPressAt.current = now;
    if (isDouble) onZoom(zoom > MIN_ZOOM ? MIN_ZOOM : DOUBLE_PRESS_ZOOM);
  }

  const contentW = box ? box.w * zoom : 0;
  const contentH = box ? box.h * zoom : 0;

  return (
    <View
      ref={hostRef}
      className="flex-1"
      onLayout={(e) =>
        setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      {box ? (
        <ScrollView
          style={{ width: box.w, height: box.h }}
          contentContainerStyle={{
            minHeight: box.h,
            alignItems: "center",
            justifyContent: "center",
          }}
          showsVerticalScrollIndicator={zoom > MIN_ZOOM}
          scrollEnabled={zoom > MIN_ZOOM}
        >
          <ScrollView
            horizontal
            contentContainerStyle={{
              minWidth: box.w,
              alignItems: "center",
              justifyContent: "center",
            }}
            showsHorizontalScrollIndicator={zoom > MIN_ZOOM}
            scrollEnabled={zoom > MIN_ZOOM}
          >
            <Pressable
              onPress={handlePress}
              accessibilityLabel="Receipt — double tap to zoom"
              style={{ width: contentW, height: contentH }}
            >
              {children}
            </Pressable>
          </ScrollView>
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * A photo — or an `"unknown"` file rendered optimistically as one, because
 * that is what an unlabelled receipt almost always turns out to be.
 *
 * If the decode fails we have to find out WHY before saying anything: a file
 * that isn't an image and a file that isn't THERE need different words on
 * screen, and `<Image onError>` cannot tell them apart. So the failure path —
 * and only the failure path — reads the first sixteen bytes and asks them
 * (`lib/sniffFile`), then hands the answer UP to `FileViewer` so the right
 * pane takes over wholesale.
 *
 * That is what stops a deleted file from rendering as an empty frame, and it
 * is also how a genuinely mislabelled historical row is rescued: a PDF stored
 * as `application/octet-stream` with no filename ends up in the real PDF
 * branch, page controls and all, with no data migration behind it.
 */
function ImagePane({
  uri,
  caption,
  onSniffed,
}: {
  uri: string;
  caption: string;
  onSniffed: (kind: SniffedKind) => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [uri]);

  useEffect(() => {
    if (!failed) return;
    let cancelled = false;
    void sniffFileKind(uri).then((kind) => {
      // `"image"` would send us straight back here in a loop: the bytes say
      // image but the decoder already refused them (a truncated or corrupt
      // file). Report that as unloadable rather than trying again.
      if (!cancelled) onSniffed(kind === "image" ? "missing" : kind);
    });
    return () => {
      cancelled = true;
    };
  }, [failed, uri, onSniffed]);

  if (failed) {
    return (
      <View className="h-full w-full items-center justify-center">
        <ActivityIndicator color={colors.raised} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={{ width: "100%", height: "100%" }}
      resizeMode="contain"
      accessibilityLabel={caption}
      onError={() => setFailed(true)}
    />
  );
}

/** A PDF, rendered page by page into the same pane a photo uses. */
function PdfPane({
  uri,
  page,
  zoom,
  onPageCount,
  filename,
}: {
  uri: string;
  page: number;
  zoom: number;
  onPageCount: (count: number) => void;
  filename?: string | null;
}) {
  const [rendered, setRendered] = useState<PdfPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supportsInlinePdf) return;
    let cancelled = false;
    setError(null);
    renderPdfPage(uri, page, zoom)
      .then((result) => {
        if (cancelled) return;
        setRendered(result);
        onPageCount(result.pageCount);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "The PDF couldn't be opened.");
      });
    return () => {
      cancelled = true;
    };
  }, [uri, page, zoom, onPageCount]);

  if (!supportsInlinePdf) {
    return (
      <Unrenderable
        uri={uri}
        title="PDFs open outside the app here"
        detail={`${filename ?? "This PDF"} can be read inline on the web app; on a phone it opens in your PDF reader.`}
      />
    );
  }

  if (error) {
    return <Unrenderable uri={uri} title="This PDF couldn't be displayed" detail={error} />;
  }

  if (!rendered) {
    return (
      <View className="h-full w-full items-center justify-center">
        <ActivityIndicator color={colors.raised} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri: rendered.uri }}
      style={{ width: "100%", height: "100%" }}
      resizeMode="contain"
      accessibilityLabel={`${filename ?? "PDF"} page ${page}`}
    />
  );
}

/** An emailed HTML/plain-text body — the receipt IS the message. Web renders
 *  it inline; native has no inline HTML surface, so it says so plainly. */
function DocumentPane({ uri, caption }: { uri: string; caption: string }) {
  // `Platform.OS === "web"` gates the JSX ITSELF, not just a handler:
  // `<iframe>` is not a valid host component on native and mounting one would
  // crash the app.
  if (Platform.OS === "web") {
    return (
      <iframe
        src={uri}
        title={caption}
        style={{ width: "100%", height: "100%", border: "0", background: "#fff" }}
      />
    );
  }
  return (
    <Unrenderable
      uri={uri}
      title="This receipt is a document"
      detail="It opens in your browser on a phone; the web app shows it inline."
    />
  );
}

/**
 * The explicit "we can't draw this, here's what to do" state. The whole point
 * of this component's existence: every failure path in the viewer lands here,
 * so no reviewer is ever shown an empty frame and left to guess.
 */
function Unrenderable({
  uri,
  title,
  detail,
}: {
  uri: string;
  title: string;
  detail: string;
}) {
  return (
    <View className="h-full w-full items-center justify-center gap-2 px-8">
      <Icon name="alert-triangle" size={26} color={colors.raised} />
      <Text className="text-center text-sm font-semibold text-raised">{title}</Text>
      <Text className="text-center text-xs text-raised/70">{detail}</Text>
      <Pressable
        onPress={() => void Linking.openURL(uri)}
        accessibilityRole="button"
        accessibilityLabel="Open the original file"
        className="mt-2 flex-row items-center gap-1.5 rounded-md border border-raised/40 px-3 py-2 active:opacity-70"
      >
        <Icon name="download" size={15} color={colors.raised} />
        <Text className="text-sm font-semibold text-raised">Open the original</Text>
      </Pressable>
    </View>
  );
}
