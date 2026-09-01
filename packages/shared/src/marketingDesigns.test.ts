/**
 * The pure rules the design library shares with everything that touches it.
 *
 * `designEmbedUrl` and `isAllowedDesignUrl` are exercised end-to-end by
 * `apps/convex/tests/marketingDesigns.test.ts`, which is where the interesting
 * questions about them are ("does a Canva link embed and a Dropbox link
 * honestly not"). What is pinned HERE is the pair a bulk upload leans on, where
 * the interesting questions are about strings and there is no database in
 * sight: what an uploaded file BECOMES, and what it is called when it lands.
 */
import { describe, expect, test } from "vitest";
import {
  DESIGN_TITLE_MAX,
  DESIGN_UPLOAD_ACCEPT,
  designKindForContentType,
  designTitleFromFileName,
  isUploadKind,
} from "./marketingDesigns";

describe("what an uploaded file becomes", () => {
  test("images and video, whatever the subtype", () => {
    expect(designKindForContentType("image/jpeg")).toBe("image");
    expect(designKindForContentType("image/heic")).toBe("image");
    expect(designKindForContentType("IMAGE/PNG")).toBe("image");
    expect(designKindForContentType("video/mp4")).toBe("video");
    expect(designKindForContentType("video/quicktime")).toBe("video");
  });

  test("anything else is refused rather than filed as an image", () => {
    // A PDF in an <Image> is a blank tile, and a blank tile that claims to be
    // artwork is the failure mode this module keeps writing rules against.
    expect(designKindForContentType("application/pdf")).toBeNull();
    expect(designKindForContentType("text/plain")).toBeNull();
    expect(designKindForContentType("")).toBeNull();
    expect(designKindForContentType(undefined)).toBeNull();
    expect(designKindForContentType(null)).toBeNull();
    // Not a suffix match — "myimage/x" is not an image.
    expect(designKindForContentType("myimage/x")).toBeNull();
  });

  test("the picker offers exactly what the mutation accepts", () => {
    for (const pattern of DESIGN_UPLOAD_ACCEPT.split(",")) {
      expect(designKindForContentType(pattern.replace("*", "png"))).not.toBeNull();
    }
  });

  test("both upload kinds answer to isUploadKind, and no other kind does", () => {
    expect(isUploadKind("image")).toBe(true);
    expect(isUploadKind("video")).toBe(true);
    expect(isUploadKind("canva")).toBe(false);
    expect(isUploadKind("figma")).toBe(false);
    expect(isUploadKind("link")).toBe(false);
  });
});

describe("what an uploaded file is called", () => {
  test("the filename, tidied — extension off, underscores opened up", () => {
    expect(designTitleFromFileName("field-day_01.JPG")).toBe("field-day 01");
    expect(designTitleFromFileName("IMG_2481.HEIC")).toBe("IMG 2481");
    expect(designTitleFromFileName("wws  reel .mp4")).toBe("wws reel");
  });

  test("a path is a filename with noise in front of it", () => {
    expect(designTitleFromFileName("/Users/mick/Pictures/wws.png")).toBe("wws");
    expect(designTitleFromFileName("C:\\shoot\\field day.mov")).toBe("field day");
  });

  test("a name with no extension keeps all of itself", () => {
    expect(designTitleFromFileName("Field Day")).toBe("Field Day");
  });

  test("it never returns a title upsertDesign would refuse", () => {
    // Empty, absent, or nothing but an extension — a nameless row would draw
    // as a box with no label in a grid of forty.
    expect(designTitleFromFileName("")).toBe("Untitled upload");
    expect(designTitleFromFileName(undefined)).toBe("Untitled upload");
    expect(designTitleFromFileName(".jpg")).toBe("Untitled upload");
    expect(designTitleFromFileName("   .jpg")).toBe("Untitled upload");

    const long = designTitleFromFileName(`${"photo ".repeat(40)}.jpg`);
    expect(long.length).toBeLessThanOrEqual(DESIGN_TITLE_MAX);
  });
});
