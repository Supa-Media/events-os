/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  name: "Events OS",
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
    associatedDomains: [],
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
          "Allow Events OS to access your photos so you can attach images.",
      },
    ],
  ],
  extra: {
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
