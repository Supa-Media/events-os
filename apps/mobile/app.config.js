const { networkInterfaces } = require("os");

/**
 * Dev only: rewrite a loopback Convex URL to the machine's current LAN
 * address, resolved fresh every time the dev server starts.
 *
 * Chrome 148+ blocks cross-origin requests from the web app
 * (localhost:8081) to loopback (127.0.0.1:3210) but allows the LAN IP —
 * and native devices can't reach the host's loopback at all. The LAN IP
 * changes with the network (wifi vs hotspot), so it must not be
 * hardcoded in .env. Non-loopback URLs (e.g. a cloud deployment) pass
 * through untouched. Read in the app via Constants.expoConfig.extra.
 */
function resolveConvexUrl() {
  const url = process.env.EXPO_PUBLIC_CONVEX_URL;
  if (!url || !/127\.0\.0\.1|localhost/.test(url)) return url;
  const ifaces = networkInterfaces();
  // Prefer the primary interfaces so a VPN/virtual adapter doesn't win.
  const names = ["en0", "en1", ...Object.keys(ifaces)];
  for (const name of names) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return url.replace(/127\.0\.0\.1|localhost/, iface.address);
      }
    }
  }
  return url;
}

/**
 * Refuse to configure a REAL build (staging/production) without the Convex URL.
 *
 * `EXPO_PUBLIC_*` vars are inlined at build/export time, so a build that runs
 * without this one ships `undefined` as the backend URL. What the user sees is
 * not a helpful error: the app throws while mounting its providers, and on a
 * release build expo-updates' ErrorRecovery escalates that fatal JS error into
 * a native abort — a SIGABRT crash log whose frames are all
 * `ErrorRecovery.crash()`, with the actual cause nowhere in the report.
 *
 * `deploy-mobile-update.yml` and `deploy-web.yml` already refuse to run without
 * it ("would ship `undefined` and crash the app on launch"). `eas build` was
 * the one path with no such check, and it is the path that produces the
 * binaries people install. Failing here turns "ships a crashing build" into
 * "the build stops with a message".
 *
 * Scoped to APP_ENV staging/production — the values `eas.json`'s two release
 * profiles set — so local dev, `pnpm dev`, and tooling that evaluates this
 * config without a backend are unaffected.
 */
function assertConvexUrlForReleaseBuilds() {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "staging" && appEnv !== "production") return;
  if (process.env.EXPO_PUBLIC_CONVEX_URL) return;
  throw new Error(
    `EXPO_PUBLIC_CONVEX_URL is not set, but APP_ENV=${appEnv}.\n\n` +
      "EXPO_PUBLIC_* vars are baked into the JS bundle at build time, so this " +
      "build would ship with no backend URL and crash on launch.\n\n" +
      "Set it in the EAS project's environment variables (`eas env:create`), " +
      "or export it in the shell running `eas build`.",
  );
}

/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => {
  assertConvexUrlForReleaseBuilds();
  return {
    ...config,
    name: "Chapter OS",
    slug: "events-os",
    version: "1.0.0",
    scheme: "eventsos",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    splash: {
      image: "./assets/splash.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
    assetBundlePatterns: ["**/*"],
    ios: {
      supportsTablet: true,
      bundleIdentifier: process.env.APP_ENV === "staging"
        ? "com.eventsos.staging"
        : "com.eventsos.mobile",
      infoPlist: {
        // Standard/exempt encryption only — skips the App Store export-compliance prompt.
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
      package: process.env.APP_ENV === "staging"
        ? "com.eventsos.staging"
        : "com.eventsos.mobile",
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [{ scheme: "eventsos" }],
          category: ["DEFAULT", "BROWSABLE"],
        },
      ],
    },
    web: {
      // The PW mark (apps/landing/public/images/pw-mark.png), trimmed and
      // squared — `expo export` turns it into the favicon.ico the web app
      // serves at publicworship.life/os.
      favicon: "./assets/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-image-picker",
        {
          photosPermission:
            "Allow Chapter OS to access your photos so you can attach images.",
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "Allow Chapter OS to access your camera to scan ticket QR codes.",
        },
      ],
    ],
    extra: {
      convexUrl: resolveConvexUrl(),
      eas: {
        projectId: "4d2f4932-3e26-433f-a8db-6da4571dff18",
      },
      router: {
        origin: false,
      },
    },
    experiments: {
      // Web-only base path once the Cloudflare Worker fronts
      // https://publicworship.life and proxies /os/* (prefix stripped) to this
      // app's EAS Hosting origin — see docs/plans/url-consolidation.md. Lets
      // expo-router's own internal navigation (<Link>/router.push) resolve
      // correctly without per-call changes. Mirrors `APP_BASE_PATH` in
      // `lib/appUrl.ts` (duplicated, not imported — this file is plain
      // CommonJS, not run through the TS/Babel pipeline); keep both in sync.
      baseUrl: "/os",
    },
    owner: "lilseyi",
    runtimeVersion: {
      policy: "appVersion",
    },
    updates: {
      url: `https://u.expo.dev/4d2f4932-3e26-433f-a8db-6da4571dff18`,
    },
  };
};
