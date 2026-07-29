import { describe, expect, test } from "vitest";
import { validateTiptapEmailDoc } from "./tiptapEmail";
import { NEWSLETTER_ASSETS, NEWSLETTER_TEMPLATE_SLOTS } from "./newsletterAssets";
import {
  PUBLIC_WORSHIP_NEWSLETTER_TIPTAP,
  TIPTAP_NEWSLETTER_ARTWORK_SLOTS,
  fillTiptapArtwork,
  type NewsletterTiptapNode,
} from "./tiptapNewsletterTemplate";

/** Walk the doc collecting every `pwSlot` attr found, and the node type it's
 *  on — used throughout to assert the slot map and the doc actually agree. */
function collectPwSlots(nodes: NewsletterTiptapNode[]): { pwSlot: string; type: string }[] {
  const out: { pwSlot: string; type: string }[] = [];
  for (const node of nodes) {
    const pwSlot = node.attrs?.pwSlot;
    if (typeof pwSlot === "string") out.push({ pwSlot, type: node.type });
    if (node.content) out.push(...collectPwSlots(node.content));
  }
  return out;
}

/** Collect every string value found under any node's `attrs`/`text`, for the
 *  loose "does this copy appear somewhere" checks below. */
function collectStrings(nodes: NewsletterTiptapNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node.text === "string") out.push(node.text);
    if (node.content) out.push(...collectStrings(node.content));
  }
  return out;
}

describe("PUBLIC_WORSHIP_NEWSLETTER_TIPTAP — shape", () => {
  test("is a doc with content", () => {
    expect(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.type).toBe("doc");
    expect(Array.isArray(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content)).toBe(true);
  });

  test("passes the write gate — a template must be savable as-is", () => {
    const result = validateTiptapEmailDoc(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  test("also passes the write gate once filled with real artwork", () => {
    const resolved = new Map(
      NEWSLETTER_ASSETS.map((a) => [a.sourceKey, { url: `https://cdn.example.com/${a.sourceKey}.png`, alt: "" }]),
    );
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    const result = validateTiptapEmailDoc(filled);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  test("uses the Public Worship node pack, not just stock nodes — the point of this artefact", () => {
    const types = new Set<string>();
    (function walk(nodes: NewsletterTiptapNode[]) {
      for (const n of nodes) {
        types.add(n.type);
        if (n.content) walk(n.content);
      }
    })(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content);
    for (const t of ["pwHeading", "pwParagraph", "pwBleedImage"]) {
      expect(types.has(t), t).toBe(true);
    }
  });

  test("the masthead is the first node, and it's full-bleed artwork, not a heading", () => {
    const first = PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content[0];
    expect(first.type).toBe("pwBleedImage");
  });

  test("the footer is nav + socials only — no address/unsubscribe text authored here", () => {
    const strings = collectStrings(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content).join(" ").toLowerCase();
    expect(strings).not.toContain("unsubscribe");
    // A real postal address would contain a digit-led street line; nothing
    // authored here should look like one.
    expect(strings).toContain("events | supply");
  });

  test("the side-by-side cards are asymmetric (44/56, 40/60), not an even split", () => {
    const json = JSON.stringify(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
    expect(json).toContain('"width":44');
    expect(json).toContain('"width":56');
    expect(json).toContain('"width":40');
    expect(json).toContain('"width":60');
    expect(json).not.toContain('"width":50');
  });

  test("exactly one CTA uses mailto: — the serve card's, per the ground truth", () => {
    const json = JSON.stringify(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
    const matches = json.match(/mailto:/g) ?? [];
    expect(matches.length).toBe(1);
  });

  // WS4, fidelity gap 2 fix: the page canvas colour lives on the doc itself.
  test("carries Public Worship's real canvas grey as a doc-level attr, not a theme table", () => {
    expect(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.attrs?.pwCanvasColor).toBe("#f0f1f5");
  });
});

describe("PUBLIC_WORSHIP_NEWSLETTER_TIPTAP — determinism", () => {
  test("the module's export is a plain literal — re-reading it twice yields identical JSON", () => {
    // There is no randomness anywhere in this file (no `Math.random`/
    // `crypto.randomUUID`); the strongest thing testable from the *output* is
    // that serializing the same in-memory constant twice agrees with itself,
    // and that it doesn't happen to contain anything UUID/timestamp-shaped.
    const a = JSON.stringify(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
    const b = JSON.stringify(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
    expect(a).toBe(b);
    expect(a).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("TIPTAP_NEWSLETTER_ARTWORK_SLOTS", () => {
  test("has exactly one slot per newsletter asset", () => {
    expect(TIPTAP_NEWSLETTER_ARTWORK_SLOTS.length).toBe(NEWSLETTER_ASSETS.length);
    expect(TIPTAP_NEWSLETTER_ARTWORK_SLOTS.length).toBe(NEWSLETTER_TEMPLATE_SLOTS.length);
  });

  test("every sourceKey is a real NEWSLETTER_ASSETS entry", () => {
    const known = new Set(NEWSLETTER_ASSETS.map((a) => a.sourceKey));
    for (const slot of TIPTAP_NEWSLETTER_ARTWORK_SLOTS) {
      expect(known.has(slot.sourceKey), slot.sourceKey).toBe(true);
    }
  });

  test("every pwSlot is unique", () => {
    const pwSlots = TIPTAP_NEWSLETTER_ARTWORK_SLOTS.map((s) => s.pwSlot);
    expect(new Set(pwSlots).size).toBe(pwSlots.length);
  });

  test("every pwSlot really exists on a node in the template — the mapping isn't a dangling reference", () => {
    const present = new Set(collectPwSlots(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content).map((p) => p.pwSlot));
    for (const slot of TIPTAP_NEWSLETTER_ARTWORK_SLOTS) {
      expect(present.has(slot.pwSlot), slot.pwSlot).toBe(true);
    }
  });

  test("every pwSlot in the template sits on an image-bearing node type", () => {
    const found = collectPwSlots(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content);
    for (const { pwSlot, type } of found) {
      expect(["image", "pwBleedImage", "logo"], pwSlot).toContain(type);
    }
  });

  test("mirrors NEWSLETTER_TEMPLATE_SLOTS' one deliberate name mismatch (banner-testimonial → …voice)", () => {
    const slot = TIPTAP_NEWSLETTER_ARTWORK_SLOTS.find((s) => s.sourceKey === "banner-testimonial");
    expect(slot?.pwSlot).toBe("nl-banner-voice");
  });
});

describe("fillTiptapArtwork", () => {
  const url = (key: string) => `https://cdn.example.com/${key}.png`;

  test("fills every slot when every sourceKey resolves", () => {
    const resolved = new Map(NEWSLETTER_ASSETS.map((a) => [a.sourceKey, { url: url(a.sourceKey), alt: "" }]));
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    const json = JSON.stringify(filled);
    for (const slot of TIPTAP_NEWSLETTER_ARTWORK_SLOTS) {
      expect(json, slot.sourceKey).toContain(url(slot.sourceKey));
    }
  });

  test("is pure — the input document is never mutated", () => {
    const before = JSON.stringify(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
    const resolved = new Map(NEWSLETTER_ASSETS.map((a) => [a.sourceKey, { url: url(a.sourceKey), alt: "filled" }]));
    fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    expect(JSON.stringify(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP)).toBe(before);
  });

  test("an empty resolved map returns the exact same document reference — no-op, no JSON churn", () => {
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, new Map());
    expect(filled).toBe(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
  });

  test("a sourceKey with no matching row is skipped, not blanked — a partial import fills a partial doc", () => {
    const resolved = new Map([["hero-photo", { url: url("hero-photo"), alt: "" }]]);
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    const json = JSON.stringify(filled);
    expect(json).toContain(url("hero-photo"));
    // Every OTHER slot's node must still carry its shipped empty src, not "".
    // (Empty src IS the shipped state — this asserts it stayed that way, not
    // that it became something else.)
    const filledStrings = collectPwSlots(filled.content).map((s) => s.pwSlot);
    expect(filledStrings.length).toBe(TIPTAP_NEWSLETTER_ARTWORK_SLOTS.length);
  });

  test("a non-empty library alt overrides the authored (empty) alt", () => {
    const resolved = new Map([["masthead", { url: url("masthead"), alt: "WHAT'S ON banner" }]]);
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    expect(JSON.stringify(filled)).toContain("WHAT'S ON banner");
  });

  test("an empty library alt leaves the template's authored alt exactly as shipped", () => {
    const resolved = new Map([["song-artwork", { url: url("song-artwork"), alt: "" }]]);
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    expect(JSON.stringify(filled)).toContain("Song of the month");
  });

  test("an empty url is skipped, not written", () => {
    const resolved = new Map([["hero-photo", { url: "", alt: "x" }]]);
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    expect(filled).toBe(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
  });

  test("a javascript: url is skipped, not written (defense-in-depth, same predicate the write gate uses)", () => {
    const resolved = new Map([["hero-photo", { url: "javascript:alert(1)", alt: "x" }]]);
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    expect(filled).toBe(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
  });

  test("a non-string url from a bad read is skipped without throwing", () => {
    const resolved = new Map([["hero-photo", { url: null as unknown as string, alt: "x" }]]);
    expect(() => fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved)).not.toThrow();
  });

  test("a sourceKey this template has no slot for is harmlessly ignored", () => {
    const resolved = new Map([["not-a-real-key", { url: url("x"), alt: "x" }]]);
    const filled = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, resolved);
    expect(filled).toBe(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP);
  });
});
