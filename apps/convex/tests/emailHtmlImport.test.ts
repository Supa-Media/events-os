import { afterEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * `emailHtmlImport.importPastedHtml` — the "use node" action that fetches +
 * re-hosts every external image in a pasted HTML paste (mocked `fetch`
 * below, real `ctx.storage`) and sanitizes the result. See
 * `emailHtmlSanitize.test.ts` for the pure sanitizer's own adversarial
 * coverage — this file is about the ACTION's own concerns: auth-gating,
 * the fetch → storage → rewrite pipeline, and graceful per-image failure.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeImageResponse(bytes = 2048, contentType = "image/png") {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

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
});

describe("importPastedHtml — graceful failure handling", () => {
  test("a 404 on one image is skipped and reported, without failing the whole import", async () => {
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
    expect(result.failures[0]).toMatchObject({ url: "https://dead-cdn.example.com/gone.png" });
    expect(result.failures[0].reason).toMatch(/404/);
    // The rest of the document is intact.
    expect(result.html).toContain("Hello");
  });

  test("a non-image content-type is skipped and reported", async () => {
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
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toMatch(/not an image/);
  });

  test("an image over the size cap is skipped and reported", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => fakeImageResponse(9 * 1024 * 1024)) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/huge.png">',
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toMatch(/exceeds/);
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
    // The dead one is left as its original URL (nothing to rewrite it to) —
    // reported as a failure rather than silently dropped from the markup.
    expect(result.html).toContain("cdn.example.com/dead.png");
  });

  test("a network error (thrown fetch) is caught and reported, not thrown to the caller", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const result = await s.as.action(api.emailHtmlImport.importPastedHtml, {
      html: '<img src="https://cdn.example.com/flaky.png">',
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toMatch(/ECONNRESET/);
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
