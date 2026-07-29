import { composerHostForFormat, composerHostForRow } from "./composerFormat";

describe("composerHostForFormat", () => {
  it("routes tiptap to the maily host", () => {
    expect(composerHostForFormat("tiptap")).toBe("tiptap");
  });

  it("routes blocks to the existing canvas", () => {
    expect(composerHostForFormat("blocks")).toBe("blocks");
  });
});

describe("composerHostForRow", () => {
  it("defaults a row with no docFormat to blocks (every pre-2026-07-29 row)", () => {
    expect(composerHostForRow({})).toBe("blocks");
  });

  it("treats a missing row (still loading) as blocks", () => {
    expect(composerHostForRow(undefined)).toBe("blocks");
    expect(composerHostForRow(null)).toBe("blocks");
  });

  it("routes an explicit tiptap row to the maily host", () => {
    expect(composerHostForRow({ docFormat: "tiptap" })).toBe("tiptap");
  });

  it("routes an explicit blocks row (and any unknown string) to the canvas", () => {
    expect(composerHostForRow({ docFormat: "blocks" })).toBe("blocks");
    expect(composerHostForRow({ docFormat: "something-else" })).toBe("blocks");
  });
});
