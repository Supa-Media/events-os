import supaConfig from "@supa-media/linter";

export default [
  ...supaConfig,
  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
