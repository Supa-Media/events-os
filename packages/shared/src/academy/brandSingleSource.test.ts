/**
 * The brand kit is the only place the brand's values are written down.
 *
 * ── The rule, and why it needs a test ───────────────────────────────────────
 * `docs/governance/operating-manual.md` §9.2 says it plainly: training, the
 * manual, and every other document POINT AT Marketing → Designs rather than
 * restating what the colors and typefaces are. The designer is meant to change
 * the brand from the app, with no PR and nobody's approval — so any second copy
 * of a hex code or a font list is a copy that goes wrong silently the moment
 * they exercise that. The person it misleads is the one who trusted their
 * training instead of opening the kit, which is the opposite of what training
 * is for.
 *
 * This started as a real defect rather than a hypothetical. `mktg-the-look`
 * taught "PW Red — #891d1a" and named three faces, and QUIZZED people on both,
 * while the newsletter theme the org actually sends is set in a fourth face.
 * Two documents in one repo, disagreeing about the org's body face, each
 * confidently marking an answer correct.
 *
 * A lesson re-adding a hex is the easiest possible regression: it reads as
 * helpful, it reviews as harmless, and nothing else in this repo would notice.
 * Hence a test rather than a convention.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Academy content only. The places that legitimately hold values are the email
 * theme (`emailTheme.ts` — the renderer's tokens, which the brand kit seed
 * READS so there is still one source) and `lib/seed/brandKit.ts` (the kit's own
 * starting rows). Neither is a document that teaches a human what the brand is.
 */
import { describe, expect, test } from "vitest";
import { ACADEMY_SECTIONS } from "../academy";
import type { AcademySection } from "./types";

/** Every string a learner can actually read in a section — blocks, quiz
 *  prompts, options and explanations, titles and subtitles. Walks the block
 *  union structurally instead of naming its cases, so a new block kind is
 *  covered the day it is added rather than silently exempt. */
function readableText(section: Omit<AcademySection, "order">): string {
  const out: string[] = [section.title, section.subtitle ?? ""];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(section.blocks);
  walk(section.quiz ?? []);
  return out.join("\n");
}

/** `#rrggbb` or `#rgb`. Deliberately not matching bare hex digits — "891d1a"
 *  with no hash does not read as a color to anybody, and a looser pattern
 *  would start flagging IDs and timestamps. */
const HEX_IN_PROSE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/;

/** The faces the brand kit ships with. Naming one in a lesson is the same
 *  mistake as printing a hex: the designer may re-role or remove any of them
 *  from the app, and the lesson would keep teaching the old answer. */
const SEEDED_FONT_NAMES = [
  "Times New Roman Condensed",
  "SF Pro Display",
  "Barbra Condensed",
];

describe("no Academy lesson restates the brand", () => {
  test("no section prints a hex color", () => {
    const offenders = ACADEMY_SECTIONS.filter((section) =>
      HEX_IN_PROSE.test(readableText(section)),
    ).map((section) => section.slug);

    expect(
      offenders,
      `these sections print a hex code: ${offenders.join(", ")}. The brand kit ` +
        `(Marketing → Designs) is the only place brand values are written down — ` +
        `point at it instead. See operating-manual.md §9.2.`,
    ).toEqual([]);
  });

  test("no section names one of the kit's typefaces", () => {
    const offenders: string[] = [];
    for (const section of ACADEMY_SECTIONS) {
      const text = readableText(section);
      for (const font of SEEDED_FONT_NAMES) {
        if (text.includes(font)) offenders.push(`${section.slug} → ${font}`);
      }
    }

    expect(
      offenders,
      `these sections name a specific typeface: ${offenders.join("; ")}. The ` +
        `designer can re-role or remove any face from Marketing → Designs ` +
        `without a deploy, so a lesson that names one goes stale the day they ` +
        `do. Describe the ROLE and point at the kit.`,
    ).toEqual([]);
  });

  test("the brand lesson still sends people somewhere for the answer", () => {
    // The complement of the two guards above: having removed the values, the
    // lesson must not simply have gone quiet about where they are. A lesson
    // that names neither the red nor the kit teaches nothing at all, and both
    // guards above would still pass.
    const look = ACADEMY_SECTIONS.find((s) => s.slug === "mktg-the-look");
    expect(look, "mktg-the-look is missing").toBeDefined();
    expect(readableText(look!)).toContain("Marketing → Designs");
  });
});
