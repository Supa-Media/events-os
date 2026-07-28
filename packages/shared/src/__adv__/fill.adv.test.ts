import { describe, expect, it } from "vitest";
import {
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
  fillTemplateArtwork,
  type ResolvedArtwork,
} from "../emailTemplates";
import { validateEmailDocument } from "../emailBlocks";
import { NEWSLETTER_TEMPLATE_SLOTS } from "../newsletterAssets";

const base = PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE.doc;

function m(entries: [string, ResolvedArtwork][]) {
  return new Map<string, ResolvedArtwork>(entries);
}

describe("fillTemplateArtwork", () => {
  it("A: baseline template is valid", () => {
    expect(validateEmailDocument(base)).toBe(null);
  });

  it("B: hostile url -> does output still validate?", () => {
    const hostile: ResolvedArtwork = {
      url: "javascript:alert(document.domain)",
      alt: "x",
    };
    const out = fillTemplateArtwork(base, m([
      ["masthead", hostile],
      ["hero-photo", hostile],
      ["footer-logo", hostile],
    ]));
    const err = validateEmailDocument(out);
    console.log("VALIDATE(js url) =>", err);
    const masthead: any = out.blocks.find((b) => b.id === "blk_nl-masthead");
    console.log("masthead block =>", JSON.stringify(masthead));
    expect(err).toBe(null);
  });

  it("C: input document must not be mutated (frozen input)", () => {
    const frozen = Object.freeze({
      ...base,
      blocks: Object.freeze(base.blocks.map((b) => Object.freeze({ ...b }))),
    }) as any;
    const out = fillTemplateArtwork(frozen, m([["masthead", { url: "https://e.com/a.png", alt: "a" }]]));
    const inMast: any = frozen.blocks.find((b: any) => b.id === "blk_nl-masthead");
    console.log("input masthead after call =>", JSON.stringify(inMast));
    expect(inMast.url).toBeUndefined();
    expect((out.blocks.find((b) => b.id === "blk_nl-masthead") as any).url).toBe("https://e.com/a.png");
  });

  it("D: duplicate block ids", () => {
    const dup = {
      ...base,
      blocks: [...base.blocks, { ...(base.blocks[0] as any) }],
    } as any;
    const out = fillTemplateArtwork(dup, m([["masthead", { url: "https://e.com/a.png", alt: "a" }]]));
    const filled = out.blocks.filter((b: any) => b.id === "blk_nl-masthead");
    console.log("duplicate id blocks filled =>", JSON.stringify(filled));
  });

  it("E: slot pointing at wrong block kind", () => {
    // nl-rule is a hairline; craft a map that resolves to it via a fake slot
    const out = fillTemplateArtwork(base, m([["masthead", { url: "https://e.com/a.png", alt: "a" }]]));
    expect(validateEmailDocument(out)).toBe(null);
  });

  it("F: alt is hostile / non-string", () => {
    const out = fillTemplateArtwork(base, m([
      ["hero-photo", { url: "https://e.com/a.png", alt: undefined as any }],
    ]));
    const err = validateEmailDocument(out);
    console.log("VALIDATE(undefined alt) =>", err);
  });

  it("G: song-artwork slot -> bleed_image, alt not overwritten?", () => {
    const out = fillTemplateArtwork(base, m([
      ["song-artwork", { url: "https://e.com/song.png", alt: "LIBRARY ALT" }],
    ]));
    const song: any = out.blocks.find((b) => b.id === "blk_nl-song");
    console.log("song block =>", JSON.stringify(song));
  });

  it("H: every mapped block id exists in the template", () => {
    const ids = new Set(base.blocks.map((b) => b.id));
    const missing = NEWSLETTER_TEMPLATE_SLOTS.filter((s) => !ids.has(s.blockId));
    console.log("missing block ids =>", JSON.stringify(missing));
    expect(missing).toEqual([]);
  });
});
