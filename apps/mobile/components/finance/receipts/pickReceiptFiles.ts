/**
 * Pick one or more receipt files and upload them to Convex storage.
 *
 * Founder, 2026-10-24: "We also need to be able to attach more than one
 * receipt at a time." Every receipt uploader used to carry its own copy of
 * the web-input / expo-image-picker split, each taking `files[0]` — so a
 * charge with a split bill or a multi-photo receipt meant one round trip per
 * file. This is the one copy, and it takes every file the human picked.
 *
 * ONE PICKED FILE = ONE RECEIPT — exactly what was picked is uploaded, never
 * rasterized or split here (see `UploadZone`'s module doc).
 */
import { Platform } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";

/** One file the human picked. `filename` is `null` only when there genuinely
 *  isn't one (a native camera-roll pick). */
export type PickedReceiptFile = {
  blob: Blob;
  contentType: string;
  filename: string | null;
};

function pickWeb(): Promise<PickedReceiptFile[]> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve([]);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.multiple = true;
    input.onchange = () => {
      resolve(
        Array.from(input.files ?? []).map((file) => ({
          blob: file as Blob,
          contentType: file.type || "application/octet-stream",
          filename: file.name || null,
        })),
      );
    };
    input.click();
  });
}

async function pickNative(): Promise<PickedReceiptFile[]> {
  // Images only on native — there is no PDF picker there (the same
  // limitation `CoverPhotoPicker`/`RequestForm` accept).
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9,
    allowsMultipleSelection: true,
  });
  if (result.canceled || !result.assets?.length) return [];
  const out: PickedReceiptFile[] = [];
  for (const asset of result.assets) {
    const blob = await (await fetch(asset.uri)).blob();
    out.push({
      blob,
      contentType: asset.mimeType || blob.type || "image/jpeg",
      filename: asset.fileName ?? null,
    });
  }
  return out;
}

/** Open the platform's file picker. Resolves `[]` when the human cancels
 *  (on web a cancelled dialog may simply never resolve — callers must not
 *  hold a busy state across the pick itself). */
export function pickReceiptFiles(): Promise<PickedReceiptFile[]> {
  return Platform.OS === "web" ? pickWeb() : pickNative();
}

/** Upload one picked file to Convex storage. */
export async function uploadReceiptFile(
  file: PickedReceiptFile,
  generateUploadUrl: () => Promise<string>,
): Promise<Id<"_storage">> {
  const uploadUrl = await generateUploadUrl();
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.contentType },
    body: file.blob,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
  return storageId;
}
