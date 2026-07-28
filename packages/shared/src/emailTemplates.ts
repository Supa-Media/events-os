/**
 * Built-in campaign templates — the starting points a campaign can be created
 * from, so a monthly send doesn't begin at an empty document every time.
 *
 * Pure TypeScript, zero react/convex deps (the `emailBlocks.ts` rule), because
 * `campaignTemplates.ts`'s `ensureBuiltInTemplates` seeds these into Convex and
 * the Expo template picker previews them from the same constant.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The designer's actual reason, in her words: "if I'm not available, Charisma
 * or Carla can jump in." Today every campaign starts empty, so the monthly
 * newsletter only exists in the head of the person who last built it. A
 * template makes the LAYOUT institutional knowledge instead of personal
 * knowledge.
 *
 * ── On artwork ─────────────────────────────────────────────────────────────
 * An earlier version of this template shipped with NO images at all, reasoning
 * that a hardcoded URL would break. That was right about the risk and wrong
 * about the result: this newsletter's masthead and section banners CARRY the
 * headings, so stripping them didn't leave a neutral skeleton, it left a
 * different design. Every image slot now holds `""`, so the
 * layout is correct from the first open and the author swaps in the real
 * artwork from the image library (migration 0052 imports it, keyed by
 * `sourceKey` in `newsletterAssets.ts`).
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * Block ids are seeded (`newBlockId("nl-hero")` → `"blk_nl-hero"`), never
 * random. `ensureBuiltInTemplates` is idempotent and re-runs on every deploy;
 * random ids would make each run look like a content change.
 */

import type { EmailDocument } from "./emailBlocks";
import { newBlockId } from "./emailBlocks";
import { PUBLIC_WORSHIP_THEME } from "./emailTheme";

/** A named starting point. `doc` is a complete, valid `EmailDocument`. */
export type CampaignTemplate = {
  name: string;
  description: string;
  doc: EmailDocument;
};

/**
 * Public Worship's monthly newsletter, rebuilt block-for-block from the real
 * thing — the layout the designer sends every month:
 *
 *   masthead → maroon hero → banner → cream event card → banner → three
 *   outlined support cards → banner → dark testimonial → song artwork →
 *   hairline → cream footer
 *
 * The copy is written as GUIDANCE, not filler: each block says what belongs
 * there in the newsletter's own voice, so someone covering for the designer
 * knows what the section is for rather than staring at "Lorem ipsum".
 */
export const PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE: CampaignTemplate = {
  name: "Monthly newsletter",
  description:
    "The Public Worship monthly, section for section: masthead, maroon hero, what's on, support us, a community voice, and the song of the month.",
  doc: {
    theme: PUBLIC_WORSHIP_THEME,
    blocks: [
      // ── Masthead ───────────────────────────────────────────────────────
      {
        id: newBlockId("nl-masthead"),
        kind: "bleed_image",
        alt: "",
      },

      // ── Maroon hero ────────────────────────────────────────────────────
      {
        id: newBlockId("nl-hero"),
        kind: "card",
        variant: "hero",
        imageSide: "top",
        heading: "Hey {{firstName}} — it's officially summer",
        body:
          "Open with the month in two or three sentences. What happened, what it meant, and what you want people to feel before they scroll.",
        ctaLabel: "Read more",
        ctaUrl: "https://publicworship.life",
      },

      // ── What's on ──────────────────────────────────────────────────────
      {
        id: newBlockId("nl-banner-whats-on"),
        kind: "bleed_image",
        alt: "",
      },
      {
        id: newBlockId("nl-event"),
        kind: "card",
        variant: "feature",
        imageSide: "right",
        imageWidthPct: 44,
        heading: "Brief headline about the event here",
        body: "Date, place, and the one line that tells someone why to come.",
        ctaLabel: "RSVP",
        ctaUrl: "https://publicworship.life",
      },

      // ── Support us — three outlined cards, photo beside text ───────────
      {
        id: newBlockId("nl-banner-support"),
        kind: "bleed_image",
        alt: "",
      },
      {
        id: newBlockId("nl-support"),
        kind: "card",
        variant: "outlined",
        imageSide: "left",
        imageWidthPct: 40,
        heading: "Copy about support",
        body:
          "Your donations play a crucial role in supporting our mission — say what giving actually pays for this month.",
        ctaLabel: "Give",
        ctaUrl: "https://publicworship.life/give",
      },
      {
        id: newBlockId("nl-supply"),
        kind: "card",
        variant: "outlined",
        imageSide: "left",
        imageWidthPct: 40,
        heading: "Public Worship Supply",
        body:
          "Every purchase from PW Supply goes towards equipment, transportation, and food for volunteers.",
        ctaLabel: "Shop",
        ctaUrl: "https://publicworship.life",
      },
      {
        id: newBlockId("nl-serve"),
        kind: "card",
        variant: "outlined",
        imageSide: "left",
        imageWidthPct: 40,
        heading: "Serve with us!",
        body:
          "We want to hear from you. If you're interested in collaborating, or have questions about future events...",
        ctaLabel: "Get in touch",
        ctaUrl: "mailto:hello@publicworship.life",
      },

      // ── A voice from the community ─────────────────────────────────────
      {
        id: newBlockId("nl-banner-voice"),
        kind: "bleed_image",
        alt: "",
      },
      {
        id: newBlockId("nl-testimonial"),
        kind: "card",
        variant: "testimonial",
        heading: "The Heart Speaks",
        body:
          "Drop in something someone actually said this month — a message, a note after a night, a line from a conversation. Real words, lightly edited.",
        attribution: "Their name, and how they're connected",
      },

      // ── Song of the month ──────────────────────────────────────────────
      {
        id: newBlockId("nl-song"),
        kind: "bleed_image",
        inset: true,
        alt: "Song of the month",
        href: "https://open.spotify.com/",
      },
      { id: newBlockId("nl-rule"), kind: "hairline" },

      // ── Footer ─────────────────────────────────────────────────────────
      {
        id: newBlockId("nl-footer"),
        kind: "footer",
        navLine: "Events | Supply",
        links: [
          { label: "TikTok", url: "https://www.tiktok.com/@publicworship.life" },
          { label: "Instagram", url: "https://www.instagram.com/publicworship.life/" },
          { label: "Website", url: "https://www.publicworship.life" },
        ],
      },
    ],
  },
};

/** Every built-in template, in picker order. `ensureBuiltInTemplates` seeds
 *  this list; the Expo picker shows it above an org's own saved templates. */
export const BUILT_IN_CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
];
