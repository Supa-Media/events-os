import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  loadNotificationProvider,
  resetNotificationProviderForTest,
} from "./notificationProvider";

/**
 * As in `clipboard.test.ts`, this file never names the gated package in
 * import-shaped text — the native-import guardrail's scan is textual. The
 * mock is reached through the `mock`-prefixed binding below, which is what
 * lets a hoisted `jest.mock` factory close over it.
 */
const mockProvider = () => null;

/** Flips the mock into "this binary has no notification native modules" mode. */
let mockNativeModuleMissing = false;

jest.mock("@supa-media/notifications", () => {
  if (mockNativeModuleMissing) {
    // What Expo throws when the JS is newer than the binary.
    throw new Error("Cannot find native module 'ExpoNotifications'");
  }
  return { NotificationProvider: mockProvider };
});

describe("loadNotificationProvider", () => {
  beforeEach(() => {
    mockNativeModuleMissing = false;
    jest.resetModules();
    resetNotificationProviderForTest();
  });

  test("returns the real provider when the build has the native modules", () => {
    expect(loadNotificationProvider()).toBe(mockProvider);
  });

  /**
   * The case the gating exists for. The root layout mounts this provider above
   * everything, so a throw here happens before React mounts — uncatchable, and
   * expo-updates' ErrorRecovery escalates it into a launch-time SIGABRT. Push
   * is a feature; a build without it has to still start.
   */
  test("returns null instead of throwing when the modules are absent", () => {
    mockNativeModuleMissing = true;

    expect(() => loadNotificationProvider()).not.toThrow();
    expect(loadNotificationProvider()).toBeNull();
  });

  test("resolves once and reuses the result", () => {
    expect(loadNotificationProvider()).toBe(loadNotificationProvider());
  });
});
