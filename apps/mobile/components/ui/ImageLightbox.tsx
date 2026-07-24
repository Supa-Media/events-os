/**
 * Fullscreen image spotlight — tap a receipt/photo thumbnail to see it large.
 * A transparent `<Modal>` over a near-black backdrop with the image contained
 * (never cropped); tapping anywhere or the ✕ closes it. Deliberately tiny and
 * self-contained (no gesture/zoom lib) — it's the "see it bigger" affordance
 * receipt previews were missing, not a full pan/zoom viewer.
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
}: {
  uri: string;
  visible: boolean;
  onClose: () => void;
  /** Optional label shown at the top (e.g. the receipt filename). */
  caption?: string;
}) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close image"
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
        {/* Stop taps on the image itself from closing (only the backdrop does),
            so a user can rest a pointer on the receipt without dismissing. */}
        <Pressable onPress={() => {}} className="h-full w-full max-w-4xl">
          <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
