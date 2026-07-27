/**
 * The small shared controls the campaign block editors are built from.
 *
 * These lived inside `BlockCard.tsx` while `image` was the only block that
 * needed them. The `card`/`columns` blocks reuse BOTH (`CardContentEditor`
 * needs the same upload affordance and the same segmented toggle), and a
 * component can't be shared out of the file that also owns the editor switch
 * without an import cycle — so they moved here, unchanged in behavior. This
 * is the "extract on second use" rule the UI kit itself follows: a control
 * earns its own module the moment a second caller needs it, not before.
 */
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
// expo-image-picker is Expo Go-safe (classified `core` in native-deps.json);
// only used on native, mirroring `CoverPhotoPicker`'s upload flow.
import * as ImagePicker from "expo-image-picker";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";

/** A small two-state toggle button — heading level, button align, column
 *  count, image width. The designer's segmented control. */
export function LevelToggle({
  label,
  active,
  onPress,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      className={`rounded-md border px-2.5 py-1 ${
        active ? "border-accent bg-accent-soft" : "border-border bg-raised"
      } ${disabled ? "opacity-40" : ""}`}
    >
      <Text
        className={`text-xs font-medium ${active ? "font-semibold text-accent" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The result of one upload.
 *
 * BOTH halves are needed downstream and neither can be derived from the
 * other: the block stores the public `url` (a mail client fetches it days
 * later, from a machine that never talked to this backend), while
 * `emailImages.addImage` takes the `storageId` and resolves the URL itself
 * rather than trusting a client-supplied one.
 */
export type UploadedImage = { url: string; storageId: Id<"_storage"> };

/** Uploader for a picked file. */
export type UploadImage = (
  file: Blob,
  contentType: string,
) => Promise<UploadedImage>;

/**
 * Cross-platform "Upload image" affordance — web file input, native picker,
 * mirroring `CoverPhotoPicker`'s upload flow (generate-URL, POST, resolve to
 * a servable URL) which is the app's only prior image-upload precedent.
 *
 * `onUploaded` also receives a SUGGESTED LABEL (the picked file's own name,
 * minus its extension) so the caller can file the upload into the shared
 * image library under something recognisable instead of "image-4.jpg".
 */
export function ImageUploadButton({
  uploadImage,
  onUploaded,
  run,
  label = "Upload image…",
}: {
  uploadImage: UploadImage;
  onUploaded: (uploaded: UploadedImage, suggestedLabel: string) => void;
  run: ActionRunner["run"];
  label?: string;
}) {
  const [uploading, setUploading] = useState(false);

  async function uploadBlob(blob: Blob, contentType: string, fileName: string) {
    setUploading(true);
    try {
      // `run` surfaces a failure (a bad response, a network error) via the
      // screen's toast/Alert instead of silently swallowing it — previously
      // an upload failure here left the spinner stop with no explanation.
      await run(
        async () => {
          const uploaded = await uploadImage(blob, contentType);
          onUploaded(uploaded, labelFromFileName(fileName));
        },
        { errorTitle: "Couldn't upload image" },
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
      if (file) void uploadBlob(file, file.type || "image/jpeg", file.name);
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
    await uploadBlob(
      blob,
      asset.mimeType || blob.type || "image/jpeg",
      asset.fileName ?? "",
    );
  }

  return (
    <Pressable
      onPress={() => (Platform.OS === "web" ? pickWeb() : void pickNative())}
      disabled={uploading}
      accessibilityRole="button"
      className="flex-row items-center gap-2 self-start rounded-md border border-border-strong bg-raised px-3 py-1.5 active:bg-sunken web:hover:bg-sunken"
    >
      {uploading ? <ActivityIndicator size="small" color={colors.muted} /> : null}
      <Text className="text-xs font-semibold text-ink">
        {uploading ? "Uploading…" : label}
      </Text>
    </Pressable>
  );
}

/** "hero-photo-final(2).JPG" → "hero photo final(2)". A human-readable
 *  starting point for the library label, not a slug — the designer can edit
 *  it, and an empty result is the caller's cue to fall back to a date. */
export function labelFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  return base
    .replace(/\.[a-zA-Z0-9]{1,5}$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** A hairline-separated group header inside a block editor — used to mark
 *  each column of a `columns` block, where three identical field stacks
 *  otherwise blur into one. */
export function EditorGroup({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="mb-3 rounded-md border border-border bg-surface p-3">
      <View className="mb-2 flex-row items-center justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
          {title}
        </Text>
        {right}
      </View>
      {children}
    </View>
  );
}
