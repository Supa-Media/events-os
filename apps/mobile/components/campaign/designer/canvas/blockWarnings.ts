/**
 * WHERE THE VALIDATION WARNINGS LIVE, now that there are no form fields.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * The form-card designer put ~15 warnings directly beneath the field each one
 * described ("This button has no link yet…" under the Link URL box). They are
 * not decoration: each mirrors an arm of `validateEmailDocument`, and a
 * document that fails the gate is rejected WHOLE — one half-typed button stops
 * autosave for every other block on the page. Losing them would turn that into
 * "the editor stopped saving" with nothing on screen admitting why.
 *
 * On a canvas there is no field to sit under, and a stack of fifteen warning
 * banners over the artwork is worse than none.
 *
 * ── The answer, in three parts ─────────────────────────────────────────────
 *  1. THIS module is the single source: one function turns a block into the
 *     warnings it currently earns, each with a severity, the name of the
 *     control that fixes it, and the copy the designer reads.
 *  2. The CANVAS shows only a count — a small badge on the block itself, red
 *     when the block is blocking the save, amber when it is merely advisory.
 *     One glyph per block, never a wall.
 *  3. The INSPECTOR (the selected block's contextual panel) shows that block's
 *     warnings in full, at the top, above the controls that fix them.
 *
 * So the warning is always one click from the thing it is about, and the
 * document-level summary in the composer's toolbar can jump straight to the
 * first block that is blocking the save.
 *
 * ── Why the predicates aren't here ─────────────────────────────────────────
 * Every `…Problem` function below comes from `lib/emailDesigner.ts`, where
 * `emailDesigner.test.ts` pins each one against the REAL `validateEmailDocument`
 * rather than against a second copy of the rules. This module only decides
 * where a problem is shown and how it is worded; whether a state is actually
 * refused stays that file's answer. A warning that merely approximates the
 * gate is worse than none.
 *
 * Pure and React-free so jest can load it (see `canvasStyles.ts`'s header).
 */
import type { EmailBlock, EmailCardContent, EmailDocument } from "@events-os/shared";
import {
  bleedImageUrlProblem,
  cardCtaUrlProblem,
  ctaPairProblem,
  footerLinkProblem,
  imageAltProblem,
  imageUrlProblem,
  linkUrlProblem,
  optionalImageUrlProblem,
  optionalLinkUrlProblem,
  pollHasBlankLabel,
} from "../../../../lib/emailDesigner";

/**
 * `blocking` — `validateEmailDocument` refuses this document, so autosave is
 * down for the WHOLE email until it's fixed.
 * `advisory` — the gate is happy; the designer can knowingly ship it (an
 * image she means to be decorative). Amber, never red: crying wolf on these
 * is what teaches people to ignore the red ones.
 */
export type BlockWarningSeverity = "blocking" | "advisory";

export type BlockWarning = {
  /** Stable within a block — a React key, and what the tests assert on. */
  key: string;
  severity: BlockWarningSeverity;
  /** The control that fixes it, in the inspector's own words ("Button link").
   *  Named rather than positioned, because on a canvas the fix may be two
   *  clicks away rather than directly below. */
  field: string;
  message: string;
};

const IMAGE_HREF_MESSAGE =
  "A link has to start with http://, https:// or mailto:. Clear the field or fix the address — the email can't be saved until then.";

const ALT_MISSING_MESSAGE =
  "This image has a URL but no alt text at all, and the email can't be saved (including edits to every other block) until it has some. Type a description — or, if the image really is decorative, type a character and delete it to leave the field deliberately empty.";

const ALT_EMPTY_MESSAGE =
  "No alt text. Screen readers and image-blocking clients (Gmail and Outlook block images by default) will show nothing here. Leave it empty only if the image is purely decorative.";

const blocking = (key: string, field: string, message: string): BlockWarning => ({
  key,
  severity: "blocking",
  field,
  message,
});

const advisory = (key: string, field: string, message: string): BlockWarning => ({
  key,
  severity: "advisory",
  field,
  message,
});

/**
 * The alt-text pair, shared by every image-bearing shape.
 *
 * Deliberately quiet while the URL itself is broken: an empty alt is
 * ACCEPTED by the gate (`""` is the contract's "decorative"), so it must never
 * be the loudest thing on a block whose url is the actual blocker.
 */
function altWarnings(
  prefix: string,
  field: string,
  image: { url?: string; alt?: string },
  urlIsBroken: boolean,
): BlockWarning[] {
  if (urlIsBroken) return [];
  const problem = imageAltProblem(image);
  if (problem === "unsaveable") {
    return [blocking(`${prefix}.alt-missing`, field, ALT_MISSING_MESSAGE)];
  }
  if (problem === "empty") return [advisory(`${prefix}.alt-empty`, field, ALT_EMPTY_MESSAGE)];
  return [];
}

/**
 * One card's warnings — reused verbatim for each cell of a `columns` block,
 * exactly as `CardContentEditor` was, so a column can never be checked more
 * loosely than a full-width card.
 */
export function cardContentWarnings(
  content: EmailCardContent,
  prefix: string,
  label: string,
): BlockWarning[] {
  const out: BlockWarning[] = [];
  const urlIssue = optionalImageUrlProblem(content.imageUrl);
  const imageField = `${label}image`;

  if (urlIssue === "missing") {
    out.push(
      blocking(
        `${prefix}.image-empty`,
        imageField,
        "This card's image URL is empty. Clear the field, upload a picture, or choose one from the library — the email can't be saved until then.",
      ),
    );
  } else if (urlIssue === "scheme") {
    out.push(
      blocking(
        `${prefix}.image-scheme`,
        imageField,
        "An image URL has to start with http:// or https://. The email can't be saved until this one does.",
      ),
    );
  }

  out.push(
    ...altWarnings(
      prefix,
      `${label}alt text`,
      { url: content.imageUrl, alt: content.imageAlt },
      urlIssue !== null,
    ),
  );

  const cta = ctaPairProblem(content);
  if (cta === "label-without-url") {
    out.push(
      blocking(
        `${prefix}.cta-no-url`,
        `${label}button link`,
        "This button has a label but no link — add one, or clear the label (a label of just a space still counts as one). A card can't save with only half a button.",
      ),
    );
  } else if (cta === "url-without-label") {
    out.push(
      blocking(
        `${prefix}.cta-no-label`,
        `${label}button label`,
        "This button has a link but no label — nothing will be visible to click. Add a label, or clear the link.",
      ),
    );
  }

  if (cardCtaUrlProblem(content)) {
    out.push(
      blocking(
        `${prefix}.cta-scheme`,
        `${label}button link`,
        "A button link has to start with http://, https:// or mailto:. The email can't be saved until this one does.",
      ),
    );
  }
  return out;
}

/** Every warning one block currently earns, in the order the inspector shows
 *  them (blocking problems first — see `sortWarnings`). */
export function blockWarnings(block: EmailBlock): BlockWarning[] {
  return sortWarnings(collect(block));
}

function collect(block: EmailBlock): BlockWarning[] {
  switch (block.kind) {
    case "button": {
      const out: BlockWarning[] = [];
      if (block.label.length === 0) {
        out.push(
          blocking(
            "label",
            "Button label",
            "This button has no label, so there'd be nothing to click. The email can't be saved until it has one.",
          ),
        );
      }
      const url = linkUrlProblem(block.url);
      if (url === "missing") {
        out.push(
          blocking(
            "url-missing",
            "Link URL",
            "This button has no link yet. The email can't be saved (including edits to every other block) until it does.",
          ),
        );
      } else if (url === "scheme") {
        out.push(
          blocking(
            "url-scheme",
            "Link URL",
            "A button link has to start with http://, https:// or mailto:. The email can't be saved until this one does.",
          ),
        );
      }
      return out;
    }

    case "image": {
      const out: BlockWarning[] = [];
      const url = imageUrlProblem(block.url);
      if (url === "missing") {
        out.push(
          blocking(
            "url-missing",
            "Image URL",
            "This image has no URL yet. Upload a picture or choose one from the library — the email can't be saved (including edits to every other block) until this is filled in.",
          ),
        );
      } else if (url === "scheme") {
        out.push(
          blocking(
            "url-scheme",
            "Image URL",
            "An image URL has to start with http:// or https://. The email can't be saved until this one does.",
          ),
        );
      }
      out.push(...altWarnings("image", "Alt text", block, url !== null));
      if (optionalLinkUrlProblem(block.href)) {
        out.push(blocking("href", "Link", IMAGE_HREF_MESSAGE));
      }
      return out;
    }

    case "bleed_image": {
      const out: BlockWarning[] = [];
      // A banner's url is the one image url the contract lets be BLANK — an
      // unfilled slot renders as a placeholder band, so the empty state is
      // described in the inspector, never warned about. Only a filled-in url
      // with a refused scheme is a problem.
      const scheme = bleedImageUrlProblem(block.url);
      if (scheme === "scheme") {
        out.push(
          blocking(
            "url-scheme",
            "Banner image",
            "An image URL has to start with http:// or https://. The email can't be saved until this one does.",
          ),
        );
      }
      out.push(
        ...altWarnings("banner", "Alt text", { url: block.url, alt: block.alt }, scheme !== null),
      );
      if (optionalLinkUrlProblem(block.href)) {
        out.push(blocking("href", "Link", IMAGE_HREF_MESSAGE));
      }
      return out;
    }

    case "footer": {
      const out: BlockWarning[] = [];
      const logo = optionalImageUrlProblem(block.logoUrl);
      if (logo === "missing") {
        out.push(
          blocking(
            "logo-empty",
            "Logo",
            "The footer's Logo field is empty. Choose an image, or clear the field — the email can't be saved until then.",
          ),
        );
      } else if (logo === "scheme") {
        out.push(
          blocking(
            "logo-scheme",
            "Logo",
            "An image URL has to start with http:// or https://. The email can't be saved until this one does.",
          ),
        );
      }
      out.push(
        ...altWarnings(
          "logo",
          "Logo alt text",
          { url: block.logoUrl, alt: block.logoAlt },
          logo !== null,
        ),
      );
      (block.links ?? []).forEach((link, index) => {
        const problem = footerLinkProblem(link);
        const field = `Link ${index + 1}`;
        if (problem === "label-missing") {
          out.push(
            blocking(
              `link-${index}-label`,
              field,
              "This link has no label, so nothing would show. Give it one, or remove the row — the email can't be saved until then.",
            ),
          );
        } else if (problem === "url-missing") {
          out.push(
            blocking(
              `link-${index}-url`,
              field,
              "This link has no address. Add one, or remove the row — the email can't be saved until then.",
            ),
          );
        } else if (problem === "url-scheme") {
          out.push(
            blocking(
              `link-${index}-scheme`,
              field,
              "A link has to start with http://, https:// or mailto:. The email can't be saved until this one does.",
            ),
          );
        }
      });
      return out;
    }

    case "poll":
      return pollHasBlankLabel(block.options)
        ? [
            blocking(
              "option-label",
              "Options",
              "Every option needs a label before this email can be saved.",
            ),
          ]
        : [];

    case "card":
      return cardContentWarnings(block, "card", "");

    case "columns":
      return block.columns.flatMap((column, index) =>
        cardContentWarnings(column, `col-${index}`, `Column ${index + 1} `),
      );

    default:
      // heading / text / divider / spacer / eyebrow / quote / hairline carry
      // no field the gate can refuse once the block exists — their required
      // strings are seeded non-empty by `defaultBlockFor` and the editors
      // cannot clear them into an invalid state.
      return [];
  }
}

/** Blocking first, then advisory; stable within each group so the order a
 *  block's fields appear in is preserved. */
function sortWarnings(warnings: BlockWarning[]): BlockWarning[] {
  return [
    ...warnings.filter((w) => w.severity === "blocking"),
    ...warnings.filter((w) => w.severity === "advisory"),
  ];
}

/** The worst severity in a list — what a block's badge shows. */
export function worstSeverity(warnings: readonly BlockWarning[]): BlockWarningSeverity | null {
  if (warnings.some((w) => w.severity === "blocking")) return "blocking";
  if (warnings.length > 0) return "advisory";
  return null;
}

export type DocumentWarnings = {
  /** Every block that has at least one warning, keyed by block id. */
  byBlockId: Record<string, BlockWarning[]>;
  /** Ids of blocks that are BLOCKING the save, in document order — the
   *  composer's summary steps through these. */
  blockingBlockIds: string[];
  blockingCount: number;
  advisoryCount: number;
};

/** Every block's warnings in one pass, plus the document-level counts the
 *  composer's toolbar summary reads. */
export function documentWarnings(doc: EmailDocument): DocumentWarnings {
  const byBlockId: Record<string, BlockWarning[]> = {};
  const blockingBlockIds: string[] = [];
  let blockingCount = 0;
  let advisoryCount = 0;

  for (const block of doc.blocks) {
    const warnings = blockWarnings(block);
    if (warnings.length === 0) continue;
    byBlockId[block.id] = warnings;
    const blockingHere = warnings.filter((w) => w.severity === "blocking").length;
    blockingCount += blockingHere;
    advisoryCount += warnings.length - blockingHere;
    if (blockingHere > 0) blockingBlockIds.push(block.id);
  }

  return { byBlockId, blockingBlockIds, blockingCount, advisoryCount };
}
