import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  NEWSLETTER_ASSETS,
  TIPTAP_NEWSLETTER_ARTWORK_SLOTS,
  validateTiptapEmailDoc,
  type NewsletterTiptapDoc,
  type NewsletterTiptapNode,
} from "@events-os/shared";

/**
 * `migrations/0052_import_newsletter_images.ts` — the one-time import of the
 * newsletter artwork into the campaign image library.
 *
 * The cases that matter are the unhappy ones: the source is a per-send CDN
 * that is expected to rot, so "some or all downloads fail" is the LIKELY
 * outcome and must be reported per-asset rather than swallowed into a count.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";
const IMPORT = internal.migrations["0052_import_newsletter_images"];

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A believable image payload — comfortably over the min-plausible floor. */
function fakeImage(bytes = 4096): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

/** Serve every asset successfully. */
function stubAllOk(bytes = 4096) {
  globalThis.fetch = (async () => fakeImage(bytes)) as typeof fetch;
}

async function libraryRows(t: ReturnType<typeof newT>) {
  return run(t, (ctx) => ctx.db.query("emailImages").collect());
}

describe("importNewsletterImages — dry run", () => {
  test("defaults to a dry run and writes nothing", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    const result = await t.action(IMPORT.importNewsletterImages, { scope: "central" });

    expect(result.dryRun).toBe(true);
    expect(result.imported).toBe(0);
    expect(result.results).toHaveLength(NEWSLETTER_ASSETS.length);
    expect(result.results.every((r: { outcome: string }) => r.outcome === "would_import")).toBe(true);
    expect(await libraryRows(t)).toHaveLength(0);
  });
});

describe("importNewsletterImages — committing", () => {
  test("imports every asset with its sourceKey, label, and EMPTY alt", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(result.imported).toBe(NEWSLETTER_ASSETS.length);
    expect(result.failed).toBe(0);

    const rows = await libraryRows(t);
    expect(rows).toHaveLength(NEWSLETTER_ASSETS.length);
    expect(new Set(rows.map((r) => r.sourceKey))).toEqual(
      new Set(NEWSLETTER_ASSETS.map((a) => a.sourceKey)),
    );
    // Alt is empty ON PURPOSE — the artwork carries untranscribed text, and
    // the result must say so rather than looking finished.
    expect(rows.every((r) => r.alt === "")).toBe(true);
    expect(new Set(result.needsAltText)).toEqual(
      new Set(NEWSLETTER_ASSETS.map((a) => a.sourceKey)),
    );
  });

  test("re-running is idempotent — nothing duplicates", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    await t.action(IMPORT.importNewsletterImages, { scope: "central", dryRun: false });
    const second = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(second.imported).toBe(0);
    expect(second.alreadyOnFile).toBe(NEWSLETTER_ASSETS.length);
    expect(await libraryRows(t)).toHaveLength(NEWSLETTER_ASSETS.length);
  });

  test("imported images are visible in the library the composer reads", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    stubAllOk();

    await t.action(IMPORT.importNewsletterImages, { scope: "central", dryRun: false });

    const listed = await s.as.query(api.emailImages.listImages, { scope: "central" });
    expect(listed).toHaveLength(NEWSLETTER_ASSETS.length);
    expect(listed.some((r) => r.label === "Masthead (top strip)")).toBe(true);
  });
});

describe("importNewsletterImages — a rotting CDN", () => {
  test("a 404 is reported per-asset, never silently skipped", async () => {
    const t = newT();
    await asSuperuser(t);
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch;

    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(NEWSLETTER_ASSETS.length);
    expect(result.results[0].error).toMatch(/404/);
    expect(await libraryRows(t)).toHaveLength(0);
  });

  test("a 200 that is really an error page is rejected on size", async () => {
    const t = newT();
    await asSuperuser(t);
    // 200 OK, but 40 bytes — the classic "CDN served an error page" shape.
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(40), { status: 200 })) as typeof fetch;

    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(result.failed).toBe(NEWSLETTER_ASSETS.length);
    expect(result.results[0].error).toMatch(/error page/i);
    expect(await libraryRows(t)).toHaveLength(0);
  });

  test("a partial failure imports the good ones and re-running picks up the rest", async () => {
    const t = newT();
    await asSuperuser(t);

    const failing = NEWSLETTER_ASSETS[3].sourceUrl;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      return url === failing
        ? new Response("gone", { status: 410, statusText: "Gone" })
        : fakeImage();
    }) as typeof fetch;

    const first = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });
    expect(first.imported).toBe(NEWSLETTER_ASSETS.length - 1);
    expect(first.failed).toBe(1);

    // The CDN recovers (or a human re-uploads); only the straggler is fetched.
    stubAllOk();
    const second = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });
    expect(second.imported).toBe(1);
    expect(second.alreadyOnFile).toBe(NEWSLETTER_ASSETS.length - 1);
    expect(await libraryRows(t)).toHaveLength(NEWSLETTER_ASSETS.length);
  });

  test("a network throw is caught and reported, not propagated", async () => {
    const t = newT();
    await asSuperuser(t);
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;

    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });
    expect(result.failed).toBe(NEWSLETTER_ASSETS.length);
    expect(result.results[0].error).toMatch(/ENOTFOUND/);
  });
});

/**
 * Importing the images is only half the job. The built-in newsletter template
 * ships with every artwork slot EMPTY and only picks the images up when it is
 * next seeded — and nothing re-seeds it on a schedule (0049 is ledgered and
 * never fires twice; `ensureBuiltInTemplates` had no production caller). So a
 * "successful" import used to leave the template exactly as blank as before,
 * until somebody happened to create a campaign. The action closes that loop
 * itself now.
 */
describe("importNewsletterImages — it fills the built-in template", () => {
  async function builtInTemplate(t: ReturnType<typeof newT>) {
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("campaigns")
        .withIndex("by_kind", (q) => q.eq("kind", "template"))
        .collect(),
    );
    return rows.find((r) => r.isBuiltIn === true);
  }

  /** Every mapped slot's current URL, keyed by the asset it expects — the
   *  tiptap twin of the blocks-format helper this replaced (see
   *  `tests/campaignTemplates.test.ts`'s identical `slotUrls`). An unfilled
   *  slot's node ships `src: ""` (never absent), unlike the blocks format's
   *  `undefined` for the same case. */
  function slotUrls(doc: NewsletterTiptapDoc) {
    const sourceKeyByPwSlot = new Map(
      TIPTAP_NEWSLETTER_ARTWORK_SLOTS.map((slot) => [slot.pwSlot, slot.sourceKey]),
    );
    const urls = new Map<string, unknown>();
    for (const slot of TIPTAP_NEWSLETTER_ARTWORK_SLOTS) urls.set(slot.sourceKey, "");
    function walk(node: NewsletterTiptapNode): void {
      const pwSlot = typeof node.attrs?.pwSlot === "string" ? node.attrs.pwSlot : undefined;
      const sourceKey = pwSlot ? sourceKeyByPwSlot.get(pwSlot) : undefined;
      if (sourceKey) urls.set(sourceKey, node.attrs?.src);
      for (const child of node.content ?? []) walk(child);
    }
    for (const node of doc.content) walk(node);
    return urls;
  }

  test("a committing run re-seeds the template and every slot ends up filled", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    stubAllOk();

    // The real sequence: the template is already seeded (and empty) when the
    // artwork arrives. This ordering is what the wiring has to survive.
    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    const before = await builtInTemplate(t);
    expect([...slotUrls(before!.doc as NewsletterTiptapDoc).values()].every((u) => u === "")).toBe(
      true,
    );

    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(result.reseededTemplates).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
    expect(result.reseededTemplates[0]).toBe(before!._id);

    const after = await run(t, (ctx) => ctx.db.get(before!._id));
    for (const [sourceKey, url] of slotUrls(after!.doc as NewsletterTiptapDoc)) {
      expect(url, sourceKey).toBeTypeOf("string");
      expect(String(url).length, sourceKey).toBeGreaterThan(0);
    }
    expect(validateTiptapEmailDoc(after!.doc).ok).toBe(true);
    expect(after!.docFormat).toBe("tiptap");
  });

  test("it seeds the template even when one never existed", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    expect(await builtInTemplate(t)).toBeUndefined();
    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(result.reseededTemplates).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
    const template = await builtInTemplate(t);
    expect(
      [...slotUrls(template!.doc as NewsletterTiptapDoc).values()].every(
        (u) => typeof u === "string" && u.length > 0,
      ),
    ).toBe(true);
  });

  test("a DRY RUN re-seeds nothing — it writes nothing at all", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    const result = await t.action(IMPORT.importNewsletterImages, { scope: "central" });

    expect(result.dryRun).toBe(true);
    expect(result.reseededTemplates).toEqual([]);
    expect(await builtInTemplate(t)).toBeUndefined();
  });

  test("a run where every download failed still leaves the template unbroken", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    globalThis.fetch = (async () =>
      new Response("gone", { status: 410, statusText: "Gone" })) as typeof fetch;

    await t.mutation(internal.campaignTemplates.ensureBuiltInTemplates, {
      scope: "central",
      createdBy: s.userId,
    });
    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });
    expect(result.failed).toBe(NEWSLETTER_ASSETS.length);

    const template = await builtInTemplate(t);
    // Empty, not undefined and not blanked with some other sentinel, and
    // still a valid document.
    expect(
      [...slotUrls(template!.doc as NewsletterTiptapDoc).values()].every((u) => u === ""),
    ).toBe(true);
    expect(validateTiptapEmailDoc(template!.doc).ok).toBe(true);
  });
});

describe("importNewsletterImages — attribution", () => {
  test("refuses to run on a deployment with no users", async () => {
    const t = newT();
    stubAllOk();
    await expect(
      t.action(IMPORT.importNewsletterImages, { scope: "central", dryRun: false }),
    ).rejects.toThrow(/No users exist/);
  });
});

/**
 * `ensureNewsletterImagesImported` — the CRON entry point, and the only thing
 * that gets this artwork into production.
 *
 * The action above defaults to a dry run and was invoked by nobody but a human
 * typing `npx convex run --prod`, so on merge the newsletter shipped with
 * eleven blank slots and the eleven library rows never existed. These tests
 * pin the four properties that replacement has to have: it commits, it retries
 * a dying CDN, it stops doing work once finished, and it is never silent.
 */
describe("ensureNewsletterImagesImported — the cron", () => {
  /** Count every outbound request, so "did this run touch the CDN at all?"
   *  is an assertion rather than an inference. */
  function countingFetch(inner: typeof globalThis.fetch) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(typeof input === "string" ? input : String(input));
      return inner(input, init);
    }) as typeof fetch;
    return calls;
  }

  async function builtInTemplate(t: ReturnType<typeof newT>) {
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("campaigns")
        .withIndex("by_kind", (q) => q.eq("kind", "template"))
        .collect(),
    );
    return rows.find((r) => r.isBuiltIn === true);
  }

  test("commits without being asked — no dry run, no human", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    const res = await t.action(IMPORT.ensureNewsletterImagesImported, {});

    expect(res.status).toBe("completed");
    expect(res.imported).toBe(NEWSLETTER_ASSETS.length);
    expect(res.missing).toEqual([]);
    expect(await libraryRows(t)).toHaveLength(NEWSLETTER_ASSETS.length);
  });

  test("the built-in template ends up carrying the artwork", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();

    await t.action(IMPORT.ensureNewsletterImagesImported, {});

    const template = await builtInTemplate(t);
    expect(template).toBeDefined();
    const sourceKeyByPwSlot = new Map(
      TIPTAP_NEWSLETTER_ARTWORK_SLOTS.map((slot) => [slot.pwSlot, slot.sourceKey]),
    );
    const found = new Set<string>();
    function walk(node: NewsletterTiptapNode): void {
      const pwSlot = typeof node.attrs?.pwSlot === "string" ? node.attrs.pwSlot : undefined;
      const sourceKey = pwSlot ? sourceKeyByPwSlot.get(pwSlot) : undefined;
      if (sourceKey) {
        expect(node.attrs?.src, sourceKey).toBeTypeOf("string");
        expect(String(node.attrs?.src).length, sourceKey).toBeGreaterThan(0);
        found.add(sourceKey);
      }
      for (const child of node.content ?? []) walk(child);
    }
    for (const node of (template!.doc as NewsletterTiptapDoc).content) walk(node);
    expect(found.size).toBe(TIPTAP_NEWSLETTER_ARTWORK_SLOTS.length);
    expect(validateTiptapEmailDoc(template!.doc).ok).toBe(true);
    expect(template!.docFormat).toBe("tiptap");
  });

  test("self-disables once complete: a second run fetches NOTHING and writes nothing", async () => {
    const t = newT();
    await asSuperuser(t);
    stubAllOk();
    await t.action(IMPORT.ensureNewsletterImagesImported, {});

    const calls = countingFetch(async () => fakeImage());
    const second = await t.action(IMPORT.ensureNewsletterImagesImported, {});

    expect(second.status).toBe("already_complete");
    expect(second.imported).toBe(0);
    expect(calls).toEqual([]);
    expect(await libraryRows(t)).toHaveLength(NEWSLETTER_ASSETS.length);
  });

  test("a dead CDN reports 'incomplete' — it does not throw, and it does not go quiet", async () => {
    const t = newT();
    await asSuperuser(t);
    globalThis.fetch = (async () =>
      new Response("gone", { status: 410, statusText: "Gone" })) as typeof fetch;
    const logged: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);

    try {
      const res = await t.action(IMPORT.ensureNewsletterImagesImported, {});
      expect(res.status).toBe("incomplete");
      expect(res.imported).toBe(0);
      expect(new Set(res.missing)).toEqual(
        new Set(NEWSLETTER_ASSETS.map((a) => a.sourceKey)),
      );
    } finally {
      console.error = realError;
    }

    // Loud, and specific enough to act on — the whole point of not being a
    // silent no-op.
    expect(logged).toHaveLength(1);
    expect(String(logged[0])).toMatch(/newsletter-artwork/);
    expect(String(logged[0])).toMatch(/410/);
    expect(await libraryRows(t)).toHaveLength(0);
  });

  test("resumable: a partial failure retries ONLY the stragglers on the next run", async () => {
    const t = newT();
    await asSuperuser(t);

    const failingUrl = NEWSLETTER_ASSETS[3].sourceUrl;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      return url === failingUrl
        ? new Response("gone", { status: 410, statusText: "Gone" })
        : fakeImage();
    }) as typeof fetch;

    const realError = console.error;
    console.error = () => {};
    let first;
    try {
      first = await t.action(IMPORT.ensureNewsletterImagesImported, {});
    } finally {
      console.error = realError;
    }
    expect(first.status).toBe("incomplete");
    expect(first.imported).toBe(NEWSLETTER_ASSETS.length - 1);
    expect(first.missing).toEqual([NEWSLETTER_ASSETS[3].sourceKey]);

    // The CDN recovers. Only the one missing asset is re-fetched — nothing
    // already on file is downloaded or duplicated.
    const calls = countingFetch(async () => fakeImage());
    const second = await t.action(IMPORT.ensureNewsletterImagesImported, {});

    expect(second.status).toBe("completed");
    expect(second.imported).toBe(1);
    expect(calls).toEqual([failingUrl]);
    expect(await libraryRows(t)).toHaveLength(NEWSLETTER_ASSETS.length);
  });

  test("a deployment with no users defers instead of crashing the cron", async () => {
    const t = newT();
    const calls = countingFetch(async () => fakeImage());
    const realWarn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args);

    try {
      const res = await t.action(IMPORT.ensureNewsletterImagesImported, {});
      expect(res.status).toBe("no_users");
      expect(res.missing).toHaveLength(NEWSLETTER_ASSETS.length);
    } finally {
      console.warn = realWarn;
    }

    expect(warned).toHaveLength(1);
    // The owner lookup happens before any download, so a userless deployment
    // never hammers the CDN.
    expect(calls).toEqual([]);
    expect(await libraryRows(t)).toHaveLength(0);
  });
});
