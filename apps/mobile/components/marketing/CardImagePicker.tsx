/**
 * One image slot on an Important Links card — upload, preview, remove.
 *
 * A card has two, and they are not variations of each other:
 *
 *   THUMBNAIL  a small logo above the card's text. The Instagram and TikTok
 *              cards are this: a mark, on the pink tile, with the title still
 *              readable underneath.
 *   BACKGROUND a full-bleed photo. `LinkCard.astro` renders NOTHING else when
 *              one is set — no title, no subtitle, no small line — because the
 *              card becomes the poster. Worth saying on the control, because
 *              "why did my text disappear?" is otherwise a support question.
 *
 * ── Why the upload is deferred ──────────────────────────────────────────────
 * This picker does not save. It uploads the file, gets a `storageId`, and hands
 * it back to the form, which sends it with the rest of the card. A picker that
 * saved on its own would give one card two save paths, and half a card's fields
 * would commit while the other half sat in a draft the marketer hadn't finished.
 *
 * Upload flow copied from `CoverPhotoPicker` — web file input, native
 * `expo-image-picker` — but through `marketingSite.generateLinkImageUploadUrl`
 * rather than the general `storage.generateUploadUrl`, so the desk's uploads
 * carry the desk's power instead of "any signed-in user".
 */
import { useState } from "react";
import { ActivityIndicator, Image, Platform, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { Button } from "../ui";
import type { ActionRunner } from "../../lib/useActionToast";

type Props = {
  kind: "thumbnail" | "background";
  /**
   * What the card shows today — an `/api/site/link-image/…` path for an OS
   * upload, or a `/links/…` path for art that still lives in the landing repo.
   * Null when the slot is empty.
   */
  current: string | null;
  /** A storage id chosen in this session but not yet saved, if any. */
  pending: string | null;
  onPicked: (storageId: string) => void;
  onCleared: () => void;
  run: ActionRunner["run"];
};

const LABELS = {
  thumbnail: {
    title: "Logo",
    help: "A small mark above the card's title.",
  },
  background: {
    title: "Background photo",
    help: "Fills the whole card. The title and subtitle stop showing when one is set.",
  },
} as const;

export function CardImagePicker({
  kind,
  current,
  pending,
  onPicked,
  onCleared,
  run,
}: Props) {
  const generateUploadUrl = useMutation(
    api.marketingSite.generateLinkImageUploadUrl,
  );
  const [uploading, setUploading] = useState(false);
  const labels = LABELS[kind];

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

  function pick() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  // A just-uploaded image has no public URL yet (the card hasn't been saved, so
  // `/api/site/link-image/<id>` would 404 on it) — say it's staged rather than
  // showing a broken frame.
  const has = Boolean(pending || current);

  return (
    <View className="mb-3">
      <Text className="mb-1 text-sm font-semibold text-ink">{labels.title}</Text>
      <Text className="mb-2 text-xs text-muted">{labels.help}</Text>
      <View className="flex-row items-center gap-3">
        {pending ? (
          <View className="h-14 w-14 items-center justify-center rounded-md border border-border bg-surface">
            <Text className="text-[10px] text-muted">New</Text>
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
          onPress={pick}
        />
        {has ? (
          <Button title="Remove" size="sm" variant="ghost" onPress={onCleared} />
        ) : null}
      </View>
      {pending ? (
        <Text className="mt-1.5 text-xs text-muted">
          Uploaded — save the card to put it on the site.
        </Text>
      ) : null}
    </View>
  );
}
