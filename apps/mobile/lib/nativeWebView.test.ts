/**
 * The gate itself: `loadWebView()` must return `null` — not throw — on a binary
 * that has no `react-native-webview` native module.
 *
 * This is the whole point of the file. When it threw instead (which is what a
 * static import does), the JS bundle failed to load, expo-updates exhausted its
 * recovery tasks and aborted the process: TestFlight 1.0.0 (8), 0.4s after
 * launch, 2026-08-15.
 *
 * Only the loader is covered here. `apps/mobile` has no renderer in its test
 * setup (every suite is pure logic), and adding one would mean a new dependency
 * in this package — which CLAUDE.md warns can re-key the Expo native graph onto
 * a second React/react-native instance, a device-only failure this very file
 * exists to avoid. Trading a native-rendering risk for a render test would be a
 * bad bargain; the consumers' fallbacks are reviewed by eye.
 */

describe("loadWebView", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("returns the module when the native side is present", () => {
    jest.doMock(
      "react-native-webview",
      () => ({ WebView: function WebView() {} }),
      { virtual: true },
    );
    const { loadWebView } = require("./nativeWebView");
    expect(loadWebView()).not.toBeNull();
    expect(typeof loadWebView()?.WebView).toBe("function");
  });

  test("returns null instead of throwing when the module is missing", () => {
    jest.doMock(
      "react-native-webview",
      () => {
        throw new Error("Cannot find native module 'RNCWebView'");
      },
      { virtual: true },
    );
    const { loadWebView } = require("./nativeWebView");
    expect(() => loadWebView()).not.toThrow();
    expect(loadWebView()).toBeNull();
  });

  test("caches the miss, so a missing module is probed once", () => {
    let requires = 0;
    jest.doMock(
      "react-native-webview",
      () => {
        requires++;
        throw new Error("Cannot find native module 'RNCWebView'");
      },
      { virtual: true },
    );
    const { loadWebView } = require("./nativeWebView");
    loadWebView();
    loadWebView();
    loadWebView();
    expect(requires).toBe(1);
  });
});
