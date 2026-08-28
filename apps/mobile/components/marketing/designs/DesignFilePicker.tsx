/**
 * One image slot on a design — upload, preview, remove.
 *
 * The same shape as `CardImagePicker` (web file input, native
 * `expo-image-picker`, deferred save) and deliberately a separate component
 * rather than a prop on that one: it goes through
 * `marketingDesigns.generateDesignUploadUrl`, so a design upload carries the
 * design desk's power rather than the Important Links desk's. Two powers, two
 * upload URLs, two pickers.
 *
 * It does not save. It hands a `storageId` back to the form, which sends it
 * with the rest of the design — a picker that saved on its own would give one
 * design two save paths and commit half a form nobody had finished.
 *
 * Lifted out of `DesignsView` unchanged when the tab became a workstation: the
 * screen is now a rail and a canvas, and the upload slot belongs beside the
 * inspector that uses it.
 */
import { useState } from "react";
import { ActivityIndicator, Image, Platform, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
// expo-image-picker is Expo Go-safe (classified `core` in native-deps.json);
// only reached on native.
import * as ImagePicker from "expo-image-picker";
import { Button } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";

const FILE_LABELS = {
  artwork: {
    title: "Artwork",
    help: "The finished image itself. This is what an uploaded design IS.",
  },
  thumbnail: {
    title: "Thumbnail",
    help: "The tile the library shows in the grid — the reason nine files aren't nine live Canva frames. Always an upload we host: a Canva CDN preview URL expires and leaves a grey box.",
  },
} as const;

export function DesignFilePicker({
  kind,
  current,
  pending,
  onPicked,
  onCleared,
  run,
}: {
  kind: "artwork" | "thumbnail";
  /** What the design shows today, or null when the slot is empty. */
  current: string | null;
  /** A storage id chosen in this session but not yet saved. */
  pending: string | null;
  onPicked: (storageId: string) => void;
  onCleared: () => void;
  run: ActionRunner["run"];
}) {
  const generateUploadUrl = useMutation(
    api.marketingDesigns.generateDesignUploadUrl,
  );
  const [uploading, setUploading] = useState(false);
  const labels = FILE_LABELS[kind];

  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      await run(
        async () => {
          const uploadUrl = await generateUploadUrl();
          const res = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          const { storageId } = await res.json();
          onPicked(storageId as string);
        },
        { errorTitle: "Couldn't upload that image" },
      );
    } finally {
      setUploading(false);
    }
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "image/jpeg");
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  const has = Boolean(pending || current);

  return (
    <View className="mb-3">
      <Text className="mb-1 text-sm font-semibold text-ink">{labels.title}</Text>
      <Text className="mb-2 text-xs text-muted">{labels.help}</Text>
      <View className="flex-row items-center gap-3">
        {/* A just-uploaded file has no servable URL yet (the design hasn't been
            saved), so it's shown as staged rather than as a broken frame. */}
        {pending ? (
          <View className="h-14 w-14 items-center justify-center rounded-md border border-border bg-surface">
            <Text className="text-2xs text-muted">New</Text>
          </View>
        ) : current ? (
          <Image
            source={{ uri: current }}
            className="h-14 w-14 rounded-md border border-border"
            resizeMode="contain"
          />
        ) : null}
        {uploading ? <ActivityIndicator size="small" /> : null}
        <Button
          title={has ? "Replace" : "Upload"}
          size="sm"
          variant="secondary"
          disabled={uploading}
          onPress={() => {
            if (Platform.OS === "web") pickWeb();
            else void pickNative();
          }}
        />
        {has ? (
          <Button title="Remove" size="sm" variant="ghost" onPress={onCleared} />
        ) : null}
      </View>
      {pending ? (
        <Text className="mt-1.5 text-xs text-muted">
          Uploaded — save the design to keep it.
        </Text>
      ) : null}
    </View>
  );
}
