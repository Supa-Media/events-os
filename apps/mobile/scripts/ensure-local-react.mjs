#!/usr/bin/env node
/**
 * Ensure `react` and `react-dom` are resolvable from apps/mobile's own
 * node_modules.
 *
 * Why this exists: the workspace uses `node-linker=hoisted` (.npmrc), which
 * Metro needs. Under the hoisted linker pnpm flattens every regular dependency
 * into the workspace-root node_modules and leaves each app's node_modules
 * containing only workspace-package symlinks. The `reactResolution` framework
 * guardrail (@supa-media/testing) statically asserts that react/react-dom exist
 * at `apps/mobile/node_modules/react(-dom)` at the app's own version — which the
 * hoisted layout never produces on its own. Metro likewise wants the app to
 * resolve its own React first.
 *
 * A fresh `pnpm install` prunes anything not in the lockfile, so this postinstall
 * step re-materializes the two links after every install (CI included). The links
 * point at the exact hoisted react realpath, so this stays a single React
 * instance — it does not create a second copy.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appModules = join(appDir, "node_modules");
// Hoisted layout: workspace root is apps/mobile/../.. ; react lives at its node_modules.
const rootModules = resolve(appDir, "..", "..", "node_modules");

for (const pkg of ["react", "react-dom"]) {
  const target = join(rootModules, pkg);
  if (!existsSync(join(target, "package.json"))) {
    console.warn(
      `[ensure-local-react] hoisted ${pkg} not found at ${target}; skipping (install may be partial).`,
    );
    continue;
  }
  const linkPath = join(appModules, pkg);
  rmSync(linkPath, { recursive: true, force: true }); // clears stale file/dir/broken symlink
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "junction"); // "junction" is a no-op hint on POSIX, needed on Windows
}
