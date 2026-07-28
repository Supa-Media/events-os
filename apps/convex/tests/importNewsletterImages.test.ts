import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  NEWSLETTER_ASSETS,
  NEWSLETTER_TEMPLATE_SLOTS,
  validateEmailDocument,
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
    const rows = await run(t, (ctx) => ctx.db.query("campaignTemplates").collect());
    return rows.find((r) => r.isBuiltIn === true);
  }

  /** Every mapped slot's current URL, keyed by the asset it expects. */
  function slotUrls(doc: { blocks: Record<string, unknown>[] }) {
    return new Map(
      NEWSLETTER_TEMPLATE_SLOTS.map((slot) => {
        const block = doc.blocks.find((b) => b.id === slot.blockId);
        return [
          slot.sourceKey,
          block?.kind === "bleed_image"
            ? block.url
            : block?.kind === "card"
              ? block.imageUrl
              : block?.kind === "footer"
                ? block.logoUrl
                : undefined,
        ] as const;
      }),
    );
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
    expect([...slotUrls(before!.doc).values()].every((u) => u === undefined)).toBe(true);

    const result = await t.action(IMPORT.importNewsletterImages, {
      scope: "central",
      dryRun: false,
    });

    expect(result.reseededTemplates).toHaveLength(BUILT_IN_CAMPAIGN_TEMPLATES.length);
    expect(result.reseededTemplates[0]).toBe(before!._id);

    const after = await run(t, (ctx) => ctx.db.get(before!._id));
    for (const [sourceKey, url] of slotUrls(after!.doc)) {
      expect(url, sourceKey).toBeTypeOf("string");
      expect(String(url).length, sourceKey).toBeGreaterThan(0);
    }
    expect(validateEmailDocument(after!.doc).ok).toBe(true);
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
    expect([...slotUrls(template!.doc).values()].every((u) => typeof u === "string")).toBe(
      true,
    );
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
    // Empty, not blanked-with-empty-strings, and still a valid document.
    expect([...slotUrls(template!.doc).values()].every((u) => u === undefined)).toBe(true);
    expect(validateEmailDocument(template!.doc).ok).toBe(true);
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
