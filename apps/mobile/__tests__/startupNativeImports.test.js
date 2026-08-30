/**
 * Nothing but STRUCTURAL native modules may be reachable by static import from
 * the route entry files.
 *
 * This is the check that would have caught the crashes. The existing
 * `nativeImports` guardrail asks "is this module classified, and are gated ones
 * imported dynamically?" — both true, and still the app died at launch, because
 * neither question is "what does the bundle actually touch before React
 * mounts?"
 *
 * That is the question that matters. Every native build of this app shares one
 * runtime version deliberately, so an OTA reaches binaries older than any given
 * dependency. A module the running binary lacks throws where Expo resolves it —
 * at module scope — and if that happens while the entry graph is loading, it is
 * before any error boundary exists. expo-updates' ErrorRecovery then escalates
 * it to a native abort, and the crash report names only `ErrorRecovery.crash()`.
 *
 * So a feature module must never be reachable from the entry graph. Two real
 * examples, both invisible to every other check:
 *
 *   - `components/ui/index.ts` re-exports `FileViewer`, which imported
 *     `react-native-reanimated` (and through it `react-native-worklets`). The
 *     barrel is imported by `(app)/_layout.tsx` for `AppShell`, so a PDF
 *     viewer's pinch-zoom put reanimated on the launch path of every screen.
 *   - The same barrel reached `react-native-webview` through
 *     `NativePdfPane.native.tsx`.
 *
 * Neither is a native module anyone would say the app "needs to start".
 *
 * If this fails, the fix is NOT to widen the list below. It is to make the new
 * import dynamic — see `lib/clipboard.ts` for the shape — so the module resolves
 * when the feature is used rather than when the app boots.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Entry points Expo Router evaluates to render any route. */
const ENTRIES = ["app/_layout.tsx", "app/(app)/_layout.tsx", "app/(auth)/_layout.tsx"];

/**
 * Modules with no possible fallback: the app cannot render at all without
 * them, so gating is not a thing that can be written. Anything NOT on this
 * list must be reachable only when its feature is used.
 */
const STRUCTURAL = [
  "@expo/vector-icons",
  "expo-constants",
  "expo-router",
  "expo-status-bar",
  "react-native",
  "react-native-gesture-handler",
  "react-native-safe-area-context",
];

const NATIVE_PATTERNS = [
  /^react-native$/,
  /^react-native-/,
  /^@react-native\//,
  /^@react-native-community\//,
  /^expo$/,
  /^expo-/,
  /^@expo\//,
];
const isNative = (name) => NATIVE_PATTERNS.some((p) => p.test(name));

/** Resolve a relative specifier the way Metro would, native platform first. */
function resolveRelative(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    `${base}.native.tsx`,
    `${base}.native.ts`,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.native.tsx"),
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/**
 * `import ... from "x"` and `export ... from "x"`, skipping `import type`
 * (erased at compile time, so it reaches no native module) — but NOT skipping
 * `import { type Foo }`, whose statement still emits a runtime require.
 */
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm;

/** Walk the static import graph, recording where each native module came from. */
function traceStartupGraph() {
  const visited = new Set();
  const reached = new Map();

  function walk(file, chain) {
    if (visited.has(file)) return;
    visited.add(file);
    const src = fs.readFileSync(file, "utf8");
    const here = [...chain, path.relative(ROOT, file)];
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(spec, file);
        if (resolved) walk(resolved, here);
      } else if (isNative(spec) && !reached.has(spec)) {
        reached.set(spec, here.slice(-2).join(" → "));
      }
    }
  }

  for (const entry of ENTRIES) {
    const file = path.join(ROOT, entry);
    if (fs.existsSync(file)) walk(file, []);
  }
  return reached;
}

describe("startup import graph", () => {
  const reached = traceStartupGraph();

  it("reaches a plausible number of files (the trace actually ran)", () => {
    // Guards against a resolver change silently turning this into a no-op.
    expect(reached.size).toBeGreaterThan(3);
  });

  it("pulls in no native module that isn't structural", () => {
    const offenders = [...reached]
      .filter(([name]) => !STRUCTURAL.includes(name))
      .map(([name, via]) => `${name} — via ${via}`);

    expect(offenders).toEqual([]);
  });

  it("still reaches the structural ones (they are genuinely on the path)", () => {
    // If one of these drops out, either the entry graph changed shape or the
    // trace broke; both are worth a look before trusting the check above.
    expect([...reached.keys()].sort()).toEqual(STRUCTURAL);
  });
});
