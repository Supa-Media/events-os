/**
 * IMAGE LIBRARY — pick a previously-used campaign image instead of
 * re-uploading it.
 *
 * The designer's complaint behind this: every newsletter reuses the same
 * handful of assets (the wordmark lockup, the venue shot, the song-of-the-
 * month artwork) and the only way to get one into an email was to find the
 * file on disk and upload it again, producing a fresh storage blob and a
 * fresh chance to forget the alt text.
 *
 * Interaction idiom is `ui/Field.tsx`'s `Select`: a trigger that expands an
 * INLINE panel rather than a modal. The designer is mid-edit inside a block
 * card; a full-screen modal would hide the field she's filling in, and the
 * app has no reusable modal primitive to begin with (`Popover`/`ContextMenu`
 * are anchored menus, not content panels).
 *
 * Picking an image fills BOTH `imageUrl` and `imageAlt` — the library row
 * carries the label that was written when the image was first added, so
 * reuse means reusing the alt text too. That's the whole accessibility
 * argument for the feature: alt text gets written once, correctly, and then
 * travels with the asset.
 */
import { useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";

/**
 * One row of `api.emailImages.listImages`.
 *
 * ⚠ The backend module (`apps/convex/emailImages.ts`) is being written
 * concurrently with this screen; this is the shape it is coded against —
 * `label` doubles as the image's alt text. Declared as a local type rather
 * than derived via `FunctionReturnType` so that, the moment the real module
 * lands, TypeScript checks the real row against it here instead of silently
 * flowing `any` through the component.
 */
export type EmailImageRow = {
  _id: string;
  url: string;
  label: string;
};

const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 68;

/** A "Choose from library…" trigger + the inline grid it expands. */
export function ImageLibraryPicker({
  onPick,
}: {
  /** Called with the chosen image — the caller writes BOTH url and alt. */
  onPick: (image: { url: string; label: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  // "skip" until the panel is actually opened: a long newsletter has a
  // dozen card/column/image editors mounted at once, and none of them needs
  // a live subscription to the whole library just to render a button.
  const images = useQuery(api.emailImages.listImages, open ? {} : "skip") as
    | EmailImageRow[]
    | undefined;

  return (
    <View className="mb-3">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-2 self-start rounded-md border border-border-strong bg-raised px-3 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name={open ? "chevron-up" : "image"} size={13} color={colors.muted} />
        <Text className="text-xs font-semibold text-ink">Choose from library…</Text>
      </Pressable>

      {open ? (
        <View className="mt-2 rounded-md border border-border bg-raised p-2">
          {images === undefined ? (
            <Text className="px-1 py-2 text-xs text-faint">Loading images…</Text>
          ) : images.length === 0 ? (
            <Text className="px-1 py-2 text-xs text-muted">
              Nothing here yet — images you upload are added to the library
              automatically, and can be reused in any campaign.
            </Text>
          ) : (
            <ScrollView className="max-h-64">
              <View className="flex-row flex-wrap gap-2">
                {images.map((img) => (
                  <Pressable
                    key={img._id}
                    onPress={() => {
                      onPick({ url: img.url, label: img.label });
                      setOpen(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Use image ${img.label}`}
                    className="rounded-md border border-border p-1 active:bg-sunken web:hover:bg-sunken"
                    style={{ width: THUMB_WIDTH + 8 }}
                  >
                    <Image
                      source={{ uri: img.url }}
                      style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT, borderRadius: 4 }}
                      resizeMode="cover"
                      accessibilityLabel={img.label}
                    />
                    <Text className="mt-1 text-2xs text-muted" numberOfLines={2}>
                      {img.label || "Untitled"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * File a freshly-uploaded image into the library.
 *
 * A hook rather than something `ImageUploadButton` does itself, because that
 * button lives in `DesignerControls.tsx`, which is deliberately convex-free
 * (it's a presentational control).
 *
 * Deliberately NOT routed through `useActionRunner`: this is a side effect
 * the designer never asked for. Her upload has already succeeded and is
 * already in the block — failing to ALSO index it for reuse is a lost
 * nicety, not a failed edit, and raising a modal Alert for it would train
 * her to ignore upload errors that do matter. It's logged instead.
 */
export function useAddToImageLibrary() {
  const addImage = useMutation(api.emailImages.addImage);
  return (url: string, label: string) => {
    void addImage({ url, label }).catch((err: unknown) => {
      console.warn("Couldn't add image to the campaign image library", err);
    });
  };
}
