import { describe, expect, it } from "vitest";
import {
  bundleFileOrMissing,
  withBrowserCache,
  withShellRevalidation,
} from "./index";

const res = (status: number, type: string) =>
  new Response(status === 200 ? "x" : null, {
    status,
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" },
  });

describe("withBrowserCache", () => {
  it("marks a hashed script as immutable for a year", () => {
    const out = withBrowserCache(res(200, "application/javascript"));
    expect(out.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(out.headers.get("Content-Type")).toBe("application/javascript");
  });

  it("leaves EAS's SPA fallback (index.html under a missing file's name) alone", () => {
    const out = withBrowserCache(res(200, "text/html; charset=utf-8"));
    expect(out.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("leaves an error response alone", () => {
    const out = withBrowserCache(res(404, "application/javascript"));
    expect(out.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });
});

describe("bundleFileOrMissing", () => {
  it("passes a real script through as immutable", () => {
    const out = bundleFileOrMissing(res(200, "application/javascript"));
    expect(out.status).toBe(200);
    expect(out.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  // A page from an older build asks for chunks the current deploy no longer
  // has. EAS's index.html under a script's name "loads" as a script and the
  // app later dies on "Requiring unknown module"; a 404 makes it fail loudly.
  it("turns EAS's SPA fallback for a missing chunk into an uncached 404", () => {
    const out = bundleFileOrMissing(res(200, "text/html; charset=utf-8"));
    expect(out.status).toBe(404);
    expect(out.headers.get("Cache-Control")).toBe("no-store");
  });

  it("turns an origin error into an uncached 404", () => {
    const out = bundleFileOrMissing(res(500, "application/javascript"));
    expect(out.status).toBe(404);
    expect(out.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("bundleFileOrMissing for Expo bundle files", () => {
  // Expo can ship different content under the same bundle name, so a
  // browser must check back rather than keep a copy for a year.
  it("makes a real bundle file revalidate on every load", () => {
    const out = bundleFileOrMissing(res(200, "application/javascript"), "revalidate");
    expect(out.status).toBe(200);
    expect(out.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("passes a 304 (browser revalidation) straight through", () => {
    const out = bundleFileOrMissing(new Response(null, { status: 304 }), "revalidate");
    expect(out.status).toBe(304);
  });

  it("still turns the SPA fallback into an uncached 404", () => {
    const out = bundleFileOrMissing(res(200, "text/html"), "revalidate");
    expect(out.status).toBe(404);
    expect(out.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("withShellRevalidation", () => {
  it("makes the app's HTML shell revalidate on every visit", () => {
    const out = withShellRevalidation(res(200, "text/html"));
    expect(out.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("leaves anything that isn't HTML alone", () => {
    const out = withShellRevalidation(res(200, "application/json"));
    expect(out.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });
});
