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
    // `@convex-dev/aggregate` is inlined too — its `/test` entry point
    // (`lib/peopleAggregate.ts`'s consistency test) uses `import.meta.glob`
    // to register the aggregate component with convex-test, which only
    // works if Vite processes it as source rather than a pre-bundled dep.
    server: { deps: { inline: ["convex-test", "@convex-dev/aggregate"] } },
    include: ["**/*.test.ts"],
  },
});
