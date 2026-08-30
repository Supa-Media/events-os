import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  copyToClipboard,
  loadClipboard,
  resetClipboardForTest,
} from "./clipboard";

// This file deliberately never names the gated module in an import statement —
// not even in a comment, whose text the framework's native-import guardrail
// scans just the same (it flagged an earlier draft of this very note). The
// mock's functions are reached through the `mock`-prefixed bindings below
// instead; that prefix is what lets a hoisted `jest.mock` factory close over
// them.
const mockSetStringAsync = jest.fn<(text: string) => Promise<void>>();

/** Flips the mock into "this binary doesn't have the native module" mode. */
let mockNativeModuleMissing = false;

jest.mock("expo-clipboard", () => {
  if (mockNativeModuleMissing) {
    // What Expo actually throws when the JS is newer than the binary.
    throw new Error("Cannot find native module 'ExpoClipboard'");
  }
  return { setStringAsync: mockSetStringAsync };
});

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

describe("copyToClipboard on native", () => {
  beforeEach(() => {
    mockSetStringAsync.mockReset();
    mockNativeModuleMissing = false;
    // Both caches: jest's module registry (so the factory above re-runs and can
    // change its mind about throwing) and this module's own memo.
    jest.resetModules();
    resetClipboardForTest();
  });

  test("copies through Expo and reports success", async () => {
    mockSetStringAsync.mockResolvedValue(undefined);

    await expect(copyToClipboard("#891d1a")).resolves.toBe(true);
    expect(mockSetStringAsync).toHaveBeenCalledWith("#891d1a");
  });

  test("reports failure when the native clipboard rejects", async () => {
    mockSetStringAsync.mockRejectedValue(new Error("clipboard unavailable"));

    await expect(copyToClipboard("text")).resolves.toBe(false);
  });

  /**
   * The case this module's gating exists for: an older binary running newer JS
   * over OTA has no `expo-clipboard` native module. Resolving it must return
   * `null` rather than throw — a throw reaches expo-updates' ErrorRecovery and
   * becomes a native abort at startup, which is what TestFlight 1.0.0 build 8
   * did on 2026-08-30 when this module was still a static import.
   */
  test("resolves to null when the native module isn't in this build", () => {
    mockNativeModuleMissing = true;

    expect(loadClipboard()).toBeNull();
  });

  test("reports failure instead of throwing when the module is missing", async () => {
    mockNativeModuleMissing = true;

    await expect(copyToClipboard("text")).resolves.toBe(false);
    expect(mockSetStringAsync).not.toHaveBeenCalled();
  });

  test("resolves the module once and reuses it", () => {
    expect(loadClipboard()).toBe(loadClipboard());
  });
});
