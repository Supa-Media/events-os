/**
 * MAILY META FIELDS — Subject / Preview text / From, inline above the
 * document. Cross-platform (plain `ui/TextField`s — no DOM), used by BOTH
 * `MailyDocumentHost.web.tsx` (above the live editor) and
 * `MailyDocumentHost.native.tsx` (above the read-only server preview, where
 * they're the ONE thing on the maily host that's still genuinely editable —
 * see the plan doc's "Platform" section).
 *
 * Eager save-on-blur, same discipline as `CampaignMetaCard.tsx` (same
 * mutations, even) — `mailyMetaText.ts` owns the actual decisions so the two
 * can't drift on what counts as "changed" or "the server would reject this".
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { TextField } from "../../ui";
import { previewTextSaveDecision, subjectSaveDecision } from "./mailyMetaText";
import type { MailyMetaFieldsProps } from "./MailyDocumentHost.types";

export function MailyMetaFields({
  subject,
  previewText,
  fromLine,
  onSaveSubject,
  onSavePreviewText,
  editable,
}: MailyMetaFieldsProps & { editable: boolean }) {
  const [subjectDraft, setSubjectDraft] = useState(subject);
  const [previewDraft, setPreviewDraft] = useState(previewText);
  useEffect(() => setSubjectDraft(subject), [subject]);
  useEffect(() => setPreviewDraft(previewText), [previewText]);

  function blurSubject() {
    const decision = subjectSaveDecision(subjectDraft, subject);
    if (decision.action === "reset") setSubjectDraft(subject);
    else if (decision.action === "save") void onSaveSubject(decision.value);
  }

  function blurPreview() {
    const decision = previewTextSaveDecision(previewDraft, previewText);
    if (decision.action === "save") void onSavePreviewText(decision.value);
  }

  return (
    <View className="mb-4 gap-1">
      <TextField
        placeholder="Subject line"
        value={subjectDraft}
        onChangeText={setSubjectDraft}
        onBlur={blurSubject}
        editable={editable}
        className="text-lg font-semibold"
      />
      <TextField
        placeholder="Preview text (optional)"
        value={previewDraft}
        onChangeText={setPreviewDraft}
        onBlur={blurPreview}
        editable={editable}
      />
      <Text className="mt-0.5 text-xs text-faint">From {fromLine}</Text>
    </View>
  );
}

export default MailyMetaFields;
