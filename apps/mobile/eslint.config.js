import supaPreset from "@supa-media/linter/preset";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...supaPreset,
  {
    // Register react-hooks so the codebase's `exhaustive-deps` rule (and
    // its inline disable directives) resolve instead of erroring as unknown.
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
