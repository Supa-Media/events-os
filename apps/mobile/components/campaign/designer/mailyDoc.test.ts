import { isTiptapDocEmpty, newTiptapDocSeed } from "./mailyDoc";

describe("newTiptapDocSeed", () => {
  it("is a doc node with a heading and an empty paragraph", () => {
    const seed = newTiptapDocSeed();
    expect(seed.type).toBe("doc");
    expect(seed.content?.map((n) => n.type)).toEqual(["heading", "paragraph"]);
  });

  it("returns a fresh object every call (two rows never share one)", () => {
    const a = newTiptapDocSeed();
    const b = newTiptapDocSeed();
    expect(a).not.toBe(b);
    expect(a.content).not.toBe(b.content);
  });

  it("is not itself considered an empty document (the heading is real placeholder content)", () => {
    expect(isTiptapDocEmpty(newTiptapDocSeed())).toBe(false);
  });
});

describe("isTiptapDocEmpty", () => {
  it("treats undefined/null as empty", () => {
    expect(isTiptapDocEmpty(undefined)).toBe(true);
    expect(isTiptapDocEmpty(null)).toBe(true);
  });

  it("treats a doc with no content array as empty", () => {
    expect(isTiptapDocEmpty({ type: "doc" })).toBe(true);
  });

  it("treats a doc with only an empty paragraph as empty", () => {
    expect(isTiptapDocEmpty({ type: "doc", content: [{ type: "paragraph" }] })).toBe(true);
  });

  it("treats a doc with only whitespace text as empty", () => {
    expect(
      isTiptapDocEmpty({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }],
      }),
    ).toBe(true);
  });

  it("treats real text as non-empty", () => {
    expect(
      isTiptapDocEmpty({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      }),
    ).toBe(false);
  });

  it("treats an atom node (image, button, poll, …) as non-empty even with no content array", () => {
    expect(
      isTiptapDocEmpty({
        type: "doc",
        content: [{ type: "image", attrs: { src: "https://example.com/x.png" } }],
      }),
    ).toBe(false);
  });

  it("treats nested empty containers as empty", () => {
    expect(
      isTiptapDocEmpty({
        type: "doc",
        content: [{ type: "section", content: [{ type: "paragraph", content: [] }] }],
      }),
    ).toBe(true);
  });
});
