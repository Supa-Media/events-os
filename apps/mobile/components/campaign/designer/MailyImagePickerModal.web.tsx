/**
 * The library-first replacement for maily's native-file-dialog image
 * placeholder (founder bug #2 — see `pwImagePlaceholderIntercept.ts`'s module
 * doc for the click-interception mechanics this sits behind).
 *
 * Reuses the SAME two controls the toolbar above the editor already offers
 * for inserting a NEW image (`ImageLibraryPicker`, `ImageUploadButton`) —
 * "Choose from library…" is the PRIMARY path (a designer reusing the
 * wordmark/venue shot/song art doesn't have to leave the editor at all),
 * "Upload new…" is the secondary path for something genuinely new. No new
 * data-fetching component: `ImageLibraryPicker` already owns the `emailImages`
 * query and its own read-only/locked-document handling, so this modal is
 * pure layout around it.
 *
 * `.web.tsx` — only ever mounted by `MailyDocumentHost.web.tsx` (the maily
 * editor is web-only; native stays read-only, no image insertion at all).
 * The outer overlay/backdrop are plain `<div>`s, not RN `View`s, for the same
 * reason `MailyDocumentHost.web.tsx`'s editor container is: `position:
 * "fixed"` isn't in RN's `ViewStyle` type at all (react-native-web renders it
 * fine at runtime, but `View`'s TYPES reject it) — a real DOM element needs
 * no such workaround.
 */
import { Pressable, Text, View } from "react-native";
import { ImageUploadButton, type UploadedImage, type UploadImage } from "./DesignerControls";
import { ImageLibraryPicker } from "./ImageLibraryPicker";
import type { ActionRunner } from "../../../lib/useActionToast";

export function MailyImagePickerModal({
  onClose,
  onPick,
  uploadImage,
  run,
  onUploaded,
}: {
  onClose: () => void;
  onPick: (image: { url: string; alt: string }) => void;
  uploadImage: UploadImage | undefined;
  run: ActionRunner["run"];
  /** Same shape as the toolbar's own `ImageUploadButton` callback — the
   *  `storageId` rides along so the caller can register the upload into the
   *  shared image library exactly like every other upload path does. */
  onUploaded: (uploaded: UploadedImage, suggestedLabel: string) => void;
}) {
  return (
    <div
      role="presentation"
      style={{
        // `fixed`, not `absolute` — this overlay must cover the actual
        // browser VIEWPORT so the panel centers on screen regardless of how
        // tall the scrollable editor document is (an `absolute` `inset:0`
        // here sizes to the nearest positioned ancestor, which for a long
        // newsletter is the whole multi-thousand-pixel-tall document —
        // "centered" in that box lands far below the fold, near wherever the
        // designer happened to click).
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(33,9,9,0.35)",
      }}
    >
      <div
        aria-label="Close"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, cursor: "default" }}
      />
      <View
        className="rounded-lg border border-border bg-raised p-4"
        // Belt-and-suspenders alongside the NativeWind `className` above:
        // matches it exactly, just inline. NativeWind resolves the className
        // at build time in the real Metro app (this is redundant there); it's
        // load-bearing only for a plain-esbuild consumer that never runs the
        // NativeWind babel transform — this repo's `__adv__/harness/`.
        style={{
          width: 360,
          maxWidth: "90%",
          backgroundColor: "#FFFFFF",
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#EFE0DC",
          padding: 16,
        }}
      >
        <View
          className="mb-3 flex-row items-center justify-between"
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}
        >
          <Text className="text-sm font-bold text-ink" style={{ fontSize: 13, fontWeight: "700", color: "#210909" }}>
            Insert image
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text
              className="text-xs font-semibold text-muted"
              style={{ fontSize: 12, fontWeight: "600", color: "#7A5A5A" }}
            >
              Close
            </Text>
          </Pressable>
        </View>

        <ImageLibraryPicker
          onPick={(image) => {
            onPick(image);
            onClose();
          }}
        />

        {uploadImage ? (
          <ImageUploadButton
            uploadImage={uploadImage}
            run={run}
            label="Upload new…"
            onUploaded={(uploaded, suggestedLabel) => {
              onUploaded(uploaded, suggestedLabel);
              onClose();
            }}
          />
        ) : null}
      </View>
    </div>
  );
}

export default MailyImagePickerModal;
