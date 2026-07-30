/**
 * POPPER CLAMP — founder bug #4 ("button text… since this button is on the
 * left it gets cut off"). maily's own bubble-menu popovers (the button's
 * edit toolbar in particular — `ButtonView`'s `<PopoverContent align="end"
 * side="top" className="mly:w-max …">`, `@maily-to/core`) are real Radix
 * `Popover`s, positioned via `@radix-ui/react-popper` with `strategy:
 * "fixed"` and NOT portaled (`portal` defaults to `false` in maily's own
 * `PopoverContent` wrapper, and the button's call site never passes it —
 * confirmed by reading `@maily-to/core/dist/index.mjs`).
 *
 * ── The bug, confirmed in the harness (`__adv__/harness/`) ──────────────────
 * The toolbar is `mly:w-max` — it sizes to its own content, ~620px wide (a
 * label field, three dropdowns, alignment/link/colour controls, a visibility
 * toggle). `align="end"` means it extends LEFTWARD from the trigger's own
 * right edge. For a button sitting near the LEFT edge of its column (every
 * "left"-variant card in the real newsletter — `EMAIL_CARD_SPECS`), there is
 * nowhere near 620px of room to its left, so Radix's own collision-avoidance
 * (`shift`) clamps the popover's left edge to the VIEWPORT's own left edge
 * (`x: 0`) — measured directly in the harness: a left-aligned RSVP button's
 * toolbar renders flush against column 0 of the browser window, entirely
 * disconnected from the button, and on any viewport narrower than the
 * toolbar's own ~620px width, its RIGHT portion (the alignment switch, link
 * field, colour pickers, visibility toggle) genuinely runs past the visible
 * edge — not just visually disconnected, actually invisible.
 *
 * ── Why this can't be fixed by passing different Radix props ────────────────
 * `align`/`side`/`collisionBoundary` are maily's OWN hardcoded JSX props on a
 * component we don't render (`ButtonView`, vendored in `@maily-to/core`) —
 * not exposed through `<Editor extensions={…}>`'s public API, so there is no
 * lever to change them without forking the dependency (this repo's
 * "upstream-first" rule: this genuinely belongs in maily itself — noting it
 * here rather than patching `node_modules`).
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * A `MutationObserver` (installed by `MailyDocumentHost.web.tsx`, scoped to
 * the editor's own container — these popovers are NOT portaled, so they stay
 * inside it) watches for Radix's own positioning wrapper
 * (`[data-radix-popper-content-wrapper]`, present regardless of portal — it's
 * `@radix-ui/react-popper`'s own internal element, not something `portal`
 * toggles) and re-clamps its horizontal position to fit inside the viewport
 * with a small margin, whenever Radix (re)computes it. This is a corrective
 * pass layered ON TOP of Radix's own math, not a replacement for it — it only
 * ever pulls the popover BACK on-screen, never fights a placement that's
 * already fully visible (see `clampPopperLeft`'s own doc for the exact rule,
 * and why it's idempotent against being re-applied on Radix's own next
 * recalculation, which fires continuously via `floating-ui`'s `autoUpdate`
 * on scroll/resize).
 */

/** Radix (`@radix-ui/react-popper`) writes its positioning wrapper's inline
 *  style as `transform: translate(Xpx, Ypx)` with `left: 0px; top: 0px;` —
 *  confirmed against the real rendered DOM in the harness. Matches either
 *  integer or decimal pixel values (measurements are often fractional, e.g.
 *  `translate(107.359375px, 925px)`). */
const TRANSLATE_RE = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/;

/**
 * Given a popper wrapper's current `transform` value and the viewport/
 * popover widths, return a corrected `transform` string whose X offset is
 * clamped into `[margin, viewportWidth - popoverWidth - margin]` — fully
 * on-screen with a small breathing-room margin on both edges.
 *
 * When the popover is WIDER than the viewport itself minus both margins
 * (pathological, but `mly:w-max` COULD exceed a very narrow window), there is
 * no X that satisfies both margins at once — pushing all the way to the
 * `margin`-based minimum would, on a viewport JUST narrower than the
 * popover, actually make the RIGHT-edge overflow WORSE than Radix's own
 * unclamped `x: 0` (caught by this file's own test: at a 600px viewport with
 * a 620px popover, forcing `x: 8` overflows the right edge by 28px, worse
 * than the 20px Radix's own `x: 0` already had). The fallback CENTERS the
 * popover instead (`(viewportWidth - popoverWidth) / 2`, split evenly
 * negative) — the position that minimizes the WORSE of the two overflows,
 * never worse than what Radix already computed.
 *
 * Returns `null` when `transformValue` doesn't match the expected shape (not
 * a translate-based transform at all — some other Radix version, or the
 * observer matched an unrelated element) or when the CURRENT position is
 * already within bounds — the "already clamped" case matters for the
 * caller's idempotency: rewriting `style.transform` to the SAME value it
 * already holds would still fire another `attributes` mutation, looping the
 * `MutationObserver` forever; returning `null` lets the caller skip the
 * write entirely when there's nothing to correct.
 */
export function clampPopperLeft(
  transformValue: string,
  viewportWidth: number,
  popoverWidth: number,
  margin = 8,
): string | null {
  const match = transformValue.match(TRANSLATE_RE);
  if (!match) return null;

  const currentX = Number(match[1]);
  const y = match[2];

  const minX = margin;
  const maxX = viewportWidth - popoverWidth - margin;

  let clampedX: number;
  if (maxX >= minX) {
    clampedX = Math.min(Math.max(currentX, minX), maxX);
  } else {
    // Doesn't fit with margins on both sides — center it instead of forcing
    // the left margin, so neither edge overflows worse than the other (see
    // this function's own doc for why a hard `margin` floor would regress
    // Radix's own `x: 0` here).
    clampedX = (viewportWidth - popoverWidth) / 2;
  }

  if (clampedX === currentX) return null;

  return transformValue.replace(TRANSLATE_RE, `translate(${clampedX}px, ${y}px)`);
}
