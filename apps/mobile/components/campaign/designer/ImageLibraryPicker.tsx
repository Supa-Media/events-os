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
 * Picking an image fills BOTH `imageUrl` and `imageAlt` — the row carries the
 * description written the first time the image was used, so reuse means
 * reusing the alt text too. That's the whole accessibility argument for the
 * feature: the description gets written once, properly, and then travels with
 * the asset (see `useImageLibraryRegistration` for how it gets there).
 */
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";

/**
 * The library is CENTRAL-scoped, matching every other campaigns surface
 * (`CampaignsListView`) — there's no chapter picker on this desk to feed one.
 */
const SCOPE = "central" as const;

const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 68;

/** A "Choose from library…" trigger + the inline grid it expands. */
export function ImageLibraryPicker({
  onPick,
}: {
  /** Called with the chosen image — the caller writes BOTH url and alt. */
  onPick: (image: { url: string; alt: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  // "skip" until the panel is actually opened: a long newsletter has a
  // dozen card/column/image editors mounted at once, and none of them needs
  // a live subscription to the whole library just to render a button.
  const images = useQuery(
    api.emailImages.listImages,
    open ? { scope: SCOPE } : "skip",
  );

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
                      onPick({ url: img.url, alt: img.alt });
                      setOpen(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Use image ${img.label ?? img.alt}`}
                    className="rounded-md border border-border p-1 active:bg-sunken web:hover:bg-sunken"
                    style={{ width: THUMB_WIDTH + 8 }}
                  >
                    <Image
                      source={{ uri: img.url }}
                      style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT, borderRadius: 4 }}
                      resizeMode="cover"
                      accessibilityLabel={img.alt}
                    />
                    <Text className="mt-1 text-2xs text-muted" numberOfLines={2}>
                      {img.label || img.alt || "Untitled"}
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
 * Registering a freshly-uploaded image into the library, and backfilling its
 * description once the designer writes one.
 *
 * ── Why not just register with the file name as alt ────────────────────────
 * A file name is not alt text. "hero photo final 2" read aloud is worse than
 * silence, and worse still it LOOKS written, so nobody ever fixes it. The
 * row is therefore created with an empty `alt` (the contract's legitimate
 * "decorative" value) and updated the moment the block's own alt field —
 * which nags visibly until it's filled — has something real in it. That's
 * what makes reuse worth anything: the description is written once,
 * properly, and travels with the asset to every future campaign.
 *
 * ── Why a hook, and why it swallows failures ───────────────────────────────
 * A hook because `ImageUploadButton` lives in `DesignerControls.tsx`, which
 * is deliberately convex-free (it's a presentational control). Failures are
 * logged rather than surfaced through `useActionRunner` because this is a
 * side effect the designer never asked for: her upload has already succeeded
 * and is already in the block, so failing to ALSO index it for reuse is a
 * lost nicety, not a failed edit — and raising an Alert for it would train
 * her to dismiss the upload errors that do matter.
 */
const ALT_BACKFILL_DEBOUNCE_MS = 800;

export function useImageLibraryRegistration() {
  const addImage = useMutation(api.emailImages.addImage);
  const updateImage = useMutation(api.emailImages.updateImage);
  /** The row created by the most recent upload from THIS editor, or null when
   *  there's nothing of ours to backfill (a library pick, a pasted URL). */
  const imageIdRef = useRef<Id<"emailImages"> | null>(null);
  const pendingAltRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  function warn(err: unknown) {
    console.warn("Couldn't file the image into the campaign image library", err);
  }

  function register(storageId: Id<"_storage">, label: string) {
    imageIdRef.current = null;
    pendingAltRef.current = "";
    void addImage({ scope: SCOPE, storageId, alt: "", label })
      .then((imageId) => {
        imageIdRef.current = imageId;
        // The designer can easily out-type the round trip; if she already
        // wrote a description while this was in flight, apply it now rather
        // than waiting for another keystroke that may never come.
        const alt = pendingAltRef.current.trim();
        if (alt) void updateImage({ imageId, alt }).catch(warn);
      })
      .catch(warn);
  }

  /** Called on every alt-text keystroke. Debounced, and a no-op unless this
   *  editor actually created a library row. */
  function noteAlt(alt: string) {
    pendingAltRef.current = alt;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const imageId = imageIdRef.current;
      const next = pendingAltRef.current.trim();
      if (!imageId || !next) return;
      void updateImage({ imageId, alt: next }).catch(warn);
    }, ALT_BACKFILL_DEBOUNCE_MS);
  }

  return { register, noteAlt };
}
