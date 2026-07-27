/**
 * A tiny, dependency-free MIME parser for FORWARDED-AS-ATTACHMENT email.
 *
 * WHY THIS EXISTS: the receipt inbox's happy path is "forward the merchant's
 * receipt email to receipts@…" — but a mail client's **Forward as attachment**
 * (Gmail's, Apple Mail's, Outlook's) does NOT inline the original message. It
 * wraps it as a `message/rfc822` attachment (a `.eml` file), so the outer
 * email that reaches the webhook has an EMPTY body and one opaque attachment
 * the pipeline's image/PDF filter used to drop on the floor — the receipt's
 * real PDF (and its real merchant/total) sat one MIME layer down, unread.
 * This module opens that layer: given the `.eml` bytes it returns the inner
 * message's headers, its body text, its own attachments, and any further
 * nested forwards (a forward of a forward), so `receiptInbox.ts` can treat
 * them exactly like a directly-attached receipt.
 *
 * DELIBERATELY SMALL. It handles what real receipt mail actually uses —
 * `multipart/*`, `base64` / `quoted-printable` transfer encodings, RFC-2047
 * encoded header words, RFC-2231 `filename*` params — and degrades to
 * "nothing found" rather than throwing on anything malformed. It is NOT a
 * general-purpose mail library and never needs to be: everything downstream
 * (OCR, matching, auto-attach) already defers to a human when it can't read
 * something.
 *
 * Pure functions only (no ctx, no network) — unit-tested directly in
 * `tests/emlMessage.test.ts`.
 */

/** How many `message/rfc822` layers deep we will unwrap. A forward of a
 *  forward is real; four layers is a mail loop, not a receipt. */
export const MAX_EML_NESTING_DEPTH = 3;

/** One file part carried by a parsed message. */
export interface EmlAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** A parsed email message: its envelope, its body, its file attachments, and
 *  any messages IT in turn carries as attachments (a forward chain). */
export interface ParsedEmlMessage {
  /** Raw `From:` value, RFC-2047 decoded (e.g. `Google Payments
   *  <payments-noreply@google.com>`) — the shape `deriveMerchantFromEmail`
   *  already knows how to read. */
  from: string | null;
  subject: string | null;
  date: string | null;
  /** First `text/plain` body part, decoded. */
  text: string | null;
  /** First `text/html` body part, decoded. */
  html: string | null;
  /** Every non-message file part (inline images included — the caller owns
   *  the "is this a logo?" judgement, not the parser). */
  attachments: EmlAttachment[];
  /** Nested `message/rfc822` parts, parsed (a forwarded forward). */
  forwarded: ParsedEmlMessage[];
}

/** True iff a content type / filename names an EMAIL MESSAGE rather than an
 *  ordinary file — the "forward as attachment" shape. Checked both ways:
 *  `message/rfc822` is what a well-behaved client sends, but some clients
 *  label the same bytes `application/octet-stream` and lean on the `.eml`
 *  extension alone (mirrors `isPdfContentType`'s belt-and-suspenders check). */
export function isEmailMessageAttachment(
  contentType: string | null | undefined,
  filename?: string | null,
): boolean {
  const ct = (contentType ?? "").toLowerCase().trim().split(";")[0].trim();
  if (ct === "message/rfc822" || ct === "message/global") return true;
  return /\.eml$/i.test((filename ?? "").trim());
}

// ── Byte/string plumbing ─────────────────────────────────────────────────────
/** Bytes → a LATIN-1 string (one char per byte). The whole parser works on
 *  this representation so binary attachment payloads survive header/boundary
 *  scanning intact; real text is decoded from bytes at the very end, with the
 *  part's own charset. Chunked to stay under argument-count limits (same
 *  discipline as `receiptInbox.arrayBufferToBase64`). */
function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** A latin-1 string back to the bytes it stands for. */
function binaryToBytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/** Decode a base64 payload to bytes, tolerating the line wrapping (and any
 *  stray characters) MIME sprinkles through it. Chunked in multiples of 4 so
 *  a large attachment never hits an `atob` size cliff; a malformed trailing
 *  group is dropped rather than thrown. */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  // A lone trailing character can't encode a byte — drop it.
  const usable = clean.length - (clean.length % 4 === 1 ? 1 : 0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const CHUNK = 4096; // multiple of 4: only the LAST piece can need padding
  for (let i = 0; i < usable; i += CHUNK) {
    let piece = clean.slice(i, Math.min(i + CHUNK, usable));
    if (piece.length % 4 !== 0) piece += "=".repeat(4 - (piece.length % 4));
    let bin: string;
    try {
      bin = atob(piece);
    } catch {
      continue;
    }
    const arr = binaryToBytes(bin);
    chunks.push(arr);
    total += arr.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Decode a quoted-printable payload to a latin-1 string (soft line breaks
 *  removed, `=XX` escapes resolved). */
export function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** Bytes → text using the part's declared charset, falling back to UTF-8 for
 *  a charset this runtime doesn't know (never a throw). */
function decodeText(bytes: Uint8Array, charset?: string): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // fall through to UTF-8
    }
  }
  return new TextDecoder().decode(bytes);
}

/** Decode RFC-2047 encoded words (`=?UTF-8?B?…?=` / `=?…?Q?…?=`) in a header
 *  value — how a non-ASCII Subject or display name is transported. Adjacent
 *  encoded words separated only by whitespace are joined first (that
 *  whitespace is an artifact of header folding, not content). */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=[\t ]+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (whole, charset: string, enc: string, text: string) => {
        try {
          const bytes =
            enc.toUpperCase() === "B"
              ? base64ToBytes(text)
              : binaryToBytes(decodeQuotedPrintable(text.replace(/_/g, " ")));
          return decodeText(bytes, charset);
        } catch {
          return whole;
        }
      },
    );
}

// ── Header parsing ───────────────────────────────────────────────────────────
/** Split a raw message/part at the header/body separator (the first blank
 *  line). A part with no separator at all is treated as all-headers-no-body. */
function splitHeadersAndBody(raw: string): { headerText: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index == null) return { headerText: raw, body: "" };
  return {
    headerText: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

/** Parse (and UNFOLD) headers into a lowercase-keyed map. A repeated header
 *  keeps its first value — the only ones this parser reads (Content-*, From,
 *  Subject, Date) are single-valued in practice. */
function parseHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerText.split(/\r?\n/);
  let current: string | null = null;
  let value = "";
  const flush = () => {
    if (current && !(current in headers)) headers[current] = value.trim();
    current = null;
    value = "";
  };
  for (const line of lines) {
    if (/^[\t ]/.test(line) && current) {
      // A folded continuation of the previous header.
      value += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    flush();
    current = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  flush();
  return headers;
}

/** A structured header value: `text/plain; charset="UTF-8"` →
 *  `{ value: "text/plain", params: { charset: "UTF-8" } }`. Scans rather than
 *  splits on `;` so a quoted parameter carrying a semicolon (a filename can)
 *  survives. Understands RFC-2231 `name*=charset''percent-encoded`. */
export function parseHeaderValue(raw: string | undefined): {
  value: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  if (!raw) return { value: "", params };
  const segments: string[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      quoted = !quoted;
      buf += ch;
      continue;
    }
    if (ch === ";" && !quoted) {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);

  const value = (segments.shift() ?? "").trim().toLowerCase();
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    let key = segment.slice(0, eq).trim().toLowerCase();
    let raw2 = segment.slice(eq + 1).trim();
    if (raw2.startsWith('"')) {
      const end = raw2.lastIndexOf('"');
      raw2 = end > 0 ? raw2.slice(1, end) : raw2.slice(1);
    }
    // RFC 2231: `filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`
    if (key.endsWith("*")) {
      key = key.slice(0, -1);
      const parts = raw2.split("'");
      const encodedCharset = parts.length >= 3 ? parts[0] : undefined;
      const encoded = parts.length >= 3 ? parts.slice(2).join("'") : raw2;
      try {
        const bytes = binaryToBytes(
          encoded.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          ),
        );
        raw2 = decodeText(bytes, encodedCharset || undefined);
      } catch {
        // keep the raw value
      }
    }
    // A `filename*` (decoded above) wins over a plain `filename`.
    if (!(key in params) || segment.includes("*=")) params[key] = raw2;
  }
  return { value, params };
}

// ── Body walking ─────────────────────────────────────────────────────────────
/** Split a multipart body into its parts on the declared boundary. Anything
 *  before the first delimiter (the "this is a MIME message" preamble) and
 *  after the closing one is discarded, per RFC 2046. */
function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.replace(/[\t ]+$/, "");
    if (trimmed === `--${boundary}`) {
      if (current) parts.push(current.join("\n"));
      current = [];
      continue;
    }
    if (trimmed === `--${boundary}--`) {
      if (current) parts.push(current.join("\n"));
      current = null;
      break;
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join("\n"));
  return parts;
}

/** Transfer-decode one part's body to bytes. Unknown/absent encodings mean
 *  "as-is" (7bit/8bit/binary all pass straight through). */
function decodeTransfer(body: string, encoding: string): Uint8Array {
  switch (encoding.trim().toLowerCase()) {
    case "base64":
      return base64ToBytes(body);
    case "quoted-printable":
      return binaryToBytes(decodeQuotedPrintable(body));
    default:
      return binaryToBytes(body);
  }
}

/** The accumulator `walkPart` fills while descending one message's MIME tree. */
interface PartSink {
  text: string | null;
  html: string | null;
  attachments: EmlAttachment[];
  forwarded: ParsedEmlMessage[];
}

function walkPart(raw: string, depth: number, sink: PartSink): void {
  const { headerText, body } = splitHeadersAndBody(raw);
  const headers = parseHeaders(headerText);
  const contentType = parseHeaderValue(headers["content-type"] || "text/plain");
  const disposition = parseHeaderValue(headers["content-disposition"]);
  const encoding = headers["content-transfer-encoding"] ?? "7bit";
  const filename = decodeEncodedWords(
    disposition.params.filename ?? contentType.params.name ?? "",
  ).trim();

  if (contentType.value.startsWith("multipart/")) {
    const boundary = contentType.params.boundary;
    if (!boundary) return;
    for (const part of splitMultipart(body, boundary)) {
      walkPart(part, depth, sink);
    }
    return;
  }

  // A forwarded message — the whole point of this module.
  if (isEmailMessageAttachment(contentType.value, filename)) {
    if (depth + 1 > MAX_EML_NESTING_DEPTH) return;
    sink.forwarded.push(parseEmlMessage(decodeTransfer(body, encoding), depth + 1));
    return;
  }

  // A named part (or one explicitly dispositioned as an attachment) is a
  // file, whatever its type. Everything else that is text is body copy.
  const isFile = disposition.value === "attachment" || filename !== "";
  if (!isFile) {
    if (contentType.value === "text/plain" && sink.text == null) {
      sink.text = decodeText(
        decodeTransfer(body, encoding),
        contentType.params.charset,
      );
    } else if (contentType.value === "text/html" && sink.html == null) {
      sink.html = decodeText(
        decodeTransfer(body, encoding),
        contentType.params.charset,
      );
    }
    return;
  }

  const bytes = decodeTransfer(body, encoding);
  if (bytes.length === 0) return;
  sink.attachments.push({
    filename: filename || "attachment",
    contentType: contentType.value || "application/octet-stream",
    bytes,
  });
}

/**
 * Parse a `.eml` / `message/rfc822` payload. Never throws: a malformed or
 * truncated message yields whatever could be read (often nothing), and the
 * caller degrades exactly as it would for an unreadable receipt.
 *
 * `depth` is the nesting level (0 for the attachment the webhook handed us) —
 * bounded by `MAX_EML_NESTING_DEPTH`.
 */
export function parseEmlMessage(
  input: Uint8Array | ArrayBuffer | string,
  depth = 0,
): ParsedEmlMessage {
  const raw =
    typeof input === "string"
      ? input
      : bytesToBinary(
          input instanceof Uint8Array ? input : new Uint8Array(input),
        );
  const sink: PartSink = { text: null, html: null, attachments: [], forwarded: [] };
  const headers = parseHeaders(splitHeadersAndBody(raw).headerText);
  try {
    walkPart(raw, depth, sink);
  } catch (err) {
    console.log(`[emlMessage] parse failed: ${String(err)}`);
  }
  return {
    from: headers.from ? decodeEncodedWords(headers.from) : null,
    subject: headers.subject ? decodeEncodedWords(headers.subject) : null,
    date: headers.date ?? null,
    text: sink.text,
    html: sink.html,
    attachments: sink.attachments,
    forwarded: sink.forwarded,
  };
}
