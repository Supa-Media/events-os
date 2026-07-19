import supaPreset from "@supa-media/linter/preset";

/**
 * ESLint config for @events-os/shared.
 *
 * This package declared a `lint` script from the day it was scaffolded but never
 * shipped a config, so `eslint .` exited 2 ("No files matching the pattern") —
 * which aborted the whole `turbo run lint` fan-out and meant NOTHING in the repo
 * was linted by `pnpm lint`. This file closes that hole.
 *
 * It reuses the framework preset (same source as apps/mobile) rather than a
 * bespoke rule list, so the three workspaces stay on one set of conventions.
 * Most preset rules are Expo/React-Native-shaped and simply never fire on pure
 * domain logic — but `no-ungated-native-import` genuinely matters here: this
 * package is imported by the CONVEX BACKEND as well as the app, so a stray
 * `react-native` import would break the server at runtime. Linting for it is
 * the cheap guard.
 *
 * NOTE: `eslint`, `@supa-media/linter` and `@typescript-eslint/parser` are NOT
 * declared in this package's devDependencies — they resolve from the root
 * because `.npmrc` sets `node-linker=hoisted`. Declaring them would be more
 * correct, but it requires regenerating pnpm-lock.yaml, which needs a
 * GITHUB_TOKEN with read:packages to re-resolve @supa-media/* from GitHub
 * Packages. Add them (and refresh the lockfile) next time you install with a
 * token present.
 */
export default [...supaPreset];
