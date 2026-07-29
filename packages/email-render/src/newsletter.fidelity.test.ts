/**
 * WS4: the acceptance artefact's fidelity gate — the honest version of
 * "recognisable to her". Renders `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP`
 * (`@events-os/shared`) through the REAL `renderEmailTiptap` entry point and
 * asserts the specific numbers from `emailGeometry.ts` survive into the
 * actual HTML — not that the doc *contains an attribute claiming* those
 * numbers, but that the rendered `<style>` strings carry them.
 *
 * ── Filled, not shipped-empty ────────────────────────────────────────────
 * The template ships every artwork slot with `src: ""` (mirroring
 * `emailTemplates.ts`'s blocks-format convention). An unfilled `pwBleedImage`
 * now renders a visible neutral placeholder band rather than nothing (WS4,
 * fidelity gap 1 fix — see `maily.tsx`'s `pwBleedImage` doc and the
 * dedicated coverage below), but it still carries no fixture URL to assert
 * the geometry numbers against, and the card photos are broken `<img>` tags
 * with no real `src`. Every "the numbers survive into HTML" test in this
 * file therefore still renders the FILLED document (`fillTiptapArtwork` +
 * fixture URLs), the same shape a real send renders after the artwork
 * import has run — this is also, itself, the fidelity check that
 * `fillTiptapArtwork` produces a document real enough to assert numbers
 * against. The unfilled-send behaviour itself (masthead placeholder, alt
 * fallback) is asserted separately, against the SHIPPED (unfilled) doc, in
 * the section below.
 *
 * ── Style-string convention ───────────────────────────────────────────────
 * `@react-email/render`'s inline styles are asserted with `\s*` after the
 * colon (`nodePack.test.ts` already establishes this isn't always
 * whitespace-free) — same convention as this package's other suites.
 */
import { describe, expect, test } from "vitest";
import {
  PUBLIC_WORSHIP_NEWSLETTER_TIPTAP,
  TIPTAP_NEWSLETTER_ARTWORK_SLOTS,
  fillTiptapArtwork,
  PUBLIC_WORSHIP_THEME,
  EMAIL_CARD_SPECS,
  type NewsletterTiptapDoc,
} from "@events-os/shared";
import type { JSONContent } from "@tiptap/core";
import { renderEmailTiptap } from "./renderEmail";

const T = PUBLIC_WORSHIP_THEME;

/** Fixture asset URLs, one per `sourceKey` — deterministic and readable in a
 *  failure message (`.../hero-photo.png`, not a hash). */
function fixtureUrl(sourceKey: string): string {
  return `https://cdn.example.com/newsletter/${sourceKey}.png`;
}

const RESOLVED = new Map(TIPTAP_NEWSLETTER_ARTWORK_SLOTS.map((slot) => [slot.sourceKey, { url: fixtureUrl(slot.sourceKey), alt: "" }]));

const FILLED: NewsletterTiptapDoc = fillTiptapArtwork(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP, RESOLVED);

const RENDER_OPTS = {
  variables: { firstName: "Alex" },
  unsubscribeUrl: "https://example.com/unsubscribe/tok123",
  orgAddress: "123 Main St, Springfield",
};

/** Render once and share across every assertion in this file — these are
 *  read-only checks against one rendered artefact, not independent fixtures,
 *  and `renderEmailTiptap` is not cheap to call per-assertion. */
const rendered = renderEmailTiptap(FILLED as unknown as JSONContent, RENDER_OPTS);

describe("newsletter fidelity — the numbers from emailGeometry.ts survive into HTML", () => {
  test("hero: #891d1a accent fill", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/891d1a/i);
  });

  test("hero heading: 38px / 0.9 line-height / -0.04em letter-spacing", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/font-size:\s*38px/);
    // Not `/0\.9/` alone — that would also match "0.9em" etc. elsewhere. The
    // negative lookahead keeps this from matching a longer decimal like
    // "0.90001" that isn't actually the same value.
    expect(html).toMatch(/line-height:\s*0\.9(?!\d)/);
    expect(html).toMatch(/letter-spacing:\s*-0\.04em/);
  });

  test("event card: #fff9ee cream fill", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/fff9ee/i);
  });

  test("event card: the image column is 44%", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/width:\s*44%/);
  });

  test("the outlined cards: exactly three 1px black borders", async () => {
    const { html } = await rendered;
    const borderHits = html.match(/border-width:\s*1px/g) ?? [];
    expect(borderHits.length).toBe(3);
    // And they're actually black, not merely 1px — check the border-color
    // that goes with each hit rather than trusting the count alone.
    const blackBorderHits = html.match(/border-color:#000000;border-width:1px/g) ?? [];
    expect(blackBorderHits.length).toBe(3);
  });

  test("testimonial: #210706 near-black fill", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/210706/i);
  });

  test("testimonial body: 20px italic", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/font-size:\s*20px/);
    expect(html).toMatch(/<em>/);
  });

  test("button max-widths: 242 (hero), 190 (event), 140 (outlined)", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/max-width:\s*242px/);
    expect(html).toMatch(/max-width:\s*190px/);
    expect(html).toMatch(/max-width:\s*140px/);
  });

  test("filled buttons are the near-black pill (#210706 bg, white text); outline buttons are transparent with a black border and ink text", async () => {
    const { html } = await rendered;
    // Filled (hero "Read more", event "RSVP", serve is outline — hero is the
    // unambiguous filled case: contrast bg, contrastInk text).
    expect(html).toMatch(/color:#ffffff;background-color:#210706/);
    // Outline (the "Give"/"Shop"/"Get in touch" cards): transparent bg, ink
    // text, black border.
    expect(html).toMatch(/color:#210706;background-color:transparent;border-color:#000000/);
  });

  test("container: 600px max-width, white surface", async () => {
    const { html } = await rendered;
    expect(html).toMatch(/max-width:\s*600px/);
    expect(html).toMatch(/class="pw-container"/);
  });

  test("bleed images render outside the container gutter — structurally, not just present", async () => {
    const { html } = await rendered;
    // The masthead is the FIRST top-level node. `renderSegmentedBody`
    // (`maily.tsx`) places a `pwBleedImage` as its own top-level table,
    // never nested inside a `pw-container`-classed Container — so its <img>
    // must appear in the HTML strictly before the first `pw-container`
    // table opens.
    const mastheadIdx = html.indexOf(fixtureUrl("masthead"));
    const firstContainerIdx = html.indexOf('class="pw-container"');
    expect(mastheadIdx).toBeGreaterThan(-1);
    expect(firstContainerIdx).toBeGreaterThan(-1);
    expect(mastheadIdx).toBeLessThan(firstContainerIdx);

    // Four `pwBleedImage` nodes in this doc (masthead, whats-on, support,
    // voice) sit between/around FOUR themed segments (hero; event; the
    // three-outlined-card group; testimonial+song+hairline+footer — see
    // `renderSegmentedBody`'s doc: consecutive non-bleed nodes share ONE
    // container, so the trailing run merges into the testimonial's). That's
    // the structural signature of segmentation actually having run, rather
    // than everything collapsing into one Container the way an ordinary
    // (non-bleed) document does.
    const containerHits = html.match(/class="pw-container"/g) ?? [];
    expect(containerHits.length).toBe(4);
  });

  test("footer: the compliance footer is injected with unsubscribe + address", async () => {
    const { html } = await rendered;
    expect(html).toContain("123 Main St, Springfield");
    expect(html).toContain("https://example.com/unsubscribe/tok123");
    expect(html).toContain("Sent with love by Public Worship");
    // Injected AFTER the authored footer's nav/socials, before </body>.
    const navIdx = html.indexOf("Events | Supply");
    const complianceIdx = html.indexOf("123 Main St, Springfield");
    expect(navIdx).toBeGreaterThan(-1);
    expect(complianceIdx).toBeGreaterThan(navIdx);
    expect(complianceIdx).toBeLessThan(html.lastIndexOf("</body>"));
  });

  test("plaintext carries the newsletter's structure, not just its words", async () => {
    const { text } = await rendered;
    // Headings, in order, each followed eventually by its own body copy —
    // proof the plaintext conversion preserves section boundaries rather
    // than flattening everything into one paragraph.
    const heroIdx = text.toLowerCase().indexOf("officially summer");
    const eventIdx = text.toLowerCase().indexOf("brief headline about the event here");
    const supportIdx = text.toLowerCase().indexOf("copy about support");
    const testimonialIdx = text.toLowerCase().indexOf("the heart speaks");
    for (const idx of [heroIdx, eventIdx, supportIdx, testimonialIdx]) expect(idx).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(heroIdx);
    expect(supportIdx).toBeGreaterThan(eventIdx);
    expect(testimonialIdx).toBeGreaterThan(supportIdx);
    // CTAs carry their URL in plaintext (a link with no visible href is
    // useless outside HTML).
    expect(text).toContain("https://publicworship.life/give");
    expect(text).toContain("hello@publicworship.life");
    // The compliance footer, appended.
    expect(text).toContain("Unsubscribe from all Public Worship emails");
  });
});

describe("newsletter fidelity — section order (the eleven-section spine)", () => {
  test("masthead → hero → banner → event → banner → 3 outlined cards → banner → testimonial → song → hairline → footer", async () => {
    const { html } = await rendered;
    const lower = html.toLowerCase();
    const idx = (needle: string) => lower.indexOf(needle.toLowerCase());

    const landmarks: [string, number][] = [
      ["1. masthead", idx(fixtureUrl("masthead"))],
      ["2. hero", idx("officially summer")],
      ["3. banner (what's on)", idx(fixtureUrl("banner-whats-on"))],
      ["4. event card", idx("brief headline about the event here")],
      ["5. banner (support)", idx(fixtureUrl("banner-support"))],
      ["6. three outlined cards (support)", idx("copy about support")],
      ["6. three outlined cards (supply)", idx("public worship supply")],
      ["6. three outlined cards (serve)", idx("serve with us")],
      ["7. banner (voice)", idx(fixtureUrl("banner-testimonial"))],
      ["8. testimonial", idx("the heart speaks")],
      ["9. song artwork", idx(fixtureUrl("song-artwork"))],
      ["10. hairline", lower.indexOf("<hr")],
      ["11. footer", idx("events | supply")],
    ];

    for (const [label, position] of landmarks) {
      expect(position, `${label} should be present`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < landmarks.length; i++) {
      const [prevLabel, prevIdx] = landmarks[i - 1];
      const [label, position] = landmarks[i];
      expect(position, `${label} should come after ${prevLabel}`).toBeGreaterThan(prevIdx);
    }
  });
});

describe("newsletter fidelity — gaps closed by WS4's fidelity gate", () => {
  test("the page canvas behind the container is Public Worship's #f0f1f5, not white", async () => {
    // Fixed (was FIDELITY GAP): the canvas colour now lives IN THE DOCUMENT
    // (`PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.attrs.pwCanvasColor`, authored as
    // `T.canvas`) rather than a theme table — see `tiptapNewsletterTemplate
    // .ts`'s doc and `renderEmailTiptap`'s doc (`renderEmail.ts`, "The page
    // canvas colour") for the mechanism. `renderEmailTiptap` reads that attr
    // and calls `maily.setTheme({ body: { backgroundColor } })`, so the
    // `<body>` tag's own inline style now carries the real brand grey.
    // Card-level colours (accent/cream/contrast) were always reachable —
    // they're painted via each `section` node's own `backgroundColor` attr —
    // this closes the one gap that wasn't: the page-behind-the-card grey.
    const { html } = await rendered;
    const bodyMatch = html.match(/<body[^>]*style="([^"]*)"/i);
    expect(bodyMatch?.[1]).toContain(`background-color:${T.canvas}`);
    expect(bodyMatch?.[1]).not.toContain("background-color:#ffffff");
  });

  test("an UNFILLED pwBleedImage banner renders a visible neutral placeholder band, not nothing", async () => {
    // Fixed (was FIDELITY GAP): `pwBleedImage`'s render-time
    // `isAllowedImageUrl` guard (`maily.tsx`) used to return an EMPTY
    // FRAGMENT for an empty/invalid `src` — nothing rendered at all. It now
    // draws a fixed-height, neutral-fill band carrying the node's `alt` (or
    // the generic "Artwork slot" label when `alt` is empty, as this
    // template ships it) — the same INTENT as the blocks format's dashed
    // "add artwork" band (`emailRender.ts#renderBleedImage`), just without
    // borrowing a theme token that doesn't exist on maily's side. A template
    // sent before artwork import must still show all eleven sections'
    // structure — this is that guarantee for the four `pwBleedImage`
    // sections (masthead, what's-on, support, voice).
    const { html } = await renderEmailTiptap(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP as unknown as JSONContent, RENDER_OPTS);
    // The fixture URL substring appears nowhere — proof this isn't a false
    // positive from some other reason the URL would be present.
    expect(html).not.toContain("masthead");
    // No external request at all: still no `<img>` tag for these four nodes'
    // worth of markup — the placeholder is text-in-a-table, not a broken img.
    const placeholderHits = html.match(/Artwork slot/g) ?? [];
    expect(placeholderHits.length).toBe(4);
    // Structural: an actual table row holding the geometry, not a blank line.
    expect(html).toMatch(/<table[^>]*>[\s\S]*Artwork slot[\s\S]*<\/table>/);
  });

  test('a stock `image` node\'s authored empty alt ("", the write gate\'s legal "decorative" value) is preserved as alt=""', async () => {
    // Fixed (was FIDELITY GAP): `image()` (`maily.tsx`) used to be
    // `alt={alt || title || 'Image'}` — an empty string is falsy, so it fell
    // through to the hardcoded default exactly like a MISSING alt would.
    // Only a genuinely ABSENT alt now falls back; an authored `""` survives,
    // matching the blocks renderer's `cardImageHtml`
    // (`alt="${esc(content.imageAlt ?? "")}"`). Every card photo in this
    // template ships `alt: ""` on purpose (this template's documented
    // default), so none of them should announce the word "Image" to a
    // screen reader on artwork deliberately marked decorative.
    const { html } = await renderEmailTiptap(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP as unknown as JSONContent, RENDER_OPTS);
    expect(html).not.toContain('alt="Image"');
    expect(html).toMatch(/alt=""/);
  });
});

describe("newsletter fidelity — sanity: the doc actually exercises every card variant EMAIL_CARD_SPECS defines", () => {
  test("hero/feature/outlined/testimonial card specs are all represented by real numbers in the rendered HTML", async () => {
    const { html } = await rendered;
    for (const variant of ["hero", "feature", "outlined", "testimonial"] as const) {
      const spec = EMAIL_CARD_SPECS[variant];
      expect(html, `${variant} heading size`).toMatch(new RegExp(`font-size:\\s*${spec.headingSize}px`));
    }
  });
});
