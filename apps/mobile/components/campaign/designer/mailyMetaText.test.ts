import {
  fromLineText,
  previewTextSaveDecision,
  subjectSaveDecision,
} from "./mailyMetaText";

describe("fromLineText", () => {
  it("shows the org default when nothing is overridden", () => {
    expect(fromLineText({})).toBe("the org default");
  });

  it("shows the org's from address when only that's known", () => {
    expect(fromLineText({ orgFromAddress: "hello@publicworship.org" })).toBe(
      "hello@publicworship.org",
    );
  });

  it("prefers the campaign's own fromEmail over the org default", () => {
    expect(
      fromLineText({ fromEmail: "aj@publicworship.org", orgFromAddress: "hello@publicworship.org" }),
    ).toBe("aj@publicworship.org");
  });

  it("shows 'Name <address>' when a from name is set", () => {
    expect(
      fromLineText({
        fromName: "AJ",
        fromEmail: "aj@publicworship.org",
        orgFromAddress: "hello@publicworship.org",
      }),
    ).toBe("AJ <aj@publicworship.org>");
  });

  it("falls back the from name onto the org default address", () => {
    expect(fromLineText({ fromName: "AJ", orgFromAddress: "hello@publicworship.org" })).toBe(
      "AJ <hello@publicworship.org>",
    );
  });
});

describe("subjectSaveDecision", () => {
  it("resets a whitespace-only draft instead of saving it", () => {
    expect(subjectSaveDecision("   ", "Old subject")).toEqual({ action: "reset" });
  });

  it("skips when the trimmed draft matches what's saved", () => {
    expect(subjectSaveDecision("Same subject  ", "Same subject")).toEqual({ action: "skip" });
  });

  it("saves a real, changed, trimmed subject", () => {
    expect(subjectSaveDecision("  New subject  ", "Old subject")).toEqual({
      action: "save",
      value: "New subject",
    });
  });
});

describe("previewTextSaveDecision", () => {
  it("skips when unchanged", () => {
    expect(previewTextSaveDecision("Same", "Same")).toEqual({ action: "skip" });
  });

  it("saves a real change", () => {
    expect(previewTextSaveDecision("New preview", "Old preview")).toEqual({
      action: "save",
      value: "New preview",
    });
  });

  it("saves an emptied preview (blank is valid here, unlike subject)", () => {
    expect(previewTextSaveDecision("", "Old preview")).toEqual({ action: "save", value: "" });
  });
});
