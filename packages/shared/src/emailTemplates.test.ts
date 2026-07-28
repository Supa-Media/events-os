import { describe, expect, test } from "vitest";
import type { EmailBlockKind } from "./emailBlocks";
import { validateEmailDocument } from "./emailBlocks";
import { renderCampaignEmail, renderCampaignText } from "./emailRender";
import { PUBLIC_WORSHIP_THEME } from "./emailTheme";
import {
  BUILT_IN_CAMPAIGN_TEMPLATES,
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
} from "./emailTemplates";

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
