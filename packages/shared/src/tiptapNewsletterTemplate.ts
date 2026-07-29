/**
 * The Public Worship monthly newsletter, rebuilt as a Tiptap document — the
 * tiptap twin of `emailTemplates.ts#PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE`.
 *
 * ── Why this exists (WS4, "the acceptance artefact") ───────────────────────
 * The blocks-format template above is the ground truth: the designer's real
 * newsletter, section by section, with the exact numbers pulled from
 * `emailGeometry.ts`. An earlier tiptap/maily editor was rejected outright —
 * "it looks nothing like this" — because typographic finish (heading size,
 * line-height, letter-spacing, button caps) was treated as optional. This
 * file is the test of whether the Public Worship node pack
 * (`pwHeading`/`pwParagraph`/`pwBleedImage`/`button.maxWidth`/the
 * `textStyle` mark's `letterSpacing`/`color`) can actually reproduce those
 * numbers, not an approximation of them. `newsletter.fidelity.test.ts`
 * (`packages/email-render`) is the gate: it renders this doc through the
 * real `renderEmailTiptap` and asserts the specific numbers survive into
 * HTML, or documents precisely where they can't.
 *
 * ── Pure, zero-dep, like every other module in this package ───────────────
 * No `@tiptap/core` import — `packages/shared` has no such dependency (only
 * `packages/email-render`'s devDependency does), so `NewsletterTiptapNode`
 * below is a small structural type standing in for `JSONContent`, not that
 * type itself. `validateTiptapEmailDoc` (`tiptapEmail.ts`) takes the same
 * approach for the same reason.
 *
 * ── Card chrome comes from the SAME tables the blocks renderer reads ──────
 * `EMAIL_CARD_SPECS`/`emailCardFill`/`emailCardTextColor` (`emailGeometry.ts`)
 * and `PUBLIC_WORSHIP_THEME` (`emailTheme.ts`) are imported directly rather
 * than re-typed as literals here — a hero card's fill, padding, heading size
 * and CTA cap are the SAME numbers the blocks renderer paints with, read
 * from the one place they're allowed to live, not a second hand-copied set
 * that can drift from it.
 *
 * ── The node pack's real limits, found building this ───────────────────────
 * Two of the four gaps first reported here were CLOSED by WS4's fidelity
 * gate (`newsletter.fidelity.test.ts`) — see `pwBleedImage`'s own doc
 * (`maily.tsx`) for the unfilled-placeholder fix, and `renderEmailTiptap`'s
 * doc (`packages/email-render/src/renderEmail.ts`) plus this doc's `attrs`
 * field above for the page-canvas-colour fix. The remaining two are
 * accepted for now, reported precisely rather than silently worked around,
 * and still pinned by `newsletter.fidelity.test.ts`:
 *
 *   1. `pwParagraph` has no per-node text-colour attr (unlike `pwHeading`,
 *      which grew `color` in the same pass). Its `<Text>` colour is always
 *      `theme.colors.paragraph` — one value for the whole document. A
 *      newsletter with a white-on-maroon hero AND a dark-ink-on-cream event
 *      card needs two different body colours in the SAME document, which
 *      `pwParagraph`'s own attrs cannot express. The workaround (used
 *      throughout below) is the `textStyle` MARK's `color`, wrapped around
 *      every body text run — it renders as a `<span style="color:…">` inside
 *      the `<Text>`, which visually overrides the paragraph's own colour.
 *      That is a real, working escape hatch, but it means `pwParagraph`
 *      alone does not carry full typographic control the way `pwHeading`
 *      does — a later lane relying on `pwParagraph.attrs` alone for colour
 *      will reproduce this file's own first draft of that bug. (See
 *      `pwParagraph`'s own doc comment in `maily.tsx` for the same note,
 *      next to the code it describes.)
 *   2. There is exactly one rule/divider node upstream (`horizontalRule`),
 *      hardcoded to 32px margin above and below with no attrs at all. The
 *      blocks format's `hairline` (tight: 1px height, 8px/16px margins) and
 *      `divider` (generous: 20px margins) are two visually distinct things
 *      in `emailGeometry.ts`; the node pack currently has no way to express
 *      either specific number, only the one hardcoded rule. Used below for
 *      the newsletter's closing hairline because it is the only option, not
 *      because it matches — flagged for a later lane, not hidden.
 *
 * ── On artwork slots ────────────────────────────────────────────────────────
 * See `TIPTAP_NEWSLETTER_ARTWORK_SLOTS`'s own doc below.
 */

import { isAllowedImageUrl } from "./emailBlocks";
import { emailCardFill, emailCardTextColor, EMAIL_CARD_SPECS, EMAIL_GEOMETRY, type EmailCardSpec } from "./emailGeometry";
import { PUBLIC_WORSHIP_THEME } from "./emailTheme";
import type { ResolvedArtwork } from "./emailTemplates";
import { NEWSLETTER_TEMPLATE_SLOTS } from "./newsletterAssets";

// ── The minimal tiptap JSON shape this module needs ─────────────────────────
// Structurally identical to `@tiptap/core`'s `JSONContent`, not imported from
// it — see this file's module doc for why `packages/shared` can't depend on
// that package. `email-render`'s `RenderedEmail`-producing call sites accept
// this shape structurally (a `JSONContent` satisfies it and vice versa).

export type NewsletterTiptapMark = { type: string; attrs?: Record<string, unknown> };

export type NewsletterTiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NewsletterTiptapNode[];
  text?: string;
  marks?: NewsletterTiptapMark[];
};

export type NewsletterTiptapDoc = {
  type: "doc";
  /** Doc-level attrs — today just `pwCanvasColor` (WS4, fidelity gap 2 fix).
   *  See `validateTiptapEmailDoc`'s `validateDocAttrs` (`tiptapEmail.ts`) for
   *  the write-gate check and `renderEmailTiptap`'s doc
   *  (`packages/email-render/src/renderEmail.ts`) for the read side. */
  attrs?: { pwCanvasColor?: string };
  content: NewsletterTiptapNode[];
};

// ── Shorthand for the tables this template paints with ──────────────────────
const T = PUBLIC_WORSHIP_THEME;
const SPEC = EMAIL_CARD_SPECS;
const G = EMAIL_GEOMETRY;

/** A text run carrying the `textStyle` mark's `color`/`letterSpacing` — the
 *  per-run colour override `pwParagraph` itself can't express (see this
 *  file's module doc, gap 2). */
function styledText(text: string, color: string, extraMarks: NewsletterTiptapMark[] = []): NewsletterTiptapNode {
  return {
    type: "text",
    text,
    marks: [{ type: "textStyle", attrs: { color, letterSpacing: T.bodyTracking } }, ...extraMarks],
  };
}

/** A `pwHeading` node using a card variant's own size/line-height/colour —
 *  the SAME numbers `EMAIL_CARD_SPECS` gives the blocks renderer, not a
 *  second hand-typed set. `level` is presentational only here (h1 for the
 *  hero, h3 for every card heading beneath it, mirroring the blocks
 *  renderer's own uniform `<h3>` for card headings) — `fontSize`/`lineHeight`
 *  are set explicitly, so the level's DEFAULT size/weight table never
 *  applies. */
function cardHeading(spec: EmailCardSpec, level: 1 | 2 | 3, text: string): NewsletterTiptapNode {
  return {
    type: "pwHeading",
    attrs: {
      level,
      fontSize: spec.headingSize,
      lineHeight: String(spec.headingLine),
      letterSpacing: T.headingTracking,
      color: emailCardTextColor(spec, T),
      textAlign: spec.align,
    },
    content: [{ type: "text", text }],
  };
}

/** A `pwParagraph` node at the card's body size (`EMAIL_GEOMETRY.card`), its
 *  text wrapped in `styledText` for the colour `pwParagraph` itself can't
 *  carry. `italic` is a real tiptap mark (`italic`), not a style trick — the
 *  testimonial's quote uses it. */
function cardBody(
  spec: EmailCardSpec,
  text: string,
  opts: { fontSize?: number; italic?: boolean } = {},
): NewsletterTiptapNode {
  const fontSize = opts.fontSize ?? G.card.bodySize;
  return {
    type: "pwParagraph",
    attrs: { fontSize, lineHeight: String(G.card.bodyLine), textAlign: spec.align },
    content: [styledText(text, emailCardTextColor(spec, T), opts.italic ? [{ type: "italic" }] : [])],
  };
}

/**
 * A card's CTA button, painted the SAME way `emailRender.ts`'s
 * `renderButtonHtml` paints every button regardless of which card it's on:
 * filled is the near-black pill (`contrast`/`contrastInk`), outline is
 * transparent with an ink label and a `border`-coloured rule. `maxWidth` is
 * only set when the spec caps one (`null` means "no cap", the testimonial's
 * case — never authored here).
 */
function cardCta(spec: EmailCardSpec, text: string, url: string): NewsletterTiptapNode {
  const filled = spec.cta === "filled";
  return {
    type: "button",
    attrs: {
      text,
      url,
      variant: spec.cta,
      buttonColor: filled ? T.contrast : T.border,
      textColor: filled ? T.contrastInk : T.ink,
      borderRadius: "round",
      alignment: spec.ctaAlign,
      ...(spec.ctaMaxWidth ? { maxWidth: spec.ctaMaxWidth } : {}),
    },
  };
}

/** A card photo — a stock `image` node (not `pwBleedImage`: this artwork
 *  sits INSIDE the card's column, not edge-to-edge) tagged with `pwSlot` so
 *  `fillTiptapArtwork` can find it. Ships with an empty `src` — see this
 *  file's module doc, gap 1, for why the shipped state is never rendered
 *  directly. */
function cardImage(pwSlot: string, alt = ""): NewsletterTiptapNode {
  return { type: "image", attrs: { src: "", alt, pwSlot, width: "auto", alignment: "center" } };
}

/** A full-bleed banner/masthead — `pwBleedImage`, the node pack's only
 *  edge-to-edge shape (see `maily.tsx`'s `renderSegmentedBody`: this node
 *  renders as its own top-level table, OUTSIDE the theme-padded Container,
 *  which is the "bleed images sit outside the container gutter" fidelity
 *  requirement — no other node type gets this treatment). */
function bleedBanner(pwSlot: string, alt = ""): NewsletterTiptapNode {
  return { type: "pwBleedImage", attrs: { src: "", alt, pwSlot } };
}

/**
 * A card's outer chrome — background, border, radius, padding, margin — read
 * straight off `EMAIL_CARD_SPECS`/`PUBLIC_WORSHIP_THEME` via `emailCardFill`,
 * the same resolver the blocks renderer calls. `borderWidth`/`borderColor`
 * are set EXPLICITLY even when they match the `section` node's own defaults
 * (`DEFAULT_SECTION_BORDER_WIDTH === 1`, `DEFAULT_SECTION_BORDER_COLOR ===
 * "#000000"` — see `maily.tsx`) — relying on an upstream default to happen to
 * equal the brand's number is exactly the kind of silent coupling that broke
 * the first rebuild.
 */
function cardSectionAttrs(spec: EmailCardSpec, marginBottom: number): Record<string, unknown> {
  const bg = emailCardFill(spec, T) ?? T.surface;
  return {
    backgroundColor: bg,
    borderWidth: spec.bordered ? 1 : 0,
    borderColor: spec.bordered ? T.border : bg,
    borderRadius: T.radius,
    align: spec.align,
    paddingTop: spec.padY,
    paddingBottom: spec.padY,
    paddingLeft: spec.padX,
    paddingRight: spec.padX,
    marginBottom,
  };
}

/** A two-column `columns`/`column` split — the event card's 56/44 text|image
 *  row and each outlined card's 40/60 image|text row. Widths are the LITERAL
 *  percentages (not gap-subtracted the way the blocks renderer's `<td
 *  width>` is) — the node pack's `columns.gap` (px) is a separate knob, set
 *  to `EMAIL_GEOMETRY.columns.gutter` for the same visual spacing, rather
 *  than eating into either column's own width. */
function twoColumns(
  first: { width: number; content: NewsletterTiptapNode[] },
  second: { width: number; content: NewsletterTiptapNode[] },
): NewsletterTiptapNode {
  return {
    type: "columns",
    attrs: { gap: G.columns.gutter },
    content: [
      { type: "column", attrs: { width: first.width }, content: first.content },
      { type: "column", attrs: { width: second.width }, content: second.content },
    ],
  };
}

// ── Masthead ──────────────────────────────────────────────────────────────
const masthead = bleedBanner("nl-masthead");

// ── Maroon hero ───────────────────────────────────────────────────────────
const hero: NewsletterTiptapNode = {
  type: "section",
  attrs: cardSectionAttrs(SPEC.hero, G.card.marginBottom),
  content: [
    cardImage("nl-hero"),
    {
      type: "pwHeading",
      attrs: {
        level: 1,
        fontSize: SPEC.hero.headingSize,
        lineHeight: String(SPEC.hero.headingLine),
        letterSpacing: T.headingTracking,
        color: emailCardTextColor(SPEC.hero, T),
        textAlign: SPEC.hero.align,
      },
      content: [
        { type: "text", text: "Hey " },
        { type: "variable", attrs: { id: "firstName", fallback: "friend" } },
        { type: "text", text: " — it's officially summer" },
      ],
    },
    cardBody(
      SPEC.hero,
      "Open with the month in two or three sentences. What happened, what it meant, and what you want people to feel before they scroll.",
    ),
    cardCta(SPEC.hero, "Read more", "https://publicworship.life"),
  ],
};

// ── What's on ─────────────────────────────────────────────────────────────
const bannerWhatsOn = bleedBanner("nl-banner-whats-on");

const event: NewsletterTiptapNode = {
  type: "section",
  attrs: cardSectionAttrs(SPEC.feature, G.card.marginBottom),
  content: [
    twoColumns(
      {
        width: 56,
        content: [
          cardHeading(SPEC.feature, 3, "Brief headline about the event here"),
          cardBody(SPEC.feature, "Date, place, and the one line that tells someone why to come."),
          cardCta(SPEC.feature, "RSVP", "https://publicworship.life"),
        ],
      },
      { width: 44, content: [cardImage("nl-event")] },
    ),
  ],
};

// ── Support us — three outlined cards, photo beside text ───────────────────
const bannerSupport = bleedBanner("nl-banner-support");

function outlinedCard(
  pwSlot: string,
  heading: string,
  body: string,
  ctaLabel: string,
  ctaUrl: string,
  marginBottom: number,
): NewsletterTiptapNode {
  return {
    type: "section",
    attrs: cardSectionAttrs(SPEC.outlined, marginBottom),
    content: [
      twoColumns(
        { width: 40, content: [cardImage(pwSlot)] },
        {
          width: 60,
          content: [
            cardHeading(SPEC.outlined, 3, heading),
            cardBody(SPEC.outlined, body),
            cardCta(SPEC.outlined, ctaLabel, ctaUrl),
          ],
        },
      ),
    ],
  };
}

const support = outlinedCard(
  "nl-support",
  "Copy about support",
  "Your donations play a crucial role in supporting our mission — say what giving actually pays for this month.",
  "Give",
  "https://publicworship.life/give",
  G.columns.gutter, // tight stacking between the three — they read as one group
);

const supply = outlinedCard(
  "nl-supply",
  "Public Worship Supply",
  "Every purchase from PW Supply goes towards equipment, transportation, and food for volunteers.",
  "Shop",
  "https://publicworship.life",
  G.columns.gutter,
);

// The one mailto CTA among the three outlined cards.
const serve = outlinedCard(
  "nl-serve",
  "Serve with us!",
  "We want to hear from you. If you're interested in collaborating, or have questions about future events...",
  "Get in touch",
  "mailto:hello@publicworship.life",
  G.card.marginBottom,
);

// ── A voice from the community ──────────────────────────────────────────────
const bannerVoice = bleedBanner("nl-banner-voice");

const testimonial: NewsletterTiptapNode = {
  type: "section",
  attrs: cardSectionAttrs(SPEC.testimonial, G.card.marginBottom),
  content: [
    cardHeading(SPEC.testimonial, 3, "The Heart Speaks"),
    cardBody(
      SPEC.testimonial,
      "Drop in something someone actually said this month — a message, a note after a night, a line from a conversation. Real words, lightly edited.",
      { fontSize: G.card.testimonialBodySize, italic: true },
    ),
    {
      type: "pwParagraph",
      attrs: { fontSize: G.card.attributionSize, lineHeight: String(G.card.bodyLine), textAlign: SPEC.testimonial.align },
      content: [styledText("Their name, and how they're connected", emailCardTextColor(SPEC.testimonial, T))],
    },
  ],
};

// ── Song of the month — INSET, not full bleed ───────────────────────────────
// A stock `image` node, deliberately not `pwBleedImage`: `pwBleedImage` has
// no "inset" concept at all (see this file's module doc, gap 1's sibling
// note) — it is always edge-to-edge with a zero-padding cell. `image`'s
// NORMAL placement, inside the theme-padded Container, IS the inset
// treatment the blocks format's `bleed_image.inset: true` asks for; no
// workaround needed, just the right node for the job.
const song: NewsletterTiptapNode = {
  type: "image",
  attrs: {
    src: "",
    alt: "Song of the month",
    pwSlot: "nl-song",
    width: "auto",
    alignment: "center",
    externalLink: "https://open.spotify.com/",
  },
};

// ── Hairline ─────────────────────────────────────────────────────────────
// The node pack's only rule shape — see this file's module doc, gap 3.
const hairline: NewsletterTiptapNode = { type: "horizontalRule" };

// ── Footer — nav line + socials only. The compliance footer (address,
// unsubscribe, signoff) is INJECTED by `renderEmailTiptap` itself
// (`renderEmail.ts`'s `complianceFooterHtml`); authoring it here would
// duplicate it. ───────────────────────────────────────────────────────────
const footerLogo: NewsletterTiptapNode = {
  // A stock `image`, not `logo`: `logo`'s `size` is one of three fixed SQUARE
  // presets (`sm`/`md`/`lg`, 40/48/64px — see `maily.tsx`'s `logoSizes`),
  // built for an avatar-shaped mark. The real footer asset is a 209×53
  // WORDMARK (`newsletterAssets.ts`'s `footer-logo` entry) — `image`'s
  // arbitrary pixel width with `height: auto` preserves that aspect ratio;
  // `logo` would force it into a square crop.
  type: "image",
  attrs: { src: "", alt: "", pwSlot: "nl-footer", width: "auto", alignment: "center" },
};

const footerNav: NewsletterTiptapNode = {
  type: "footer",
  attrs: { textAlign: "center" },
  content: [{ type: "text", text: "Events | Supply" }],
};

const footerSocials: NewsletterTiptapNode = {
  type: "footer",
  attrs: { textAlign: "center" },
  content: [
    { type: "text", text: "TikTok", marks: [{ type: "link", attrs: { href: "https://www.tiktok.com/@publicworship.life" } }] },
    { type: "text", text: " · " },
    { type: "text", text: "Instagram", marks: [{ type: "link", attrs: { href: "https://www.instagram.com/publicworship.life/" } }] },
    { type: "text", text: " · " },
    { type: "text", text: "Website", marks: [{ type: "link", attrs: { href: "https://www.publicworship.life" } }] },
  ],
};

/**
 * The full newsletter, in document order — the same eleven-section spine
 * `emailTemplates.ts`'s own doc comment names: masthead → maroon hero →
 * banner → cream event card → banner → three outlined support cards →
 * banner → dark testimonial → song artwork → hairline → footer.
 *
 * Deterministic by construction: every node here is a literal object built
 * from named constants (`PUBLIC_WORSHIP_THEME`, `EMAIL_CARD_SPECS`,
 * `EMAIL_GEOMETRY`), never `Math.random()`/`crypto.randomUUID()` — a re-run
 * of whatever seeds this into Convex produces byte-identical JSON, the same
 * property `emailTemplates.ts`'s `newBlockId("nl-hero")` determinism note
 * asks for on the blocks side.
 */
export const PUBLIC_WORSHIP_NEWSLETTER_TIPTAP: NewsletterTiptapDoc = {
  type: "doc",
  // Public Worship's real page-behind-the-card grey (WS4, fidelity gap 2
  // fix) — `T.canvas` (`PUBLIC_WORSHIP_THEME`), the SAME token the blocks
  // renderer paints the page with, not a second hand-typed hex. Lives on the
  // DOCUMENT (not a theme table — see this file's module doc, gap 2) so it
  // travels with duplication and templates the way every other authored
  // value here does.
  attrs: { pwCanvasColor: T.canvas },
  content: [
    masthead,
    hero,
    bannerWhatsOn,
    event,
    bannerSupport,
    support,
    supply,
    serve,
    bannerVoice,
    testimonial,
    song,
    hairline,
    footerLogo,
    footerNav,
    footerSocials,
  ],
};

// ── Artwork slots ────────────────────────────────────────────────────────

export type TiptapArtworkSlot = { sourceKey: string; pwSlot: string };

/**
 * `sourceKey` (from `newsletterAssets.ts`) → the deterministic `pwSlot` attr
 * this template stamps on the matching `image`/`pwBleedImage` node — the
 * tiptap twin of `newsletterAssets.ts#NEWSLETTER_TEMPLATE_SLOTS`.
 *
 * Derived from `NEWSLETTER_TEMPLATE_SLOTS` itself (its `blockId` with the
 * blocks format's `blk_` prefix stripped) rather than re-typed as a second
 * literal list — the two formats' slot names stay recognisably paired by
 * construction, and `NEWSLETTER_TEMPLATE_SLOTS`' one deliberate name
 * mismatch (`banner-testimonial` sourceKey → `nl-banner-voice` slot, because
 * the block is "a voice from the community") carries over unchanged for the
 * same reason: the block/node is right; the asset was named before the
 * section was.
 *
 * `pwSlot` is an attr `validateTiptapEmailDoc` never inspects — the
 * validator only type-checks the specific attrs each node type is known to
 * use (see `tiptapEmail.ts`'s module doc: "attrs are not types"), so an
 * extra, unrecognised attr like this one is silently tolerated, exactly the
 * property this design leans on.
 */
export const TIPTAP_NEWSLETTER_ARTWORK_SLOTS: readonly TiptapArtworkSlot[] = NEWSLETTER_TEMPLATE_SLOTS.map((slot) => ({
  sourceKey: slot.sourceKey,
  pwSlot: slot.blockId.replace(/^blk_/, ""),
}));

const ARTWORK_NODE_TYPES = new Set(["image", "pwBleedImage", "logo"]);

/**
 * Which alt text survives when artwork is placed into a node — identical
 * semantics to `emailTemplates.ts`'s `preferAuthoredAlt` (mirrored here, not
 * imported: that function is private to that module, and the two formats'
 * artwork-filling functions are meant to stay independently readable — see
 * this file's module doc). The library row's alt wins ONLY when it actually
 * says something; an empty library alt leaves whatever this template
 * authored (today, `""` everywhere — see `fillTiptapArtwork`'s own doc).
 */
function preferAuthoredAlt(libraryAlt: string, authoredAlt: string | undefined): string {
  if (libraryAlt.length > 0) return libraryAlt;
  return authoredAlt ?? "";
}

function fillNode(node: NewsletterTiptapNode, byPwSlot: ReadonlyMap<string, ResolvedArtwork>): NewsletterTiptapNode {
  let content = node.content;
  if (content) {
    let changed = false;
    const nextContent = content.map((child) => {
      const filled = fillNode(child, byPwSlot);
      if (filled !== child) changed = true;
      return filled;
    });
    if (changed) content = nextContent;
  }

  const pwSlot = typeof node.attrs?.pwSlot === "string" ? node.attrs.pwSlot : undefined;
  const art = pwSlot ? byPwSlot.get(pwSlot) : undefined;

  if (art && ARTWORK_NODE_TYPES.has(node.type)) {
    const authoredAlt = typeof node.attrs?.alt === "string" ? node.attrs.alt : undefined;
    return {
      ...node,
      attrs: { ...node.attrs, src: art.url, alt: preferAuthoredAlt(art.alt, authoredAlt) },
      ...(content !== node.content ? { content } : {}),
    };
  }
  if (content !== node.content) return { ...node, content };
  return node;
}

/**
 * Place imported artwork into the tiptap template's empty slots — the tiptap
 * twin of `emailTemplates.ts#fillTemplateArtwork`, same documented semantics:
 *
 *  - PURE and non-mutating: the input `doc` is never mutated; unfilled
 *    branches are returned BY REFERENCE (an empty `resolved` map — or one
 *    with nothing valid in it — returns the exact same `doc` object), so a
 *    seeder that diffs JSON sees no churn from an import that hasn't run.
 *  - SKIP-NEVER-BLANK: a `sourceKey` with no matching row, or a `pwSlot` with
 *    no matching `sourceKey`, is left exactly as the template shipped it —
 *    never stamped with `""`/`undefined`.
 *  - The library row's `alt` wins only when non-empty (`preferAuthoredAlt`);
 *    a `url` that isn't a real string, is empty, or fails
 *    `isAllowedImageUrl` (the SAME predicate the write gate uses) costs that
 *    slot alone, not the whole fill.
 *
 * Recurses through EVERY node's `content` (columns, sections, etc. — unlike
 * the flat top-level `blocks` array the blocks format walks), because
 * artwork here sits inside `section`/`columns` nesting, not at the document's
 * top level.
 */
export function fillTiptapArtwork(
  doc: NewsletterTiptapDoc,
  resolved: ReadonlyMap<string, ResolvedArtwork>,
): NewsletterTiptapDoc {
  const byPwSlot = new Map<string, ResolvedArtwork>();
  for (const slot of TIPTAP_NEWSLETTER_ARTWORK_SLOTS) {
    const art = resolved.get(slot.sourceKey);
    if (!art || typeof art.url !== "string") continue;
    if (art.url.length === 0 || !isAllowedImageUrl(art.url)) continue;
    byPwSlot.set(slot.pwSlot, { url: art.url, alt: typeof art.alt === "string" ? art.alt : "" });
  }
  if (byPwSlot.size === 0) return doc;

  const content = doc.content.map((node) => fillNode(node, byPwSlot));
  const changed = content.some((node, i) => node !== doc.content[i]);
  return changed ? { ...doc, content } : doc;
}
