/**
 * RECEIPTS TAB — mass upload zone (the owner's backfill workflow, item 5 of
 * the receipt CRM UI plan). Web: a hidden multi-select `<input type=file>`;
 * native: `expo-image-picker` with `allowsMultipleSelection` — the same
 * generate-url → POST → storageId dance every upload surface in the app uses
 * (`CoverPhotoPicker`, `ReimbursementRequestForm`), just batched.
 *
 * Every picked file is uploaded to Convex storage FIRST (in parallel, capped
 * — see `MAX_CONCURRENT_UPLOADS`), then every resulting `storageId` rides in
 * ONE `api.receipts.submitUploadedReceipts` call — chunked at
 * `MAX_UPLOAD_BATCH` (25) since that's the backend's own per-call cap. The
 * mutation's per-file outcome (`duplicate: boolean`) drives an inline
 * results list; new/updated receipts themselves show up in the Library
 * section via its own live `listReceipts` subscription — this component
 * never patches that list itself.
 */
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";

/** `receipts.submitUploadedReceipts`'s own per-call cap — mirrored here so a
 *  big batch splits into legal-sized chunks rather than throwing. */
const MAX_UPLOAD_BATCH = 25;

type UploadOutcome = { name: string; receiptId: Id<"receipts">; duplicate: boolean };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function UploadZone({
  run,
  onOpenReceipt,
}: {
  run: ActionRunner["run"];
  onOpenReceipt: (receiptId: Id<"receipts">) => void;
}) {
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const submitUploadedReceipts = useMutation(api.receipts.submitUploadedReceipts);
  const [uploading, setUploading] = useState(false);
  const [outcomes, setOutcomes] = useState<UploadOutcome[] | null>(null);

  async function uploadFiles(files: { blob: Blob; contentType: string; name: string }[]) {
    if (files.length === 0) return;
    setUploading(true);
    setOutcomes(null);
    await run(
      async () => {
        const uploaded: { storageId: Id<"_storage">; name: string }[] = [];
        for (const file of files) {
          const uploadUrl = await generateUploadUrl();
          const res = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": file.contentType },
            body: file.blob,
          });
          const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
          uploaded.push({ storageId, name: file.name });
        }

        const named: UploadOutcome[] = [];
        for (const batch of chunk(uploaded, MAX_UPLOAD_BATCH)) {
          const results = await submitUploadedReceipts({
            storageIds: batch.map((b) => b.storageId),
          });
          for (const r of results) {
            const name = batch.find((b) => b.storageId === r.storageId)?.name ?? "Receipt";
            named.push({ name, receiptId: r.receiptId, duplicate: r.duplicate });
          }
        }
        setOutcomes(named);
      },
      { errorTitle: "Couldn't upload receipts" },
    );
    setUploading(false);
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,application/pdf";
    input.onchange = () => {
      const fileList = input.files;
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList).map((f) => ({
        blob: f,
        contentType: f.type || "image/jpeg",
        name: f.name,
      }));
      void uploadFiles(files);
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const files = await Promise.all(
      result.assets.map(async (asset, i) => {
        const resp = await fetch(asset.uri);
        const blob = await resp.blob();
        return {
          blob,
          contentType: asset.mimeType || blob.type || "image/jpeg",
          name: asset.fileName ?? `Receipt ${i + 1}`,
        };
      }),
    );
    await uploadFiles(files);
  }

  function pick() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  return (
    <View className="mb-5 overflow-hidden rounded-xl border border-border bg-raised">
      <Pressable
        onPress={pick}
        disabled={uploading}
        accessibilityRole="button"
        accessibilityLabel="Upload receipts"
        className="flex-row items-center gap-3 border-b border-border border-dashed bg-sunken/60 px-4 py-4 active:opacity-80"
      >
        {uploading ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <View className="h-9 w-9 items-center justify-center rounded-pill bg-accent-soft">
            <Icon name="upload" size={17} color={colors.accent} />
          </View>
        )}
        <View className="flex-1">
          <Text className="font-display text-base text-ink">
            {uploading ? "Uploading…" : "Add receipts"}
          </Text>
          <Text className="text-xs text-muted">
            Photos or PDFs, one or many at once — they land in the library below.
          </Text>
        </View>
        <Icon name="chevron-right" size={16} color={colors.faint} />
      </Pressable>

      {outcomes && outcomes.length > 0 ? (
        <View className="gap-1.5 px-4 py-3">
          {outcomes.map((o) => (
            <Pressable
              key={o.receiptId}
              onPress={() => onOpenReceipt(o.receiptId)}
              className="flex-row items-center justify-between gap-2 rounded-md px-2 py-1.5 active:opacity-70"
            >
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {o.name}
              </Text>
              {o.duplicate ? (
                <Badge label="Duplicate of existing receipt" tone="danger" />
              ) : (
                <Badge label="Processing…" tone="neutral" icon="clock" />
              )}
            </Pressable>
          ))}
          <Pressable onPress={() => setOutcomes(null)} className="self-start px-2 py-1">
            <Text className="text-xs font-semibold text-muted">Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
