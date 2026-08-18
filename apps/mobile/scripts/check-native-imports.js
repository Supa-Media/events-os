#!/usr/bin/env node
/**
 * CI enforcement: catch ungated static imports of native dependencies.
 *
 * Gated native deps must be imported dynamically behind a NativeModules
 * require() behind a try/catch (see lib/nativeWebView.ts for the pattern).
 * Static imports bypass that safety net and crash on older native builds.
 *
 * This script:
 * 1. Reads native-deps.json (core vs gated classification)
 * 2. Scans all .ts/.tsx source files for static imports of gated deps
 * 3. Checks that every native dep in package.json is classified
 * 4. Fails CI if violations are found
 *
 * WHY THIS FILE EXISTS HERE. The framework's reusable CI
 * (Supa-Media/supa-framework/.github/workflows/ci.yml) already runs this check
 * — but only by looking for `apps/mobile/scripts/check-native-imports.js`, and
 * when it isn't found it emits a `::notice::` and SKIPS. This repo never had
 * the file, so the gate silently no-op'd on every PR while `native-deps.json`
 * sat here looking authoritative.
 *
 * That is how `react-native-webview` came to be statically imported by three
 * components: it was added on 2026-06-14 at 23:57, hours after that day's iOS
 * binary was built, and classified `core` — a claim that every binary in the
 * field already had it. With `runtimeVersion: { policy: "appVersion" }` and a
 * version string that has never changed, EAS Update served that bundle to the
 * older binary, the bundle failed to load, and expo-updates aborted the
 * process. TestFlight 1.0.0 (8) crashed 0.4s after launch on 2026-08-15.
 *
 * Adapted from Togather's copy of this script (same framework convention).
 * Deliberately dependency-free (`fs` + `path` only) so it needs no package
 * install — adding one to apps/mobile risks pnpm re-keying the Expo native
 * graph onto a second React/react-native instance, which is its own device-only
 * failure mode.
 *
 * A follow-up worth raising upstream: the framework should fail, not skip,
 * when an Expo app has a native-deps.json but no checker.
 *
 * Usage:
 *   node scripts/check-native-imports.js
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");

// The gating utilities themselves — the one place a gated dep may be named,
// because each resolves it through a runtime require() in a try/catch and
// returns null when the native module is absent.
const ALLOWLISTED_FILES = new Set([
  "lib/cameraScanning.ts",
  "lib/nativeWebView.ts",
]);

/**
 * Patterns that match native dependency package names in package.json.
 * Used to detect new native deps that aren't classified yet.
 */
const NATIVE_PACKAGE_PATTERNS = [
  /^react-native$/,
  /^react-native-/,
  /^@react-native\//,
  /^@react-native-community\//,
  /^@react-native-picker\//,
  /^@react-native-async-storage\//,
  /^expo$/,
  /^expo-/,
  /^@expo\//,
  /^@sentry\/react-native/,
  /^@shopify\/flash-list/,
  /^@gorhom\/bottom-sheet/,
  /^@rnmapbox\//,
  /^@mapbox\//,
];

function isNativePackage(name) {
  return NATIVE_PACKAGE_PATTERNS.some((p) => p.test(name));
}

/**
 * Recursively find all .ts and .tsx files, skipping node_modules and hidden dirs
 */
function findSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      findSourceFiles(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  // 1. Load config
  const configPath = path.join(PROJECT_ROOT, "native-deps.json");
  if (!fs.existsSync(configPath)) {
    console.error("❌ native-deps.json not found");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const coreDeps = new Set(config.core);
  const gatedDeps = new Set(config.gated);
  const allClassified = new Set([...coreDeps, ...gatedDeps]);

  // 2. Check that all native deps in package.json are classified
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8")
  );
  const allDeps = Object.keys(packageJson.dependencies || {});
  const nativeDeps = allDeps.filter(isNativePackage);

  const unclassified = nativeDeps.filter((dep) => !allClassified.has(dep));
  if (unclassified.length > 0) {
    console.error("❌ Unclassified native dependencies found in package.json:");
    console.error("");
    for (const dep of unclassified) {
      console.error(`   ${dep}`);
    }
    console.error("");
    console.error(
      "   Add each dependency to either 'core' or 'gated' in native-deps.json."
    );
    console.error(
      "   - core: present in the baseline native build (safe for static import)"
    );
    console.error(
      "   - gated: requires runtime NativeModules check before import"
    );
    console.error("");
    console.error('   See CLAUDE.md, "Native dependencies and OTA updates".');
    process.exit(1);
  }

  // 3. Scan source files for static imports of gated deps
  const sourceFiles = findSourceFiles(PROJECT_ROOT);
  const violations = [];

  // Match: import ... from 'dep' or import ... from "dep" or import 'dep'
  // Also match: export ... from 'dep'
  const importRegex =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:[\s\S]*?\s+from\s+)?)['"]([^'"]+)['"]/g;

  for (const filePath of sourceFiles) {
    const relativePath = path.relative(PROJECT_ROOT, filePath);

    // Skip allowlisted files (they contain the gating logic itself)
    if (ALLOWLISTED_FILES.has(relativePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    let match;

    importRegex.lastIndex = 0;
    while ((match = importRegex.exec(content)) !== null) {
      const importedPackage = match[1];

      // Check if this is a static import of a gated dep
      if (gatedDeps.has(importedPackage)) {
        // Determine line number
        const beforeMatch = content.substring(0, match.index);
        const lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;

        violations.push({
          file: relativePath,
          line: lineNumber,
          dep: importedPackage,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error("❌ Static imports of gated native dependencies found:\n");
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line}`);
      console.error(`   Static import of: ${v.dep}\n`);
    }
    console.error(
      "   A gated native dependency may only be resolved through a"
    );
    console.error("   runtime require(), so a binary that lacks it degrades");
    console.error("   instead of crashing. Follow lib/nativeWebView.ts:\n");
    console.error("   1. Add a loader in lib/ that require()s it inside a");
    console.error("      try/catch and returns null when it is absent (then");
    console.error("      add that file to ALLOWLISTED_FILES in this script)");
    console.error("   2. Have every consumer call the loader and render a");
    console.error("      real fallback for the null case");
    console.error("   3. Keep it in native-deps.json's \"gated\" list until a");
    console.error("      binary containing it is the oldest one still served\n");
    console.error('   See CLAUDE.md, "Native dependencies and OTA updates".');
    process.exit(1);
  }

  // All checks passed
  console.log("✅ Native import gating check passed");
  console.log(`   Scanned ${sourceFiles.length} source files`);
  console.log(`   Core deps: ${coreDeps.size}, Gated deps: ${gatedDeps.size}`);
}

main();
