import { defineConfig } from "vitest/config";

/**
 * Vitest config for `packages/shared`. Pure TS modules, no Convex runtime
 * needed (unlike `apps/convex`'s `edge-runtime` config for `convex-test`), so
 * this stays on Vitest's default Node environment.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
