/**
 * Cover photo for the public event page — a 4:5 tap target that uploads a
 * new image (web file input / native picker) and a "Remove cover" affordance.
 * Mirrors the grid PhotoCell upload flow.
 *
 * Once a cover is set, the preview doubles as a focal-point picker: tapping
 * anywhere on the image sets the crop focal point (0–100% x/y) that the
 * public landing page uses as CSS `object-position`, so a portrait subject
 * doesn't get cropped out on a wide card. A small "Change photo" chip in the
 * corner keeps the upload flow reachable without it fighting the focal tap.
 */
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
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

  // Measured pixel size of the preview box — only needed for native's
  // locationX/locationY, which come back in pixels, not percent.
  const containerRef = useRef<View>(null);
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  const focalX = page.coverFocalX ?? 50;
  const focalY = page.coverFocalY ?? 50;

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

  function handleBoxLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    setBoxSize({ width, height });
  }

  function saveFocal(xPct: number, yPct: number) {
    const x = Math.max(0, Math.min(100, Math.round(xPct)));
    const y = Math.max(0, Math.min(100, Math.round(yPct)));
    if (x === focalX && y === focalY) return;
    void run(
      () => updatePage({ pageId: page._id, patch: { coverFocalX: x, coverFocalY: y } }),
      { errorTitle: "Couldn't update focal point" },
    );
  }

  /**
   * Tap-to-set focal point. Web reads the real DOM rect off the container
   * ref (RN-web's locationX/locationY are unreliable — same tradeoff as the
   * site-map editor's canvas); native uses locationX/locationY over the
   * measured box size from `onLayout`.
   */
  function handleFocalPress(e: GestureResponderEvent) {
    let xPct: number | null = null;
    let yPct: number | null = null;
    if (Platform.OS === "web") {
      const node: any = containerRef.current;
      if (node && typeof node.getBoundingClientRect === "function") {
        const rect = node.getBoundingClientRect();
        const ne: any = e.nativeEvent;
        const clientX = ne.clientX ?? ne.pageX ?? null;
        const clientY = ne.clientY ?? ne.pageY ?? null;
        if (rect.width && rect.height && clientX != null && clientY != null) {
          xPct = ((clientX - rect.left) / rect.width) * 100;
          yPct = ((clientY - rect.top) / rect.height) * 100;
        }
      }
    } else {
      const { locationX, locationY } = e.nativeEvent;
      if (boxSize && boxSize.width > 0 && boxSize.height > 0) {
        xPct = (locationX / boxSize.width) * 100;
        yPct = (locationY / boxSize.height) * 100;
      }
    }
    if (xPct == null || yPct == null) return;
    saveFocal(xPct, yPct);
  }

  return (
    <>
      {coverUrl ? (
        <View
          ref={containerRef}
          onLayout={handleBoxLayout}
          className="relative mb-1 w-full max-w-[280px] items-center justify-center self-center overflow-hidden rounded-xl border border-border bg-sunken"
          style={{ aspectRatio: 4 / 5 }}
        >
          {uploading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <>
              <Image
                source={{ uri: coverUrl }}
                style={{ width: "100%", height: "100%" }}
                resizeMode="cover"
              />
              {/* Tap-anywhere focal-point target — sits under the "Change"
                  chip so the chip's own tap wins in that corner. */}
              <Pressable
                onPress={handleFocalPress}
                disabled={uploading}
                accessibilityRole="button"
                accessibilityLabel="Set cover focal point"
                style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
              />
              {/* The focal dot — purely visual, never intercepts taps. */}
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: `${focalX}%`,
                  top: `${focalY}%`,
                  width: 20,
                  height: 20,
                  marginLeft: -10,
                  marginTop: -10,
                  borderRadius: 10,
                  borderWidth: 2,
                  borderColor: "#FFFFFF",
                  backgroundColor: "rgba(0,0,0,0.35)",
                }}
              />
              <Pressable
                onPress={pickCover}
                disabled={uploading}
                accessibilityLabel="Change cover photo"
                className="absolute right-1.5 top-1.5 flex-row items-center gap-1 rounded-pill bg-ink/70 px-2 py-1 active:opacity-80"
              >
                <Icon name="camera" size={11} color="#FFFFFF" />
                <Text className="text-2xs font-semibold text-white">Change</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : (
        <Pressable
          onPress={pickCover}
          disabled={uploading}
          accessibilityLabel="Add cover photo"
          className="mb-1 w-full max-w-[280px] items-center justify-center self-center overflow-hidden rounded-xl border border-border bg-sunken active:opacity-80"
          style={{ aspectRatio: 4 / 5 }}
        >
          {uploading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <View className="items-center gap-2 px-6">
              <Icon name="image" size={22} color={colors.faint} />
              <Text className="text-center text-sm text-muted">
                Tap to add a cover photo
              </Text>
            </View>
          )}
        </Pressable>
      )}
      {coverUrl ? (
        <>
          <Text className="mb-1 text-center text-2xs text-faint">
            Tap the photo to set the focal point — this is what shows on your
            landing page.
          </Text>
          <Pressable
            onPress={removeCover}
            className="mb-3 self-center active:opacity-70"
          >
            <Text className="text-xs font-semibold text-muted">Remove cover</Text>
          </Pressable>
        </>
      ) : (
        <View className="mb-3" />
      )}
    </>
  );
}
