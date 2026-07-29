/**
 * PW FONT STACKS — founder bug #5 ("no way to change fonts"). Themes-the-
 * system are dead (a founder decision — see `renderEmail.ts`'s module doc),
 * so this is NOT a theme picker: it's a single document-level attr,
 * `doc.attrs.pwFontFamily`, that travels with the document exactly like
 * `pwCanvasColor` already does (same write-gate shape in `tiptapEmail.ts`,
 * same `Maily.setTheme()` wiring in `renderEmail.ts`).
 *
 * ── Why an ID, not a raw font-family string ─────────────────────────────────
 * `validateTiptapEmailDoc` (this package's write gate) needs to REJECT
 * arbitrary input, not just well-formed-looking CSS — a free-text font name
 * is either a trivial no-op (the recipient's client doesn't have it and
 * silently falls back) or, with a `webFont` URL attached, an arbitrary
 * cross-origin resource load in every recipient's inbox. Storing one of a
 * fixed set of IDs makes "valid" a plain set-membership check, and the
 * ACTUAL font stack (family, fallback, optional web font) is looked up here,
 * server- and client-side, from a single curated table neither the doc nor
 * the write gate can override.
 *
 * ── The three stacks (product default, 2026-07-29) ──────────────────────────
 * All three are chosen to render reliably across mail clients
 * (caniemail.com's `@font-face` support matrix is spotty — Outlook desktop
 * never loads a web font at all, and silently falls back to `fallback
 * FontFamily`, which is why every stack below is genuinely wearable on its
 * own, not just as a web-font's shadow):
 *   - `sans` (default): `Inter`, the SAME family+web-font the app already
 *     shipped as `DEFAULT_FONT` (`theme.ts`) — picking it changes nothing for
 *     a document that never touches this attr, matching `pwCanvasColor`'s own
 *     "absent renders exactly today's default" contract.
 *   - `serif`: `Georgia` — a genuine system font on both Windows and macOS
 *     (no `webFont` needed, so it never depends on a client loading anything)
 *     with real editorial/brand-serif character, the "brand serif" option.
 *   - `mono`: `Courier New` — likewise a real system font on both major
 *     platforms (unlike e.g. `SFMono-Regular`, which isn't installed on
 *     Windows at all and would silently fall back there), for the rare
 *     newsletter section that wants a typewriter/code feel.
 */
export type PwFontStackId = "sans" | "serif" | "mono";

export const PW_FONT_STACK_IDS: readonly PwFontStackId[] = ["sans", "serif", "mono"];

export function isPwFontStackId(value: unknown): value is PwFontStackId {
  return typeof value === "string" && (PW_FONT_STACK_IDS as readonly string[]).includes(value);
}

/** Mirrors `packages/email-render/src/theme.ts`'s vendored `allowedFallbackFonts`
 *  union exactly (this package stays dependency-free — see this file's own
 *  module doc — so it's copied, not imported). Every stack below uses one of
 *  these; `renderEmail.ts` hands the whole stack straight to
 *  `Maily#setTheme({ font })`, so a value outside this set would be a type
 *  error there, not just here. */
type PwFallbackFont =
  | "Arial"
  | "Helvetica"
  | "Verdana"
  | "Georgia"
  | "Times New Roman"
  | "serif"
  | "sans-serif"
  | "monospace"
  | "cursive"
  | "fantasy";

/** Mirrors `packages/email-render/src/theme.ts`'s vendored `FontProps`
 *  shape (this package stays dependency-free — see this file's own module
 *  doc — so the shape is copied, not imported; `renderEmail.ts` is what
 *  actually hands this to `Maily#setTheme({ font: … })`, which is where the
 *  real type lives). */
export type PwFontStack = {
  /** Shown in the designer's Font control. */
  label: string;
  fontFamily: string;
  fallbackFontFamily: PwFallbackFont;
  webFont?: { url: string; format: "woff" | "woff2" | "truetype" | "opentype" | "embedded-opentype" | "svg" };
};

export const PW_FONT_STACKS: Record<PwFontStackId, PwFontStack> = {
  sans: {
    label: "Sans (Inter)",
    fontFamily: "Inter",
    fallbackFontFamily: "sans-serif",
    webFont: {
      url: "https://rsms.me/inter/font-files/Inter-Regular.woff2?v=3.19",
      format: "woff2",
    },
  },
  serif: {
    label: "Serif (Georgia)",
    fontFamily: "Georgia",
    fallbackFontFamily: "serif",
  },
  mono: {
    label: "Mono (Courier New)",
    fontFamily: "Courier New",
    fallbackFontFamily: "monospace",
  },
};

export const DEFAULT_PW_FONT_STACK_ID: PwFontStackId = "sans";

/** The literal CSS `font-family` VALUE (no web-font declaration — that's a
 *  render-only concern, `renderEmail.ts`'s `<Font>` tag) for a given stack,
 *  for the EDITOR's own display (`MailyDocumentHost.web.tsx`) — a plain CSS
 *  string an inline `style.fontFamily` can use directly. Unknown/absent
 *  falls back to the same default the render side uses when the attr is
 *  absent, so editor and send read the SAME default. */
export function pwFontFamilyCss(id: string | null | undefined): string {
  const stack = isPwFontStackId(id) ? PW_FONT_STACKS[id] : PW_FONT_STACKS[DEFAULT_PW_FONT_STACK_ID];
  return `${stack.fontFamily}, ${stack.fallbackFontFamily}`;
}
