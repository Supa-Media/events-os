import { describe, expect, test } from "vitest";
import {
  normalizeRsvpPageLinkUrl,
  rsvpPageLinkHost,
  rsvpTitleFont,
} from "./rsvpPageStyle";

describe("rsvpTitleFont", () => {
  test("unset and unknown ids fall back to classic", () => {
    expect(rsvpTitleFont(null).id).toBe("classic");
    expect(rsvpTitleFont(undefined).id).toBe("classic");
    expect(rsvpTitleFont("papyrus").id).toBe("classic");
  });

  test("known ids resolve to their stack", () => {
    expect(rsvpTitleFont("helvetica").family).toContain("Helvetica");
    expect(rsvpTitleFont("sans").family).toContain("DM Sans");
  });
});

describe("normalizeRsvpPageLinkUrl", () => {
  test("keeps http(s) URLs", () => {
    expect(normalizeRsvpPageLinkUrl(" https://forms.gle/abc ")).toBe(
      "https://forms.gle/abc",
    );
    expect(normalizeRsvpPageLinkUrl("http://example.org")).toBe(
      "http://example.org",
    );
  });

  test("adds https:// to a bare domain", () => {
    expect(normalizeRsvpPageLinkUrl("forms.gle/abc")).toBe(
      "https://forms.gle/abc",
    );
  });

  test("rejects other schemes and non-links", () => {
    expect(normalizeRsvpPageLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRsvpPageLinkUrl("data:text/html,hi")).toBeNull();
    expect(normalizeRsvpPageLinkUrl("mailto:a@b.co")).toBeNull();
    expect(normalizeRsvpPageLinkUrl("not a link")).toBeNull();
    expect(normalizeRsvpPageLinkUrl("questionnaire")).toBeNull();
    expect(normalizeRsvpPageLinkUrl("")).toBeNull();
  });
});

describe("rsvpPageLinkHost", () => {
  test("strips www.", () => {
    expect(rsvpPageLinkHost("https://www.example.org/x")).toBe("example.org");
  });
});
