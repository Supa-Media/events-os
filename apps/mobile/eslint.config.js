import supaPreset from "@supa-media/linter/preset";
import supaPlugin from "@supa-media/linter";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...supaPreset,
  {
    // The shared preset registers its plugin under the "@supa" namespace, but
    // its rule ids use the "@supa-media/" prefix — so ESLint can't resolve them
    // as shipped. Re-register the same plugin under the matching namespace so
    // the preset's rules ("@supa-media/no-ungated-native-import", …) resolve.
    // Also register react-hooks so the codebase's `exhaustive-deps` rule (and
    // its inline disable directives) resolve instead of erroring as unknown.
    plugins: { "@supa-media": supaPlugin, "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
