/**
 * MARKETING · Designs — can this device actually SHOW this face?
 *
 * A font row that isn't set in the font tells you nothing, so the kit renders
 * specimens. The whole difficulty is the sentence after that: a specimen set in
 * a face the device doesn't have is not a specimen, it is a lie in Helvetica.
 * Every platform silently falls back, so "just set fontFamily and see" produces
 * a card that confidently shows you the wrong typeface.
 *
 * So a specimen is only drawn against an answer from a real probe, and there
 * are three honest outcomes:
 *
 *   exact       the device has the face. Draw it.
 *   substitute  the device has the face's BASE cut but not this width — the
 *               Times New Roman / Times New Roman Condensed case. Draw it and
 *               SAY which one you are actually looking at.
 *   unavailable nothing to draw. Say so, and offer the download link, which is
 *               the only useful thing the card can do at that point.
 *
 * The probe itself is platform-specific and lives in `./fontProbe` (a real
 * canvas measurement on web; the list of faces the OS ships on native). This
 * module is the pure decision on top of it, and is tested in node.
 */

/** What a specimen card should draw. */
export type Specimen =
  | { status: "exact"; fontFamily: string }
  /** `fontFamily` is the cut we really have; `actualName` is what to call it. */
  | { status: "substitute"; fontFamily: string; actualName: string }
  | { status: "unavailable" };

/** Answers "does this device have a family by this exact name?" */
export type FontProbe = (family: string) => boolean;

/** The glyph line every specimen shows — enough to judge letterforms. */
export const SPECIMEN_GLYPHS = "Aa Bb Cc";

/** The phrase under it. The org's own sentence, so the card reads as the
 *  brand's rather than as a type-foundry demo. */
export const SPECIMEN_PHRASE = "Worship belongs in the public square";

/**
 * Width modifiers a face name can end in.
 *
 * Only WIDTH, deliberately — not weight. "Inter Bold" not being installed while
 * "Inter" is means the specimen is the right typeface at the wrong weight,
 * which a reader forgives and, more to the point, which the app can usually fix
 * by asking for the weight. A condensed cut substituted by its normal width is
 * a visibly different face, and that is the one worth naming out loud.
 */
const WIDTH_WORDS = new Set([
  "condensed",
  "compressed",
  "narrow",
  "extended",
  "expanded",
  "wide",
  "semicondensed",
  "semiexpanded",
  "ultracondensed",
  "extracondensed",
]);

/** Trim, collapse runs of whitespace. Face names arrive typed by a human. */
export function normalizeFaceName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * The base cut of a width variant — "Times New Roman Condensed" → "Times New
 * Roman" — or null when the name isn't one.
 *
 * Returns null when stripping would leave nothing ("Condensed" on its own is
 * somebody's font, not a modifier) so the caller never probes for "".
 */
export function baseFaceName(name: string): string | null {
  const words = normalizeFaceName(name).split(" ").filter(Boolean);
  let end = words.length;
  while (end > 0 && WIDTH_WORDS.has(words[end - 1].toLowerCase())) end -= 1;
  if (end === words.length) return null;
  if (end === 0) return null;
  return words.slice(0, end).join(" ");
}

/**
 * What to draw for one face.
 *
 * The order matters: ask for the face itself first, so a device that genuinely
 * has the condensed cut gets `exact` and no apology.
 */
export function resolveSpecimen(name: string, has: FontProbe): Specimen {
  const face = normalizeFaceName(name);
  if (!face) return { status: "unavailable" };
  if (has(face)) return { status: "exact", fontFamily: face };

  const base = baseFaceName(face);
  if (base && has(base)) {
    return { status: "substitute", fontFamily: base, actualName: base };
  }
  return { status: "unavailable" };
}

/**
 * The line a card says when it is not showing you the face on the label.
 *
 * Written as a plain statement of what you ARE looking at rather than as a
 * warning about what you aren't: the point is that nobody signs off a flyer
 * believing they saw the real thing.
 */
export function specimenCaveat(
  name: string,
  specimen: Specimen,
): string | null {
  if (specimen.status === "exact") return null;
  if (specimen.status === "substitute") {
    return `Showing ${specimen.actualName} — this device doesn’t have ${normalizeFaceName(name)}.`;
  }
  return `${normalizeFaceName(name)} isn’t on this device, so there’s nothing to set the sample in.`;
}
