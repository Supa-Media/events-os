"use node";

/**
 * "Paste HTML" import (PR 2 of the founder's editor feedback, verbatim:
 * "there should be an option to forgo the email editor entirely and just
 * use a html paste from things like canva to send the email. We do have to
 * make sure the images are hosted reliably though", 2026-07-30).
 *
 * `importPastedHtml` is the ONE place untrusted paste content is ever
 * accepted at the string level: it takes raw pasted HTML from the "Paste
 * HTML" composer and returns HTML that's safe to store as a
 * `docFormat: "html"` campaign doc (`{ html }` — see `@events-os/shared`'s
 * `emailHtmlDoc.ts`), preview, and eventually send. Three things happen, in
 * this order (mirrors `lib/emailHtmlSanitize.ts`'s module doc):
 *
 *   1. FIND every external image reference in the RAW html
 *      (`findImageUrls` — `<img src>`, CSS `url(...)` in `style=`/
 *      `<style>`, legacy `background=`).
 *   2. RE-HOST each one: fetch it, store the blob in Convex storage (the
 *      same `ctx.storage.store` → `ctx.storage.getUrl` two-step
 *      `emailImages.ts`/`migrations/0052_import_newsletter_images.ts` use
 *      for exactly this "found a URL, want a URL we control" shape), and
 *      rewrite every occurrence of the original URL to the re-hosted one
 *      (`rewriteImageUrls`). THIS is what makes hosting reliable — a Canva
 *      export's own CDN URLs expire/block hotlinking; a Convex storage URL
 *      doesn't.
 *   3. SANITIZE the (now-rewritten) html for real (`sanitizeEmailHtml` — a
 *      real parser, `sanitize-html`, not a regex pass) — strips
 *      `<script>`, event handlers, `javascript:`/non-image `data:` URLs,
 *      `<iframe>`/`<object>`/`<embed>`, while keeping the tables/inline
 *      styles a real newsletter paste depends on.
 *
 * ── Failure handling (the founder's other hard requirement) ────────────────
 * A single image that 404s, times out, isn't actually an image, or exceeds
 * the size cap is SKIPPED — recorded in the returned `failures` array and
 * logged (`console.warn`) — never a thrown error that aborts the whole
 * import. The email a designer is trying to send should not be blocked
 * because one decorative image on a CDN went stale; it should ship with
 * that one image broken and a clear list of what to go fix. Bounded to
 * `MAX_IMAGE_URLS` distinct images and `MAX_IMAGE_BYTES` per image — both
 * abuse backstops, not realistic ceilings for a real newsletter paste.
 *
 * ── Why "use node" ───────────────────────────────────────────────────────
 * `sanitizeEmailHtml` needs a real HTML parser (`sanitize-html`, built on
 * `htmlparser2`) — heavier than the default V8-isolate runtime's guidelines
 * call for, and the task brief calls for the Node runtime explicitly so
 * `fetch` + a real parser/sanitizer can both run here. `fetch()` itself
 * works in either runtime, but the sanitizer decides the file's runtime.
 * FLAGGED FIRST-DEPLOY RISK (see this repo's own precedent with `juice`):
 * `sanitize-html`'s dependency tree (`htmlparser2`, `postcss`, `deepmerge`,
 * `parse-srcset`, …) is pure JS with no native bindings and no `fs`/`net`
 * usage, which is the profile of dependency that bundles cleanly in a
 * Convex node action — but this has only been verified by `vitest`
 * (plain Node), never a REAL `convex deploy`. Watch the first deploy after
 * this ships.
 *
 * Auth-gated exactly like composing an email — reuses
 * `campaigns.ts#assertAccessForAction` (`requireCampaignCompose`) rather
 * than a new resolver, since importing pasted HTML for a campaign IS
 * composing one (see `lib/campaignsAccess.ts`'s doc on why compose is a
 * named power).
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  findImageUrls,
  rewriteImageUrls,
  sanitizeEmailHtml,
} from "./lib/emailHtmlSanitize";

/** Abuse backstop on the RAW paste size, before any processing — generous
 *  (a Canva export with inline styles can run large), bounded so a
 *  multi-megabyte paste can't tie up the action indefinitely. The FINAL
 *  stored doc is bounded again, separately, at write time
 *  (`emailHtmlDoc.ts`'s `MAX_HTML_DOC_CHARS`). */
const MAX_RAW_HTML_CHARS = 2_000_000;

/** Per-image size cap — a "reasonable newsletter photo," not a raw dump;
 *  bounds both the fetch and the Convex storage write. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** How long one image fetch gets before it's treated as a failure — a
 *  paste with several slow/dead CDN links must still finish in reasonable
 *  time, not hang the whole import on the last one. */
const IMAGE_FETCH_TIMEOUT_MS = 8_000;

export type ImageImportFailure = { url: string; reason: string };

async function fetchImageBlob(
  url: string,
): Promise<{ ok: true; blob: Blob } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return { ok: false, reason: `not an image (content-type: ${contentType || "unknown"})` };
    }
    const blob = await res.blob();
    if (blob.size === 0) {
      return { ok: false, reason: "empty response body" };
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `${blob.size} bytes exceeds the ${MAX_IMAGE_BYTES}-byte cap` };
    }
    return { ok: true, blob };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

export const importPastedHtml = action({
  args: { html: v.string() },
  returns: v.object({
    html: v.string(),
    imagesFound: v.number(),
    imagesRehosted: v.number(),
    failures: v.array(v.object({ url: v.string(), reason: v.string() })),
  }),
  handler: async (
    ctx,
    { html },
  ): Promise<{
    html: string;
    imagesFound: number;
    imagesRehosted: number;
    failures: ImageImportFailure[];
  }> => {
    await ctx.runQuery(internal.campaigns.assertAccessForAction, {});

    if (html.trim().length === 0) {
      return { html: "", imagesFound: 0, imagesRehosted: 0, failures: [] };
    }
    const bounded = html.length > MAX_RAW_HTML_CHARS ? html.slice(0, MAX_RAW_HTML_CHARS) : html;

    // ── 1. Find every external image reference ────────────────────────────
    const imageUrls = findImageUrls(bounded);

    // ── 2. Re-host each one — never let one failure abort the rest ────────
    const urlMap = new Map<string, string>();
    const failures: ImageImportFailure[] = [];
    for (const url of imageUrls) {
      const fetched = await fetchImageBlob(url);
      if (!fetched.ok) {
        console.warn(`[emailHtmlImport] dropped image (${fetched.reason}): ${url}`);
        failures.push({ url, reason: fetched.reason });
        continue;
      }
      const storageId = await ctx.storage.store(fetched.blob);
      const rehostedUrl = await ctx.storage.getUrl(storageId);
      if (!rehostedUrl) {
        // Stored but storage won't serve it — don't leave an orphaned blob
        // OR a broken re-hosted reference behind (mirrors
        // `migrations/0052_import_newsletter_images.ts`'s identical guard).
        await ctx.storage.delete(storageId);
        console.warn(`[emailHtmlImport] stored but storage.getUrl returned null: ${url}`);
        failures.push({ url, reason: "stored but couldn't resolve a servable URL" });
        continue;
      }
      urlMap.set(url, rehostedUrl);
    }

    // ── 3. Rewrite, then sanitize for real ─────────────────────────────────
    const rewritten = rewriteImageUrls(bounded, urlMap);
    const sanitized = sanitizeEmailHtml(rewritten);

    return {
      html: sanitized,
      imagesFound: imageUrls.length,
      imagesRehosted: urlMap.size,
      failures,
    };
  },
});
