/**
 * Drift guard: infra/router/src/route.ts hand-syncs several constants with
 * other packages (the Convex public HTTP route table, the Expo web app's
 * base path, the production Convex deployment name). Nothing enforces that
 * sync at compile time — a rename or addition on the other side would
 * silently misroute production traffic.
 *
 * This test mechanically re-derives those constants from the source files
 * they're synced with (via `node:fs` + regex — this suite runs under
 * Vitest/Node, not the Workers runtime, so plain file reads are fine) and
 * asserts they still agree with route.ts. If it fails, the fix is almost
 * always in infra/router/src/route.ts, not here.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONVEX_ORIGIN, OS_PREFIX, route } from "./route";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function read(relativeToRepoRoot: string): string {
  return readFileSync(resolve(REPO_ROOT, relativeToRepoRoot), "utf8");
}

describe("drift guard: apps/convex/http.ts public routes are all proxied", () => {
  const httpTs = read("apps/convex/http.ts");

  // Simple on purpose: pathPrefix/path literals only ever appear in http.ts
  // as `pathPrefix: "..."` / `path: "..."` inside an `http.route({...})`
  // call, so a plain regex is enough — no need to parse the AST.
  const pathPrefixes = [...httpTs.matchAll(/pathPrefix:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const exactPaths = [...httpTs.matchAll(/\bpath:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const literals = [...pathPrefixes, ...exactPaths];

  it("found at least one route literal to check (regex didn't silently break)", () => {
    expect(literals.length).toBeGreaterThan(0);
  });

  // NOTE: auth routes (auth.addHttpRoutes(http), e.g. /.well-known/*) are
  // registered by a library, not as string literals in http.ts, so the
  // regex above never sees them — that's fine, they're served via
  // CONVEX_SITE_URL directly and are intentionally not proxied by this
  // Worker.
  it.each(literals)("%s is routed to Convex by infra/router/src/route.ts", (literal) => {
    const path = literal.endsWith("/") ? `${literal}x` : literal;
    const decision = route(new URL(`https://publicworship.life${path}`));
    expect(
      decision,
      `apps/convex/http.ts registers "${literal}" but the router doesn't proxy ` +
        `"${path}" to Convex — update infra/router/src/route.ts's CONVEX_PREFIXES ` +
        `(or the /give special-case) to match.`,
    ).toEqual({
      kind: "proxy",
      target: `${CONVEX_ORIGIN}${path}`,
    });
  });
});

describe("drift guard: Expo web app base path matches OS_PREFIX", () => {
  it("apps/mobile/lib/appUrl.ts's APP_BASE_PATH matches route.ts's OS_PREFIX", () => {
    const appUrlTs = read("apps/mobile/lib/appUrl.ts");
    const match = appUrlTs.match(/APP_BASE_PATH\s*=\s*"([^"]+)"/);
    expect(
      match,
      "couldn't find APP_BASE_PATH in apps/mobile/lib/appUrl.ts — update this regex",
    ).not.toBeNull();
    expect(
      match?.[1],
      "apps/mobile/lib/appUrl.ts's APP_BASE_PATH no longer matches " +
        "infra/router/src/route.ts's OS_PREFIX — update infra/router/src/route.ts",
    ).toBe(OS_PREFIX);
  });

  it("apps/mobile/app.config.js's experiments.baseUrl matches route.ts's OS_PREFIX", () => {
    const appConfigJs = read("apps/mobile/app.config.js");
    const match = appConfigJs.match(/baseUrl:\s*"([^"]+)"/);
    expect(
      match,
      "couldn't find baseUrl in apps/mobile/app.config.js — update this regex",
    ).not.toBeNull();
    expect(
      match?.[1],
      "apps/mobile/app.config.js's experiments.baseUrl no longer matches " +
        "infra/router/src/route.ts's OS_PREFIX — update infra/router/src/route.ts",
    ).toBe(OS_PREFIX);
  });
});

describe("drift guard: production Convex deployment matches CONVEX_ORIGIN", () => {
  it("apps/mobile/.../ticketing/helpers.ts's PROD_CONVEX_DEPLOYMENT matches route.ts's CONVEX_ORIGIN", () => {
    const helpersTs = read(
      "apps/mobile/components/event/ticketing/helpers.ts",
    );
    const match = helpersTs.match(/PROD_CONVEX_DEPLOYMENT\s*=\s*"([^"]+)"/);
    expect(
      match,
      "couldn't find PROD_CONVEX_DEPLOYMENT in " +
        "apps/mobile/components/event/ticketing/helpers.ts — update this regex",
    ).not.toBeNull();
    expect(
      CONVEX_ORIGIN,
      "apps/mobile/.../ticketing/helpers.ts's PROD_CONVEX_DEPLOYMENT no longer " +
        "matches infra/router/src/route.ts's CONVEX_ORIGIN — update " +
        "infra/router/src/route.ts's CONVEX_ORIGIN",
    ).toBe(`https://${match?.[1]}.convex.site`);
  });
});
