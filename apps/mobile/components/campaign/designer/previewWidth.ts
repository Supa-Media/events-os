/**
 * PREVIEW WIDTH — founder bug #7 ("preview the email in multiple widths…
 * a light dark and mobile tablet web toggle"). A SECOND, independent axis
 * from `previewColorScheme.ts`'s Light/Dark toggle — this one constrains the
 * preview iframe's own rendered WIDTH, so a designer can see how the email
 * reflows at a phone-sized viewport vs. a tablet vs. full desktop-webmail
 * width, the same way a browser's own responsive-design mode works. Both
 * axes compose freely (mobile+dark, tablet+light, …) because they're
 * orthogonal: colour scheme rewrites the HTML string
 * (`forceIframeColorScheme`); width only constrains the `<iframe>`'s own box
 * — the SAME html string renders at whatever width its containing box gives
 * it, exactly like a real mail client's own viewport does.
 *
 * `desktop`'s `null` width is deliberately "no constraint" (100% of the
 * preview pane, `EMAIL_SEND_WIDTH`-ish in practice since the email's own
 * `Container` caps itself) — this is the option that reproduces today's
 * pre-#7 behavior exactly, so switching TO desktop is a true no-op regression
 * check, not a fourth new layout.
 */
export type PreviewWidthId = "mobile" | "tablet" | "desktop";

export const PREVIEW_WIDTH_IDS: readonly PreviewWidthId[] = ["mobile", "tablet", "desktop"];

export type PreviewWidthOption = {
  /** Shown on the toggle. */
  label: string;
  /** Iframe width in px, or `null` for "no constraint" (desktop/web). */
  width: number | null;
};

/** Widths chosen to match common device viewport widths designers actually
 *  care about — not exact device pixel widths (those vary by model), but the
 *  CSS-px breakpoints most responsive email frameworks (and this app's own
 *  `tailwind.config.js` `sm`/`md`) already treat as "phone" / "tablet". */
export const PREVIEW_WIDTHS: Record<PreviewWidthId, PreviewWidthOption> = {
  mobile: { label: "Mobile", width: 375 },
  tablet: { label: "Tablet", width: 768 },
  desktop: { label: "Desktop", width: null },
};

export const DEFAULT_PREVIEW_WIDTH_ID: PreviewWidthId = "desktop";

export function isPreviewWidthId(value: unknown): value is PreviewWidthId {
  return typeof value === "string" && (PREVIEW_WIDTH_IDS as readonly string[]).includes(value);
}
