import {
  BUTTON_ALIGNMENTS,
  buttonAlignmentUpdate,
  isButtonAlignment,
  resolveSelectedButtonAlignment,
  type SelectedNodeLike,
} from "./pwButtonAlignment";

describe("isButtonAlignment", () => {
  test.each(BUTTON_ALIGNMENTS)("accepts %s", (value) => {
    expect(isButtonAlignment(value)).toBe(true);
  });

  it("rejects an arbitrary string", () => {
    expect(isButtonAlignment("justify")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isButtonAlignment(null)).toBe(false);
    expect(isButtonAlignment(undefined)).toBe(false);
    expect(isButtonAlignment(1)).toBe(false);
  });
});

describe("resolveSelectedButtonAlignment", () => {
  function fakeSelection(overrides: Partial<{ typeName: string; attrs: Record<string, unknown>; from: number }> = {}): SelectedNodeLike {
    return {
      node: { type: { name: overrides.typeName ?? "button" }, attrs: overrides.attrs ?? {} },
      from: overrides.from ?? 12,
    };
  }

  it("returns null for a null selection (nothing selected)", () => {
    expect(resolveSelectedButtonAlignment(null)).toBeNull();
  });

  it("returns null when the selected node isn't a button", () => {
    expect(resolveSelectedButtonAlignment(fakeSelection({ typeName: "image" }))).toBeNull();
    expect(resolveSelectedButtonAlignment(fakeSelection({ typeName: "pwBleedImage" }))).toBeNull();
    expect(resolveSelectedButtonAlignment(fakeSelection({ typeName: "section" }))).toBeNull();
  });

  it("returns the button's position and its authored alignment", () => {
    const result = resolveSelectedButtonAlignment(fakeSelection({ attrs: { alignment: "right" }, from: 40 }));
    expect(result).toEqual({ pos: 40, alignment: "right" });
  });

  it("defaults to 'left' when alignment is absent — matches maily's DEFAULT_BUTTON_ALIGNMENT", () => {
    const result = resolveSelectedButtonAlignment(fakeSelection({ attrs: {} }));
    expect(result?.alignment).toBe("left");
  });

  it("defaults to 'left' when alignment is present but invalid (corrupt/foreign doc)", () => {
    const result = resolveSelectedButtonAlignment(fakeSelection({ attrs: { alignment: "justify" } }));
    expect(result?.alignment).toBe("left");
  });
});

describe("buttonAlignmentUpdate", () => {
  function fakeDoc(nodesByPos: Record<number, { type: string; attrs?: Record<string, unknown> }>) {
    return {
      nodeAt: (pos: number) => {
        const entry = nodesByPos[pos];
        return entry ? { type: { name: entry.type }, attrs: entry.attrs ?? {} } : null;
      },
    };
  }

  it("returns updated attrs (spreading existing attrs, overriding alignment) when pos still resolves to a button", () => {
    const doc = fakeDoc({ 10: { type: "button", attrs: { text: "RSVP", alignment: "left", variant: "filled" } } });
    const result = buttonAlignmentUpdate(doc, 10, "center");
    expect(result).toEqual({ attrs: { text: "RSVP", alignment: "center", variant: "filled" } });
  });

  it("returns null when the position no longer resolves to a button (stale position guard)", () => {
    const doc = fakeDoc({ 10: { type: "image", attrs: {} } });
    expect(buttonAlignmentUpdate(doc, 10, "center")).toBeNull();
  });

  it("returns null when the position resolves to nothing at all", () => {
    const doc = fakeDoc({});
    expect(buttonAlignmentUpdate(doc, 10, "center")).toBeNull();
  });

  it("preserves every other attr untouched", () => {
    const doc = fakeDoc({
      5: { type: "button", attrs: { text: "Give", buttonColor: "#000", maxWidth: 190, alignment: "center" } },
    });
    const result = buttonAlignmentUpdate(doc, 5, "right");
    expect(result).toEqual({ attrs: { text: "Give", buttonColor: "#000", maxWidth: 190, alignment: "right" } });
  });
});
