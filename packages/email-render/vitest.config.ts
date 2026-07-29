import { defineConfig } from "vitest/config";

/**
 * Vitest config for `packages/email-render`.
 *
 * `environment: "edge-runtime"` deliberately mirrors `apps/convex/vitest.config.ts`
 * — this package's whole reason for existing is to render inside a Convex
 * default-isolate action, so its own test suite runs under the SAME
 * `@edge-runtime/vm` sandbox (Web APIs, no Node globals) `convex-test` uses,
 * approximating that isolate without needing a file inside `apps/convex`
 * itself (see `src/render.edge.test.ts` — WS0 spike, Bet 2).
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
