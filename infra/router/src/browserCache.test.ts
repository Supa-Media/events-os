import { describe, expect, it } from "vitest";
import { withBrowserCache } from "./index";

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
