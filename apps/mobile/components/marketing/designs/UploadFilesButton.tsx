/**
 * MARKETING · Designs — "upload a pile of photos and clips into this folder".
 *
 * The marketing lead's ask in one control: "is there a way we can create a
 * library where we can upload multiple images/vid content ex: WWS or Field
 * Day". A folder was already that library; what stopped it being used that way
 * was that adding to it meant a form per file. This button is the form removed
 * — pick forty photos, they land in the folder you are standing on, titled from
 * their filenames, editable afterwards like any other design.
 *
 * ── A button of its own, not a line on the Add menu ─────────────────────────
 * Two reasons, and the second is load-bearing. It is the thing people came to
 * do with an event folder, so it should not be one press further away than
 * "Face". And on web a file dialog may only be opened inside the gesture that
 * asked for it — going through a menu that closes first is how `input.click()`
 * turns into a popup the browser blocks.
 *
 * ── Uploads first, then ONE mutation ────────────────────────────────────────
 * Each file goes to Convex storage on its own (that is what an upload URL is),
 * and the batch is recorded in a single `addUploads` call. So the rows appear
 * together or not at all: a folder holding eleven of the twenty photos somebody
 * dropped, with no way to tell which nine are missing, is worse than a refusal.
 * A file whose upload itself fails takes the batch down with it, for the same
 * reason — the count in the toast has to be the truth.
 *
 * Sequential, not parallel. A phone on chapel wifi uploading forty videos at
 * once finishes no sooner and reports nothing useful on the way; one at a time
 * gives the honest "3 of 20" that tells somebody whether to keep waiting.
 *
 * ── Nothing is dropped quietly ──────────────────────────────────────────────
 * A pick can exceed what one press may add, and a file dialog's `accept` is a
 * filter rather than a promise — a drag-and-drop or a stubborn "All files" pick
 * still hands back the PDF. Both cases trim the batch, and both SAY so under
 * the button. Somebody who selected sixty photos and got forty without being
 * told is somebody who thinks twenty photos uploaded and went missing.
 */
import { useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
// expo-image-picker is Expo Go-safe (classified `core` in native-deps.json);
// only reached on native.
import * as ImagePicker from "expo-image-picker";
import {
  DESIGN_UPLOAD_ACCEPT,
  DESIGN_UPLOAD_BATCH_MAX,
  designKindForContentType,
} from "@events-os/shared";
import { Button } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { asId } from "./ids";

/** One picked file, whatever platform picked it. */
type Picked = { blob: Blob; name: string; contentType: string };

export function UploadFilesButton({
  /** The folder the batch lands in, or null for Unfiled. */
  folderId,
  /** How many designs the library can still hold. Below one, the button says
   *  so instead of collecting files the mutation will refuse. */
  room,
  run,
  onUploaded,
  title = "Upload files",
}: {
  folderId: string | null;
  room: number;
  run: ActionRunner["run"];
  /** How many landed, and where — the caller says so on the page. */
  onUploaded: (count: number) => void;
  title?: string;
}) {
  const generateUploadUrl = useMutation(
    api.marketingDesigns.generateDesignUploadUrl,
  );
  const addUploads = useMutation(api.marketingDesigns.addUploads);
  /** `{ done, total }` while a batch is in flight — the "3 of 20" line. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  /** What this press could not take, said under the button. */
  const [hint, setHint] = useState<string | null>(null);

  const full = room < 1;

  async function upload(files: Picked[]) {
    if (files.length === 0) return;
    setProgress({ done: 0, total: files.length });
    try {
      await run(
        async () => {
          const uploaded: {
            storageId: string;
            name: string;
            contentType: string;
          }[] = [];
          for (const file of files) {
            const uploadUrl = await generateUploadUrl();
            const res = await fetch(uploadUrl, {
              method: "POST",
              headers: { "Content-Type": file.contentType },
              body: file.blob,
            });
            const { storageId } = await res.json();
            uploaded.push({
              storageId: storageId as string,
              name: file.name,
              contentType: file.contentType,
            });
            setProgress({ done: uploaded.length, total: files.length });
          }
          const ids = await addUploads({
            files: uploaded.map((file) => ({
              storageId: asId(file.storageId),
              name: file.name,
              contentType: file.contentType,
            })),
            ...(folderId ? { folderIds: [asId(folderId)] } : {}),
          });
          onUploaded(ids.length);
        },
        { errorTitle: "Couldn't upload those files" },
      );
    } finally {
      setProgress(null);
    }
  }

  /**
   * Trim a pick to what this press can actually land, and say what it left.
   *
   * Both bounds are the server's (`DESIGN_UPLOAD_BATCH_MAX` and the library
   * cap), applied here so somebody who selected their whole camera roll gets
   * the first forty rather than an error and nothing — and told about the rest,
   * because a silent truncation reads as files that vanished.
   *
   * `skipped` is what the media filter refused before we got here.
   */
  function trim(files: Picked[], skipped: number): Picked[] {
    const limit = Math.min(DESIGN_UPLOAD_BATCH_MAX, room);
    const take = files.slice(0, limit);
    const dropped = files.length - take.length;
    setHint(
      dropped > 0
        ? `Uploading the first ${take.length} — pick the remaining ${dropped} in another go.`
        : skipped > 0 && take.length === 0
          ? "Photos and video only — add anything else as a design with a link."
          : skipped > 0
            ? `${skipped} file${skipped === 1 ? "" : "s"} skipped — the library holds photos and video; anything else goes in as a link.`
            : null,
    );
    return take;
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = DESIGN_UPLOAD_ACCEPT;
    input.onchange = () => {
      const chosen = Array.from(input.files ?? []);
      const picked = chosen
        // The dialog's `accept` is a filter, not a promise — a drag-and-drop or
        // a stubborn "All files" pick can still hand back a PDF, and the
        // mutation would refuse the whole batch for it.
        .filter((file) => designKindForContentType(file.type) !== null)
        .map((file) => ({
          blob: file,
          name: file.name,
          contentType: file.type,
        }));
      void upload(trim(picked, chosen.length - picked.length));
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      selectionLimit: Math.min(DESIGN_UPLOAD_BATCH_MAX, room),
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const picked: Picked[] = [];
    let skipped = 0;
    for (const asset of result.assets) {
      const resp = await fetch(asset.uri);
      const blob = await resp.blob();
      // `expo-image-picker` reports the type as "image"/"video" separately from
      // the MIME type, and either can be missing on an older OS — so the asset's
      // own `type` is the fallback that keeps a clip from being filed as a JPEG.
      const contentType =
        asset.mimeType ??
        (blob.type ||
          (asset.type === "video" ? "video/mp4" : "image/jpeg"));
      if (designKindForContentType(contentType) === null) {
        skipped += 1;
        continue;
      }
      picked.push({
        blob,
        name: asset.fileName ?? `${asset.type ?? "image"}-${picked.length + 1}`,
        contentType,
      });
    }
    await upload(trim(picked, skipped));
  }

  return (
    <View className="items-end">
      <View className="flex-row items-center gap-2">
        {progress ? (
          <View className="flex-row items-center gap-1.5">
            <ActivityIndicator size="small" />
            <Text className="text-2xs text-muted">
              Uploading {progress.done} of {progress.total}…
            </Text>
          </View>
        ) : null}
        <Button
          title={full ? "Library full" : title}
          icon="upload"
          size="sm"
          variant="secondary"
          disabled={Boolean(progress) || full}
          onPress={() => {
            setHint(null);
            if (Platform.OS === "web") pickWeb();
            else void pickNative();
          }}
        />
      </View>
      {hint ? (
        <Text className="mt-1 max-w-xs text-right text-2xs text-muted">{hint}</Text>
      ) : null}
    </View>
  );
}
