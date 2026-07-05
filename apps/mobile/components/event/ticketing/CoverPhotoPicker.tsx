/**
 * Cover photo for the public event page — a 4:5 tap target that uploads a
 * new image (web file input / native picker) and a "Remove cover" affordance.
 * Mirrors the grid PhotoCell upload flow.
 */
import { useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";

type Props = {
  page: Doc<"eventPages">;
  coverUrl: string | null;
  run: ActionRunner["run"];
};

export function CoverPhotoPicker({ page, coverUrl, run }: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const [uploading, setUploading] = useState(false);

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
          await updatePage({ pageId: page._id, patch: { coverImage: storageId } });
        },
        { errorTitle: "Couldn't upload cover" },
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

  function pickCover() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  function removeCover() {
    void run(() => updatePage({ pageId: page._id, patch: { coverImage: null } }), {
      errorTitle: "Couldn't update page",
    });
  }

  return (
    <>
      {/* Cover photo — 4:5, tap to upload/change */}
      <Pressable
        onPress={pickCover}
        disabled={uploading}
        accessibilityLabel="Change cover photo"
        className="mb-1 w-full max-w-[280px] items-center justify-center self-center overflow-hidden rounded-xl border border-border bg-sunken active:opacity-80"
        style={{ aspectRatio: 4 / 5 }}
      >
        {uploading ? (
          <ActivityIndicator color={colors.accent} />
        ) : coverUrl ? (
          <Image
            source={{ uri: coverUrl }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="cover"
          />
        ) : (
          <View className="items-center gap-2 px-6">
            <Icon name="image" size={22} color={colors.faint} />
            <Text className="text-center text-sm text-muted">
              Tap to add a cover photo
            </Text>
          </View>
        )}
      </Pressable>
      {coverUrl ? (
        <Pressable
          onPress={removeCover}
          className="mb-3 self-center active:opacity-70"
        >
          <Text className="text-xs font-semibold text-muted">Remove cover</Text>
        </Pressable>
      ) : (
        <View className="mb-3" />
      )}
    </>
  );
}
