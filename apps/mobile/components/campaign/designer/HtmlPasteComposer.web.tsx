/**
 * HtmlPasteComposer (web) — "Paste HTML" (PR 2 of the founder's editor
 * feedback, verbatim: "there should be an option to forgo the email editor
 * entirely and just use a html paste from things like canva to send the
 * email. We do have to make sure the images are hosted reliably though",
 * 2026-07-30).
 *
 * Two modes, switched on whether the row already has pasted content:
 *
 *  - EMPTY (or `pasting === true`): a textarea + "Import & preview" button.
 *    Import calls `api.emailHtmlImport.importPastedHtml` (the "use node"
 *    action — sanitizes the html for real and re-hosts every external
 *    image into Convex storage, see that file's module doc), then
 *    IMMEDIATELY persists the result via `onSave` (the same
 *    `campaigns.updateCampaignDoc` autosave path every other composer
 *    uses) so the saved doc and what's shown in the preview pane below are
 *    never out of sync. Any per-image failures (a dead/expired CDN link,
 *    say) are listed inline — the import still succeeds and the email
 *    still ships, just without that one image (`emailHtmlImport.ts`'s own
 *    "never fail the whole import silently" contract).
 *  - HAS CONTENT: a compact "Pasted HTML — not block-editable" notice (the
 *    task brief's own words) with a "Re-paste to replace" action that
 *    drops back into paste mode, plus the SAME server-rendered preview
 *    pane `MailyDocumentHost.web.tsx` uses for the maily editor — width
 *    (mobile/tablet/desktop) and light/dark VIEW toggles included
 *    (`previewWidth.ts`/`previewColorScheme.ts`, reused verbatim rather
 *    than reimplemented, per the task brief).
 *
 * Meta fields (Subject/Preview text/From) are the same `MailyMetaFields`
 * component every other maily-family host renders, unchanged.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useAction, useConvex } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, TextField } from "../../ui";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { fetchCampaignPreview } from "../../../lib/emailPreview";
import { MailyMetaFields } from "./MailyMetaFields";
import { ComposerFormatSwitchLink } from "./ComposerFormatSwitchLink";
import { forceIframeColorScheme } from "./previewColorScheme";
import {
  DEFAULT_PREVIEW_WIDTH_ID,
  PREVIEW_WIDTH_IDS,
  PREVIEW_WIDTHS,
  type PreviewWidthId,
} from "./previewWidth";
import type { HtmlPasteComposerProps } from "./HtmlPasteComposer.types";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "unavailable" };

type ImportOutcome = { imagesFound: number; imagesRehosted: number; failures: { url: string; reason: string }[] };

export function HtmlPasteComposer({
  campaignId,
  doc,
  editable,
  lockedNotice,
  onSave,
  run,
  meta,
  formatSwitch,
}: HtmlPasteComposerProps) {
  const convex = useConvex();
  const importPastedHtml = useAction(api.emailHtmlImport.importPastedHtml);

  const hasContent = !!doc?.html && doc.html.trim().length > 0;
  // Starts in paste mode when there's nothing saved yet; a saved doc starts
  // in preview mode. `undefined` `doc` (still loading) defers to preview
  // mode too — flips to paste mode the moment loading resolves empty.
  const [pasting, setPasting] = useState(!hasContent);
  useEffect(() => {
    if (doc !== undefined) setPasting(!hasContent);
    // Only re-derive when the CAMPAIGN's own doc reference changes (a fresh
    // load, or a save from THIS component); never on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  const [draft, setDraft] = useState("");
  const [importing, setImporting] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<ImportOutcome | null>(null);

  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [previewScheme, setPreviewScheme] = useState<"light" | "dark">("light");
  const [previewWidthId, setPreviewWidthId] = useState<PreviewWidthId>(DEFAULT_PREVIEW_WIDTH_ID);

  const refreshPreview = useCallback(() => {
    setPreview((s) => (s.status === "ready" ? s : { status: "loading" }));
    fetchCampaignPreview(convex, campaignId)
      .then((result) => setPreview({ status: "ready", html: result.html }))
      .catch(() => setPreview({ status: "unavailable" }));
  }, [convex, campaignId]);

  const previewedDocRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pasting) return; // nothing saved to preview yet, or intentionally re-pasting
    if (!hasContent) return;
    if (previewedDocRef.current === doc?.html) return;
    previewedDocRef.current = doc?.html;
    refreshPreview();
  }, [pasting, hasContent, doc?.html, refreshPreview]);

  async function handleImport() {
    if (!draft.trim() || importing) return;
    setImporting(true);
    try {
      const result = await run(() => importPastedHtml({ html: draft }), {
        errorTitle: "Couldn't import that HTML",
      });
      if (!result) return; // already surfaced by `run`
      setLastOutcome({
        imagesFound: result.imagesFound,
        imagesRehosted: result.imagesRehosted,
        failures: result.failures,
      });
      const saved = await run(() => onSave({ html: result.html }), {
        errorTitle: "Imported, but couldn't save it",
      });
      if (saved === undefined) return; // save failed — stay in paste mode with the draft intact
      setDraft("");
      setPasting(false);
    } finally {
      setImporting(false);
    }
  }

  return (
    <View className="gap-3">
      {!editable ? (
        <View className="rounded-lg border border-border bg-raised px-3 py-2.5">
          <Text className="text-xs text-muted">{lockedNotice}</Text>
        </View>
      ) : null}

      {meta ? (
        <MailyMetaFields
          subject={meta.subject}
          previewText={meta.previewText}
          fromLine={meta.fromLine}
          onSaveSubject={meta.onSaveSubject}
          onSavePreviewText={meta.onSavePreviewText}
          editable={editable}
        />
      ) : null}

      {editable && pasting ? (
        <View className="gap-2 rounded-lg border border-border bg-raised p-3">
          <Text className="text-xs font-bold uppercase tracking-wider text-faint">
            Paste HTML
          </Text>
          <Text className="text-xs text-muted">
            Paste HTML exported from Canva (or anywhere else) — every external image
            gets re-hosted here so it never breaks, and the markup is sanitized before
            it&apos;s stored.
          </Text>
          {formatSwitch ? <ComposerFormatSwitchLink formatSwitch={formatSwitch} /> : null}
          <TextField
            placeholder="<html>…</html>"
            value={draft}
            onChangeText={setDraft}
            multiline
            numberOfLines={14}
            className="min-h-[220px] font-mono text-xs"
            editable={!importing}
          />
          <View className="flex-row items-center gap-2">
            <Button
              title={importing ? "Importing…" : "Import & preview"}
              onPress={() => void handleImport()}
              disabled={!draft.trim() || importing}
              loading={importing}
            />
            {hasContent ? (
              <Button
                title="Cancel"
                variant="secondary"
                onPress={() => {
                  setDraft("");
                  setPasting(false);
                }}
                disabled={importing}
              />
            ) : null}
          </View>
          {lastOutcome && lastOutcome.failures.length > 0 ? (
            <View className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2">
              <Text className="text-xs font-semibold text-amber-800">
                {lastOutcome.imagesRehosted} of {lastOutcome.imagesFound} image
                {lastOutcome.imagesFound === 1 ? "" : "s"} re-hosted — {lastOutcome.failures.length}{" "}
                skipped:
              </Text>
              {lastOutcome.failures.map((f) => (
                <Text key={f.url} className="mt-0.5 text-2xs text-amber-800" numberOfLines={1}>
                  {f.url} — {f.reason}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : (
        <View className="gap-2">
          <View className="flex-row flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-raised px-3 py-2.5">
            <Text className="flex-1 text-xs text-muted">
              Pasted HTML — not block-editable. Re-paste to change it.
            </Text>
            {editable ? (
              <Button
                title="Re-paste to replace"
                size="sm"
                variant="secondary"
                onPress={() => setPasting(true)}
              />
            ) : null}
          </View>

          <View className="mb-1 flex-row flex-wrap items-center justify-between gap-2">
            <Text className="text-xs font-bold uppercase tracking-wider text-faint">Preview</Text>
            <View className="flex-row flex-wrap items-center gap-2">
              <View className="flex-row overflow-hidden rounded-md border border-border-strong">
                {PREVIEW_WIDTH_IDS.map((option) => (
                  <Text
                    key={option}
                    accessibilityRole="button"
                    onPress={() => setPreviewWidthId(option)}
                    className={`px-2 py-1 text-2xs font-semibold ${
                      previewWidthId === option ? "bg-accent text-white" : "bg-raised text-muted"
                    }`}
                  >
                    {PREVIEW_WIDTHS[option].label}
                  </Text>
                ))}
              </View>
              <View className="flex-row overflow-hidden rounded-md border border-border-strong">
                {(["light", "dark"] as const).map((option) => (
                  <Text
                    key={option}
                    accessibilityRole="button"
                    onPress={() => setPreviewScheme(option)}
                    className={`px-2 py-1 text-2xs font-semibold ${
                      previewScheme === option ? "bg-accent text-white" : "bg-raised text-muted"
                    }`}
                  >
                    {option === "light" ? "Light" : "Dark"}
                  </Text>
                ))}
              </View>
            </View>
          </View>
          {!hasContent ? (
            <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-14">
              <Text className="text-sm text-muted">Nothing pasted yet.</Text>
            </View>
          ) : preview.status === "ready" ? (
            <div style={{ overflowX: "auto" }}>
              <div style={{ width: PREVIEW_WIDTHS[previewWidthId].width ?? "100%" }}>
                <EmailHtmlPreview
                  html={forceIframeColorScheme(preview.html, previewScheme)}
                  // The whole email, not a 520px window onto it — a pasted
                  // newsletter is routinely 3,000px+ tall and the designer
                  // needs to see all of it (founder bug, 2026-07-30).
                  height="auto"
                />
              </div>
            </div>
          ) : preview.status === "loading" ? (
            <View className="items-center rounded-lg border border-border bg-raised px-6 py-14">
              <Text className="text-sm text-faint">Loading preview…</Text>
            </View>
          ) : (
            <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-10">
              <Text className="text-center text-sm text-muted">Preview isn&apos;t available.</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export default HtmlPasteComposer;
