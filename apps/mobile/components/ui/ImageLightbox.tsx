/**
 * Fullscreen image/PDF spotlight — tap a receipt/photo thumbnail to see it
 * large. A transparent `<Modal>` over a near-black backdrop with the content
 * contained (never cropped); tapping the backdrop or the ✕ closes it.
 * Deliberately tiny and self-contained (no gesture/zoom lib) — it's the "see
 * it bigger" affordance receipt previews were missing, not a full pan/zoom
 * viewer.
 *
 * PDFs (`isPdf`): a raw file URL handed to RN `<Image>` silently renders
 * nothing — `<Image>` can't decode `application/pdf`. This mirrors
 * `ReceiptDetailModal`'s own file-preview branch: web gets an inline
 * `<iframe>`; native (no RN PDF renderer) gets an "Open PDF"
 * `Pressable`/`Linking.openURL` fallback. The `Platform.OS === "web"` check
 * gates the JSX branch itself (not just a handler) — `<iframe>` is not a
 * valid host component on native and would crash the app if it ever mounted
 * there.
 *
 * Works on web and native: the backdrop is a plain `Pressable`, the image a
 * plain RN `<Image resizeMode="contain">`. On web an "Open original" link also
 * opens the file in a new tab for true 1:1 inspection / download.
 */
import { Image, Linking, Modal, Platform, Pressable, Text, View } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";

export function ImageLightbox({
  uri,
  visible,
  onClose,
  caption,
  isPdf = false,
}: {
  uri: string;
  visible: boolean;
  onClose: () => void;
  /** Optional label shown at the top (e.g. the receipt filename). */
  caption?: string;
  /** Render the PDF web-iframe/native-"Open PDF" branch instead of `<Image>`. */
  isPdf?: boolean;
}) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={isPdf ? "Close PDF" : "Close image"}
        className="flex-1 items-center justify-center bg-ink/95 p-4"
      >
        <View className="absolute inset-x-0 top-0 flex-row items-center justify-between px-4 pb-3 pt-5">
          <Text className="flex-1 text-sm text-raised/80" numberOfLines={1}>
            {caption ?? ""}
          </Text>
          {Platform.OS === "web" ? (
            <Pressable
              onPress={() => void Linking.openURL(uri)}
              hitSlop={8}
              className="mr-3 flex-row items-center gap-1.5 active:opacity-70"
            >
              <Icon name="external-link" size={15} color={colors.raised} />
              <Text className="text-xs font-semibold text-raised">Open original</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onClose} hitSlop={10} className="rounded-md p-1 active:opacity-70">
            <Icon name="x" size={22} color={colors.raised} />
          </Pressable>
        </View>
        {/* Stop taps on the content itself from closing (only the backdrop
            does), so a user can rest a pointer on the receipt without
            dismissing. */}
        <Pressable onPress={() => {}} className="h-full w-full max-w-4xl">
          {isPdf && Platform.OS === "web" ? (
            // RN-web renders this iframe directly in the DOM (same pattern as
            // `ReceiptDetailModal`'s inline PDF preview / `crew/BriefingView.tsx`'s
            // video embed). Gated on `Platform.OS === "web"` in the JSX itself —
            // see the file doc for why that must not be a runtime-only check.
            <iframe
              src={uri}
              title={caption ?? "Receipt PDF"}
              style={{ width: "100%", height: "100%", border: "0" }}
            />
          ) : isPdf ? (
            <View className="h-full w-full items-center justify-center">
              <Pressable
                onPress={() => void Linking.openURL(uri)}
                className="items-center gap-2 px-6 py-4 active:opacity-70"
              >
                <Icon name="file-text" size={28} color={colors.raised} />
                <Text className="text-sm font-semibold text-raised">Open PDF</Text>
              </Pressable>
            </View>
          ) : (
            <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
