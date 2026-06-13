import supaConfig from "@supa/linter";

export default [
  ...supaConfig,
  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
