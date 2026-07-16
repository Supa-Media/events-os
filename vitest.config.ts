import { defineConfig } from "vitest/config";

/**
 * Root-level Vitest config.
 *
 * This repo runs tests per-workspace via `turbo run test` (apps/convex uses
 * Vitest, apps/mobile uses Jest), so this file is not on that path. It exists
 * only to make a bare `vitest run` invoked from the repo root safe: without
 * it, Vitest's default include glob sweeps up apps/mobile's Jest test files
 * (e.g. apps/mobile/__tests__/supa-framework.test.js), which use bare Jest
 * globals (`describe`/`test`) and fail with "describe is not defined" under
 * Vitest.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "apps/mobile/**"],
  },
});
