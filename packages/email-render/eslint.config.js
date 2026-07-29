import supaPreset from "@supa-media/linter/preset";

/**
 * ESLint config for @events-os/email-render — same reasoning as
 * `packages/shared/eslint.config.js` (this package's `lint` script needs a
 * config file to exist at all, or `eslint .` exits 2 and aborts the
 * `turbo run lint` fan-out). Reuses the framework preset unchanged.
 *
 * `eslint`, `@supa-media/linter` and `@typescript-eslint/parser` resolve from
 * the workspace root (`.npmrc`'s `node-linker=hoisted`) rather than being
 * declared here directly — same as `packages/shared`.
 */
export default [...supaPreset];
