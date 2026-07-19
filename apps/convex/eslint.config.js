import supaPreset from "@supa-media/linter/preset";

/**
 * ESLint config for @events-os/convex.
 *
 * The backend previously had no `lint` script at all, so 336 function modules
 * went entirely unlinted. It now runs the same framework preset as the other two
 * workspaces.
 *
 * `no-ungated-native-import` is the rule that earns its keep on the server: the
 * Convex runtime is neither Node nor React Native, so an accidental
 * `react-native` (or native-module) import is a deploy-time failure that
 * typecheck alone won't always catch.
 *
 * `_generated/` is excluded — it is rewritten by `convex dev` and must never be
 * hand-edited, so lint findings there are unactionable noise.
 *
 * NOTE: the lint toolchain (`eslint`, `@supa-media/linter`,
 * `@typescript-eslint/parser`) is not declared in devDependencies here; it
 * resolves from the root via `node-linker=hoisted`. See the same note in
 * packages/shared/eslint.config.js. One consequence: the scoped install in
 * .github/workflows/deploy-convex.yml (`--filter @events-os/convex...`)
 * deliberately omits the private @supa-media/* packages, so `pnpm lint` is not
 * runnable in that job — which is fine, since it only typechecks and deploys.
 */
export default [
  ...supaPreset,
  {
    ignores: ["_generated/**"],
  },
];
