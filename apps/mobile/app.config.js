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

/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
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
  plugins: [
    "expo-router",
    [
      "expo-image-picker",
      {
        photosPermission:
          "Allow Chapter OS to access your photos so you can attach images.",
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
  owner: "lilseyi",
  runtimeVersion: {
    policy: "appVersion",
  },
  updates: {
    url: `https://u.expo.dev/4d2f4932-3e26-433f-a8db-6da4571dff18`,
  },
});
