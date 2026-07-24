// Metro emits WEB bundles as classic scripts (and lazy chunks are loaded via
// fetch + eval), so a bare `import.meta` token ANYWHERE in the output — app
// code or a dependency — is a parse-time SyntaxError ("Cannot use 'import.meta'
// outside a module") that kills the whole script before one line runs. That's
// how PR #410 white-screened publicworship.life/os: the token itself, not any
// runtime throw, so lazy-loading/try-catch can't help (see PR #415, which
// missed this). Babel is the only layer that sees every file Metro bundles
// (including node_modules — pdfjs-dist ships one in a Node-only path), so the
// token is stripped here: `import.meta` → `({})`, making `import.meta.url`
// evaluate to `undefined` instead of crashing the parse.
// Candidate for @supa-media/metro upstream once proven here (upstream-first
// rule) — kept local for the hotfix because babel.config.js is app-owned.
const stripImportMeta = ({ types: t }) => ({
  name: "strip-import-meta",
  visitor: {
    MetaProperty(path) {
      if (
        path.node.meta.name === "import" &&
        path.node.property.name === "meta"
      ) {
        path.replaceWith(t.objectExpression([]));
      }
    },
  },
});

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    // react-native-worklets/plugin is the Reanimated v4 babel plugin (replaces
    // the old react-native-reanimated/plugin). It MUST be listed last.
    plugins: [stripImportMeta, "react-native-worklets/plugin"],
  };
};
