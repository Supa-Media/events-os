import { describe, expect, test } from "vitest";
import type { EmailBlockKind } from "./emailBlocks";
import { validateEmailDocument } from "./emailBlocks";
import { renderCampaignEmail, renderCampaignText } from "./emailRender";
import { PUBLIC_WORSHIP_THEME } from "./emailTheme";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
  fillTemplateArtwork,
  type ResolvedArtwork,
} from "./emailTemplates";
import { NEWSLETTER_ASSETS, NEWSLETTER_TEMPLATE_SLOTS } from "./newsletterAssets";

const baseOpts = {
  recipient: { name: "Alex Rivera", email: "alex@example.com" },
  unsubscribeUrl: "https://example.com/unsub/abc123",
};

const template = PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE;

describe("PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE — shape", () => {
  test("carries a name and a description a picker can show", () => {
    expect(template.name.length).toBeGreaterThan(0);
    expect(template.description.length).toBeGreaterThan(0);
  });

  test("its document passes the write gate — a template must be savable as-is", () => {
    const result = validateEmailDocument(template.doc);
    expect(result.ok).toBe(true);
    if (!result.ok) expect(result.error).toBe("");
  });

  test("every block id is unique", () => {
    const ids = template.doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("block ids are deterministic, not random (the seed re-runs on every deploy)", () => {
    for (const block of template.doc.blocks) {
      expect(block.id).toMatch(/^blk_nl-/);
    }
  });

  test("it is listed in BUILT_IN_CAMPAIGN_TEMPLATES", () => {
    expect(BUILT_IN_CAMPAIGN_TEMPLATES).toContain(template);
  });

  test("every built-in template's document is valid", () => {
    for (const t of BUILT_IN_CAMPAIGN_TEMPLATES) {
      const result = validateEmailDocument(t.doc);
      expect(result.ok, `${t.name}: ${result.ok ? "" : result.error}`).toBe(true);
    }
  });
});

describe("PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE — theme", () => {
  test("it carries a theme rather than relying on the renderer's default", () => {
    expect(template.doc.theme).toBeDefined();
  });

  test("the theme is Public Worship's real brand", () => {
    expect(template.doc.theme?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);
    expect(template.doc.theme?.canvas).toBe(PUBLIC_WORSHIP_THEME.canvas);
    expect(template.doc.theme?.name).toBe(PUBLIC_WORSHIP_THEME.name);
    expect(template.doc.theme?.accent).toBe("#891d1a");
  });
});

describe("PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE — layout vocabulary", () => {
  const kinds = new Set<EmailBlockKind>(template.doc.blocks.map((b) => b.kind));
  const cardVariants = new Set(
    template.doc.blocks.flatMap((b) => (b.kind === "card" ? [b.variant ?? "plain"] : [])),
  );

  // The point of the template is that it carries the newsletter's STRUCTURE.
  // Six headings in a row would validate fine and teach nobody anything.
  //
  // `eyebrow`/`columns`/`quote` were the generic stand-ins the first rebuild
  // reached for. The real newsletter says those things differently: the
  // section headings are full-bleed ARTWORK, the side-by-side rows are
  // asymmetric cards rather than an even column grid, and the community voice
  // is a dark testimonial card rather than a rule-and-quote.
  for (const kind of ["bleed_image", "card", "hairline", "footer"] as const) {
    test(`uses the "${kind}" block — the template exercises the real layout, not just headings`, () => {
      expect(kinds.has(kind)).toBe(true);
    });
  }

  for (const variant of ["hero", "feature", "outlined", "testimonial"] as const) {
    test(`uses a "${variant}" card — the four fills are what distinguish the sections`, () => {
      expect(cardVariants.has(variant)).toBe(true);
    });
  }

  test("it is a composed document, not a stack of one kind", () => {
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(cardVariants.size).toBeGreaterThanOrEqual(4);
    expect(template.doc.blocks.length).toBeGreaterThanOrEqual(10);
    // No single kind may account for the whole document.
    for (const kind of kinds) {
      const share = template.doc.blocks.filter((b) => b.kind === kind).length;
      expect(share, kind).toBeLessThan(template.doc.blocks.length);
    }
  });

  test("the masthead is full-bleed artwork, not a text heading", () => {
    const first = template.doc.blocks[0];
    expect(first?.kind).toBe("bleed_image");
    if (first?.kind !== "bleed_image") return;
    // Edge to edge: the masthead is not inset by the container's 24px.
    expect(first.inset).toBeFalsy();
  });

  test("the side-by-side rows are asymmetric, not an even split", () => {
    // The source newsletter's rows are 44/56 and 40/60. Forcing 50/50 is one
    // of the specific things that made the first rebuild read as generic.
    const sideways = template.doc.blocks.filter(
      (b) => b.kind === "card" && (b.imageSide === "left" || b.imageSide === "right"),
    );
    expect(sideways.length).toBeGreaterThan(0);
    for (const block of sideways) {
      if (block.kind !== "card") continue;
      expect(block.imageWidthPct).toBeDefined();
      expect(block.imageWidthPct).not.toBe(50);
    }
  });

  test("the sign-off is a real footer block carrying the org's links", () => {
    const footer = template.doc.blocks.find((b) => b.kind === "footer");
    expect(footer).toBeDefined();
    if (footer?.kind !== "footer") return;
    expect(footer.links?.length).toBeGreaterThan(0);
  });

  test("no block references an image URL this deployment doesn't own", () => {
    // Deliberate: a hardcoded absolute image URL would open every new campaign
    // with broken-image icons. The composer's picker attaches the real art.
    //
    // The template now DECLARES its artwork slots (`bleed_image`, cards with
    // an `imageSide`) so the layout is right from the first open — but every
    // one of those slots is empty, and an empty slot makes no request at all.
    for (const block of template.doc.blocks) {
      if (block.kind === "image") expect.unreachable("template must not seed an image block");
      if (block.kind === "card") expect(block.imageUrl).toBeUndefined();
      if (block.kind === "bleed_image") expect(block.url).toBeUndefined();
      if (block.kind === "footer") expect(block.logoUrl).toBeUndefined();
      if (block.kind === "columns") {
        for (const col of block.columns) expect(col.imageUrl).toBeUndefined();
      }
    }
  });

  test("no absolute image URL survives anywhere in the serialized document", () => {
    // The invariant above, restated so a NEW image-bearing field can't slip
    // past it: nothing in the document may point at an image file.
    const json = JSON.stringify(template.doc);
    expect(json).not.toMatch(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)/i);
  });
});

describe("PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE — rendering", () => {
  test("renders to non-empty HTML without throwing", () => {
    const html = renderCampaignEmail(template.doc, baseOpts);
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
  });

  test("the rendered HTML carries the maroon accent", () => {
    const html = renderCampaignEmail(template.doc, baseOpts);
    expect(html).toContain("#891d1a");
    expect(html).not.toMatch(/#d23b3a/i);
  });

  test("nothing renders as 'undefined' or a leaked merge tag", () => {
    const html = renderCampaignEmail(template.doc, baseOpts);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("{{");
  });

  test("it renders without requesting a single remote image", () => {
    // The end-to-end form of the "no URL we don't own" rule: the template
    // renders its artwork slots as placeholder bands, so a brand-new campaign
    // opens as a complete layout with zero broken-image icons in it.
    const html = renderCampaignEmail(template.doc, baseOpts);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
  });

  test("the empty artwork slots name themselves so the author knows what to attach", () => {
    const html = renderCampaignEmail(template.doc, baseOpts);
    expect(html).toContain("Add artwork from the image library");
  });

  test("the recipient's name reaches the hero heading", () => {
    const html = renderCampaignEmail(template.doc, baseOpts);
    expect(html).toContain("Alex");
  });

  test("it renders to non-empty plaintext with a working unsubscribe line", () => {
    const text = renderCampaignText(template.doc, baseOpts);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(baseOpts.unsubscribeUrl);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("{{");
  });
});

// ── The asset → block map ───────────────────────────────────────────────────

/**
 * `NEWSLETTER_TEMPLATE_SLOTS` is a hardcoded join between two files that can
 * each move independently: the asset manifest and the template's block ids.
 * Nothing at runtime would notice a broken pair — a slot pointing at a block
 * that no longer exists just silently stays empty, which is exactly the class
 * of failure this whole change exists to fix. These are the drift guards.
 */
describe("NEWSLETTER_TEMPLATE_SLOTS — drift guard", () => {
  const blockIds = new Set(template.doc.blocks.map((b) => b.id));
  const assetKeys = new Set(NEWSLETTER_ASSETS.map((a) => a.sourceKey));

  test("every sourceKey is a real asset in NEWSLETTER_ASSETS", () => {
    for (const slot of NEWSLETTER_TEMPLATE_SLOTS) {
      expect(assetKeys.has(slot.sourceKey), slot.sourceKey).toBe(true);
    }
  });

  test("every blockId is a real block in the newsletter template", () => {
    for (const slot of NEWSLETTER_TEMPLATE_SLOTS) {
      expect(blockIds.has(slot.blockId), slot.blockId).toBe(true);
    }
  });

  test("every imported asset has a home — the counts match", () => {
    // If an asset were imported with nowhere to go, the library would grow a
    // row nothing ever places.
    expect(NEWSLETTER_TEMPLATE_SLOTS).toHaveLength(NEWSLETTER_ASSETS.length);
    expect(new Set(NEWSLETTER_TEMPLATE_SLOTS.map((s) => s.sourceKey))).toEqual(assetKeys);
  });

  test("no sourceKey and no blockId is used twice", () => {
    const keys = NEWSLETTER_TEMPLATE_SLOTS.map((s) => s.sourceKey);
    const ids = NEWSLETTER_TEMPLATE_SLOTS.map((s) => s.blockId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every mapped block is one that can actually hold an image", () => {
    const holders = new Set<EmailBlockKind>(["bleed_image", "card", "footer"]);
    for (const slot of NEWSLETTER_TEMPLATE_SLOTS) {
      const block = template.doc.blocks.find((b) => b.id === slot.blockId);
      expect(block, slot.blockId).toBeDefined();
      expect(holders.has(block!.kind), `${slot.blockId} is a ${block?.kind}`).toBe(true);
    }
  });
});

// ── fillTemplateArtwork ─────────────────────────────────────────────────────

/** A resolved library map covering every asset, with distinguishable URLs. */
function fullLibrary(): Map<string, ResolvedArtwork> {
  return new Map(
    NEWSLETTER_ASSETS.map((a) => [
      a.sourceKey,
      { url: `https://files.example.com/${a.sourceKey}.png`, alt: `alt for ${a.sourceKey}` },
    ]),
  );
}

function blockById(doc: typeof template.doc, id: string) {
  return doc.blocks.find((b) => b.id === id);
}

describe("fillTemplateArtwork", () => {
  test("fills a bleed_image slot's url", () => {
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    const masthead = blockById(filled, "blk_nl-masthead");
    expect(masthead?.kind).toBe("bleed_image");
    if (masthead?.kind !== "bleed_image") return;
    expect(masthead.url).toBe("https://files.example.com/masthead.png");
  });

  test("fills a card slot's imageUrl AND imageAlt — the validator requires both", () => {
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    const hero = blockById(filled, "blk_nl-hero");
    expect(hero?.kind).toBe("card");
    if (hero?.kind !== "card") return;
    expect(hero.imageUrl).toBe("https://files.example.com/hero-photo.png");
    expect(hero.imageAlt).toBe("alt for hero-photo");
    // Everything else about the card is untouched.
    expect(hero.variant).toBe("hero");
    expect(hero.ctaLabel).toBe("Read more");
  });

  test("fills the footer's logoUrl AND logoAlt", () => {
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    const footer = blockById(filled, "blk_nl-footer");
    expect(footer?.kind).toBe("footer");
    if (footer?.kind !== "footer") return;
    expect(footer.logoUrl).toBe("https://files.example.com/footer-logo.png");
    expect(footer.logoAlt).toBe("alt for footer-logo");
    expect(footer.links?.length).toBeGreaterThan(0);
  });

  test("the name mismatch is really wired: banner-testimonial fills blk_nl-banner-voice", () => {
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    const voice = blockById(filled, "blk_nl-banner-voice");
    if (voice?.kind !== "bleed_image") return expect.unreachable("expected a bleed_image");
    expect(voice.url).toBe("https://files.example.com/banner-testimonial.png");
  });

  test("every mapped slot ends up filled when the whole library is present", () => {
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    for (const slot of NEWSLETTER_TEMPLATE_SLOTS) {
      const block = blockById(filled, slot.blockId);
      const url =
        block?.kind === "bleed_image"
          ? block.url
          : block?.kind === "card"
            ? block.imageUrl
            : block?.kind === "footer"
              ? block.logoUrl
              : undefined;
      expect(url, slot.blockId).toBe(`https://files.example.com/${slot.sourceKey}.png`);
    }
  });

  test("a PARTIAL library fills only what it has and leaves the rest EMPTY", () => {
    // The likely real outcome: the source CDN is dying, so some assets import
    // and some don't. A missing key must be SKIPPED, never blanked — a
    // half-filled template is fine, a corrupted one is not.
    const partial = new Map<string, ResolvedArtwork>([
      ["masthead", { url: "https://files.example.com/masthead.png", alt: "The masthead" }],
      ["hero-photo", { url: "https://files.example.com/hero.png", alt: "A hero" }],
    ]);
    const filled = fillTemplateArtwork(template.doc, partial);

    const masthead = blockById(filled, "blk_nl-masthead");
    if (masthead?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(masthead.url).toBe("https://files.example.com/masthead.png");

    // Untouched slots keep the shipped shape exactly: still undefined, NOT "".
    const banner = blockById(filled, "blk_nl-banner-support");
    if (banner?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(banner.url).toBeUndefined();

    const supply = blockById(filled, "blk_nl-supply");
    if (supply?.kind !== "card") return expect.unreachable("card");
    expect(supply.imageUrl).toBeUndefined();
    expect(supply.imageAlt).toBeUndefined();

    const footer = blockById(filled, "blk_nl-footer");
    if (footer?.kind !== "footer") return expect.unreachable("footer");
    expect(footer.logoUrl).toBeUndefined();
    expect(footer.logoAlt).toBeUndefined();
  });

  test("a row with an empty url is treated as absent, not written in", () => {
    const filled = fillTemplateArtwork(
      template.doc,
      new Map([["masthead", { url: "", alt: "nothing" }]]),
    );
    const masthead = blockById(filled, "blk_nl-masthead");
    if (masthead?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(masthead.url).toBeUndefined();
  });

  test("an empty map is a no-op — byte-identical, so the seeder doesn't churn", () => {
    const filled = fillTemplateArtwork(template.doc, new Map());
    expect(JSON.stringify(filled)).toBe(JSON.stringify(template.doc));
  });

  test("a map of keys that mean nothing here is also a no-op", () => {
    const filled = fillTemplateArtwork(
      template.doc,
      new Map([["some-hand-uploaded-photo", { url: "https://x.example/a.png", alt: "a" }]]),
    );
    expect(JSON.stringify(filled)).toBe(JSON.stringify(template.doc));
  });

  test("it does not mutate the input document", () => {
    const before = JSON.stringify(template.doc);
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    expect(JSON.stringify(template.doc)).toBe(before);
    // And the result really is a different document.
    expect(JSON.stringify(filled)).not.toBe(before);
    // Not even the blocks array is shared.
    expect(filled.blocks).not.toBe(template.doc.blocks);
  });

  test("the theme survives", () => {
    const filled = fillTemplateArtwork(template.doc, fullLibrary());
    expect(filled.theme?.accent).toBe(PUBLIC_WORSHIP_THEME.accent);
  });

  test("the filled document still passes the write gate", () => {
    for (const doc of [
      fillTemplateArtwork(template.doc, fullLibrary()),
      fillTemplateArtwork(
        template.doc,
        // Alt text still empty everywhere — the state right after an import.
        new Map(
          NEWSLETTER_ASSETS.map((a) => [
            a.sourceKey,
            { url: `https://files.example.com/${a.sourceKey}.png`, alt: "" },
          ]),
        ),
      ),
    ]) {
      const result = validateEmailDocument(doc);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
  });

  test("a filled document renders its artwork as real images", () => {
    const html = renderCampaignEmail(fillTemplateArtwork(template.doc, fullLibrary()), baseOpts);
    expect(html).toContain("https://files.example.com/masthead.png");
    expect(html).toContain("https://files.example.com/footer-logo.png");
    expect(html).toContain("<img");
    // The "attach artwork" placeholder is gone once every slot is filled.
    expect(html).not.toContain("Add artwork from the image library");
  });
});

/**
 * The alt-text trap.
 *
 * Every row the newsletter import writes carries `alt: ""` on purpose, and the
 * seeder re-runs `fillTemplateArtwork` on every import. So an unconditional
 * `imageAlt: art.alt` doesn't just fail to add alt text — it DELETES any the
 * shipped template authors. That is harmless only for exactly as long as the
 * shipped newsletter happens to author none on its card/footer slots, which is
 * an accident of today's copy, not a property of the function. These tests
 * pin the rule so writing alt text into the template can never silently
 * regress accessibility on the next seed.
 */
describe("fillTemplateArtwork — an empty library alt never erases authored alt", () => {
  /** The shipped newsletter with alt text authored onto its artwork slots —
   *  the state this guard exists to protect. */
  function docWithAuthoredAlt() {
    return {
      ...template.doc,
      blocks: template.doc.blocks.map((block) => {
        if (block.id === "blk_nl-hero" && block.kind === "card") {
          return { ...block, imageAlt: "Volunteers setting up in the park" };
        }
        if (block.id === "blk_nl-footer" && block.kind === "footer") {
          return { ...block, logoAlt: "Public Worship" };
        }
        return block;
      }),
    };
  }

  /** The library exactly as an import leaves it: real URLs, empty alt. */
  function libraryWithNoAlt(): Map<string, ResolvedArtwork> {
    return new Map(
      NEWSLETTER_ASSETS.map((a) => [
        a.sourceKey,
        { url: `https://files.example.com/${a.sourceKey}.png`, alt: "" },
      ]),
    );
  }

  test("a card's authored imageAlt survives an import's empty alt", () => {
    const filled = fillTemplateArtwork(docWithAuthoredAlt(), libraryWithNoAlt());
    const hero = blockById(filled, "blk_nl-hero");
    if (hero?.kind !== "card") return expect.unreachable("card");
    expect(hero.imageUrl).toBe("https://files.example.com/hero-photo.png");
    expect(hero.imageAlt).toBe("Volunteers setting up in the park");
  });

  test("a footer's authored logoAlt survives an import's empty alt", () => {
    const filled = fillTemplateArtwork(docWithAuthoredAlt(), libraryWithNoAlt());
    const footer = blockById(filled, "blk_nl-footer");
    if (footer?.kind !== "footer") return expect.unreachable("footer");
    expect(footer.logoUrl).toBe("https://files.example.com/footer-logo.png");
    expect(footer.logoAlt).toBe("Public Worship");
  });

  test("a NON-empty library alt still wins — a human writing alt in the library reaches the template", () => {
    const library = libraryWithNoAlt();
    library.set("hero-photo", {
      url: "https://files.example.com/hero-photo.png",
      alt: "Transcribed from the library",
    });
    library.set("footer-logo", {
      url: "https://files.example.com/footer-logo.png",
      alt: "Public Worship wordmark",
    });
    const filled = fillTemplateArtwork(docWithAuthoredAlt(), library);

    const hero = blockById(filled, "blk_nl-hero");
    if (hero?.kind !== "card") return expect.unreachable("card");
    expect(hero.imageAlt).toBe("Transcribed from the library");

    const footer = blockById(filled, "blk_nl-footer");
    if (footer?.kind !== "footer") return expect.unreachable("footer");
    expect(footer.logoAlt).toBe("Public Worship wordmark");
  });

  test("a slot with no alt on EITHER side still gets \"\" — the validator requires the field", () => {
    // `imageAlt`/`logoAlt` are mandatory once a url is set ("" is the legal
    // decorative value), so the guard must not leave them undefined.
    const filled = fillTemplateArtwork(template.doc, libraryWithNoAlt());
    const supply = blockById(filled, "blk_nl-supply");
    if (supply?.kind !== "card") return expect.unreachable("card");
    expect(supply.imageAlt).toBe("");

    const footer = blockById(filled, "blk_nl-footer");
    if (footer?.kind !== "footer") return expect.unreachable("footer");
    expect(footer.logoAlt).toBe("");

    expect(validateEmailDocument(filled).ok).toBe(true);
  });

  test("a bleed_image's authored alt survives an import's empty alt", () => {
    // The song artwork is the one bleed block that authors copy. An empty
    // library alt must not touch it.
    const song = blockById(template.doc, "blk_nl-song");
    if (song?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(song.alt).toBe("Song of the month");

    const filled = fillTemplateArtwork(template.doc, libraryWithNoAlt());
    const after = blockById(filled, "blk_nl-song");
    if (after?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(after.alt).toBe("Song of the month");
    expect(after.url).toBe("https://files.example.com/song-artwork.png");
  });
});

/**
 * The BANNERS are the regression this whole guard exists for.
 *
 * `bleed_image` used to be filled with `url` alone — no alt at all. Four of
 * the newsletter's five bleed blocks ship `alt: ""`, and in this design the
 * banner IS the section heading, so a SUCCESSFUL import produced a newsletter
 * whose masthead and every section banner rendered `alt=""`. Gmail and Outlook
 * block remote images by default: the recipient saw four blank bands where the
 * headings should be, and the plaintext part lost its section structure
 * entirely. It also meant alt typed into `emailImages.updateImage` — the one
 * escape hatch — reached cards and the footer but never a banner.
 */
describe("fillTemplateArtwork — a library alt reaches the BLEED banners", () => {
  /** The library once a human has transcribed the words in the artwork. */
  function libraryWithBannerAlt(): Map<string, ResolvedArtwork> {
    const library = new Map<string, ResolvedArtwork>(
      NEWSLETTER_ASSETS.map((a) => [
        a.sourceKey,
        { url: `https://files.example.com/${a.sourceKey}.png`, alt: "" },
      ]),
    );
    library.set("masthead", {
      url: "https://files.example.com/masthead.png",
      alt: "Public Worship",
    });
    library.set("banner-whats-on", {
      url: "https://files.example.com/banner-whats-on.png",
      alt: "What's on",
    });
    return library;
  }

  test("a non-empty library alt lands on the masthead and the banners", () => {
    const filled = fillTemplateArtwork(template.doc, libraryWithBannerAlt());

    const masthead = blockById(filled, "blk_nl-masthead");
    if (masthead?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(masthead.alt).toBe("Public Worship");

    const whatsOn = blockById(filled, "blk_nl-banner-whats-on");
    if (whatsOn?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(whatsOn.alt).toBe("What's on");
  });

  test("the transcribed heading reaches the rendered <img alt>", () => {
    const html = renderCampaignEmail(
      fillTemplateArtwork(template.doc, libraryWithBannerAlt()),
      baseOpts,
    );
    expect(html).toContain('alt="Public Worship"');
    expect(html).toContain("alt=\"What&#39;s on\"");
  });

  test("the transcribed heading reaches the PLAINTEXT part", () => {
    // `renderCampaignText`'s bleed case falls back to null on an empty alt, so
    // a url-only fill left the text/plain alternative with no section
    // structure at all — a spam signal and a dead end for a plaintext reader.
    const text = renderCampaignText(
      fillTemplateArtwork(template.doc, libraryWithBannerAlt()),
      baseOpts,
    );
    expect(text).toContain("What's on");
  });

  test("an empty library alt still leaves every authored bleed alt intact", () => {
    const library = libraryWithBannerAlt();
    const filled = fillTemplateArtwork(template.doc, library);
    // The song's alt is authored in the template and empty in the library.
    const song = blockById(filled, "blk_nl-song");
    if (song?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(song.alt).toBe("Song of the month");
    // A banner nobody transcribed keeps the shipped "" — legal "decorative".
    const support = blockById(filled, "blk_nl-banner-support");
    if (support?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(support.alt).toBe("");
    expect(validateEmailDocument(filled).ok).toBe(true);
  });
});

/**
 * A poisoned library row costs its own slot and nothing else.
 *
 * `fillTemplateArtwork` writes straight into a document that
 * `assertValidTemplateDoc` then validates, so a url the write gate rejects
 * doesn't break one image — it throws out of `seedBuiltInTemplates` on EVERY
 * deploy and out of every `createCampaign`. Urls come from
 * `ctx.storage.getUrl()` today, which is why this is defensive rather than
 * reachable.
 */
describe("fillTemplateArtwork — an implausible url is skipped, never written", () => {
  function libraryWith(url: unknown): Map<string, ResolvedArtwork> {
    return new Map([
      ["masthead", { url, alt: "" } as unknown as ResolvedArtwork],
      [
        "hero-photo",
        { url: "https://files.example.com/hero-photo.png", alt: "" } as ResolvedArtwork,
      ],
    ]);
  }

  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "  ", "not-a-url"]) {
    test(`"${bad}" leaves the slot empty and the document valid`, () => {
      const filled = fillTemplateArtwork(template.doc, libraryWith(bad));
      const masthead = blockById(filled, "blk_nl-masthead");
      if (masthead?.kind !== "bleed_image") return expect.unreachable("bleed_image");
      expect(masthead.url).toBeUndefined();
      // The good row in the same library still lands.
      const hero = blockById(filled, "blk_nl-hero");
      if (hero?.kind !== "card") return expect.unreachable("card");
      expect(hero.imageUrl).toBe("https://files.example.com/hero-photo.png");
      // And the seed's own gate still passes.
      const result = validateEmailDocument(filled);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    });
  }

  for (const bad of [null, undefined, 42]) {
    test(`a ${bad === null ? "null" : typeof bad} url does not throw`, () => {
      const filled = fillTemplateArtwork(template.doc, libraryWith(bad));
      const masthead = blockById(filled, "blk_nl-masthead");
      if (masthead?.kind !== "bleed_image") return expect.unreachable("bleed_image");
      expect(masthead.url).toBeUndefined();
      expect(validateEmailDocument(filled).ok).toBe(true);
    });
  }

  test("a non-string alt does not throw either", () => {
    const filled = fillTemplateArtwork(
      template.doc,
      new Map([
        [
          "masthead",
          { url: "https://files.example.com/masthead.png", alt: null } as unknown as ResolvedArtwork,
        ],
      ]),
    );
    const masthead = blockById(filled, "blk_nl-masthead");
    if (masthead?.kind !== "bleed_image") return expect.unreachable("bleed_image");
    expect(masthead.alt).toBe("");
    expect(validateEmailDocument(filled).ok).toBe(true);
  });
});
