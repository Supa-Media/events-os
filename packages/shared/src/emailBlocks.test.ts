import { describe, expect, test } from "vitest";
import {
  isAllowedImageUrl,
  isAllowedLinkUrl,
  isKnownMergeTag,
  MERGE_TAGS,
  newBlockId,
  validateEmailDocument,
  type EmailDocument,
} from "./emailBlocks";

describe("MERGE_TAGS", () => {
  test("includes firstName and name", () => {
    const tags = MERGE_TAGS.map((t) => t.tag);
    expect(tags).toContain("firstName");
    expect(tags).toContain("name");
  });

  test("isKnownMergeTag matches MERGE_TAGS entries only", () => {
    expect(isKnownMergeTag("firstName")).toBe(true);
    expect(isKnownMergeTag("name")).toBe(true);
    expect(isKnownMergeTag("bogus")).toBe(false);
  });
});

describe("newBlockId", () => {
  test("two calls without a seed produce different ids", () => {
    expect(newBlockId()).not.toBe(newBlockId());
  });

  test("a seed produces a deterministic id", () => {
    expect(newBlockId("abc")).toBe(newBlockId("abc"));
    expect(newBlockId(1)).toBe(newBlockId(1));
  });

  test("ids are non-empty strings", () => {
    const id = newBlockId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("validateEmailDocument", () => {
  test("accepts an empty block list", () => {
    const result = validateEmailDocument({ blocks: [] });
    expect(result.ok).toBe(true);
  });

  test("accepts one of every block kind", () => {
    const doc: EmailDocument = {
      blocks: [
        { id: "1", kind: "heading", text: "Hi", level: 1 },
        { id: "2", kind: "text", markdown: "**hello**" },
        { id: "3", kind: "image", url: "https://x.test/a.png", alt: "alt", width: "full" },
        { id: "4", kind: "button", label: "Go", url: "https://x.test", align: "center" },
        { id: "5", kind: "divider" },
        { id: "6", kind: "spacer", size: "md" },
      ],
    };
    const result = validateEmailDocument(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.blocks).toHaveLength(6);
  });

  test("accepts blocks with optional fields omitted", () => {
    const doc: EmailDocument = {
      blocks: [
        { id: "1", kind: "heading", text: "Hi" },
        { id: "2", kind: "image", url: "https://x.test/a.png", alt: "alt" },
        { id: "3", kind: "button", label: "Go", url: "https://x.test" },
      ],
    };
    expect(validateEmailDocument(doc).ok).toBe(true);
  });

  test("rejects a non-object document", () => {
    expect(validateEmailDocument(null).ok).toBe(false);
    expect(validateEmailDocument("blocks").ok).toBe(false);
    expect(validateEmailDocument([]).ok).toBe(false);
  });

  test("rejects a document whose blocks field isn't an array", () => {
    const result = validateEmailDocument({ blocks: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocks/);
  });

  test("rejects a block missing an id", () => {
    const result = validateEmailDocument({
      blocks: [{ kind: "divider" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/id/);
  });

  test("rejects an unknown block kind", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "video", url: "https://x.test" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown block kind/);
  });

  test("rejects a heading with a bad level", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "heading", text: "Hi", level: 3 }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an image missing a url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "image", alt: "alt" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a spacer with an invalid size", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "spacer", size: "xl" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate block ids", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "divider" },
        { id: "1", kind: "spacer", size: "sm" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate id/);
  });

  // ── URL scheme allowlist (SECURITY write gate) ───────────────────────────

  test("rejects a javascript: button url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "button", label: "Go", url: "javascript:alert(1)" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/http:, https:, or mailto:/);
  });

  test("rejects a data: image url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "image", url: "data:image/png;base64,xxx", alt: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/http: or https:/);
  });

  test("accepts a mailto: button url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "button", label: "Email us", url: "mailto:hello@example.com" }],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a mailto: image url (images are http/https only)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "image", url: "mailto:hello@example.com", alt: "x" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("isAllowedLinkUrl / isAllowedImageUrl (unit)", () => {
  test("isAllowedLinkUrl allows http/https/mailto, case-insensitive", () => {
    expect(isAllowedLinkUrl("https://x.test")).toBe(true);
    expect(isAllowedLinkUrl("HTTP://x.test")).toBe(true);
    expect(isAllowedLinkUrl("mailto:a@b.com")).toBe(true);
    expect(isAllowedLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl("JavaScript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl("not-a-url")).toBe(false);
  });

  test("isAllowedImageUrl allows only http/https", () => {
    expect(isAllowedImageUrl("https://x.test/a.png")).toBe(true);
    expect(isAllowedImageUrl("http://x.test/a.png")).toBe(true);
    expect(isAllowedImageUrl("mailto:a@b.com")).toBe(false);
    expect(isAllowedImageUrl("data:image/png;base64,xxx")).toBe(false);
  });
});
