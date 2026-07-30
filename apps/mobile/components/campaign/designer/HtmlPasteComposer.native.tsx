/**
 * HtmlPasteComposer (native) — READ-ONLY, permanently, mirroring
 * `MailyDocumentHost.native.tsx`'s exact posture for the tiptap host:
 * "Paste HTML" is a web-only composing surface (the task brief's own "UI
 * (web-only)" framing — a paste-and-import flow has no obvious native
 * affordance, and the real gate is the same as the maily editor's: a
 * contenteditable/DOM-shaped tool has no business in the native bundle).
 *
 * What IS still live here: the Subject/Preview-text meta fields
 * (`MailyMetaFields`) and the server-rendered preview (`EmailHtmlPreview`,
 * fed by `lib/emailPreview.ts`'s `fetchCampaignPreview` — the SAME contract
 * the web host reads from, now dispatching on `docFormat: "html"` too —
 * `emailPreview.ts`'s own doc). The pasted document itself is shown, never
 * pasted-into.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useConvex } from "convex/react";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { fetchCampaignPreview } from "../../../lib/emailPreview";
import { MailyMetaFields } from "./MailyMetaFields";
import type { HtmlPasteComposerProps } from "./HtmlPasteComposer.types";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "unavailable" };

export function HtmlPasteComposer({
  campaignId,
  doc,
  editable,
  lockedNotice,
  meta,
}: HtmlPasteComposerProps) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, campaignId, doc]);

  const hasContent = !!doc?.html && doc.html.trim().length > 0;

  return (
    <View className="gap-3">
      <View className="rounded-lg border border-border bg-raised px-3 py-2.5">
        <Text className="text-xs text-muted">
          Pasting HTML happens on the web app — this screen is read-only.
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

      {doc === undefined ? null : !hasContent ? (
        <Text className="text-sm text-muted">Nothing pasted yet.</Text>
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

export default HtmlPasteComposer;
