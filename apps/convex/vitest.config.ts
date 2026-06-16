import { defineConfig } from "vitest/config";

/**
 * Vitest config for the Convex backend.
 *
 * `convex-test` runs functions against an in-memory mock of the Convex runtime,
 * which requires the `edge-runtime` environment (Web APIs, no Node globals).
 * See https://docs.convex.dev/testing/convex-test.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["**/*.test.ts"],
  },
});
