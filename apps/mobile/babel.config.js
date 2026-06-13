module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    // react-native-worklets/plugin is the Reanimated v4 babel plugin (replaces
    // the old react-native-reanimated/plugin). It MUST be listed last.
    plugins: ["react-native-worklets/plugin"],
  };
};
