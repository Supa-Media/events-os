import { describe, expect, test } from "vitest";
import {
  MAX_EML_NESTING_DEPTH,
  base64ToBytes,
  decodeEncodedWords,
  decodeQuotedPrintable,
  isEmailMessageAttachment,
  parseEmlMessage,
  parseHeaderValue,
} from "../lib/emlMessage";

/**
 * The MIME parser behind FORWARDED-AS-ATTACHMENT receipts (`lib/emlMessage.ts`).
 * Everything here is pure — no ctx, no network — so the fixtures are literal
 * `.eml` text built the way a real mail client builds it: CRLF line endings,
 * a `multipart/mixed` wrapper, base64/quoted-printable transfer encodings,
 * RFC-2047 encoded header words.
 */

const CRLF = "\r\n";
/** Join lines with real CRLFs — a mail client never sends bare LFs, and the
 *  parser must not quietly depend on the friendlier shape. */
function eml(...lines: string[]): string {
  return lines.join(CRLF);
}

/** A receipt email with a plain-text body and one base64 PDF attachment —
 *  the exact shape of a forwarded Google Workspace invoice. */
function invoiceEml(): string {
  return eml(
    "Date: Wed, 01 Jul 2026 12:28:45 -0700",
    "Subject: Google Workspace: Your invoice is available",
    "From: Google Payments <payments-noreply@google.com>",
    "To: seyi@publicworship.life",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="OUTER"',
    "",
    "--OUTER",
    'Content-Type: multipart/alternative; boundary="INNER"',
    "",
    "--INNER",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("Your invoice is available.\r\nTotal in USD $14.29\r\n"),
    "--INNER",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Total in USD $14.=32=39</p>",
    "--INNER--",
    "--OUTER",
    'Content-Type: application/pdf; name="5628803684.pdf"',
    'Content-Disposition: attachment; filename="5628803684.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("%PDF-1.4 invoice bytes"),
    "--OUTER--",
    "",
  );
}

describe("isEmailMessageAttachment", () => {
  test("recognizes a forwarded message by content type OR by .eml extension", () => {
    expect(isEmailMessageAttachment("message/rfc822", "anything")).toBe(true);
    expect(isEmailMessageAttachment("message/rfc822; charset=us-ascii", "x")).toBe(true);
    // Some clients mislabel the bytes — the extension is the second signal.
    expect(isEmailMessageAttachment("application/octet-stream", "Receipt.EML")).toBe(true);
    expect(isEmailMessageAttachment("application/pdf", "invoice.pdf")).toBe(false);
    expect(isEmailMessageAttachment("image/jpeg", "photo.jpg")).toBe(false);
    expect(isEmailMessageAttachment(null, null)).toBe(false);
  });
});

describe("parseEmlMessage", () => {
  test("reads the envelope, both bodies, and the attachment of a real-shaped invoice", () => {
    const parsed = parseEmlMessage(invoiceEml());

    expect(parsed.from).toBe("Google Payments <payments-noreply@google.com>");
    expect(parsed.subject).toBe("Google Workspace: Your invoice is available");
    expect(parsed.date).toBe("Wed, 01 Jul 2026 12:28:45 -0700");
    expect(parsed.text).toContain("Total in USD $14.29");
    // quoted-printable escapes resolved
    expect(parsed.html).toBe("<p>Total in USD $14.29</p>");

    expect(parsed.attachments).toHaveLength(1);
    const [pdf] = parsed.attachments;
    expect(pdf.filename).toBe("5628803684.pdf");
    expect(pdf.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(pdf.bytes)).toBe("%PDF-1.4 invoice bytes");
  });

  test("accepts raw bytes as well as a string (what the pipeline actually hands it)", () => {
    const bytes = new TextEncoder().encode(invoiceEml());
    const parsed = parseEmlMessage(bytes);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.subject).toBe("Google Workspace: Your invoice is available");
  });

  test("unwraps a nested forward — a forward of a forward still reaches the receipt", () => {
    const outer = eml(
      "Subject: Fwd: Fwd: invoice",
      "From: Alice <alice@publicworship.life>",
      'Content-Type: multipart/mixed; boundary="WRAP"',
      "",
      "--WRAP",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--WRAP",
      'Content-Type: message/rfc822; name="forwarded.eml"',
      'Content-Disposition: attachment; filename="forwarded.eml"',
      "",
      invoiceEml(),
      "--WRAP--",
      "",
    );
    const parsed = parseEmlMessage(outer);

    expect(parsed.from).toBe("Alice <alice@publicworship.life>");
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.forwarded).toHaveLength(1);
    const [inner] = parsed.forwarded;
    expect(inner.from).toBe("Google Payments <payments-noreply@google.com>");
    expect(inner.attachments[0].filename).toBe("5628803684.pdf");
  });

  test("stops unwrapping at MAX_EML_NESTING_DEPTH (a mail loop is not a receipt)", () => {
    // Build a forward chain deeper than the bound and count how far we got.
    let message = invoiceEml();
    for (let i = 0; i < MAX_EML_NESTING_DEPTH + 2; i++) {
      message = eml(
        `Subject: Fwd ${i}`,
        'Content-Type: message/rfc822; name="f.eml"',
        'Content-Disposition: attachment; filename="f.eml"',
        "",
        message,
        "",
      );
    }
    let depth = 0;
    let cursor = parseEmlMessage(message);
    while (cursor.forwarded.length > 0) {
      depth++;
      cursor = cursor.forwarded[0];
    }
    expect(depth).toBe(MAX_EML_NESTING_DEPTH);
  });

  test("decodes an RFC-2047 subject and a name-only (no Content-Disposition) part", () => {
    const message = eml(
      "Subject: =?UTF-8?B?UmVjZWlwdCDigJQgQ2Fmw6k=?=",
      "From: =?UTF-8?Q?Caf=C3=A9_Roast?= <hello@cafe.example>",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      'Content-Type: image/jpeg; name="receipt.jpg"',
      "Content-Transfer-Encoding: base64",
      "",
      btoa("\xff\xd8\xff-jpeg-bytes"),
      "--B--",
      "",
    );
    const parsed = parseEmlMessage(message);
    expect(parsed.subject).toBe("Receipt — Café");
    expect(parsed.from).toBe("Café Roast <hello@cafe.example>");
    // A `name=` param alone (no Content-Disposition) still makes it a file.
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("receipt.jpg");
    expect(parsed.attachments[0].contentType).toBe("image/jpeg");
  });

  test("decodes an RFC-2231 filename* parameter", () => {
    const message = eml(
      "Subject: Rechnung",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      btoa("%PDF-1.4"),
      "--B--",
      "",
    );
    expect(parseEmlMessage(message).attachments[0].filename).toBe("Rechnung März.pdf");
  });

  test("a single-part message with no MIME structure still yields its body", () => {
    const parsed = parseEmlMessage(
      eml("Subject: Receipt", "From: shop@example.com", "", "Total: $12.00", ""),
    );
    expect(parsed.text).toContain("Total: $12.00");
    expect(parsed.attachments).toHaveLength(0);
  });

  test("degrades to empty on garbage instead of throwing", () => {
    for (const junk of ["", "not an email at all", "Subject: x", "\r\n\r\n"]) {
      const parsed = parseEmlMessage(junk);
      expect(parsed.attachments).toHaveLength(0);
      expect(parsed.forwarded).toHaveLength(0);
    }
    // A multipart that declares a boundary it never uses: no parts, no throw.
    const truncated = parseEmlMessage(
      eml('Content-Type: multipart/mixed; boundary="NOPE"', "", "body without a boundary"),
    );
    expect(truncated.attachments).toHaveLength(0);
  });
});

describe("MIME primitives", () => {
  test("base64ToBytes tolerates line wrapping, padding, and a stray character", () => {
    const wrapped = btoa("hello receipt world").replace(/(.{4})/g, "$1\r\n");
    expect(new TextDecoder().decode(base64ToBytes(wrapped))).toBe("hello receipt world");
    // Round-trips binary that isn't valid UTF-8 text.
    const raw = new Uint8Array([0, 255, 128, 1, 2, 3]);
    let bin = "";
    for (const b of raw) bin += String.fromCharCode(b);
    expect(Array.from(base64ToBytes(btoa(bin)))).toEqual(Array.from(raw));
  });

  test("base64ToBytes handles a payload larger than one decode chunk", () => {
    const big = "x".repeat(50_000);
    expect(new TextDecoder().decode(base64ToBytes(btoa(big)))).toBe(big);
  });

  test("decodeQuotedPrintable resolves soft breaks and escapes", () => {
    expect(decodeQuotedPrintable("Total: $14.=\r\n29")).toBe("Total: $14.29");
    expect(decodeQuotedPrintable("a=3Db")).toBe("a=b");
  });

  test("decodeEncodedWords joins adjacent words and leaves plain text alone", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Caf=C3=A9?= =?UTF-8?Q?_Roast?=")).toBe("Café Roast");
    expect(decodeEncodedWords("Plain subject")).toBe("Plain subject");
    // Malformed encoded word — returned as-is rather than thrown on.
    expect(decodeEncodedWords("=?UTF-8?Z?zzz?=")).toBe("=?UTF-8?Z?zzz?=");
  });

  test("parseHeaderValue keeps a quoted parameter that contains a semicolon", () => {
    const parsed = parseHeaderValue('attachment; filename="jan; feb.pdf"; size=10');
    expect(parsed.value).toBe("attachment");
    expect(parsed.params.filename).toBe("jan; feb.pdf");
    expect(parsed.params.size).toBe("10");
  });
});
