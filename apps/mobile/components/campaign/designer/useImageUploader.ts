/**
 * The composer's image-upload flow, as a hook.
 *
 * generate-URL → POST → resolve a servable URL: the `CoverPhotoPicker` /
 * `doc/[id].tsx` precedent (the app's only prior image-upload flows), lifted
 * out of `campaign/[id]/design.tsx` when the template editor needed exactly
 * the same three steps. `storage.getUrl` is a QUERY, not a mutation, so it's
 * resolved on demand through the imperative Convex client rather than
 * `useQuery` (which subscribes reactively — not what a one-off resolve after
 * an upload needs).
 *
 * Returns `undefined` when `enabled` is false, which is what makes every
 * upload control in `DesignerControls` disappear on a locked document rather
 * than sit there and fail.
 */
import { useMemo } from "react";
import { useConvex, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { UploadImage, UploadedImage } from "./DesignerControls";

export function useDesignerImageUploader(enabled: boolean): UploadImage | undefined {
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const convex = useConvex();

  return useMemo<UploadImage | undefined>(() => {
    if (!enabled) return undefined;
    return async (file: Blob, contentType: string): Promise<UploadedImage> => {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: file,
      });
      // A non-2xx response's body usually isn't JSON at all (a proxy error
      // page, an empty body) — check `res.ok` BEFORE parsing it, or the real
      // failure (upload rejected) gets masked by a confusing JSON parse error
      // instead.
      if (!res.ok) {
        throw new Error(`Image upload failed (HTTP ${res.status})`);
      }
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      const url = await convex.query(api.storage.getUrl, { storageId });
      if (!url) throw new Error("Could not resolve uploaded image URL");
      // The `storageId` rides along because `emailImages.addImage` takes the
      // storage handle, not a client-supplied URL — it resolves the public
      // URL itself rather than trusting one it was handed.
      return { url, storageId };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
