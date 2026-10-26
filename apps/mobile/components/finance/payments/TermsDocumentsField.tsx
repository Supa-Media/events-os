/**
 * FINANCES · PAYMENTS · Documents attached to an agreement's additional terms.
 *
 * Founder, 2026-10-26: "I need to be able to attach a document on the
 * 'additional terms' section rather than just type it in." Files upload to
 * storage as soon as they're picked and join the draft; nothing is attached to
 * the agreement until the form saves (`createAgreement` / `updateTerms` take
 * the whole list). The contractor sees each one, with a download link, in the
 * terms they sign — so removing or adding one after they've signed voids the
 * signature, same as editing the text.
 */
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Field, Icon, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  pickReceiptFiles,
  uploadReceiptFile,
} from "../receipts/pickReceiptFiles";

/** One document in the draft. `url` is set for files already on the
 *  agreement; a freshly uploaded one has none until the form saves. */
export type TermsDocumentDraft = {
  storageId: Id<"_storage">;
  fileName: string | null;
  url?: string | null;
};

/** Mirrors the server's `TERMS_DOCUMENTS_MAX`. */
const MAX_DOCUMENTS = 10;
const ACCEPT =
  "application/pdf,image/*,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The draft list → the mutation arg shape. */
export function toTermsDocumentArgs(docs: TermsDocumentDraft[]) {
  return docs.map((d) => ({
    storageId: d.storageId,
    ...(d.fileName ? { fileName: d.fileName } : {}),
  }));
}

/** Whether the draft's set of files differs from what's on file. */
export function termsDocumentsMoved(
  draft: TermsDocumentDraft[],
  onFile: { storageId: Id<"_storage"> }[] | undefined,
): boolean {
  const before = new Set((onFile ?? []).map((d) => d.storageId));
  return (
    draft.length !== before.size || draft.some((d) => !before.has(d.storageId))
  );
}

export function TermsDocumentsField({
  value,
  onChange,
}: {
  value: TermsDocumentDraft[];
  onChange: (next: TermsDocumentDraft[]) => void;
}) {
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();
  const [adding, setAdding] = useState(false);

  async function add() {
    const files = await pickReceiptFiles({ accept: ACCEPT });
    if (files.length === 0) return;
    setAdding(true);
    const added: TermsDocumentDraft[] = [];
    try {
      for (const file of files.slice(0, MAX_DOCUMENTS - value.length)) {
        const storageId = await run(
          () => uploadReceiptFile(file, generateUploadUrl),
          { errorTitle: "Couldn't attach that document" },
        );
        if (!storageId) break;
        added.push({ storageId, fileName: file.filename });
      }
    } finally {
      setAdding(false);
      if (added.length) onChange([...value, ...added]);
    }
  }

  return (
    <Field
      label="Terms documents (optional)"
      hint="Attach the terms as a file instead of (or as well as) typing them — a PDF, a Word document, or a photo. The contractor can open each one on their page, and their signature covers it."
    >
      <View className="gap-2">
        {value.map((doc, i) => (
          <View
            key={doc.storageId}
            className="flex-row items-center gap-2 rounded-md border border-border bg-raised px-3 py-2"
          >
            <Icon name="file-text" size={14} color={colors.muted} />
            {doc.url ? (
              <Pressable
                onPress={() => void Linking.openURL(doc.url!)}
                accessibilityRole="link"
                className="flex-1 active:opacity-70"
              >
                <Text className="text-sm text-accent underline" numberOfLines={1}>
                  {doc.fileName ?? `Document ${i + 1}`}
                </Text>
              </Pressable>
            ) : (
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {doc.fileName ?? `Document ${i + 1}`}
              </Text>
            )}
            <Pressable
              onPress={() =>
                onChange(value.filter((d) => d.storageId !== doc.storageId))
              }
              accessibilityRole="button"
              accessibilityLabel={`Remove ${doc.fileName ?? "document"}`}
              hitSlop={6}
              className="rounded-md p-1 active:opacity-70"
            >
              <Icon name="x" size={14} color={colors.muted} />
            </Pressable>
          </View>
        ))}
        {value.length < MAX_DOCUMENTS ? (
          <View className="flex-row">
            <Button
              title={value.length ? "Attach another" : "Attach a document"}
              size="sm"
              variant="secondary"
              icon="upload"
              loading={adding}
              onPress={() => void add()}
            />
          </View>
        ) : null}
      </View>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Field>
  );
}
