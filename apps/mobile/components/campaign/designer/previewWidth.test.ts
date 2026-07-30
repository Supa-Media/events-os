import {
  DEFAULT_PREVIEW_WIDTH_ID,
  PREVIEW_WIDTHS,
  PREVIEW_WIDTH_IDS,
  isPreviewWidthId,
} from "./previewWidth";

describe("isPreviewWidthId", () => {
  test.each(PREVIEW_WIDTH_IDS)("accepts %s", (id) => {
    expect(isPreviewWidthId(id)).toBe(true);
  });

  it("rejects an arbitrary string", () => {
    expect(isPreviewWidthId("phablet")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isPreviewWidthId(375)).toBe(false);
    expect(isPreviewWidthId(null)).toBe(false);
    expect(isPreviewWidthId(undefined)).toBe(false);
  });
});

describe("PREVIEW_WIDTHS", () => {
  it("mobile and tablet carry a positive px width; desktop is unconstrained (null)", () => {
    expect(PREVIEW_WIDTHS.mobile.width).toBeGreaterThan(0);
    expect(PREVIEW_WIDTHS.tablet.width).toBeGreaterThan(0);
    expect(PREVIEW_WIDTHS.desktop.width).toBeNull();
  });

  it("mobile is narrower than tablet", () => {
    expect(PREVIEW_WIDTHS.mobile.width as number).toBeLessThan(PREVIEW_WIDTHS.tablet.width as number);
  });

  it("every id has a non-empty label", () => {
    for (const id of PREVIEW_WIDTH_IDS) {
      expect(PREVIEW_WIDTHS[id].label.length).toBeGreaterThan(0);
    }
  });
});

describe("DEFAULT_PREVIEW_WIDTH_ID", () => {
  it("defaults to desktop — today's pre-existing (unconstrained) preview behavior", () => {
    expect(DEFAULT_PREVIEW_WIDTH_ID).toBe("desktop");
    expect(PREVIEW_WIDTHS[DEFAULT_PREVIEW_WIDTH_ID].width).toBeNull();
  });
});
