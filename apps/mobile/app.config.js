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
  ],
  extra: {
    eas: {
      projectId: "YOUR_EAS_PROJECT_ID",
    },
    router: {
      origin: false,
    },
  },
  owner: "supa-media",
  runtimeVersion: {
    policy: "appVersion",
  },
  updates: {
    url: `https://u.expo.dev/YOUR_EAS_PROJECT_ID`,
  },
});
