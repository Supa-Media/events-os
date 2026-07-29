/**
 * MailyDocumentHost (native) — READ-ONLY, permanently (the plan doc's
 * "Platform" section, founder decision 2026-07-29: "it's okay to only allow
 * email editing in the browser and not on mobile" — not a v1 gap, the shape
 * of this stage). `@maily-to/core`'s `<Editor>` is a contenteditable DOM
 * component (Tiptap/ProseMirror) and must NEVER be imported into a native
 * bundle — this repo has already shipped a crash from exactly that (see
 * `MarkdownEditor.native.tsx`'s WebView-hosting workaround, and the WS0
 * spike's own `EditorSpikeScreen.native.tsx` doc). Metro/Webpack resolve this
 * file instead of `.web.tsx` on iOS/Android, so `@maily-to/core` is never
 * even present in the native dependency graph.
 *
 * What IS still live here: the Subject/Preview-text meta fields
 * (`MailyMetaFields` — plain RN `TextField`s, nothing DOM-specific) and the
 * server-rendered preview (`EmailHtmlPreview.native`, fed by
 * `lib/emailPreview.ts`'s `fetchCampaignPreview` — the SAME contract the web
 * host reads from). The document itself is shown, never edited.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useConvex } from "convex/react";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { fetchCampaignPreview } from "../../../lib/emailPreview";
import { MailyMetaFields } from "./MailyMetaFields";
import { isTiptapDocEmpty } from "./mailyDoc";
import type { MailyDocumentHostProps } from "./MailyDocumentHost.types";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "unavailable" };

export function MailyDocumentHost({
  campaignId,
  doc,
  editable,
  lockedNotice,
  meta,
}: MailyDocumentHostProps) {
  const convex = useConvex();
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: "loading" });
    fetchCampaignPreview(convex, campaignId)
      .then((result) => {
        if (!cancelled) setPreview({ status: "ready", html: result.html });
      })
      .catch(() => {
        if (!cancelled) setPreview({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the doc reference changes (i.e. after the web app saves a
    // new version and this screen's `campaign`/`template` query refreshes) —
    // there is no native autosave to debounce against, so a plain effect
    // dependency is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, campaignId, doc]);

  return (
    <View className="gap-3">
      <View className="rounded-lg border border-border bg-raised px-3 py-2.5">
        <Text className="text-xs text-muted">
          Editing this document happens on the web app — this screen is read-only.
          {lockedNotice ? ` ${lockedNotice}` : ""}
        </Text>
      </View>

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

      {doc === undefined ? null : isTiptapDocEmpty(doc) ? (
        <Text className="text-sm text-muted">This email has no content yet.</Text>
      ) : preview.status === "ready" ? (
        <EmailHtmlPreview html={preview.html} height={520} />
      ) : preview.status === "loading" ? (
        <Text className="text-sm text-faint">Loading preview…</Text>
      ) : (
        <Text className="text-sm text-faint">
          Preview isn&apos;t available yet — open this on the web app to see it rendered.
        </Text>
      )}
    </View>
  );
}

export default MailyDocumentHost;
