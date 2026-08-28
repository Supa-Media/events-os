import { describe, expect, it } from "vitest";
import { CONVEX_ORIGIN, EXPO_ORIGIN, route } from "./route";

function u(url: string): URL {
  return new URL(url);
}

describe("route: apex landing paths -> assets", () => {
  it.each(["/", "/beliefs", "/music-policy", "/collaborate", "/use-our-songs"])(
    "%s serves static assets",
    (path) => {
      expect(route(u(`https://publicworship.life${path}`))).toEqual({
        kind: "assets",
      });
    },
  );

  it("an unrelated path that merely starts with a Convex-ish word does not match", () => {
    // "/backers" must NOT match the exact "/backer" route — it is one page
    // with nothing beneath it, so anything longer belongs to the static site.
    expect(route(u("https://publicworship.life/backers"))).toEqual({
      kind: "assets",
    });
    // "/giveaway" must NOT match the "/give" Convex route.
    expect(route(u("https://publicworship.life/giveaway"))).toEqual({
      kind: "assets",
    });
  });
});

describe("route: /code is the sayable link to the app's coding page", () => {
  it("redirects to the /os-mounted page", () => {
    expect(route(u("https://publicworship.life/code"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/os/code",
    });
  });

  it("carries the query string every coding reminder already sends", () => {
    expect(route(u("https://publicworship.life/code?filter=uncoded"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/os/code?filter=uncoded",
    });
  });

  it("does NOT swallow neighbouring paths — it is one page, not a prefix", () => {
    // A landing page called /codex must keep serving the static site, and
    // nothing hangs beneath /code for a prefix rule to catch.
    expect(route(u("https://publicworship.life/codex"))).toEqual({
      kind: "assets",
    });
    expect(route(u("https://publicworship.life/code/extra"))).toEqual({
      kind: "assets",
    });
  });

  it("the app's own mount point still serves the page directly", () => {
    expect(route(u("https://publicworship.life/os/code"))).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/code`,
    });
  });
});

describe("route: Convex prefixes -> proxy unchanged", () => {
  it.each([
    // /rsvp/ is the canonical public RSVP page; /r/ (short), /event/ and /e/
    // are aliases that all resolve to the same page.
    ["/rsvp/abc123", `${CONVEX_ORIGIN}/rsvp/abc123`],
    ["/rsvp/abc123/cover", `${CONVEX_ORIGIN}/rsvp/abc123/cover`],
    ["/r/abc123", `${CONVEX_ORIGIN}/r/abc123`],
    ["/event/abc123", `${CONVEX_ORIGIN}/event/abc123`],
    ["/event/abc123/cover", `${CONVEX_ORIGIN}/event/abc123/cover`],
    ["/e/abc123", `${CONVEX_ORIGIN}/e/abc123`],
    ["/t/XYZ", `${CONVEX_ORIGIN}/t/XYZ`],
    ["/give", `${CONVEX_ORIGIN}/give`],
    ["/give/some-territory", `${CONVEX_ORIGIN}/give/some-territory`],
    ["/p/token123", `${CONVEX_ORIGIN}/p/token123`],
    ["/reimburse/some-chapter", `${CONVEX_ORIGIN}/reimburse/some-chapter`],
    ["/api/tickets/checkout", `${CONVEX_ORIGIN}/api/tickets/checkout`],
    ["/api/reimburse/submit", `${CONVEX_ORIGIN}/api/reimburse/submit`],
    ["/api/give/pledge", `${CONVEX_ORIGIN}/api/give/pledge`],
    // The backer portal: one exact path (the page) plus its posts under /api/.
    ["/backer", `${CONVEX_ORIGIN}/backer`],
    ["/api/backer/verify", `${CONVEX_ORIGIN}/api/backer/verify`],
    ["/stripe/webhook", `${CONVEX_ORIGIN}/stripe/webhook`],
    ["/increase/webhook", `${CONVEX_ORIGIN}/increase/webhook`],
  ])("%s proxies to %s", (path, expectedTarget) => {
    expect(route(u(`https://publicworship.life${path}`))).toEqual({
      kind: "proxy",
      target: expectedTarget,
    });
  });
});

describe("route: /os -> strip prefix, proxy to the Expo web app", () => {
  it("bare /os proxies to the Expo app root", () => {
    expect(route(u("https://publicworship.life/os"))).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/`,
    });
  });

  it("/os/ (trailing slash) proxies to the Expo app root", () => {
    expect(route(u("https://publicworship.life/os/"))).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/`,
    });
  });

  it("/os/event/abc strips the prefix", () => {
    expect(route(u("https://publicworship.life/os/event/abc"))).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/event/abc`,
    });
  });

  it("/os/_expo/asset.js strips the prefix (Expo's baseUrl=/os assets)", () => {
    expect(route(u("https://publicworship.life/os/_expo/asset.js"))).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/_expo/asset.js`,
      cache: "immutable",
    });
  });

  it("/osprey (looks like /os but isn't) is not stripped, falls through to assets", () => {
    expect(route(u("https://publicworship.life/osprey"))).toEqual({
      kind: "assets",
    });
  });
});

describe("route: edge cache hint for Expo's hashed bundle output", () => {
  it("/os/_expo/static/js/x.js gets cache: immutable", () => {
    expect(
      route(u("https://publicworship.life/os/_expo/static/js/x.js")),
    ).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/_expo/static/js/x.js`,
      cache: "immutable",
    });
  });

  it("/os/event/abc does not get a cache hint", () => {
    expect(route(u("https://publicworship.life/os/event/abc"))).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/event/abc`,
    });
  });
});

describe("route: query-string preservation", () => {
  it("preserves query strings on Convex proxies", () => {
    expect(
      route(u("https://publicworship.life/give/x?pledge=success")),
    ).toEqual({
      kind: "proxy",
      target: `${CONVEX_ORIGIN}/give/x?pledge=success`,
    });
  });

  it("preserves query strings on /os proxies", () => {
    expect(
      route(u("https://publicworship.life/os/event/abc?ref=email")),
    ).toEqual({
      kind: "proxy",
      target: `${EXPO_ORIGIN}/event/abc?ref=email`,
    });
  });

  it("preserves query strings on redirects", () => {
    expect(
      route(u("https://www.publicworship.life/give?foo=bar")),
    ).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/give?foo=bar",
    });
  });
});

describe("route: legacy subdomain redirects", () => {
  it("www root redirects to the apex root", () => {
    expect(route(u("https://www.publicworship.life/"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/",
    });
  });

  it("www with a path preserves it", () => {
    expect(route(u("https://www.publicworship.life/beliefs"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/beliefs",
    });
  });

  it("events root redirects to /os", () => {
    expect(route(u("https://events.publicworship.life/"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/os",
    });
  });

  it("events with a path redirects under /os", () => {
    expect(route(u("https://events.publicworship.life/songs/x"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/os/songs/x",
    });
  });

  it("rsvp root redirects to the apex root", () => {
    expect(route(u("https://rsvp.publicworship.life/"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/",
    });
  });

  it("rsvp with a path preserves it unchanged (no /os prefix)", () => {
    expect(route(u("https://rsvp.publicworship.life/t/XYZ"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/t/XYZ",
    });
  });
});

describe("route: the blog is served by Convex", () => {
  // Posts live in Convex (apps/convex/lib/blogPage.ts) — a path that isn't
  // proxied here doesn't degrade, it 404s at the edge from the static build
  // while Convex is never asked. drift.test.ts pins these against the shared
  // contract's own path constants; these cases pin the shapes around them.
  it.each([
    "/blog",
    "/blog/",
    "/blog/why-we-sing-what-we-sing",
    "/blog/rss.xml",
    "/blog/sitemap.xml",
  ])("%s is proxied to Convex", (path) => {
    expect(route(u(`https://publicworship.life${path}`))).toEqual({
      kind: "proxy",
      target: `${CONVEX_ORIGIN}${path}`,
    });
  });

  it("carries a preview token through to Convex", () => {
    expect(
      route(u("https://publicworship.life/blog/a-draft?preview=abc123")),
    ).toEqual({
      kind: "proxy",
      target: `${CONVEX_ORIGIN}/blog/a-draft?preview=abc123`,
    });
  });

  it("a retired /blog/drafts/* URL is proxied like any other post path (Convex 404s it)", () => {
    // The gated prefix is gone; these URLs must reach the blog's own 404 page
    // rather than a password form or the static build's empty 404.
    expect(route(u("https://publicworship.life/blog/drafts/some-post"))).toEqual({
      kind: "proxy",
      target: `${CONVEX_ORIGIN}/blog/drafts/some-post`,
    });
  });

  it.each(["/blogs/drafts", "/blogging"])(
    "%s is not the blog — still a static asset",
    (path) => {
      expect(route(u(`https://publicworship.life${path}`))).toEqual({
        kind: "assets",
      });
    },
  );

  it("the old /rss.xml redirects to the blog's feed", () => {
    expect(route(u("https://publicworship.life/rss.xml"))).toEqual({
      kind: "redirect",
      location: "https://publicworship.life/blog/rss.xml",
    });
  });
});
