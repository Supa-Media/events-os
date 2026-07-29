import {
  IMAGE_PLACEHOLDER_NODE_TYPES,
  findImagePlaceholderWrapper,
  resolveImageNodePos,
  type ClickTarget,
} from "./pwImagePlaceholderIntercept";

/** A plain-object stand-in for a real DOM element — duck-typed on purpose
 *  (see the module doc) so these tests run under this repo's Jest `node`
 *  test environment with no `jsdom`/real DOM globals at all. */
function fakeTarget(overrides: Partial<ClickTarget & { wrapper: unknown }> = {}) {
  const wrapper = overrides.wrapper ?? { marker: "wrapper" };
  return {
    tagName: "INPUT",
    type: "file",
    closest: (selector: string) => (selector === ".mly-image-drop-zone" ? wrapper : null),
    ...overrides,
  };
}

describe("findImagePlaceholderWrapper", () => {
  it("returns the wrapper for a file input inside .mly-image-drop-zone", () => {
    const wrapper = { marker: "the-wrapper" };
    const target = fakeTarget({ wrapper });
    expect(findImagePlaceholderWrapper(target as unknown as EventTarget)).toBe(wrapper);
  });

  it("returns null for null/undefined targets", () => {
    expect(findImagePlaceholderWrapper(null)).toBeNull();
  });

  it("returns null for a non-INPUT element", () => {
    const target = fakeTarget({ tagName: "DIV" });
    expect(findImagePlaceholderWrapper(target as unknown as EventTarget)).toBeNull();
  });

  it("returns null for an input that isn't type=file (e.g. the alt-text field)", () => {
    const target = fakeTarget({ type: "text" });
    expect(findImagePlaceholderWrapper(target as unknown as EventTarget)).toBeNull();
  });

  it("returns null when the file input isn't inside a .mly-image-drop-zone wrapper", () => {
    const target = fakeTarget({ closest: () => null });
    expect(findImagePlaceholderWrapper(target as unknown as EventTarget)).toBeNull();
  });

  it("returns null for a target with no closest() at all (not a real Element)", () => {
    const target = { tagName: "INPUT", type: "file" };
    expect(findImagePlaceholderWrapper(target as unknown as EventTarget)).toBeNull();
  });
});

describe("IMAGE_PLACEHOLDER_NODE_TYPES", () => {
  it("covers exactly maily's two click-or-drop node views", () => {
    expect(Array.from(IMAGE_PLACEHOLDER_NODE_TYPES).sort()).toEqual(["image", "logo"]);
  });
});

describe("resolveImageNodePos", () => {
  function fakeDoc(nodesByPos: Record<number, string>) {
    return {
      nodeAt: (pos: number) => {
        const type = nodesByPos[pos];
        return type ? { type: { name: type } } : null;
      },
    };
  }

  it("returns posAtDOM's own position when it directly resolves to an image/logo node", () => {
    const view = { posAtDOM: () => 5 };
    const doc = fakeDoc({ 5: "image" });
    expect(resolveImageNodePos(view, doc, {} as any)).toBe(5);
  });

  it("falls back to pos - 1 when that's where the atom node actually sits", () => {
    const view = { posAtDOM: () => 6 };
    const doc = fakeDoc({ 5: "logo" });
    expect(resolveImageNodePos(view, doc, {} as any)).toBe(5);
  });

  it("returns null when neither position resolves to a known placeholder node type", () => {
    const view = { posAtDOM: () => 6 };
    const doc = fakeDoc({ 6: "paragraph", 5: "heading" });
    expect(resolveImageNodePos(view, doc, {} as any)).toBeNull();
  });

  it("never tries a negative position", () => {
    const view = { posAtDOM: () => 0 };
    const doc = fakeDoc({ 0: "image" });
    expect(resolveImageNodePos(view, doc, {} as any)).toBe(0);
  });

  it("returns null when posAtDOM resolves to 0 and that's not a placeholder node", () => {
    const view = { posAtDOM: () => 0 };
    const doc = fakeDoc({});
    expect(resolveImageNodePos(view, doc, {} as any)).toBeNull();
  });
});
