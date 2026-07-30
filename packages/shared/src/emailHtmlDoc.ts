/**
 * The `docFormat: "html"` document shape ("Paste HTML" — PR 2 of the
 * founder's editor feedback, 2026-07-30) — see `emailDocFormat.ts`'s module
 * doc for how this fits alongside `"blocks"`/`"tiptap"`.
 *
 * `doc` is `{ html: string }`: the SANITIZED, image-re-hosted HTML that came
 * out of `apps/convex/emailHtmlImport.ts`'s "use node" import action. This
 * module is the write-time gate every campaign write path
 * (`campaigns.ts#validateDocForFormat`) runs an `"html"`-format doc through —
 * mirrors `emailBlocks.ts#validateEmailDocument` / `tiptapEmail.ts#
 * validateTiptapEmailDoc`'s "validated at every write" posture exactly.
 *
 * ── Two sanitization layers, on purpose ─────────────────────────────────────
 * The REAL sanitizer (strip `<script>`, event handlers, `javascript:`, etc.,
 * while keeping the tables/inline-styles emails depend on) runs ONCE, in the
 * import action, using a real HTML parser (`sanitize-html`) — that's the only
 * place with the "use node" Node runtime a real parser needs, and the only
 * place untrusted paste content is ever accepted at the string level.
 *
 * `findHtmlDocHazard` below is a SEPARATE, coarse, regex-based backstop that
 * runs at every WRITE of an `"html"`-format doc (`createCampaign`,
 * `updateCampaignDoc`) — including a hypothetical direct API call that skips
 * the import action entirely. It is NOT a sanitizer (it never rewrites
 * anything) and it is NOT a substitute for the real one — it exists so that
 * no path, now or added later, can land a doc carrying an unsanitized
 * `<script>`/`javascript:`/event-handler payload in the table that a
 * composer's preview pane or a reviewer's inbox would then execute/render.
 * A doc that trips it is rejected outright with `INVALID_DOC`, same as any
 * other malformed document — the caller re-imports through Paste HTML so the
 * real sanitizer can do its job.
 */

export type EmailHtmlDocument = { html: string };

/** Generous but bounded — most mail clients clip well before this (Gmail
 *  clips around ~102KB), so this is purely an abuse/storage-size backstop,
 *  not a "will it render" prediction. */
export const MAX_HTML_DOC_CHARS = 600_000;

/** Coarse, deliberately over-inclusive hostile-content patterns — see this
 *  file's module doc for why a false positive here (rejecting something
 *  technically safe) is the correct failure direction: the caller re-runs
 *  the real sanitizer via the import action rather than this gate trying to
 *  be clever about what's "safe enough" to allow through unsanitized. */
const HAZARD_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /<script[\s>]/i, label: "a <script> tag" },
  { re: /<\/script\s*>/i, label: "a </script> tag" },
  { re: /<iframe[\s>]/i, label: "an <iframe> tag" },
  { re: /<object[\s>]/i, label: "an <object> tag" },
  { re: /<embed[\s>]/i, label: "an <embed> tag" },
  { re: /\son[a-z]+\s*=\s*["']/i, label: "an inline event handler attribute" },
  { re: /javascript\s*:/i, label: "a javascript: URL" },
  { re: /vbscript\s*:/i, label: "a vbscript: URL" },
  // Non-image `data:` URLs — `data:image/...` is fine (an inline, already
  // self-contained image), everything else (`data:text/html`,
  // `data:application/...`) is the payload shape a `data:` XSS uses.
  { re: /data\s*:\s*(?!image\/)/i, label: "a non-image data: URL" },
];

/** Scan `html` for a known-hostile construct; `null` means it looks clean by
 *  this coarse check (the real sanitizer is what actually earns that HTML's
 *  presence in a sent email — see module doc). */
export function findHtmlDocHazard(html: string): string | null {
  for (const { re, label } of HAZARD_PATTERNS) {
    if (re.test(html)) return label;
  }
  return null;
}

export type ValidateEmailHtmlDocumentResult =
  | { ok: true; doc: EmailHtmlDocument }
  | { ok: false; error: string };

/** The write gate `campaigns.ts#validateDocForFormat` dispatches
 *  `docFormat: "html"` through. Written defensively — `doc` is `v.any()` at
 *  the Convex boundary — so anything not shaped like `{ html: string }`
 *  fails cleanly rather than throwing a raw TypeError. */
export function validateEmailHtmlDocument(doc: unknown): ValidateEmailHtmlDocumentResult {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, error: "A pasted-HTML email must be an object." };
  }
  const html = (doc as Record<string, unknown>).html;
  if (typeof html !== "string") {
    return { ok: false, error: "A pasted-HTML email must carry an `html` string." };
  }
  if (html.trim().length === 0) {
    return { ok: false, error: "Paste the HTML first." };
  }
  if (html.length > MAX_HTML_DOC_CHARS) {
    return {
      ok: false,
      error: `Pasted HTML is too large (max ${MAX_HTML_DOC_CHARS.toLocaleString()} characters) — trim it down and re-paste.`,
    };
  }
  const hazard = findHtmlDocHazard(html);
  if (hazard) {
    return {
      ok: false,
      error: `Pasted HTML contains ${hazard} — re-import it through Paste HTML so it can be sanitized.`,
    };
  }
  return { ok: true, doc: { html } };
}

/** Coarse, root-level-only "did the author paste anything at all" check —
 *  the `"html"` twin of `campaigns.ts#tiptapDocContentIsEmpty` /
 *  `EmailDocument.blocks.length === 0`. `validateEmailHtmlDocument` already
 *  rejects a blank/whitespace-only `html` string, so in practice this only
 *  ever fires on a doc that failed validation entirely and is being probed
 *  defensively anyway. */
export function emailHtmlDocContentIsEmpty(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return true;
  const html = (doc as { html?: unknown }).html;
  return typeof html !== "string" || html.trim().length === 0;
}
