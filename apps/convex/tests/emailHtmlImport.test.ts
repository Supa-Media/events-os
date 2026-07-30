import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lookup as dnsLookup } from "node:dns/promises";
import { api } from "../_generated/api";
import { newT, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * `emailHtmlImport.importPastedHtml` — the "use node" action that fetches +
 * re-hosts every external image in a pasted HTML paste (mocked `fetch` +
 * mocked DNS below, real `ctx.storage`) and sanitizes the result. See
 * `emailHtmlSanitize.test.ts` for the pure sanitizer's own adversarial
 * coverage — this file is about the ACTION's own concerns: auth-gating, the
 * fetch → storage → rewrite pipeline, graceful per-image failure, and (this
 * pass, 2026-07-30) the SSRF guard + "never ship a live third-party
 * reference for a failed image" behavior.
 *
 * `node:dns/promises#lookup` is mocked (not real network) so every test is
 * deterministic and offline — a real `assertSafeImageUrl` (`ssrfGuard.ts`)
 * does a REAL DNS lookup, which this sandbox has no route for anyway.
 * Defaults to resolving every hostname to a public, non-blocked test-net
 * address (`203.0.113.x`, RFC 5737 TEST-NET-3) unless a test overrides it —
 * see `mockDns`.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

/** Point every hostname NOT explicitly listed in `overrides` at a safe
 *  public test-net address; a hostname in `overrides` resolves to whatever
 *  address that entry says (used by the SSRF tests below to prove a
 *  hostname that RESOLVES into a blocked range is refused, not just an
 *  IP-literal one). */
function mockDns(overrides: Record<string, string> = {}) {
  (dnsLookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (hostname: string) => {
      const address = overrides[hostname] ?? "203.0.113.10";
      return [{ address, family: address.includes(":") ? 6 : 4 }];
    },
  );
}

beforeEach(() => {
  mockDns();
});

/** A real PNG signature followed by filler — the import decides "is this an
 *  image?" from the BYTES now (`lib/imageSniff.ts`), so a response body has to
 *  actually start like an image to be accepted. A zero-filled buffer (what
 *  this helper used to return) is correctly refused. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(Math.max(size, PNG_SIGNATURE.length)));
  bytes.set(PNG_SIGNATURE, 0);
  return bytes;
}

/** `contentType: null` models a CDN that sends NO content-type header at all
 *  — which is exactly what Canva's own `*.canva-cdn.email` does, and what
 *  used to make every real Canva import fail. */
function fakeImageResponse(bytes = 2048, contentType: string | null = "image/png") {
  return new Response(pngBytes(bytes), {
    status: 200,
    headers: contentType === null ? {} : { "content-type": contentType },
  });
}

const INERT_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

describe("importPastedHtml — auth", () => {
  test("throws FORBIDDEN for a caller without compose power", async () => {
    const t = newT();
    // A plain chapter member — not a superuser, no campaigns.compose seat.
    await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(
      t
        .withIdentity({ subject: "someone|session", issuer: "test" })
        .action(api.emailHtmlImport.importPastedHtml, { html: "<p>hi</p>" }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});

describe("importPastedHtml — image re-hosting", () => {
  test("rewrites an external <img src> to an app-hosted URL", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse()) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://canva-cdn.example.com/banner.png" alt="Banner">',
    });

    expect(result.imagesFound).toBe(1);
    expect(result.imagesRehosted).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(result.html).not.toContain("canva-cdn.example.com");
    expect(result.html).toMatch(/src="https?:\/\/[^"]+"/);
  });

  test("rewrites a CSS background-image url() the same way", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse()) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<div style="background-image:url(https://canva-cdn.example.com/bg.jpg)">hi</div>',
    });

    expect(result.imagesRehosted).toBe(1);
    expect(result.html).not.toContain("canva-cdn.example.com");
  });

  test("rehosts multiple distinct images independently", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse()) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html:
        '<img src="https://cdn.example.com/one.png">' +
        '<img src="https://cdn.example.com/two.png">',
    });
    expect(result.imagesFound).toBe(2);
    expect(result.imagesRehosted).toBe(2);
  });

  test("a data: image is left as-is — nothing to re-host, and it survives sanitization", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called for a data: URL");
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
    });
    expect(result.imagesFound).toBe(0);
    expect(result.html).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  // Adversarial-review finding #3 (HIGH): protocol-relative image refs used
  // to be neither re-hosted nor blocked.
  test("re-hosts a protocol-relative <img src> (resolved to https: for the fetch)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      fetchedUrls.push(String(url));
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="//tracker.example.com/pixel.gif">',
    });

    expect(result.imagesFound).toBe(1);
    expect(result.imagesRehosted).toBe(1);
    expect(result.html).not.toContain("tracker.example.com");
    expect(fetchedUrls).toEqual(["https://tracker.example.com/pixel.gif"]);
  });
});

describe("importPastedHtml — graceful failure handling (generic reason to the caller, real reason logged)", () => {
  test("a 404 on one image is skipped and reported (generic reason), without failing the whole import", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<p>Hello</p><img src="https://dead-cdn.example.com/gone.png">',
    });

    expect(result.imagesFound).toBe(1);
    expect(result.imagesRehosted).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({
      url: "https://dead-cdn.example.com/gone.png",
      reason: "Couldn't fetch this image.",
    });
    // The rest of the document is intact.
    expect(result.html).toContain("Hello");
  });

  test("a non-image content-type is skipped and reported generically", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () =>
      new Response("<html>not an image</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/actually-a-page.png">',
    });
    expect(result.failures).toEqual([
      { url: "https://cdn.example.com/actually-a-page.png", reason: "Couldn't fetch this image." },
    ]);
  });

  // ── The founder's "the images aren't loading", 2026-07-30 ────────────────
  // Canva serves an emailed design's assets from `*.canva-cdn.email` behind
  // Cloudflare with NO `content-type` header. The old header-only check made
  // EVERY image in a real Canva export fail.
  test("re-hosts an image served with NO content-type header (the real Canva CDN shape)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse(2048, null)) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://abc.canva-cdn.email/hero.png" width="600" height="62">',
    });

    expect(result.failures).toEqual([]);
    expect(result.imagesRehosted).toBe(1);
    expect(result.html).not.toContain("canva-cdn.email");
    expect(result.html).not.toContain(INERT_PLACEHOLDER);
  });

  test("a content-type-less image is STORED as the type its bytes actually are", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse(2048, null)) as unknown as typeof fetch;

    await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://abc.canva-cdn.email/hero.png">',
    });

    // A blob stored with type `""` (what a header-less response produces if
    // you pass it straight through) is served back as a download, so the
    // image STILL wouldn't render — just from our domain instead of Canva's.
    // Asserted on the stored BLOB's own type: `convex-test`'s in-memory
    // `_storage` metadata only models `size`/`sha256`, but it does hand back
    // the very Blob the action stored, which is what real Convex reads the
    // served `Content-Type` from.
    const storedType = await t.run(async (ctx) => {
      const [metadata] = await ctx.db.system.query("_storage").collect();
      const blob = await ctx.storage.get(metadata._id);
      return blob?.type;
    });
    expect(storedType).toBe("image/png");
  });

  test("bytes that aren't an image are refused even when the header claims image/png", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () =>
      new Response("<html><script>alert(1)</script></html>", {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/lies.png">',
    });

    expect(result.failures).toEqual([
      { url: "https://cdn.example.com/lies.png", reason: "Couldn't fetch this image." },
    ]);
    expect(result.html).toContain(INERT_PLACEHOLDER);
  });

  // ── The founder's "the spacing is off", 2026-07-30 ───────────────────────
  test("a failed image keeps its declared box instead of inflating to a square", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html:
        '<img src="https://dead.example.com/masthead.png" width="600" height="62" ' +
        'style="display:block;width:600px;height:auto;max-width:100%">',
    });

    expect(result.html).toContain(INERT_PLACEHOLDER);
    // Without this, `height:auto` resolves against the 1×1 placeholder's own
    // 1:1 ratio and a 600×62 masthead renders as a 600×600 blank block.
    expect(result.html).toMatch(/aspect-ratio:\s*600\s*\/\s*62/);
  });

  test("an image over the size cap is skipped and reported generically", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse(9 * 1024 * 1024)) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/huge.png">',
    });
    expect(result.failures).toEqual([
      { url: "https://cdn.example.com/huge.png", reason: "Couldn't fetch this image." },
    ]);
  });

  test("one failing image among several still re-hosts the rest — a partial failure never aborts the import", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("dead")) return new Response("nope", { status: 404 });
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html:
        '<img src="https://cdn.example.com/good.png">' +
        '<img src="https://cdn.example.com/dead.png">',
    });
    expect(result.imagesFound).toBe(2);
    expect(result.imagesRehosted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].url).toContain("dead.png");
    // The good one really did get rewritten.
    expect(result.html).not.toContain("cdn.example.com/good.png");
    // [finding #7] The DEAD one is no longer left as its original (live,
    // third-party) URL — it's rewritten to the inert local placeholder, so
    // the sent email makes zero calls to a host this import couldn't
    // verify. Still reported in `failures`, just never shipped as a live ref.
    expect(result.html).not.toContain("cdn.example.com/dead.png");
    expect(result.html).toContain(INERT_PLACEHOLDER);
  });

  test("a network error (thrown fetch) is caught and reported generically, not thrown to the caller", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/flaky.png">',
    });
    expect(result.failures).toEqual([
      { url: "https://cdn.example.com/flaky.png", reason: "Couldn't fetch this image." },
    ]);
  });

  test("[finding #7] a failed image's original URL never survives into the returned html", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://dead.example.com/x.png" alt="x">',
    });
    expect(result.html).not.toContain("dead.example.com");
    expect(result.html).toContain(INERT_PLACEHOLDER);
  });

  test("a redirect response is treated as a failure, not followed", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    let requestedUrls: string[] = [];
    globalThis.fetch = (async (url: unknown, init: any) => {
      requestedUrls.push(String(url));
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } });
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://redirector.example.com/x.png">',
    });
    // Never followed to the redirect target.
    expect(requestedUrls).toEqual(["https://redirector.example.com/x.png"]);
    expect(result.failures).toHaveLength(1);
    expect(result.html).not.toContain("redirector.example.com");
    expect(result.html).not.toContain("elsewhere.example");
  });
});

describe("importPastedHtml — SSRF guard (adversarial-review finding #6)", () => {
  test("blocks an IP-literal loopback URL (127.0.0.1) without calling fetch", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://127.0.0.1/secret.png">',
    });
    expect(fetchCalled).toBe(false);
    expect(result.failures).toEqual([
      { url: "http://127.0.0.1/secret.png", reason: "Couldn't fetch this image." },
    ]);
    expect(result.html).toContain(INERT_PLACEHOLDER);
  });

  test.each([
    ["10.1.2.3", "private 10/8"],
    ["172.16.5.5", "private 172.16/12"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["0.0.0.0", "unspecified"],
  ])("blocks IP-literal %s (%s)", async (ip) => {
    const t = newT();
    const s = await asSuperuser(t);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: `<img src="http://${ip}/x.png">`,
    });
    expect(fetchCalled).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  test("blocks an IPv6 loopback literal (::1)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://[::1]/x.png">',
    });
    expect(fetchCalled).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  test("blocks a HOSTNAME that DNS-resolves to a private IP (the plain literal-IP-only bypass)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    mockDns({ "internal.corp.example": "10.0.0.5" });
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://internal.corp.example/secret.png">',
    });
    expect(fetchCalled).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe("Couldn't fetch this image.");
  });

  test("blocks an IPv4-mapped IPv6 literal (::ffff:127.0.0.1) — a known bare-v4-check bypass", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://[::ffff:127.0.0.1]/x.png">',
    });
    expect(fetchCalled).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  test("allows a hostname that resolves to a public IP", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    mockDns({ "cdn.example.com": "203.0.113.55" });
    globalThis.fetch = (async () => fakeImageResponse()) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://cdn.example.com/ok.png">',
    });
    expect(result.imagesRehosted).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  test("blocks a hostname DNS refuses to resolve at all (fail closed)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    (dnsLookup as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("NXDOMAIN");
    });
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeImageResponse();
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://nowhere.example.invalid/x.png">',
    });
    expect(fetchCalled).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  test("SSRF-blocked and ordinary-404 failures are INDISTINGUISHABLE to the caller (kills the oracle)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const blockedResult = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="http://127.0.0.1/internal-probe">',
    });
    const notFoundResult = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/genuinely-missing.png">',
    });
    expect(blockedResult.failures[0].reason).toBe(notFoundResult.failures[0].reason);
  });
});

describe("importPastedHtml — sanitization happens on the rewritten output", () => {
  test("strips a <script> tag even when a legitimate image sits alongside it", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse()) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/a.png"><script>alert(1)</script>',
    });
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("alert(1)");
    expect(result.imagesRehosted).toBe(1);
  });

  test("an empty paste returns cleanly with no images and no failures", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, { html: "   " });
    expect(result).toEqual({ html: "", imagesFound: 0, imagesRehosted: 0, failures: [] });
  });
});
