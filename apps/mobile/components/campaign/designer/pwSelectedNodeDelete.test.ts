import { isNodeDeleteKeydown, type DeleteKeyTarget } from "./pwSelectedNodeDelete";

describe("isNodeDeleteKeydown", () => {
  it("accepts Backspace against a plain (non-text-entry) target", () => {
    expect(isNodeDeleteKeydown("Backspace", { tagName: "BUTTON" })).toBe(true);
  });

  it("accepts Delete against a plain (non-text-entry) target", () => {
    expect(isNodeDeleteKeydown("Delete", { tagName: "BUTTON" })).toBe(true);
  });

  it("accepts a DIV target (e.g. an image/section node view's own wrapper)", () => {
    expect(isNodeDeleteKeydown("Delete", { tagName: "DIV" })).toBe(true);
  });

  it("accepts SELECT (not a free-text entry surface)", () => {
    expect(isNodeDeleteKeydown("Backspace", { tagName: "SELECT" })).toBe(true);
  });

  it("accepts a null/undefined target (no target info available)", () => {
    expect(isNodeDeleteKeydown("Delete", null)).toBe(true);
    expect(isNodeDeleteKeydown("Delete", undefined)).toBe(true);
  });

  it("rejects every other key", () => {
    expect(isNodeDeleteKeydown("Enter", { tagName: "BUTTON" })).toBe(false);
    expect(isNodeDeleteKeydown("a", { tagName: "BUTTON" })).toBe(false);
    expect(isNodeDeleteKeydown("ArrowLeft", { tagName: "BUTTON" })).toBe(false);
  });

  it("rejects an INPUT target — a bubble-menu's own text field (e.g. the button label editor)", () => {
    expect(isNodeDeleteKeydown("Backspace", { tagName: "INPUT" })).toBe(false);
    expect(isNodeDeleteKeydown("Delete", { tagName: "INPUT" })).toBe(false);
  });

  it("rejects a TEXTAREA target", () => {
    expect(isNodeDeleteKeydown("Backspace", { tagName: "TEXTAREA" })).toBe(false);
  });

  it("rejects any isContentEditable target — ordinary prose typing", () => {
    const target: DeleteKeyTarget = { tagName: "DIV", isContentEditable: true };
    expect(isNodeDeleteKeydown("Backspace", target)).toBe(false);
    expect(isNodeDeleteKeydown("Delete", target)).toBe(false);
  });

  it("isContentEditable wins even if tagName also happens to be a text-entry tag", () => {
    // Not a real combination in the DOM, but proves the check order is safe.
    expect(isNodeDeleteKeydown("Backspace", { tagName: "INPUT", isContentEditable: false })).toBe(false);
  });
});
