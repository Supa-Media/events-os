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
 * ── On the deliberate absence of images ────────────────────────────────────
 * Every card below is authored WITHOUT an `imageUrl`, and that is a decision,
 * not an omission. A seeded template can only reference an image by absolute
 * URL, and any URL hardcoded here would point at an asset this deployment does
 * not own — every new campaign would open with broken-image icons, and a send
 * that slipped out would carry them to real inboxes. The composer's image
 * picker (and the new image library) is the correct place to attach the real
 * artwork; the template's job is to carry the STRUCTURE and the voice.
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
 *   wordmark → hero → what's on this month (2-up) → support us → a voice from
 *   the community → song of the month → sign-off
 *
 * The copy is written as GUIDANCE, not filler: each block says what belongs
 * there in the newsletter's own voice, so someone covering for the designer
 * knows what the section is for rather than staring at "Lorem ipsum".
 */
export const PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE: CampaignTemplate = {
  name: "Monthly newsletter",
  description:
    "The Public Worship monthly: hero, what's on, support us, a community voice, and the song of the month. Start here for the regular send.",
  doc: {
    theme: PUBLIC_WORSHIP_THEME,
    blocks: [
      // ── Hero ───────────────────────────────────────────────────────────
      {
        id: newBlockId("nl-eyebrow-hero"),
        kind: "eyebrow",
        text: "This month at Public Worship",
        icon: "◆",
      },
      {
        id: newBlockId("nl-hero-heading"),
        kind: "heading",
        level: 1,
        text: "Hey {{firstName}} —",
      },
      {
        id: newBlockId("nl-hero-body"),
        kind: "text",
        markdown:
          "Open with the month in two or three sentences. What happened, what it meant, and what you want people to feel before they scroll. Keep it warm and specific — one real moment beats a list of announcements.",
      },
      { id: newBlockId("nl-hero-rule"), kind: "divider" },

      // ── What's on ──────────────────────────────────────────────────────
      {
        id: newBlockId("nl-eyebrow-events"),
        kind: "eyebrow",
        text: "What's on",
        icon: "✦",
      },
      {
        id: newBlockId("nl-events-columns"),
        kind: "columns",
        columns: [
          {
            heading: "First event",
            body:
              "Date, place, and the one line that tells someone why to come. Add the cover image from the library.",
            ctaLabel: "RSVP",
            ctaUrl: "https://publicworship.life",
          },
          {
            heading: "Second event",
            body:
              "Same shape. If there's only one event this month, delete a column — two is the minimum, so swap this row for a single card block instead.",
            ctaLabel: "RSVP",
            ctaUrl: "https://publicworship.life",
          },
        ],
      },
      { id: newBlockId("nl-events-rule"), kind: "divider" },

      // ── Support us ─────────────────────────────────────────────────────
      {
        id: newBlockId("nl-eyebrow-support"),
        kind: "eyebrow",
        text: "Support us",
        icon: "❯",
      },
      {
        id: newBlockId("nl-support-card"),
        kind: "card",
        heading: "Help us keep the room open",
        body:
          "Say what giving actually pays for this month — the room, the gear, the people. Concrete beats general: what does one gift make possible?",
        ctaLabel: "Give",
        ctaUrl: "https://publicworship.life/give",
      },

      // ── A voice from the community ─────────────────────────────────────
      {
        id: newBlockId("nl-quote"),
        kind: "quote",
        text:
          "Drop in something someone actually said this month — a message, a note after a night, a line from a conversation. Real words, lightly edited.",
        attribution: "Their name, and how they're connected",
      },
      { id: newBlockId("nl-quote-rule"), kind: "divider" },

      // ── Song of the month ──────────────────────────────────────────────
      {
        id: newBlockId("nl-eyebrow-song"),
        kind: "eyebrow",
        text: "Song of the month",
        icon: "♪",
      },
      {
        id: newBlockId("nl-song-body"),
        kind: "text",
        markdown:
          "One short paragraph on why this one. Then add the artwork above as an image block and set its **link** to the streaming URL — tapping the artwork should take people straight to the song.",
      },
      {
        id: newBlockId("nl-song-button"),
        kind: "button",
        label: "Listen",
        url: "https://publicworship.life",
        align: "center",
      },

      // ── Sign-off ───────────────────────────────────────────────────────
      { id: newBlockId("nl-signoff-spacer"), kind: "spacer", size: "md" },
      {
        id: newBlockId("nl-signoff"),
        kind: "text",
        markdown:
          "See you this month,\n\n**The Public Worship team**",
      },
    ],
  },
};

/** Every built-in template, in picker order. `ensureBuiltInTemplates` seeds
 *  this list; the Expo picker shows it above an org's own saved templates. */
export const BUILT_IN_CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE,
];
