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
 *      `<style>`, legacy `background=`, INCLUDING protocol-relative
 *      `//host/…` references).
 *   2. RE-HOST each one: SSRF-check it (`ssrfGuard.ts`), fetch it (no
 *      auto-follow on redirects — see `fetchImageBlob`), store the blob in
 *      Convex storage (the same `ctx.storage.store` → `ctx.storage.getUrl`
 *      two-step `emailImages.ts`/`migrations/0052_import_newsletter_images.ts`
 *      use for exactly this "found a URL, want a URL we control" shape),
 *      and rewrite every occurrence of the ORIGINAL reference to either the
 *      re-hosted URL (success) or an inert local placeholder (failure — see
 *      "Failure handling" below) — `rewriteImageUrls`. THIS is what makes
 *      hosting reliable — a Canva export's own CDN URLs expire/block
 *      hotlinking; a Convex storage URL doesn't, and a failed one never
 *      ships as a live third-party reference either.
 *   3. SANITIZE the (now-rewritten) html for real (`sanitizeEmailHtml` — a
 *      real parser, `sanitize-html`, not a regex pass) — strips
 *      `<script>`, event handlers, `javascript:`/non-image `data:` URLs,
 *      `<iframe>`/`<object>`/`<embed>`/`<form>`/`<link>`/`<base>`, a
 *      `<meta http-equiv>`, and CSS-level hazards, while keeping the
 *      tables/inline styles a real newsletter paste depends on.
 *
 * ── Failure handling (the founder's other hard requirement) ────────────────
 * A single image that 404s, times out, isn't actually an image, exceeds the
 * size cap, redirects, or fails the SSRF check is SKIPPED — recorded in the
 * returned `failures` array and logged in FULL DETAIL server-side
 * (`console.warn`) — never a thrown error that aborts the whole import. The
 * email a designer is trying to send should not be blocked because one
 * decorative image on a CDN went stale; it should ship with that one image
 * dropped and a clear list of what to go fix.
 *
 * TWO things changed here in the adversarial-review pass (2026-07-30):
 *   - A failed image's ORIGINAL external reference no longer survives into
 *     the returned html (finding #7) — it's rewritten to a fully inert,
 *     local `data:` placeholder (a 1×1 transparent GIF), so the SENT email
 *     makes ZERO third-party calls for an image this import couldn't
 *     verify, not just "the ones that worked are re-hosted." The founder's
 *     "make sure the images are hosted reliably" reads as drop-not-leak;
 *     flagged as a product decision in this PR's report regardless.
 *   - Every failure reason returned to the CALLER is now the SAME generic
 *     string (finding #6's closing note) — a per-cause message (404 vs.
 *     "blocked: private IP" vs. timeout) would let a compose-power holder
 *     use this import action as a blind SSRF/internal-network oracle,
 *     probing which internal hosts/ports exist by the shape of the failure
 *     they get back. The SPECIFIC reason is still logged server-side
 *     (`console.warn`) for whoever needs to actually debug an import.
 *
 * Bounded to `MAX_IMAGE_URLS` (`emailHtmlSanitize.ts`) distinct images and
 * `MAX_IMAGE_BYTES` per image — both abuse backstops, not realistic
 * ceilings for a real newsletter paste.
 *
 * ── SSRF guard (`ssrfGuard.ts`) ─────────────────────────────────────────────
 * Every resolved fetch URL (after `resolveImageFetchUrl` turns a
 * protocol-relative reference into `https:…`) is checked against
 * loopback/private/link-local/reserved IP ranges — both as a literal and via
 * DNS resolution — BEFORE this action ever calls `fetch`. See that file's
 * own doc for the documented DNS-rebinding residual risk. Redirects are
 * refused outright (`redirect: "manual"`, any 3xx treated as a failure)
 * rather than followed and re-checked — the simplest way to guarantee the
 * SSRF guard's verdict on the URL a designer pasted is the URL this action
 * actually fetches.
 *
 * ── Why "use node" ───────────────────────────────────────────────────────
 * `sanitizeEmailHtml` needs a real HTML parser (`sanitize-html`, built on
 * `htmlparser2`) — heavier than the default V8-isolate runtime's guidelines
 * call for, and the task brief calls for the Node runtime explicitly so
 * `fetch` + a real parser/sanitizer (and, now, `node:net`/`node:dns` for the
 * SSRF guard) can all run here. FLAGGED FIRST-DEPLOY RISK (see this repo's
 * own precedent with `juice`): `sanitize-html`'s dependency tree
 * (`htmlparser2`, `postcss`, `deepmerge`, `parse-srcset`, …) is pure JS with
 * no native bindings and no `fs`/`net` usage of its OWN, which is the
 * profile of dependency that bundles cleanly in a Convex node action — but
 * this has only been verified by `vitest` (plain Node), never a REAL
 * `convex deploy`. Watch the first deploy after this ships.
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
  resolveImageFetchUrl,
  rewriteImageUrls,
  sanitizeEmailHtml,
} from "./lib/emailHtmlSanitize";
import { assertSafeImageUrl } from "./lib/ssrfGuard";

/** Abuse backstop on the RAW paste size, before any processing — generous
 *  (a Canva export with inline styles can run large), bounded so a
 *  multi-megabyte paste can't tie up the action indefinitely. The FINAL
 *  stored doc is bounded again, separately, at write time
 *  (`emailHtmlDoc.ts`'s `MAX_HTML_DOC_CHARS`). */
const MAX_RAW_HTML_CHARS = 2_000_000;

/** Per-image size cap — a "reasonable newsletter photo," not a raw dump;
 *  bounds both the fetch and the Convex storage write. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** How long one image fetch (DNS + connect + full body) gets before it's
 *  treated as a failure — a paste with several slow/dead CDN links must
 *  still finish in reasonable time, not hang the whole import on the last
 *  one. */
const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/** The SAME generic message for every fetch failure, regardless of cause —
 *  see this file's module doc, "Failure handling", for why a per-cause
 *  message is an SSRF/internal-network oracle. The REAL reason is always
 *  logged server-side via `console.warn` right where it's discovered. */
const GENERIC_FAILURE_REASON = "Couldn't fetch this image.";

/** A fully self-contained, zero-network 1×1 transparent GIF — what a failed
 *  image reference is rewritten to (finding #7) so the returned html never
 *  carries a live third-party reference for an image this import couldn't
 *  verify. Renders as a blank/invisible pixel rather than a broken-image
 *  icon, and (unlike an EMPTY `src=""`) never triggers the "empty src
 *  re-requests the current document" browser quirk. */
const INERT_IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export type ImageImportFailure = { url: string; reason: string };

async function fetchImageBlob(
  originalRef: string,
): Promise<{ ok: true; blob: Blob } | { ok: false; reason: string }> {
  const fetchUrl = resolveImageFetchUrl(originalRef);

  const safety = await assertSafeImageUrl(fetchUrl);
  if (!safety.ok) {
    console.warn(`[emailHtmlImport] blocked by SSRF guard (${safety.reason}): ${originalRef}`);
    return { ok: false, reason: safety.reason };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(fetchUrl, {
      signal: controller.signal,
      // Never auto-follow a redirect — a redirect target is a DIFFERENT URL
      // this action never SSRF-checked. Treating any redirect as a plain
      // failure (below) is simpler and safer than re-validating a chain of
      // hops. See this file's module doc, "SSRF guard".
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, reason: `redirected (HTTP ${res.status || "3xx"})` };
    }
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

    // ── 1. Find every external image reference (absolute + protocol-relative) ──
    const imageUrls = findImageUrls(bounded);

    // ── 2. Re-host each one — never let one failure abort the rest. EVERY
    // found reference gets a urlMap entry: the re-hosted URL on success, the
    // inert local placeholder on failure — so step 3's rewrite leaves NO
    // original external reference behind either way (finding #7). ──────────
    const urlMap = new Map<string, string>();
    const failures: ImageImportFailure[] = [];
    for (const originalRef of imageUrls) {
      const fetched = await fetchImageBlob(originalRef);
      if (!fetched.ok) {
        console.warn(`[emailHtmlImport] dropped image (${fetched.reason}): ${originalRef}`);
        failures.push({ url: originalRef, reason: GENERIC_FAILURE_REASON });
        urlMap.set(originalRef, INERT_IMAGE_PLACEHOLDER);
        continue;
      }
      const storageId = await ctx.storage.store(fetched.blob);
      const rehostedUrl = await ctx.storage.getUrl(storageId);
      if (!rehostedUrl) {
        // Stored but storage won't serve it — don't leave an orphaned blob
        // behind (mirrors `migrations/0052_import_newsletter_images.ts`'s
        // identical guard), and don't leave the original live reference in
        // the output either.
        await ctx.storage.delete(storageId);
        console.warn(`[emailHtmlImport] stored but storage.getUrl returned null: ${originalRef}`);
        failures.push({ url: originalRef, reason: GENERIC_FAILURE_REASON });
        urlMap.set(originalRef, INERT_IMAGE_PLACEHOLDER);
        continue;
      }
      urlMap.set(originalRef, rehostedUrl);
    }

    // ── 3. Rewrite, then sanitize for real ─────────────────────────────────
    const rewritten = rewriteImageUrls(bounded, urlMap);
    const sanitized = sanitizeEmailHtml(rewritten);

    return {
      html: sanitized,
      imagesFound: imageUrls.length,
      imagesRehosted: imageUrls.length - failures.length,
      failures,
    };
  },
});
