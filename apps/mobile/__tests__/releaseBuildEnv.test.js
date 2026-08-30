/**
 * A real release build must not be configurable without its backend URL.
 *
 * `EXPO_PUBLIC_*` vars are inlined into the JS bundle at build/export time, so
 * a build that runs without `EXPO_PUBLIC_CONVEX_URL` ships `undefined` as the
 * Convex URL. The app then throws while mounting its providers, and on a
 * release build expo-updates' ErrorRecovery escalates that fatal JS error into
 * a native abort — the crash log that comes back is all `ErrorRecovery.crash()`
 * frames with the real cause nowhere in it.
 *
 * `deploy-mobile-update.yml` and `deploy-web.yml` already refuse to run without
 * the var. `eas build` had no such check, and it is the path that produces the
 * binaries people install. `app.config.js` now throws instead; this pins that,
 * and pins the scoping — a guard that also fired in local dev would be reverted
 * within a day.
 */
const path = require("path");

const CONFIG = path.join(__dirname, "..", "app.config.js");

/** Evaluate app.config.js with a given env, restoring the real env after. */
function evaluateConfig({ appEnv, convexUrl }) {
  const saved = {
    APP_ENV: process.env.APP_ENV,
    EXPO_PUBLIC_CONVEX_URL: process.env.EXPO_PUBLIC_CONVEX_URL,
  };
  if (appEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = appEnv;
  if (convexUrl === undefined) delete process.env.EXPO_PUBLIC_CONVEX_URL;
  else process.env.EXPO_PUBLIC_CONVEX_URL = convexUrl;

  try {
    delete require.cache[require.resolve(CONFIG)];
    return require(CONFIG)({ config: {} });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(CONFIG)];
  }
}

describe("app.config.js release-build guard", () => {
  for (const appEnv of ["staging", "production"]) {
    it(`refuses to configure an APP_ENV=${appEnv} build with no Convex URL`, () => {
      expect(() => evaluateConfig({ appEnv })).toThrow(
        /EXPO_PUBLIC_CONVEX_URL is not set/,
      );
    });

    it(`configures an APP_ENV=${appEnv} build when the URL is present`, () => {
      const config = evaluateConfig({
        appEnv,
        convexUrl: "https://example.convex.cloud",
      });
      expect(config.extra.convexUrl).toBe("https://example.convex.cloud");
    });
  }

  // The guard must stay out of the way everywhere else: a dev machine with no
  // .env.local, and any tooling that evaluates this config without a backend.
  for (const appEnv of [undefined, "development"]) {
    it(`stays quiet for APP_ENV=${String(appEnv)}`, () => {
      expect(() => evaluateConfig({ appEnv })).not.toThrow();
    });
  }

  it("still rewrites a loopback URL to the LAN address in dev", () => {
    // The existing behavior the guard sits next to — a device can't reach the
    // host's loopback, so `resolveConvexUrl` swaps in the machine's LAN IP.
    const config = evaluateConfig({
      appEnv: "development",
      convexUrl: "http://127.0.0.1:3210",
    });
    expect(config.extra.convexUrl).toMatch(/^http:\/\/[\d.]+:3210$/);
    expect(config.extra.convexUrl).not.toContain("127.0.0.1");
  });

  it("passes a non-loopback URL through untouched", () => {
    const config = evaluateConfig({
      appEnv: "production",
      convexUrl: "https://real.convex.cloud",
    });
    expect(config.extra.convexUrl).toBe("https://real.convex.cloud");
  });
});
