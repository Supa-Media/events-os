/**
 * Does this BROWSER have a font family by this name? (Metro resolves this file
 * for the web bundle; `fontProbe.ts` is the native half.)
 *
 * Measured, not guessed. `document.fonts.check()` is the API that looks right
 * and is not: Chrome answers true for a family it has never heard of, because
 * the family *can* be resolved — by falling back — which is precisely the case
 * we need to detect. So this does the old canvas trick instead: draw a string
 * in `"<family>", <generic>` and in `<generic>` alone, and compare widths. If
 * the family resolved to real glyphs, the metrics move.
 *
 * Three generics are tried because a face can coincidentally match one of them
 * (a monospace-metric face against `monospace`); any single disagreement is
 * proof the family exists.
 *
 * Answers are cached per family for the life of the page — a specimen wall
 * re-renders on every keystroke in the search box, and a canvas measurement per
 * face per keystroke is a lot of layout for a question whose answer cannot
 * change.
 */

/** Wide, mixed-width glyphs plus a couple of digits — the string most likely to
 *  differ between two faces of similar metrics. */
const SAMPLE = "mmmmmmmmwwwwwwwwiiiiiiiil1234567890";
const SIZE = 72;
const GENERICS = ["monospace", "serif", "sans-serif"] as const;

const cache = new Map<string, boolean>();

let context: CanvasRenderingContext2D | null | undefined;

function measuringContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  try {
    // `document` is absent during a static web export's prerender pass; a null
    // context means every face reports unavailable, which is the honest answer
    // when there is no browser to ask.
    context =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  return context;
}

function widthIn(ctx: CanvasRenderingContext2D, font: string): number {
  ctx.font = `${SIZE}px ${font}`;
  return ctx.measureText(SAMPLE).width;
}

/**
 * A family name as CSS: quoted, with any quote in the name dropped rather than
 * escaped. The name comes from a text field somebody types, and a stray quote
 * would otherwise break out of the font shorthand and silently change what is
 * being measured.
 */
function cssFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "")}"`;
}

/** Whether the browser has a family by this name. */
export function hasFontFamily(family: string): boolean {
  const name = family.trim();
  if (!name) return false;
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const ctx = measuringContext();
  let found = false;
  if (ctx) {
    found = GENERICS.some(
      (generic) =>
        widthIn(ctx, `${cssFamily(name)}, ${generic}`) !== widthIn(ctx, generic),
    );
  }
  cache.set(name, found);
  return found;
}
