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

  // The point of the template is that it carries the newsletter's STRUCTURE.
  // Six headings in a row would validate fine and teach nobody anything.
  for (const kind of ["eyebrow", "card", "columns", "quote"] as const) {
    test(`uses the "${kind}" block — the template exercises the real layout, not just headings`, () => {
      expect(kinds.has(kind)).toBe(true);
    });
  }

  test("it is a composed document, not a stack of one kind", () => {
    expect(kinds.size).toBeGreaterThanOrEqual(6);
    expect(template.doc.blocks.length).toBeGreaterThanOrEqual(10);
  });

  test("the 'what's on' row is a real multi-column layout", () => {
    const columns = template.doc.blocks.filter((b) => b.kind === "columns");
    expect(columns.length).toBeGreaterThan(0);
    for (const block of columns) {
      if (block.kind !== "columns") continue;
      expect(block.columns.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("no block references an image URL this deployment doesn't own", () => {
    // Deliberate: a hardcoded absolute image URL would open every new campaign
    // with broken-image icons. The composer's picker attaches the real art.
    for (const block of template.doc.blocks) {
      if (block.kind === "image") expect.unreachable("template must not seed an image block");
      if (block.kind === "card") expect(block.imageUrl).toBeUndefined();
      if (block.kind === "columns") {
        for (const col of block.columns) expect(col.imageUrl).toBeUndefined();
      }
    }
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
