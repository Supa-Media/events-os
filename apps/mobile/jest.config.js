/** Jest config for @supa-media/testing framework guardrails (pure-node static
 *  checks) plus colocated `*.test.ts` unit tests for dependency-free logic
 *  (e.g. `components/orgchart/treeUtils.test.ts`) — both run through the
 *  default babel-jest transform, which already handles TS via this package's
 *  own `babel.config.js` (babel-preset-expo includes @babel/preset-typescript). */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js", "**/*.test.ts"],
  moduleNameMapper: {
    // babel-preset-expo injects `import "expo/virtual/env"` into any app module
    // reading an EXPO_PUBLIC_* var; the real module is untransformed ESM, so map
    // it to a process.env-backed stub for colocated unit tests.
    "^expo/virtual/env$": "<rootDir>/jest/expoVirtualEnvStub.js",
  },
};
