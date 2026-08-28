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
  //
  // …EXCEPT that "only ever" broke, silently, in the exact way this guard
  // exists to catch: the public-ledger routes are registered as TEMPLATE
  // literals (`/${LEDGER_PATH}` / `/${LEDGER_PATH}/`) and the double-quote
  // regex never saw them — so the guard stayed green while every
  // publicworship.life/finances URL 404'd at the edge (2026-08-12). The
  // template-literal pass below resolves the one interpolation http.ts uses
  // (${LEDGER_PATH}) against its exported constant, and the count assertion
  // beneath pins that at least one template route was actually resolved, so
  // a new interpolated name can't slip back into the blind spot.
  const pathPrefixes = [...httpTs.matchAll(/pathPrefix:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const exactPaths = [...httpTs.matchAll(/\bpath:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  // Template-literal routes: `path: `/${NAME}`` / `pathPrefix: `/${NAME}/``.
  // Resolve ${NAME} from the constant's definition (exported from
  // apps/convex — LEDGER_PATH lives in lib/publicLedgerPage.ts).
  const constantSources = [
    httpTs,
    read("apps/convex/lib/publicLedgerPage.ts"),
  ].join("\n");
  const resolveConst = (name: string): string => {
    const m = constantSources.match(
      new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`),
    );
    if (!m) {
      throw new Error(
        `drift guard can't resolve \${${name}} in an http.ts route template — ` +
          "add its defining file to constantSources above.",
      );
    }
    return m[1];
  };
  const templateRoutes = [
    ...httpTs.matchAll(/(?:pathPrefix|path):\s*`([^`]+)`/g),
  ].map((m) =>
    m[1].replace(/\$\{(\w+)\}/g, (_, name: string) => resolveConst(name)),
  );
  const literals = [...pathPrefixes, ...exactPaths, ...templateRoutes];

  it("resolved at least one template-literal route (the /finances blind spot stays closed)", () => {
    expect(templateRoutes.length).toBeGreaterThan(0);
  });

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

/**
 * THE BLOG'S PUBLIC PATHS.
 *
 * The guard above only sees routes written as literals in apps/convex/http.ts.
 * The blog's are not: they are registered from apps/convex/lib/blogPage.ts
 * (`registerBlogPageRoutes`), the same way the /api/* routes are registered
 * from their own lib modules — http.ts contains one import and one call. So
 * that scrape cannot cover them, and something else has to.
 *
 * This block derives the blog's URLs from the place both sides already read,
 * packages/shared/src/marketingBlog.ts, and asserts the Worker proxies every
 * one of them. Posts are database rows now: a path that isn't proxied here
 * doesn't render a stale copy, it doesn't exist — the Worker answers a shared
 * link from the static build (an empty 404) and Convex is never consulted,
 * which is exactly what happened to /finances on 2026-08-12.
 */
describe("drift guard: the blog's shared paths are proxied to Convex", () => {
  const sharedBlog = read("packages/shared/src/marketingBlog.ts");

  const constant = (name: string): string => {
    const m = sharedBlog.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
    expect(
      m,
      `couldn't find ${name} in packages/shared/src/marketingBlog.ts — update this regex`,
    ).not.toBeNull();
    return m![1];
  };

  const indexPath = constant("BLOG_INDEX_PATH");
  const feedPath = constant("BLOG_FEED_PATH");
  const sitemapPath = constant("BLOG_SITEMAP_PATH");
  // `blogPostPath` is a template, not a constant: resolve its one
  // interpolation with a sample slug so a real post URL gets checked.
  const postTemplate = sharedBlog.match(
    /export function blogPostPath\(slug: string\): string \{\s*return `([^`]+)`/,
  );
  expect(
    postTemplate,
    "couldn't find blogPostPath's returned template in " +
      "packages/shared/src/marketingBlog.ts — update this regex",
  ).not.toBeNull();
  const postPath = postTemplate![1].replace(
    /\$\{slug\}/g,
    "why-we-sing-what-we-sing",
  );

  it.each([
    indexPath,
    // The trailing-slash spelling of the index, which Astro's
    // `trailingSlash: "ignore"` made a live URL for as long as the blog was
    // static, so links to it are in circulation.
    `${indexPath}/`,
    postPath,
    feedPath,
    sitemapPath,
  ])("%s reaches Convex", (path) => {
    expect(
      route(new URL(`https://publicworship.life${path}`)),
      `packages/shared/src/marketingBlog.ts publishes "${path}" but the router ` +
        "doesn't proxy it to Convex — update infra/router/src/route.ts's " +
        "CONVEX_PREFIXES (or the /blog exact-path case).",
    ).toEqual({ kind: "proxy", target: `${CONVEX_ORIGIN}${path}` });
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
