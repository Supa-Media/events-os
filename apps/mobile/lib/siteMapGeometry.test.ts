import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_MARKER_SIZE,
  MAX_MARKER_SIZE,
  MIN_MARKER_SIZE,
  clampMarkerSize,
  markerHalf,
} from "./siteMapGeometry";

describe("clampMarkerSize", () => {
  test("passes values inside the range through unchanged", () => {
    expect(clampMarkerSize(24)).toBe(24);
  });
  test("clamps below MIN_MARKER_SIZE and above MAX_MARKER_SIZE", () => {
    expect(clampMarkerSize(2)).toBe(MIN_MARKER_SIZE);
    expect(clampMarkerSize(999)).toBe(MAX_MARKER_SIZE);
  });
  test("falls back to the default for non-finite input", () => {
    expect(clampMarkerSize(NaN)).toBe(DEFAULT_MARKER_SIZE);
  });
});

describe("markerHalf", () => {
  test("halves a marker's own size", () => {
    expect(markerHalf({ size: 40 })).toBe(20);
  });
  test("falls back to half the default size when size is unset", () => {
    expect(markerHalf({ size: undefined })).toBe(DEFAULT_MARKER_SIZE / 2);
    expect(markerHalf({ size: null })).toBe(DEFAULT_MARKER_SIZE / 2);
  });
});
