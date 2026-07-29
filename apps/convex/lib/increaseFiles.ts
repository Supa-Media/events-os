/**
 * Increase Files API upload plumbing (WP-C.2 card art): a hand-built
 * `multipart/form-data` POST — `/files` is the one Increase endpoint that
 * isn't JSON. Pure helpers only (see `lib/increaseApi.ts`'s header note);
 * the registered card-art pipeline lives in `increaseCardArt.ts`.
 */
import { ConvexError } from "convex/values";
import { describeIncreaseError } from "./increaseApi";

/** The two `POST /files` `purpose` values WP-C.2 uses — grounded against
 *  `increase-typescript`'s `Files` resource (the full `purpose` enum also
 *  covers check images, statements, etc.; these are the only two relevant to
 *  Digital Wallet card art). */
export type CardArtFilePurpose =
  | "digital_wallet_artwork"
  | "digital_wallet_app_icon";

/** CRLF is required between every multipart line/part per RFC 7578 — a bare
 *  `\n` is rejected by strict multipart parsers. Named so every literal below
 *  reads as "the multipart line ending", not a stray escape sequence. */
const CRLF = "\r\n";

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hand-build a `multipart/form-data` request body as a `Uint8Array` — one
 * binary file field plus any number of string fields, RFC 7578-correct
 * (CRLF between every line, a blank CRLF line ending each part's headers,
 * `--{boundary}--` + CRLF as the closing delimiter).
 *
 * This exists ONLY because `FormData`/`Blob` are DOM constructs that are
 * unverified in Convex's default (non-Node) action runtime — tests import
 * Node and would pass even if they silently didn't exist live, the exact
 * "green CI, breaks live" class of bug ADR-013 documents for mobile native
 * rendering. Building the body from `TextEncoder` + `Uint8Array` concatenation
 * uses only primitives the isolate guarantees, so there's nothing left to
 * verify at runtime — the byte layout is asserted directly by
 * `tests/cardArtProfile.test.ts`.
 */
export function buildMultipartFormData(
  boundary: string,
  fields: Record<string, string>,
  file: {
    fieldName: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array<ArrayBuffer>;
  },
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const pushText = (s: string) => chunks.push(encoder.encode(s));

  for (const [name, value] of Object.entries(fields)) {
    pushText(`--${boundary}${CRLF}`);
    pushText(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`);
    pushText(`${value}${CRLF}`);
  }

  pushText(`--${boundary}${CRLF}`);
  pushText(
    `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"${CRLF}`,
  );
  pushText(`Content-Type: ${file.contentType}${CRLF}${CRLF}`);
  chunks.push(file.bytes);
  pushText(CRLF);

  pushText(`--${boundary}--${CRLF}`);

  const length = chunks.reduce((sum, c) => sum + c.length, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return body;
}

/**
 * Upload one base64-encoded PNG to Increase's Files API (WP-C.2 card art).
 * `POST /files` is the one Increase endpoint that ISN'T JSON — it requires
 * `multipart/form-data` (confirmed against the Increase docs). The body is
 * built BY HAND via `buildMultipartFormData` (no `FormData`/`Blob` — see its
 * doc comment) with an explicit `Content-Type: multipart/form-data;
 * boundary=...` header; `fetch` does not compute a boundary for a raw
 * `Uint8Array` body the way it would for `FormData`, so the header must name
 * the exact boundary used to build the body.
 *
 * Rejects a `data:` URI prefix defensively (`uploadCardArtAssets`'s docstring
 * requires raw base64, but a caller pasting straight from a browser file
 * picker easily includes it) rather than silently uploading a corrupt PNG.
 * Throws ConvexError on a non-2xx or a response with no usable file id.
 */
export async function increasePostFile(
  key: string,
  base: string,
  base64Png: string,
  filename: string,
  purpose: CardArtFilePurpose,
): Promise<string> {
  if (base64Png.startsWith("data:")) {
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `Card art must be raw base64 (no "data:" URI prefix) — got one for the "${purpose}" upload.`,
    });
  }
  const boundary = `----ConvexFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const body = buildMultipartFormData(
    boundary,
    { purpose },
    {
      fieldName: "file",
      filename,
      contentType: "image/png",
      bytes: base64ToBytes(base64Png),
    },
  );
  const res = await fetch(`${base}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error(`[increase] POST /files (${purpose}) failed:`, bodyText);
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase file upload failed (${describeIncreaseError(res.status, bodyText)}).`,
    });
  }
  const responseBody = (await res.json()) as { id?: unknown };
  if (typeof responseBody.id !== "string" || !responseBody.id) {
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: `The Increase file upload (${purpose}) returned no usable file id.`,
    });
  }
  return responseBody.id;
}
