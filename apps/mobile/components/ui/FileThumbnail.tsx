/**
 * FILE THUMBNAIL — the small preview that sits in a list row or a detail
 * panel, and the companion to `FileViewer` (which is what pressing it opens).
 *
 * WHY IT EXISTS: every list that shows receipts drew its own thumbnail, and
 * each one drew a BLANK for anything that wasn't a photo. The receipts inbox
 * was the worst of them — an emailed PDF invoice rendered as an empty tile
 * with no icon, no label and no way to tell it apart from a receipt whose file
 * was actually missing. A reviewer scanning that queue can't tell "PDF" from
 * "broken", which is exactly the difference they need at a glance.
 *
 * So: a PDF renders its FIRST PAGE, on web, through the same
 * `lib/pdfPages` cache `FileViewer` uses. That is not decoration — it means
 * that by the time the reviewer presses the row, page one is already rendered
 * and the viewer opens on an image it does not have to fetch or parse. The
 * thumbnail is the prefetch.
 *
 * Everything that can't be rendered (a PDF on native, an emailed HTML body, a
 * decode failure, a missing file) gets a LABELLED tile — an icon plus what the
 * thing is. Never an empty box.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Text, View } from "react-native";
import { receiptFileKind } from "@events-os/shared";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";
import { renderPdfPage, supportsInlinePdf } from "../../lib/pdfPages";

export function FileThumbnail({
  uri,
  contentType,
  filename,
  resizeMode = "cover",
}: {
  /** `null` when the row has no stored file at all — a distinct state from
   *  "a file we can't draw", and labelled as such. */
  uri: string | null | undefined;
  contentType?: string | null;
  filename?: string | null;
  resizeMode?: "cover" | "contain";
}) {
  const kind = receiptFileKind({ contentType, filename });
  const [failed, setFailed] = useState(false);
  const [pdfPageUri, setPdfPageUri] = useState<string | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setPdfFailed(false);
    setPdfPageUri(null);
  }, [uri]);

  // Render (and thereby cache) page one of a PDF. `zoom: 1` picks the base
  // render scale, which is the same bitmap the viewer opens with — so this
  // costs one render, not two.
  useEffect(() => {
    if (kind !== "pdf" || !uri || !supportsInlinePdf) return;
    let cancelled = false;
    renderPdfPage(uri, 1, 1)
      .then((page) => {
        if (!cancelled) setPdfPageUri(page.uri);
      })
      .catch(() => {
        if (!cancelled) setPdfFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, uri]);

  if (!uri) return <Tile icon="file" label="NO FILE" />;

  if (kind === "pdf") {
    if (pdfPageUri) {
      return (
        <Image
          source={{ uri: pdfPageUri }}
          style={{ width: "100%", height: "100%" }}
          resizeMode={resizeMode}
          accessibilityLabel={`${filename ?? "PDF"} — page 1`}
        />
      );
    }
    if (pdfFailed || !supportsInlinePdf) return <Tile icon="file-text" label="PDF" />;
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="small" color={colors.faint} />
      </View>
    );
  }

  if (kind === "document") {
    return <Tile icon="mail" label={Platform.OS === "web" ? "EMAIL" : "EMAIL"} />;
  }

  if (failed) return <Tile icon="alert-triangle" label="CAN'T OPEN" />;

  return (
    <Image
      source={{ uri }}
      style={{ width: "100%", height: "100%" }}
      resizeMode={resizeMode}
      accessibilityLabel={filename ?? "Receipt"}
      onError={() => setFailed(true)}
    />
  );
}

/** The labelled fallback. The LABEL is the point — a bare icon reads
 *  identically to "no file at all", which these states are not. */
function Tile({ icon, label }: { icon: "file" | "file-text" | "mail" | "alert-triangle"; label: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-0.5">
      <Icon name={icon} size={16} color={colors.faint} />
      <Text className="text-2xs font-bold text-faint">{label}</Text>
    </View>
  );
}
