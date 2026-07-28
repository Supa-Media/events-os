/**
 * The artwork the Public Worship monthly newsletter is built from.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The newsletter is roughly 40% artwork: the masthead, the section banners
 * (which ARE the section headings — they're not decoration above a text
 * title, they replace it), the card photos, the song-of-the-month GIF, and
 * the footer logo. A template that ships without them isn't a neutral
 * skeleton, it's a different design. Reproducing the layout therefore needs
 * the assets to exist somewhere stable first.
 *
 * Today they live on a `canva-cdn.email` host, which is a per-send CDN and
 * WILL stop resolving. `migrations/0052_import_newsletter_images.ts` fetches
 * each one once and re-hosts it in Convex file storage as an `emailImages`
 * row, keyed by `sourceKey`.
 *
 * ── `sourceKey` is the stable handle ───────────────────────────────────────
 * It is the join between this manifest, the imported library row
 * (`emailImages.sourceKey`), and the built-in template that wants to place
 * the image. It must never change once imported — renaming one orphans the
 * library row and silently re-imports a duplicate. `label` and `alt` are
 * free to change; `sourceKey` is not.
 *
 * ── On `alt` being empty ───────────────────────────────────────────────────
 * Every entry ships with `alt: ""` deliberately. These images carry text I
 * have not seen — a banner that reads "WHAT'S ON" is a HEADING, and inventing
 * alt text for it would put words in the designer's mouth and, worse, would
 * look complete while being wrong. Empty alt is the honest state: the import
 * reports every row still needing it, and the composer already warns when an
 * image block has no alt. `role` records what each one is FOR, which is what
 * a human needs in order to write the alt text properly.
 */

/** Where each asset sits in the newsletter — used to place it when the
 *  built-in template is rebuilt, and to tell a human what they're captioning. */
export type NewsletterAssetRole =
  /** Full-bleed strip at the very top of the email. */
  | "masthead"
  /** Full-bleed strip that acts AS a section heading (contains the words). */
  | "section_banner"
  /** Photo inside a card. */
  | "card_photo"
  /** The song-of-the-month artwork, linked to the streaming URL. */
  | "song_artwork"
  /** Wordmark in the footer block. */
  | "footer_logo";

export type NewsletterAsset = {
  /** Stable join key. NEVER change after import. */
  sourceKey: string;
  /** Human label shown in the image library picker. */
  label: string;
  role: NewsletterAssetRole;
  /** Intrinsic pixel size from the source newsletter, so the rebuilt template
   *  can reserve the right aspect ratio before the image loads. */
  width: number;
  height: number;
  /**
   * The original CDN URL, kept ONLY for the one-time import. Expect this to
   * rot — `0050`'s whole purpose is to stop depending on it. A failure to
   * fetch here is expected eventually and is reported, never swallowed.
   */
  sourceUrl: string;
};

const CDN =
  "https://mlimodqx6iyxdsos93ruzv_ggcqa9_aeo4plswkidng.canva-cdn.email";

/**
 * In document order, top to bottom. The order is meaningful: it's the section
 * sequence the rebuilt template follows (masthead → hero → banner → event →
 * banner → the three support cards → banner → testimonial → song → footer).
 */
export const NEWSLETTER_ASSETS: readonly NewsletterAsset[] = [
  {
    sourceKey: "masthead",
    label: "Masthead (top strip)",
    role: "masthead",
    width: 600,
    height: 62,
    sourceUrl: `${CDN}/122d3bfcacb8b7b46ca01ef30ae050e5.png`,
  },
  {
    sourceKey: "hero-photo",
    label: "Hero photo (inside the maroon card)",
    role: "card_photo",
    width: 552,
    height: 399,
    sourceUrl: `${CDN}/73f689aed4eb4be00fedea845c69caf4.png`,
  },
  {
    sourceKey: "banner-whats-on",
    label: "Section banner — above the event card",
    role: "section_banner",
    width: 600,
    height: 46,
    sourceUrl: `${CDN}/674a25824d63d4b9618bfce3cd98e9c1.png`,
  },
  {
    sourceKey: "event-photo",
    label: "Event card photo",
    role: "card_photo",
    width: 239,
    height: 271,
    sourceUrl: `${CDN}/fcd5ce47359607d3b39263a5e093f012.png`,
  },
  {
    sourceKey: "banner-support",
    label: "Section banner — above the support cards",
    role: "section_banner",
    width: 600,
    height: 48,
    sourceUrl: `${CDN}/6bda87341890267bd66ea31749e0917b.png`,
  },
  {
    sourceKey: "support-photo",
    label: "Support card photo (giving)",
    role: "card_photo",
    width: 194,
    height: 223,
    sourceUrl: `${CDN}/ec693b5a329b72507ea9e7ffd0ec5f96.png`,
  },
  {
    sourceKey: "supply-photo",
    label: "Supply card photo (PW Supply)",
    role: "card_photo",
    width: 194,
    height: 252,
    sourceUrl: `${CDN}/7da87d6cf78b6654f85551af6a39d002.png`,
  },
  {
    sourceKey: "serve-photo",
    label: "Serve card photo (volunteer)",
    role: "card_photo",
    width: 200,
    height: 236,
    sourceUrl: `${CDN}/bf00df868eb933dfe4b5dd399cf022d9.png`,
  },
  {
    sourceKey: "banner-testimonial",
    label: "Section banner — above the testimonial",
    role: "section_banner",
    width: 600,
    height: 50,
    sourceUrl: `${CDN}/5bc7dd3dc7c61c672d8d7baa7e4491ab.png`,
  },
  {
    sourceKey: "song-artwork",
    label: "Song of the month artwork (animated)",
    role: "song_artwork",
    width: 552,
    height: 341,
    sourceUrl: `${CDN}/e6a87e591e734f3636535f4fc7e5c321.gif`,
  },
  {
    sourceKey: "footer-logo",
    label: "Footer logo",
    role: "footer_logo",
    width: 209,
    height: 53,
    sourceUrl: `${CDN}/8ffa211600159675fbae59716ac54087.png`,
  },
];

/** Look up one asset by its stable key, or null. */
export function newsletterAsset(sourceKey: string): NewsletterAsset | null {
  return NEWSLETTER_ASSETS.find((a) => a.sourceKey === sourceKey) ?? null;
}

/**
 * WHERE each asset goes — the join that was missing between the import and the
 * built-in template.
 *
 * The import (`migrations/0052`) writes eleven `emailImages` rows keyed by
 * `sourceKey`, and the built-in template
 * (`emailTemplates.ts#PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE`) ships eleven EMPTY
 * artwork slots. Those two landed back to back and nothing read `sourceKey` to
 * connect them, so a completed import still left the template blank. This map
 * is that connection; `emailTemplates.ts#fillTemplateArtwork` walks it.
 *
 * `blockId` is safe to hardcode because the template's ids are DETERMINISTIC:
 * `newBlockId("nl-hero")` returns exactly `"blk_nl-hero"` (that determinism is
 * load-bearing for the seeder's no-churn diff, and is asserted by its own
 * test). The shared test below asserts every id here really exists in the
 * template, so a block rename breaks CI instead of silently un-filling a slot.
 *
 * NOTE the one deliberate name mismatch: the asset is `banner-testimonial`
 * while the block it fills is `blk_nl-banner-voice` ("a voice from the
 * community"). Neither name is wrong and `sourceKey` may never change once
 * imported, so the mismatch is recorded here rather than renamed away.
 */
export const NEWSLETTER_TEMPLATE_SLOTS: readonly {
  blockId: string;
  sourceKey: string;
}[] = [
  { sourceKey: "masthead", blockId: "blk_nl-masthead" },
  { sourceKey: "hero-photo", blockId: "blk_nl-hero" },
  { sourceKey: "banner-whats-on", blockId: "blk_nl-banner-whats-on" },
  { sourceKey: "event-photo", blockId: "blk_nl-event" },
  { sourceKey: "banner-support", blockId: "blk_nl-banner-support" },
  { sourceKey: "support-photo", blockId: "blk_nl-support" },
  { sourceKey: "supply-photo", blockId: "blk_nl-supply" },
  { sourceKey: "serve-photo", blockId: "blk_nl-serve" },
  // `banner-testimonial` → `blk_nl-banner-voice`. See the note above.
  { sourceKey: "banner-testimonial", blockId: "blk_nl-banner-voice" },
  { sourceKey: "song-artwork", blockId: "blk_nl-song" },
  { sourceKey: "footer-logo", blockId: "blk_nl-footer" },
];
