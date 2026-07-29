/*
 * MIT License
 *
 * Copyright (c) Arik Chakma
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/**
 * PROVENANCE: vendored from `arikchakma/maily.to`, `packages/shared/src/theme.ts`,
 * commit 042d13169b39e0ae8c692a25693bebdbb9b894c0 (2026-07-21), on 2026-07-29.
 *
 * WHY VENDORED: see `maily.tsx`'s provenance comment — this file exists only
 * to give `maily.tsx` the two exported types (`FontProps`,
 * `RendererThemeOptions`) and three constants (`DEFAULT_RENDERER_THEME`,
 * `DEFAULT_FONT`, `DEFAULT_LINK_TEXT_COLOR`) it imported from `@maily-to/shared`
 * upstream. TRIMMED from the original: `EditorThemeOptions`,
 * `DEFAULT_EDITOR_THEME`, and the `allowedFontFormats`/`FontFormat` exports are
 * editor-only (never read by render) and were dropped — see
 * `docs/plans/maily-editor-overhaul.md`'s WS0 spike, Bet 2, "copy ONLY what
 * render actually needs".
 */
import type * as CSS from "csstype";

export const allowedFallbackFonts = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Georgia",
  "Times New Roman",
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
] as const;

export type FallbackFont = (typeof allowedFallbackFonts)[number];

type FontWeight = CSS.Properties["fontWeight"];
type FontStyle = CSS.Properties["fontStyle"];

export interface FontProps {
  /** The font you want to use. NOTE: Do not insert multiple fonts here, use fallbackFontFamily for that */
  fontFamily: string;
  /** An array is possible, but the order of the array is the priority order */
  fallbackFontFamily: FallbackFont;
  /** Not all clients support web fonts. For support check: https://www.caniemail.com/features/css-at-font-face/ */
  webFont?: {
    url: string;
    format: "woff" | "woff2" | "truetype" | "opentype" | "embedded-opentype" | "svg";
  };
  /** Default: 'normal' */
  fontStyle?: FontStyle;
  /** Default: 400 */
  fontWeight?: FontWeight;
}

export interface BaseThemeOptions {
  container?: Partial<
    Pick<
      CSS.Properties,
      | "backgroundColor"
      | "maxWidth"
      | "minWidth"
      | "paddingTop"
      | "paddingRight"
      | "paddingBottom"
      | "paddingLeft"
      | "borderRadius"
      | "borderWidth"
      | "borderColor"
    >
  >;
  body?: Partial<
    Pick<CSS.Properties, "backgroundColor" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft">
  >;
  button?: Partial<
    Pick<
      CSS.Properties,
      "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "backgroundColor" | "color"
    >
  >;
  link?: Partial<Pick<CSS.Properties, "color">>;
  font?: Pick<FontProps, "fontFamily" | "fallbackFontFamily" | "webFont"> | null;
}

/**
 * The theme options for the renderer.
 * currently, we don't allow any customizations for the colors in the editor.
 * that's why we have a separate theme for the renderer.
 */
export interface RendererThemeOptions extends BaseThemeOptions {
  colors?: Partial<{
    heading: string;
    paragraph: string;
    horizontal: string;
    footer: string;
    blockquoteBorder: string;
    codeBackground: string;
    codeText: string;
    linkCardTitle: string;
    linkCardDescription: string;
    linkCardBadgeText: string;
    linkCardBadgeBackground: string;
    linkCardSubTitle: string;
  }>;
  fontSize?: Partial<{
    paragraph: Partial<{
      size: string;
      lineHeight: string;
    }>;
    footer: Partial<{
      size: string;
      lineHeight: string;
    }>;
  }>;
}

export const DEFAULT_FONT: FontProps = {
  fallbackFontFamily: "sans-serif",
  fontFamily: "Inter",
  webFont: {
    url: "https://rsms.me/inter/font-files/Inter-Regular.woff2?v=3.19",
    format: "woff2",
  },
};

export const DEFAULT_LINK_TEXT_COLOR = "#111827";

export const DEFAULT_RENDERER_THEME: RendererThemeOptions = {
  colors: {
    heading: "#111827",
    paragraph: "#374151",
    horizontal: "#EAEAEA",
    footer: "#64748B",
    blockquoteBorder: "#D1D5DB",
    codeBackground: "#EFEFEF",
    codeText: "#111827",
    linkCardTitle: "#111827",
    linkCardDescription: "#6B7280",
    linkCardBadgeText: "#111827",
    linkCardBadgeBackground: "#FEF08A",
    linkCardSubTitle: "#6B7280",
  },
  fontSize: {
    paragraph: {
      size: "15px",
      lineHeight: "26.25px",
    },
    footer: {
      size: "14px",
      lineHeight: "24px",
    },
  },

  container: {
    backgroundColor: "#ffffff",
    maxWidth: "600px",
    minWidth: "300px",
    paddingTop: "0.5rem",
    paddingRight: "0.5rem",
    paddingBottom: "0.5rem",
    paddingLeft: "0.5rem",

    borderRadius: "0px",
    borderWidth: "0px",
    borderColor: "transparent",
  },
  body: {
    backgroundColor: "#ffffff",

    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
  },
  button: {
    backgroundColor: "#000000",
    color: "#ffffff",
    paddingTop: "10px",
    paddingRight: "32px",
    paddingBottom: "10px",
    paddingLeft: "32px",
  },
  link: {
    color: DEFAULT_LINK_TEXT_COLOR,
  },
  font: DEFAULT_FONT,
};
