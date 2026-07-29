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
 * PROVENANCE: vendored from `arikchakma/maily.to`, `packages/render/src/maily.tsx`,
 * commit 042d13169b39e0ae8c692a25693bebdbb9b894c0 (2026-07-21), on 2026-07-29.
 *
 * WHY VENDORED (not depended on as `@maily-to/render`): that package wraps
 * this exact class as a closed, ~30-hardcoded-private-method renderer with no
 * extension point — it throws on any node `type` it doesn't already know
 * about, and there is no way to teach it a new one short of subclassing an
 * undocumented internal of a single-maintainer package. The Public Worship
 * node pack (`pwHeading`, tracking marks, capped-width buttons, bleed images,
 * polls — see the plan doc's "The Public Worship node pack") needs first-
 * class render methods here, not a subclass hack, so this file is MIT-vendored
 * and owned going forward instead. Also lets us pick `@react-email/render@^2.1`
 * ourselves (its explicit `convex` export condition, unavailable on maily's
 * pinned 1.x line) rather than inherit whatever `@maily-to/render` pins.
 *
 * ADAPTED FROM UPSTREAM (import surface only, behavior otherwise identical
 * except where marked "DEVIATION FROM UPSTREAM" inline below):
 *   - `@maily-to/shared` → `./theme` (this package's own trimmed copy, see
 *     `theme.ts`'s provenance comment).
 *   - `@antfu/utils`'s `deepMerge` → `./utils`'s `deepMerge` (same behavior,
 *     inlined so this package doesn't take on a whole dependency for one
 *     ~15-line function — see `utils.ts`'s provenance comment).
 *   - `node-html-parser`, `juice`, `@react-email/components`,
 *     `@react-email/render` kept as real dependencies — this file's own
 *     `htmlCodeBlock` method (search `juice(`) is the ONLY place `juice`/
 *     `node-html-parser` are used; nothing else in this vendored slice needs
 *     them. `@react-email/render`'s `renderAsync` is the actual HTML/plain-
 *     text renderer this class hands its JSX tree to (see `render()` below).
 *
 * Two IN-PLACE MUTATION bugs in upstream's shared module-level default
 * objects (`DEFAULT_RENDERER_THEME`, `DEFAULT_META_TAGS`) were found and
 * fixed while vendoring — see the two "DEVIATION FROM UPSTREAM" comments at
 * the `config`/`meta` class fields below. Everything else is unchanged, EXCEPT
 * every bare `JSX.Element` → `React.JSX.Element` (with the added
 * `import type React from 'react'` below) — `@types/react@19` dropped the
 * global ambient `JSX` namespace upstream's source relies on; see
 * `meta.tsx`'s matching deviation note.
 *
 * WS1 (Public Worship node pack, 2026-07-29) additions on top of the above:
 *   - A THIRD upstream bug, found while building `pwHeading` alongside the
 *     stock `heading()` method: see the "DEVIATION FROM UPSTREAM" comment at
 *     `heading()` below — an out-of-range `level` attr made a lookup
 *     destructure `undefined` and throw.
 *   - Four new render methods (`pwHeading`, `pwParagraph`, `pwBleedImage`,
 *     `pwPoll`) and two extended existing ones (`textStyle` mark gains
 *     `letterSpacing`; `button` gains `maxWidth`) — the gaps recon found
 *     stock maily has no way to express (see the plan doc's "The Public
 *     Worship node pack"). `nodeTypes.ts`'s `MAILY_DISPATCHED_NODE_TYPES`
 *     is the authoritative list of every dispatchable type, kept in
 *     lockstep with `@events-os/shared`'s `EMAIL_TIPTAP_NODE_TYPES` by
 *     `nodeTypes.drift.test.ts`.
 *   - `markup()` was restructured (see `renderSegmentedBody`'s doc) so a
 *     `pwBleedImage` node can render truly edge-to-edge without a negative-
 *     margin CSS trick — everything else renders byte-identical to before.
 */
import { Fragment, type CSSProperties } from 'react';
import type React from 'react';
import {
  Text,
  Html,
  Head,
  Body,
  Font,
  Container,
  Link,
  Heading,
  Hr,
  Button,
  Img,
  Preview,
  Row,
  Column,
  Section,
  HtmlProps,
} from '@react-email/components';
// DEVIATION FROM UPSTREAM (2026-07-29): upstream imports `renderAsync` from
// `@react-email/render`'s 1.x line (maily pins `^1.2.1`). We deliberately
// pinned `^2.1.0` instead — its explicit `convex` package.json export
// condition (targeting exactly our send runtime) is the whole reason this
// plan chose to vendor rather than depend on `@maily-to/render` at all, see
// this file's top provenance comment. 2.x renamed the export
// `renderAsync` → `render` and reshaped `Options` into a discriminated union
// keyed on `plainText`; our own `render()` call below still passes the same
// flat `{ pretty, plainText }` shape, which satisfies both members of that
// union structurally.
import { render as reactEmailRenderAsync } from '@react-email/render';
import type { JSONContent } from '@tiptap/core';
// WS1 addition (2026-07-29, adversarial-review HIGH fix): the render-time
// URL scheme CHOKEPOINT every href/src in this class now passes through
// post-resolution — see `urlSanitize.ts`'s module doc for the full story
// (variable-resolved URLs used to bypass the write gate's scheme allowlist
// entirely; this is what closes that gap for every sink, not just
// `pwBleedImage`, which had its own earlier, narrower copy of this check).
import { safeRenderHref, safeRenderImageSrc } from './urlSanitize';
import { deepMerge, generateKey } from './utils';
import type { MetaDescriptors } from './meta';
import { meta } from './meta';
import { parse } from 'node-html-parser';
import juice from 'juice';
import type {
  FontProps,
  RendererThemeOptions as ThemeOptions,
} from './theme';
import {
  DEFAULT_RENDERER_THEME as DEFAULT_THEME,
  DEFAULT_FONT,
  DEFAULT_LINK_TEXT_COLOR,
} from './theme';
import { Preheader } from './preheader';

interface NodeOptions {
  parent?: JSONContent;
  prev?: JSONContent;
  next?: JSONContent;

  payloadValue?: PayloadValue;
}

export interface MarkType {
  [key: string]: any;
  type: string;
  attrs?: Record<string, any> | undefined;
}

const antialiased: CSSProperties = {
  WebkitFontSmoothing: 'antialiased',
  MozOsxFontSmoothing: 'grayscale',
};

const allowedHeadings = ['h1', 'h2', 'h3'] as const;
type AllowedHeadings = (typeof allowedHeadings)[number];

// WS1 addition: the numeric levels `headings` below actually has an entry
// for, used to clamp `heading()`/`pwHeading()`'s `attrs.level` before it
// becomes a lookup key — see the "DEVIATION FROM UPSTREAM" note on
// `heading()`.
type AllowedHeadingLevel = 1 | 2 | 3;
const HEADING_LEVEL_KEYS: ReadonlySet<number> = new Set([1, 2, 3]);

const headings: Record<AllowedHeadings, CSSProperties> = {
  h1: {
    fontSize: '36px',
    lineHeight: '40px',
    fontWeight: 800,
  },
  h2: {
    fontSize: '30px',
    lineHeight: '36px',
    fontWeight: 700,
  },
  h3: {
    fontSize: '24px',
    lineHeight: '38px',
    fontWeight: 600,
  },
};

const allowedLogoSizes = ['sm', 'md', 'lg'] as const;
type AllowedLogoSizes = (typeof allowedLogoSizes)[number];

const logoSizes: Record<AllowedLogoSizes, string> = {
  sm: '40px',
  md: '48px',
  lg: '64px',
};

export interface MailyConfig {
  /**
   * The preview text is the snippet of text that is pulled into the inbox
   * preview of an email client, usually right after the subject line.
   *
   * Default: `undefined`
   */
  preview?: string | JSONContent;
  /**
   * The theme object allows you to customize the colors and font sizes of the
   * rendered email.
   *
   * Default:
   * ```js
   * {
   *   colors: {
   *     heading: '#111827',
   *     paragraph: '#374151',
   *     horizontal: '#EAEAEA',
   *     footer: '#64748B',
   *   },
   *   fontSize: {
   *     paragraph: '15px',
   *     footer: {
   *       size: '14px',
   *       lineHeight: '24px',
   *     },
   *   },
   * }
   * ```
   *
   * @example
   * ```js
   * const maily = new Maily(content, {
   *   theme: {
   *     colors: {
   *       heading: '#111827',
   *     },
   *     fontSize: {
   *       footer: {
   *         size: '14px',
   *         lineHeight: '24px',
   *       },
   *     },
   *   },
   * });
   * ```
   */
  theme?: Partial<ThemeOptions>;
}

const CODE_FONT_FAMILY =
  'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
export const DEFAULT_SECTION_BACKGROUND_COLOR = '#ffffff';
export const DEFAULT_SECTION_ALIGN = 'left';
export const DEFAULT_SECTION_BORDER_WIDTH = 1;
export const DEFAULT_SECTION_BORDER_COLOR = '#000000';

export const DEFAULT_SECTION_MARGIN_TOP = 0;
export const DEFAULT_SECTION_MARGIN_RIGHT = 0;
export const DEFAULT_SECTION_MARGIN_BOTTOM = 0;
export const DEFAULT_SECTION_MARGIN_LEFT = 0;

export const DEFAULT_SECTION_PADDING_TOP = 5;
export const DEFAULT_SECTION_PADDING_RIGHT = 5;
export const DEFAULT_SECTION_PADDING_BOTTOM = 5;
export const DEFAULT_SECTION_PADDING_LEFT = 5;

export const DEFAULT_COLUMNS_WIDTH = '100%';
export const DEFAULT_COLUMNS_GAP = 8;

export const DEFAULT_COLUMN_BACKGROUND_COLOR = 'transparent';
export const DEFAULT_COLUMN_BORDER_RADIUS = 0;
export const DEFAULT_COLUMN_BORDER_WIDTH = 0;
export const DEFAULT_COLUMN_BORDER_COLOR = 'transparent';

export const DEFAULT_COLUMN_PADDING_TOP = 0;
export const DEFAULT_COLUMN_PADDING_RIGHT = 0;
export const DEFAULT_COLUMN_PADDING_BOTTOM = 0;
export const DEFAULT_COLUMN_PADDING_LEFT = 0;

export const DEFAULT_INLINE_IMAGE_HEIGHT = 20;
export const DEFAULT_INLINE_IMAGE_WIDTH = 20;

// WS4 addition (fidelity gap 1 fix, 2026-07-29): an unfilled `pwBleedImage`
// slot's placeholder band — see that method's doc. Deliberately theme-agnostic
// hardcoded neutrals, not a `ThemeOptions` field: `DEFAULT_RENDERER_THEME`
// (`theme.ts`) carries no "muted surface" token to borrow (that table only
// ever styled real content), and this repo's standing decision is that page-
// level brand colour lives IN THE DOCUMENT (`doc.attrs.pwCanvasColor` — see
// `renderEmail.ts`'s `renderEmailTiptap`), not a theme table — so this stays
// a fixed, always-legible grey rather than growing a second colour knob.
export const PW_BLEED_IMAGE_PLACEHOLDER_HEIGHT = 96;
export const PW_BLEED_IMAGE_PLACEHOLDER_BG = '#F3F4F6';
export const PW_BLEED_IMAGE_PLACEHOLDER_FG = '#6B7280';
export const PW_BLEED_IMAGE_PLACEHOLDER_LABEL = 'Artwork slot';

export const LINK_PROTOCOL_REGEX = /https?:\/\//;

export const DEFAULT_META_TAGS: MetaDescriptors = [
  {
    name: 'viewport',
    content: 'width=device-width',
  },
  {
    httpEquiv: 'X-UA-Compatible',
    content: 'IE=edge',
  },
  {
    name: 'x-apple-disable-message-reformatting',
  },
  {
    // http://www.html-5.com/metatags/format-detection-meta-tag.html
    // It will prevent iOS from automatically detecting possible phone numbers in a block of text
    name: 'format-detection',
    content: 'telephone=no,address=no,email=no,date=no,url=no',
  },
  {
    name: 'color-scheme',
    content: 'light',
  },
  {
    name: 'supported-color-schemes',
    content: 'light',
  },
];

export const DEFAULT_HTML_PROPS: HtmlProps = {
  lang: 'en',
  dir: 'ltr',
};

const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  pretty: false,
  plainText: false,
};

export interface RenderOptions {
  /**
   * The options object allows you to customize the output of the rendered
   * email.
   * - `pretty` - If `true`, the output will be formatted with indentation and
   *  line breaks.
   * - `plainText` - If `true`, the output will be plain text instead of HTML.
   * This is useful for testing purposes.
   *
   * Default: `pretty` - `false`, `plainText` - `false`
   */
  pretty?: boolean;
  plainText?: boolean;
}

export type VariableFormatter = (options: {
  variable: string;
  fallback?: string;
}) => string;
export type VariableValues = Map<string, string>;
export type LinkValues = Map<string, string>;

export type PayloadValue = Record<string, any> | boolean;
export type PayloadValues = Map<string, PayloadValue>;

export class Maily {
  readonly preheader = new Preheader(this);

  private readonly content: JSONContent;
  // DEVIATION FROM UPSTREAM (2026-07-29, WS0 spike vendoring pass): the
  // original field initializer here is `theme: DEFAULT_THEME` — the SAME
  // module-level object every `Maily` instance starts with, not a copy.
  // `setTheme` below then calls `deepMerge(this.config.theme || DEFAULT_THEME,
  // theme)`, and `deepMerge` MUTATES its first argument in place. First
  // instance in a process to call `setTheme` permanently corrupts the shared
  // `DEFAULT_RENDERER_THEME` constant for every OTHER `Maily` instance built
  // afterwards in the same isolate — exactly the shape of bug that would
  // silently bleed one campaign's/recipient's theme into another's in the
  // send loop this plan describes (one `Maily` per recipient, same
  // invocation). `structuredClone` gives each instance its own theme object
  // instead. Caught during Bet 2's spike, not upstream behavior we chose —
  // see docs/plans/maily-editor-overhaul.md's WS0 report.
  private config: MailyConfig = {
    theme: structuredClone(DEFAULT_THEME),
  };

  private variableFormatter: VariableFormatter = ({ variable, fallback }) => {
    return fallback
      ? `{{${variable},fallback=${fallback}}}`
      : `{{${variable}}}`;
  };

  private shouldReplaceVariableValues = false;
  private variableValues: VariableValues = new Map();
  private linkValues: LinkValues = new Map();
  private openTrackingPixel: string | undefined;
  private payloadValues: PayloadValues = new Map();
  private marksOrder = ['underline', 'bold', 'italic', 'textStyle', 'link'];
  // Same class of bug as `config.theme` above (2026-07-29 deviation):
  // upstream initializes this to the shared `DEFAULT_META_TAGS` array
  // reference, and `setMetaTags` below does `this.meta.push(...)` — an
  // in-place mutation of that shared module-level array. A single caller
  // anywhere in the process invoking `setMetaTags` would permanently grow
  // every future `Maily` instance's meta tags (including the `color-scheme`/
  // `supported-color-schemes` entries Bet 3's postprocessing targets). A
  // shallow copy is enough here (entries themselves are never mutated, only
  // the array is pushed to).
  private meta: MetaDescriptors = [...DEFAULT_META_TAGS];
  private htmlProps: HtmlProps = DEFAULT_HTML_PROPS;

  constructor(content: JSONContent = { type: 'doc', content: [] }) {
    this.content = content;
  }

  setPreviewText(preview?: string | JSONContent) {
    this.config.preview = preview;
  }

  setTheme(theme: Partial<ThemeOptions>) {
    this.config.theme = deepMerge(
      this.config.theme || DEFAULT_THEME,
      theme
    ) as ThemeOptions;
  }

  setVariableFormatter(formatter: VariableFormatter) {
    this.variableFormatter = formatter;
  }

  /**
   * `setVariableValue` will set the variable value.
   * It will also set `shouldReplaceVariableValues` to `true`.
   *
   * @param variable - The variable name
   * @param value - The variable value
   */
  setVariableValue(variable: string, value: string) {
    if (!this.shouldReplaceVariableValues) {
      this.shouldReplaceVariableValues = true;
    }

    this.variableValues.set(variable, value);
  }

  /**
   * `setVariableValues` will set the variable values.
   * It will also set `shouldReplaceVariableValues` to `true`.
   *
   * @param values - The variable values
   *
   * @example
   * ```js
   * const maily = new Maily(content);
   * maily.setVariableValues({
   *  name: 'John Doe',
   *  email: 'john@doe.com',
   * });
   * ```
   */
  setVariableValues(values: Record<string, string>) {
    if (!this.shouldReplaceVariableValues) {
      this.shouldReplaceVariableValues = true;
    }

    Object.entries(values).forEach(([variable, value]) => {
      this.setVariableValue(variable, value);
    });
  }

  setLinkValue(link: string, value: string) {
    this.linkValues.set(link, value);
  }

  setLinkValues(values: Record<string, string>) {
    Object.entries(values).forEach(([link, value]) => {
      this.setLinkValue(link, value);
    });
  }

  setPayloadValue(key: string, value: PayloadValue) {
    if (!this.shouldReplaceVariableValues) {
      this.shouldReplaceVariableValues = true;
    }

    this.payloadValues.set(key, value);
  }

  setPayloadValues(values: Record<string, PayloadValue>) {
    Object.entries(values).forEach(([key, value]) => {
      this.setPayloadValue(key, value);
    });
  }

  /**
   * `setOpenTrackingPixel` will set the open tracking pixel.
   *
   * @param pixel - The open tracking pixel
   */
  setOpenTrackingPixel(pixel?: string) {
    this.openTrackingPixel = pixel;
  }

  /**
   * `setShouldReplaceVariableValues` will determine whether to replace the
   * variable values or not. Otherwise, it will just return the formatted variable.
   *
   * Default: `false`
   */
  setShouldReplaceVariableValues(shouldReplace: boolean) {
    this.shouldReplaceVariableValues = shouldReplace;
  }

  /**
   * `setMetaTags` will add the meta tags.
   *
   * @param meta - The meta tags
   */
  setMetaTags(meta: MetaDescriptors) {
    this.meta.push(...meta);
  }

  /**
   * `setHtmlProps` will set the HTML props.
   *
   * @param props - The HTML props
   */
  setHtmlProps(props: HtmlProps) {
    this.htmlProps = {
      ...this.htmlProps,
      ...props,
    };
  }

  getAllLinks() {
    const nodes = this.content.content || [];
    const links = new Set<string>();

    const isValidLink = (href: string) => {
      return (
        href &&
        this.isValidUrl(href) &&
        !href.startsWith('#') &&
        !href.startsWith('mailto:') &&
        !href.startsWith('tel:') &&
        typeof href === 'string'
      );
    };

    const extractLinksFromNode = (node: JSONContent) => {
      if (node.type === 'button') {
        const originalLink = node.attrs?.url;
        if (isValidLink(originalLink) && originalLink) {
          links.add(originalLink);
        }
      } else if (node.content) {
        node.content.forEach((childNode) => {
          if (childNode.marks) {
            childNode.marks.forEach((mark) => {
              const originalLink = mark.attrs?.href;
              if (mark.type === 'link' && isValidLink(originalLink)) {
                links.add(originalLink);
              }
            });
          }
          if (childNode.content) {
            extractLinksFromNode(childNode);
          }
        });
      }
    };

    nodes.forEach((childNode) => {
      extractLinksFromNode(childNode);
    });

    return links;
  }

  private isValidUrl(href: string) {
    try {
      const _ = new URL(href);
      return true;
    } catch (err) {
      return false;
    }
  }

  async render(
    options: RenderOptions = DEFAULT_RENDER_OPTIONS
  ): Promise<string> {
    const markup = this.markup();

    // `RenderOptions` (this class's own public, flat `{ pretty?, plainText? }`
    // shape — unchanged from upstream, kept stable for OUR callers) doesn't
    // structurally satisfy `@react-email/render@2.x`'s `Options` discriminated
    // union at the type level even though every value it can hold matches one
    // of that union's members at runtime. Cast at this one boundary rather
    // than reshape `RenderOptions` and ripple the discriminated union out to
    // every call site in this repo — see this file's top provenance comment
    // for why we're on 2.x at all.
    return reactEmailRenderAsync(
      markup,
      options as Parameters<typeof reactEmailRenderAsync>[1]
    );
  }

  /**
   * `children` will return the children of the content.
   * this is useful for rendering the content in a custom component.
   *
   * @returns The children of the content as JSX elements
   */
  children() {
    const nodes = this.content.content || [];
    return this.renderTopLevelRun(nodes);
  }

  // WS1 addition: factored out of the old `children()` body so `markup()`
  // can call it per-SEGMENT (see `renderSegmentedBody` below) while
  // `children()` itself keeps its exact original behavior — one flat run
  // over every top-level node — for the "render in a custom component"
  // callers its own doc describes.
  private renderTopLevelRun(nodes: JSONContent[]) {
    return nodes.map((node, index) => {
      const nodeOptions: NodeOptions = {
        prev: nodes[index - 1],
        next: nodes[index + 1],
        parent: node,
      };

      const component = this.renderNode(node, nodeOptions);
      if (!component) {
        return null;
      }

      return <Fragment key={generateKey()}>{component}</Fragment>;
    });
  }

  /**
   * WS1 addition: top-level nodes, split into SEGMENTS before `markup()`
   * places them — consecutive ordinary nodes share one themed `<Container>`
   * (upstream's only behavior), and each `pwBleedImage` node stands ALONE as
   * its own full-width `<table>` row rendered as a SIBLING of that
   * Container rather than a child of it.
   *
   * WHY (plan doc: "bleed image … emit the image OUTSIDE the padded
   * container … table row with full-width cell, not CSS tricks"):
   * `theme.container`'s horizontal padding (`DEFAULT_RENDERER_THEME.container
   * .paddingLeft/Right`) is a CSS style applied to the single shared
   * `<table>` react-email's `Container` renders (see
   * `@react-email/container`'s `container.tsx` — the padding lands on the
   * `<table>` tag itself, not on a per-child `<td>`), so nothing nested
   * INSIDE that one Container can locally opt out of it without a negative
   * margin cancelling the ancestor's own padding — exactly the CSS trick
   * the plan doc rules out (and one Outlook's Word engine tolerates poorly
   * regardless). Pulling the bleed node OUT of the Container instead gives
   * it a genuine `<table width="100%">` row with a zero-padding `<td>` — no
   * margin trick anywhere — at the cost of possibly more than one Container
   * per document instead of exactly one (invisible in the rendered output:
   * every Container shares the identical theme style, so a document with NO
   * `pwBleedImage` node produces byte-identical markup to before this
   * change — one segment, one Container, same props).
   */
  private renderSegmentedBody(): React.JSX.Element[] {
    const nodes = this.content.content || [];
    const containerStyles = this.config.theme?.container;

    type Segment = { bleed: boolean; nodes: JSONContent[] };
    const segments: Segment[] = [];
    for (const node of nodes) {
      const isBleed = node.type === 'pwBleedImage';
      const last = segments[segments.length - 1];
      if (!isBleed && last && !last.bleed) {
        last.nodes.push(node);
      } else {
        segments.push({ bleed: isBleed, nodes: [node] });
      }
    }

    return segments.map((seg) => {
      const rendered = this.renderTopLevelRun(seg.nodes);
      if (seg.bleed) {
        return <Fragment key={generateKey()}>{rendered}</Fragment>;
      }
      return (
        <Container
          key={generateKey()}
          // `pw-container` is a WS1 addition (not upstream): maily's own
          // Container carries no class/id hook at all, so the compliance
          // shell's dark-mode `<style>` block (`renderEmail.ts`) has nothing
          // stable to target for the container's own background without
          // this. Purely additive — an unstyled class name changes nothing
          // about the light rendering.
          className="pw-container"
          style={{
            width: '100%',
            marginLeft: 'auto',
            marginRight: 'auto',
            borderStyle: 'solid',
            ...containerStyles,
          }}
        >
          {rendered}
        </Container>
      );
    });
  }

  /**
   * `markup` will render the JSON content into React Email markup.
   * and return the raw React Tree.
   */
  markup() {
    const { preview } = this.config;
    const tags = meta(this.meta);
    const htmlProps = this.htmlProps;
    const fontOptions: FontProps = {
      ...(this.config.theme?.font || DEFAULT_FONT),
      fontStyle: 'normal',
      fontWeight: 400,
    };

    const bodyStyles: CSSProperties = {
      margin: '0px',
      ...this.config.theme?.body,
    };

    const preheader = preview ? this.preheader.render(preview) : null;
    const body = this.renderSegmentedBody();

    const markup = (
      <Html {...htmlProps}>
        <Head>
          <Font {...fontOptions} />

          <style
            dangerouslySetInnerHTML={{
              __html: /* css */ `blockquote,h1,h2,h3,img,li,ol,p,ul{margin-top:0;margin-bottom:0}@media only screen and (max-width:425px){.tab-row-full{width:100%!important}.tab-col-full{display:block!important;width:100%!important}.tab-pad{padding:0!important}}`,
            }}
          />
          {tags}
        </Head>
        <Body style={bodyStyles}>
          {preheader ? <Preview>{preheader}</Preview> : null}
          {body}
          {this.openTrackingPixel ? (
            <Img
              alt=""
              src={this.openTrackingPixel}
              style={{
                display: 'none',
                width: '1px',
                height: '1px',
              }}
            />
          ) : null}
        </Body>
      </Html>
    );

    return markup;
  }

  private getMarginOverrideConditions(
    node: JSONContent,
    options?: NodeOptions
  ) {
    const { parent, prev, next } = options || {};

    const isNextSpacer = next?.type === 'spacer';
    const isPrevSpacer = prev?.type === 'spacer';

    const isParentListItem = parent?.type === 'listItem';

    const isLastSectionElement = parent?.type === 'section' && !next;
    const isFirstSectionElement = parent?.type === 'section' && !prev;

    const isLastColumnElement = parent?.type === 'column' && !next;
    const isFirstColumnElement = parent?.type === 'column' && !prev;

    const isFirstRepeatElement = parent?.type === 'repeat' && !prev;
    const isLastRepeatElement = parent?.type === 'repeat' && !next;

    const isFirstShowElement = parent?.type === 'show' && !prev;
    const isLastShowElement = parent?.type === 'show' && !next;

    return {
      isNextSpacer,
      isPrevSpacer,
      isLastSectionElement,
      isFirstSectionElement,
      isParentListItem,
      isLastColumnElement,
      isFirstColumnElement,
      isFirstRepeatElement,
      isLastRepeatElement,
      isFirstShowElement,
      isLastShowElement,

      shouldRemoveTopMargin:
        isPrevSpacer ||
        isFirstSectionElement ||
        isFirstColumnElement ||
        isFirstRepeatElement ||
        isFirstShowElement,
      shouldRemoveBottomMargin:
        isNextSpacer ||
        isLastSectionElement ||
        isLastColumnElement ||
        isLastRepeatElement ||
        isLastShowElement,
    };
  }

  // `getMappedContent` will call corresponding node type
  // and return text content
  private getMappedContent(
    node: JSONContent,
    options?: NodeOptions
  ): React.JSX.Element[] {
    const allNodes = node.content || [];
    return allNodes
      .map((childNode, index) => {
        const component = this.renderNode(childNode, {
          ...options,
          next: allNodes[index + 1],
          prev: allNodes[index - 1],
        });
        if (!component) {
          return null;
        }

        return <Fragment key={generateKey()}>{component}</Fragment>;
      })
      .filter((n) => n !== null) as React.JSX.Element[];
  }

  // `renderNode` will call the method of the corresponding node type
  private renderNode(
    node: JSONContent,
    options: NodeOptions = {}
  ): React.JSX.Element | null {
    const type = node.type || '';

    if (type in this) {
      // @ts-expect-error - `this` is not assignable to type 'never'
      return this[type]?.(node, options) as React.JSX.Element;
    }

    throw new Error(`Node type "${type}" is not supported.`);
  }

  // `renderMark` will call the method of the corresponding mark type
  private renderMark(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    // It will wrap the text with the corresponding mark type
    const text = node?.text || <>&nbsp;</>;
    let marks = node?.marks || [];
    // sort the marks by uderline, bold, italic, textStyle, link
    // so that the text will be wrapped in the correct order
    marks.sort((a, b) => {
      return this.marksOrder.indexOf(a.type) - this.marksOrder.indexOf(b.type);
    });

    return marks.reduce(
      (acc, mark) => {
        const type = mark.type;
        if (type in this) {
          // @ts-expect-error - `this` is not assignable to type 'never'
          return this[type]?.(mark, acc, options) as React.JSX.Element;
        }

        throw new Error(`Mark type "${type}" is not supported.`);
      },
      <>{text}</>
    );
  }

  private paragraph(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const alignment = attrs?.textAlign || 'left';
    const textDirection = attrs?.textDirection || 'ltr';
    const { isParentListItem, shouldRemoveBottomMargin } =
      this.getMarginOverrideConditions(node, options);

    const show = this.shouldShow(node, options);
    if (!show) {
      return <></>;
    }

    const marginBottom = isParentListItem || shouldRemoveBottomMargin ? 0 : 20;

    return (
      <Text
        style={{
          ...(alignment !== 'left' ? { textAlign: alignment } : {}),
          ...(textDirection !== 'ltr' ? { direction: textDirection } : {}),
          ...antialiased,
          fontSize: this.config.theme?.fontSize?.paragraph?.size,
          lineHeight: this.config.theme?.fontSize?.paragraph?.lineHeight,
          color: this.config.theme?.colors?.paragraph,
          margin: `0 0 ${marginBottom}px 0`,
        }}
      >
        {node.content ? (
          this.getMappedContent(node, {
            ...options,
            parent: node,
          })
        ) : (
          <>&nbsp;</>
        )}
      </Text>
    );
  }

  private text(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    if (node.marks) {
      return this.renderMark(node, options);
    }

    const text = node.text;
    // if it's all empty, return an invisible space length
    // of the text so that it doesn't look empty for inline-images
    const spaces = text?.match(/\s/g);
    if (spaces && spaces.length === text?.length) {
      return (
        <>
          {spaces.map((_, index) => (
            <Fragment key={index}>&nbsp;</Fragment>
          ))}
        </>
      );
    }

    return text ? <>{text}</> : <>&nbsp;</>;
  }

  private bold(_: MarkType, text: React.JSX.Element): React.JSX.Element {
    return <strong>{text}</strong>;
  }

  private italic(_: MarkType, text: React.JSX.Element): React.JSX.Element {
    return <em>{text}</em>;
  }

  private underline(_: MarkType, text: React.JSX.Element): React.JSX.Element {
    return <u>{text}</u>;
  }

  private strike(_: MarkType, text: React.JSX.Element): React.JSX.Element {
    return <s style={{ textDecoration: 'line-through' }}>{text}</s>;
  }

  private textStyle(mark: MarkType, text: React.JSX.Element): React.JSX.Element {
    const { attrs } = mark;
    const { color = this.config.theme?.colors?.paragraph, letterSpacing } = attrs || {};

    return (
      <span
        style={{
          color,
          // WS1 addition (not upstream): maily has NO tracking concept
          // anywhere (see the plan doc's recon) — `letterSpacing` is only
          // ever applied when the mark actually carries a string value, so
          // every existing document (never setting it) renders identically
          // to before.
          ...(typeof letterSpacing === 'string' && letterSpacing ? { letterSpacing } : {}),
        }}
      >
        {text}
      </span>
    );
  }

  private link(
    mark: MarkType,
    text: React.JSX.Element,
    options?: NodeOptions
  ): React.JSX.Element {
    const { attrs } = mark;

    const linkTheme = this.config.theme?.link;

    let href = attrs?.href || '#';
    const target = attrs?.target || '_blank';
    const rel = attrs?.rel || 'noopener noreferrer nofollow';
    const isUrlVariable = attrs?.isUrlVariable ?? false;

    if (isUrlVariable) {
      const linkWithoutProtocol = this.removeLinkProtocol(href);
      href = this.variableUrlValue(linkWithoutProtocol, options);
    } else {
      href = this.linkValues.get(href) || href;
    }
    // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review HIGH fix): the
    // write gate's scheme allowlist (`tiptapEmail.ts#checkUrlAttr`) skips
    // this attr entirely when `isUrlVariable` is true — the doc only ever
    // held a variable NAME, not a URL, so there was nothing to check at
    // write time. `variableUrlValue`/`linkValues` above resolve that name to
    // a real value with no scheme check of their own upstream, so a hostile
    // `variableValues` entry (a recipient's own profile name, see
    // `urlSanitize.ts`'s module doc) reached a real `href` unchecked. Gated
    // here, post-resolution, same as every other sink in this class now.
    href = safeRenderHref(href);

    return (
      <Link
        href={href}
        rel={rel}
        style={{
          fontWeight: 500,
          textDecoration: 'none',
          color: linkTheme?.color || DEFAULT_LINK_TEXT_COLOR,
        }}
        target={target}
      >
        {text}
      </Link>
    );
  }

  private removeLinkProtocol(href: string) {
    return href.replace(LINK_PROTOCOL_REGEX, '');
  }

  private variableUrlValue(href: string, options?: NodeOptions) {
    const { payloadValue } = options || {};
    const linkWithoutProtocol = this.removeLinkProtocol(href);

    if (!this.shouldReplaceVariableValues) {
      return this.variableFormatter({
        variable: linkWithoutProtocol,
      });
    }

    return (
      (typeof payloadValue === 'object'
        ? payloadValue[linkWithoutProtocol]
        : payloadValue) ??
      this.variableValues.get(linkWithoutProtocol) ??
      href
    );
  }

  private heading(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;

    // DEVIATION FROM UPSTREAM (WS1, 2026-07-29): upstream's `level` here is
    // `\`h${Number(attrs?.level) || 1}\`` with no bound on the result —
    // `attrs.level = 4` (or any number outside 1-3, including negatives and
    // non-integers) produces `"h4"`, and `headings['h4']` below is
    // `undefined`. Destructuring `{ fontSize, lineHeight, fontWeight }` from
    // `undefined` THROWS, uncaught, inside a per-recipient send loop — the
    // third upstream bug found while vendoring (see the two "DEVIATION FROM
    // UPSTREAM" notes on `config`/`meta` above for the first two). Clamped
    // to the three levels this class actually has a size for; the write
    // gate (`validateTiptapEmailDoc`'s `headingLevelIsSafe`, mirroring this
    // exact coercion) rejects an out-of-range level before it ever reaches
    // here, but this clamp is what makes that correspondence TRUE rather
    // than merely intended.
    const rawLevel = Number(attrs?.level) || 1;
    const level = HEADING_LEVEL_KEYS.has(rawLevel as AllowedHeadingLevel)
      ? (`h${rawLevel}` as AllowedHeadings)
      : 'h1';
    const textDirection = attrs?.textDirection || 'ltr';
    const isRtl = textDirection === 'rtl';
    const defaultAlignment = isRtl ? 'right' : 'left';
    const alignment = attrs?.textAlign || defaultAlignment;
    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );
    const { fontSize, lineHeight, fontWeight } = headings[level];

    const show = this.shouldShow(node, options);
    if (!show) {
      return <></>;
    }

    return (
      <Heading
        as={level}
        style={{
          ...(alignment !== 'left' ? { textAlign: alignment } : {}),
          ...(isRtl ? { direction: textDirection } : {}),
          color: this.config.theme?.colors?.heading,
          fontSize,
          lineHeight,
          fontWeight,
        }}
        mb={shouldRemoveBottomMargin ? 0 : 12}
        mt={0}
        mx={0}
      >
        {this.getMappedContent(node, {
          ...options,
          parent: node,
        })}
      </Heading>
    );
  }

  /**
   * `pwHeading` — the Public Worship node pack's free-form heading (see the
   * plan doc's recon: stock `heading` is hardcoded to three size/weight
   * triples, "the typographic finish is not" expressible in stock nodes).
   * `fontSize`/`lineHeight`/`letterSpacing`/`color` are free; any left unset
   * falls back to the SAME `headings[level]` triple `heading()` uses, so an
   * un-customized `pwHeading` renders identically to a stock heading of that
   * level. `level` gets the identical throw-guard as `heading()` above —
   * same bug, same fix, because this shares that lookup table.
   */
  private pwHeading(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;

    const rawLevel = Number(attrs?.level) || 2;
    const level = HEADING_LEVEL_KEYS.has(rawLevel as AllowedHeadingLevel)
      ? (`h${rawLevel}` as AllowedHeadings)
      : 'h2';
    const defaults = headings[level];

    const textDirection = attrs?.textDirection || 'ltr';
    const isRtl = textDirection === 'rtl';
    const defaultAlignment = isRtl ? 'right' : 'left';
    const alignment = attrs?.textAlign || defaultAlignment;
    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    const show = this.shouldShow(node, options);
    if (!show) {
      return <></>;
    }

    const fontSize =
      typeof attrs?.fontSize === 'number' ? `${attrs.fontSize}px` : defaults.fontSize;
    const lineHeight =
      attrs?.lineHeight === undefined || attrs?.lineHeight === null
        ? defaults.lineHeight
        : typeof attrs.lineHeight === 'number'
          ? `${attrs.lineHeight}px`
          : String(attrs.lineHeight);
    const letterSpacing =
      typeof attrs?.letterSpacing === 'string' ? attrs.letterSpacing : undefined;
    const color =
      typeof attrs?.color === 'string' ? attrs.color : this.config.theme?.colors?.heading;

    return (
      <Heading
        as={level}
        style={{
          ...(alignment !== 'left' ? { textAlign: alignment } : {}),
          ...(isRtl ? { direction: textDirection } : {}),
          color,
          fontSize,
          lineHeight,
          ...(letterSpacing ? { letterSpacing } : {}),
          fontWeight: defaults.fontWeight,
        }}
        mb={shouldRemoveBottomMargin ? 0 : 12}
        mt={0}
        mx={0}
      >
        {this.getMappedContent(node, {
          ...options,
          parent: node,
        })}
      </Heading>
    );
  }

  /**
   * `pwParagraph` — a paragraph with its OWN `fontSize`/`lineHeight`,
   * overriding the document-global `theme.fontSize.paragraph` (see the plan
   * doc's recon: "paragraph size is one global value per document" —
   * PW's testimonial-at-20px-in-a-16px-body case). Unset falls back to the
   * theme value, i.e. identical to a stock `paragraph`.
   *
   * Asymmetric with `pwHeading`, which grew a per-node `color` attr in the
   * same pass: `pwParagraph` never did, so a per-run colour still has to go
   * through the `textStyle` mark's `color` instead of an attr here (see
   * `tiptapNewsletterTemplate.ts`'s `styledText` helper, which exists
   * entirely because of this gap) — accepted for now, not a bug to silently
   * work around.
   */
  private pwParagraph(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const alignment = attrs?.textAlign || 'left';
    const textDirection = attrs?.textDirection || 'ltr';
    const { isParentListItem, shouldRemoveBottomMargin } =
      this.getMarginOverrideConditions(node, options);

    const show = this.shouldShow(node, options);
    if (!show) {
      return <></>;
    }

    const marginBottom = isParentListItem || shouldRemoveBottomMargin ? 0 : 20;
    const fontSize =
      typeof attrs?.fontSize === 'number'
        ? `${attrs.fontSize}px`
        : this.config.theme?.fontSize?.paragraph?.size;
    const lineHeight =
      attrs?.lineHeight === undefined || attrs?.lineHeight === null
        ? this.config.theme?.fontSize?.paragraph?.lineHeight
        : typeof attrs.lineHeight === 'number'
          ? `${attrs.lineHeight}px`
          : String(attrs.lineHeight);

    return (
      <Text
        style={{
          ...(alignment !== 'left' ? { textAlign: alignment } : {}),
          ...(textDirection !== 'ltr' ? { direction: textDirection } : {}),
          ...antialiased,
          fontSize,
          lineHeight,
          color: this.config.theme?.colors?.paragraph,
          margin: `0 0 ${marginBottom}px 0`,
        }}
      >
        {node.content ? (
          this.getMappedContent(node, {
            ...options,
            parent: node,
          })
        ) : (
          <>&nbsp;</>
        )}
      </Text>
    );
  }

  private variable(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { payloadValue } = options || {};
    const { id: variable, fallback } = node.attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow || !variable) {
      return <></>;
    }

    const formattedVariable = this.getVariableValue(
      variable,
      fallback,
      options
    );

    if (node?.marks) {
      return this.renderMark(
        {
          text: formattedVariable,
          marks: node.marks,
        },
        options
      );
    }

    return <>{formattedVariable}</>;
  }

  getVariableValue(variable: string, fallback?: string, options?: NodeOptions) {
    const { payloadValue } = options || {};

    let formattedVariable = this.variableFormatter({
      variable,
      fallback,
    });

    // If `shouldReplaceVariableValues` is true, replace the variable values
    // Otherwise, just return the formatted variable
    if (this.shouldReplaceVariableValues) {
      formattedVariable =
        (typeof payloadValue === 'object'
          ? payloadValue[variable]
          : payloadValue) ??
        this.variableValues.get(variable) ??
        fallback ??
        formattedVariable;
    }

    return formattedVariable;
  }

  private horizontalRule(_: JSONContent, __?: NodeOptions): React.JSX.Element {
    return (
      <Hr
        style={{
          marginTop: '32px',
          marginBottom: '32px',
        }}
      />
    );
  }

  private orderedList(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    return (
      <Container
        style={{
          marginTop: '0px',
          marginBottom: shouldRemoveBottomMargin ? '0' : '20px',
        }}
      >
        <ol
          style={{
            paddingLeft: '26px',
            listStyleType: 'decimal',
          }}
        >
          {this.getMappedContent(node, {
            ...options,
            parent: node,
          })}
        </ol>
      </Container>
    );
  }

  private bulletList(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { parent, next } = options || {};
    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      {
        parent,
        next,
      }
    );

    return (
      <Container
        style={{
          maxWidth: '100%',
          marginTop: '0px',
          marginBottom: shouldRemoveBottomMargin ? '0' : '20px',
        }}
      >
        <ul
          style={{
            paddingLeft: '26px',
            listStyleType: 'disc',
          }}
        >
          {this.getMappedContent(node, {
            ...options,
            parent: node,
          })}
        </ul>
      </Container>
    );
  }

  private listItem(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    return (
      <li
        style={{
          marginBottom: '8px',
          marginTop: '8px',
          paddingLeft: '6px',
          ...antialiased,
        }}
      >
        {this.getMappedContent(node, { ...options, parent: node })}
      </li>
    );
  }

  private button(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;

    const buttonTheme = this.config.theme?.button;

    let {
      text: _text,
      isTextVariable,
      url,
      isUrlVariable,
      variant,
      buttonColor: _buttonColor,
      textColor: _textColor,
      borderRadius,
      // @TODO: Update the attribute to `textAlign`
      alignment = 'left',

      paddingTop: _paddingTop,
      paddingRight: _paddingRight,
      paddingBottom: _paddingBottom,
      paddingLeft: _paddingLeft,
      // WS1 addition (not upstream): stock maily buttons cannot be width-
      // capped (see the plan doc's recon) — a long label stretches the
      // button edge-to-edge inside its `Container`. `maxWidth` (px) is
      // OPTIONAL; unset renders byte-identical to before.
      maxWidth: _maxWidth,
    } = attrs || {};

    const buttonColor = _buttonColor || buttonTheme?.backgroundColor;
    const textColor = _textColor || buttonTheme?.color;

    let paddingTop =
      parseInt(String(_paddingTop || buttonTheme?.paddingTop)) || 0;
    const paddingRight =
      parseInt(String(_paddingRight || buttonTheme?.paddingRight)) || 0;
    let paddingBottom =
      parseInt(String(_paddingBottom || buttonTheme?.paddingBottom)) || 0;
    const paddingLeft =
      parseInt(String(_paddingLeft || buttonTheme?.paddingLeft)) || 0;

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    let radius: string | undefined = '0px';
    if (borderRadius === 'round') {
      radius = '9999px';
    } else if (borderRadius === 'smooth') {
      radius = '6px';
    }

    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review HIGH fix): see
    // the `link` mark's matching comment above — `isUrlVariable`/`linkValues`
    // resolution has no scheme check of its own, so the result is gated here
    // before it becomes a real `href` (`safeRenderHref`, `urlSanitize.ts`).
    const href = safeRenderHref(
      isUrlVariable ? this.variableUrlValue(url, options) : this.linkValues.get(url) || url,
    );
    const text = isTextVariable ? this.variableUrlValue(_text, options) : _text;

    paddingTop += 2;
    paddingBottom += 2;

    // A positive, finite pixel cap: a button with `maxWidth` set fills up to
    // that width and no further (`width: 100%` + `maxWidth`, the same "cap
    // an inline-block" technique used elsewhere in this file's marks/cards),
    // instead of stretching to the Container's full width. Unset (or a bad
    // value) is exactly today's behavior.
    const maxWidthNum = Number(_maxWidth);
    const maxWidth =
      typeof _maxWidth === 'number' || typeof _maxWidth === 'string'
        ? Number.isFinite(maxWidthNum) && maxWidthNum > 0
          ? maxWidthNum
          : undefined
        : undefined;

    return (
      <Container
        style={{
          textAlign: alignment,
          maxWidth: '100%',
          marginBottom: shouldRemoveBottomMargin ? '0px' : '20px',
        }}
      >
        <Button
          href={href}
          style={{
            color: String(textColor),
            backgroundColor:
              variant === 'filled' ? String(buttonColor) : 'transparent',
            borderColor: String(buttonColor),
            borderWidth: '2px',
            borderStyle: 'solid',
            textDecoration: 'none',
            fontSize: '14px',
            fontWeight: 500,
            borderRadius: radius,
            padding: `${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px`,
            boxSizing: 'border-box',
            ...(maxWidth ? { maxWidth: `${maxWidth}px`, width: '100%' } : {}),
          }}
        >
          {text}
        </Button>
      </Container>
    );
  }

  private spacer(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const { height } = attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    return (
      <Container
        style={{
          height: `${height}px`,
        }}
      />
    );
  }

  private hardBreak(_: JSONContent, __?: NodeOptions): React.JSX.Element {
    return <br />;
  }

  private logo(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    let {
      src,
      isSrcVariable,
      alt,
      title,
      size,
      // @TODO: Update the attribute to `textAlign`
      alignment = 'left',
    } = attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review HIGH fix): see
    // the `link` mark's matching comment — `isSrcVariable` resolution has no
    // scheme check of its own, so the result is gated here (`safeRenderImageSrc`,
    // `urlSanitize.ts`) before it becomes a real `src`.
    src = safeRenderImageSrc(isSrcVariable ? this.variableUrlValue(src, options) : src);

    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    // DEVIATION FROM UPSTREAM (WS4, fidelity gap 3 fix, 2026-07-29): upstream
    // is `alt || title || 'Logo'`, which treats an authored `alt: ""` (the
    // legal "decorative, on purpose" value the write gate accepts — see
    // `tiptapEmail.ts`'s module doc) identically to a genuinely ABSENT alt,
    // overriding it with the literal word "Logo". Only a truly missing attr
    // (not a string at all) may fall back now; an authored empty string
    // survives as `alt=""`, matching the blocks renderer's
    // `cardImageHtml`/`renderFooterBlock` (`emailRender.ts`) which write
    // `alt="${content.imageAlt ?? ""}"` the same way.
    const hasAuthoredAlt = typeof alt === 'string';
    const logoAlt = hasAuthoredAlt ? alt : title || 'Logo';

    return (
      <Row
        style={{
          marginTop: '0px',
          marginBottom: shouldRemoveBottomMargin ? '0px' : '32px',
        }}
      >
        <Column align={alignment}>
          <Img
            alt={logoAlt}
            src={src}
            style={{
              width: logoSizes[size as AllowedLogoSizes] || size,
              height: logoSizes[size as AllowedLogoSizes] || size,
            }}
            title={title || alt || 'Logo'}
          />
        </Column>
      </Row>
    );
  }

  private image(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    let {
      src,
      isSrcVariable,
      alt,
      title,
      width = 'auto',
      alignment = 'center',
      externalLink = '',
      isExternalLinkVariable,
      borderRadius = 0,
    } = attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review HIGH fix): see
    // the `link` mark's matching comment — `isSrcVariable`/
    // `isExternalLinkVariable` resolution has no scheme check of its own, so
    // both results are gated here (`urlSanitize.ts`) before they become a
    // real `src`/`href`. `externalLink`'s gate keeps `"#"` un-passed-through
    // as a literal empty string on failure (not the href fallback `"#"`) so
    // the `externalLink ? <a>… : image` branch below still treats an
    // invalid/hostile link exactly like an absent one — no dead-link wrapper
    // around the image, matching this method's own pre-existing
    // falsy-means-unwrapped convention.
    src = safeRenderImageSrc(isSrcVariable ? this.variableUrlValue(src, options) : src);
    externalLink = safeRenderHref(
      isExternalLinkVariable ? this.variableUrlValue(externalLink, options) : externalLink,
      '',
    );

    // Handle width value
    const imageWidth = width === 'auto' ? 'auto' : Number(width);
    const widthStyle = imageWidth === 'auto' ? 'auto' : `${imageWidth}px`;

    // DEVIATION FROM UPSTREAM (WS4, fidelity gap 3 fix, 2026-07-29): upstream
    // is `alt || title || 'Image'`, which treats an authored `alt: ""` (the
    // write gate's legal "decorative, on purpose" value — see
    // `tiptapEmail.ts`'s module doc) identically to a genuinely ABSENT alt,
    // overriding it with the literal word "Image" — a real accessibility
    // regression versus the blocks renderer's `cardImageHtml`
    // (`emailRender.ts`), which writes `alt="${content.imageAlt ?? ""}"` and
    // lets an authored empty string survive. Every card photo in
    // `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP` ships `alt: ""` on purpose; only a
    // truly missing attr (not a string at all) may fall back here now.
    const hasAuthoredAlt = typeof alt === 'string';
    const imageAlt = hasAuthoredAlt ? alt : title || 'Image';

    const mainImage = (
      <Img
        alt={imageAlt}
        src={src}
        style={{
          width: widthStyle, // Use the calculated width
          height: 'auto', // Let height follow width to preserve aspect ratio
          maxWidth: '100%', // Ensure image doesn't overflow container
          outline: 'none',
          border: 'none',
          textDecoration: 'none',
          display: 'block', // Prevent unwanted spacing
          borderRadius,
        }}
        title={title || alt || 'Image'}
      />
    );

    return (
      <Row
        style={{
          marginTop: '0px',
          marginBottom: shouldRemoveBottomMargin ? '0px' : '32px',
        }}
      >
        <Column align={alignment}>
          {externalLink ? (
            <a
              href={externalLink}
              rel="noopener noreferrer"
              style={{
                display: 'block',
                maxWidth: '100%',
                textDecoration: 'none',
              }}
              target="_blank"
            >
              {mainImage}
            </a>
          ) : (
            mainImage
          )}
        </Column>
      </Row>
    );
  }

  private footer(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const { textAlign = 'left', textDirection = 'ltr' } = attrs || {};

    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    return (
      <Text
        style={{
          fontSize: this.config.theme?.fontSize?.footer?.size,
          lineHeight: this.config.theme?.fontSize?.footer?.lineHeight,
          color: this.config.theme?.colors?.footer,
          marginTop: '0px',
          marginBottom: shouldRemoveBottomMargin ? '0px' : '20px',
          textAlign,
          ...(textDirection !== 'ltr' ? { direction: textDirection } : {}),
          ...antialiased,
        }}
      >
        {this.getMappedContent(node, {
          ...options,
          parent: node,
        })}
      </Text>
    );
  }

  private blockquote(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { isPrevSpacer, shouldRemoveBottomMargin } =
      this.getMarginOverrideConditions(node, options);

    return (
      <blockquote
        style={{
          borderLeftWidth: '4px',
          borderLeftStyle: 'solid',
          borderLeftColor: this.config.theme?.colors?.blockquoteBorder,
          paddingLeft: '16px',
          marginLeft: '0px',
          marginRight: '0px',
          marginTop: isPrevSpacer ? '0px' : '20px',
          marginBottom: shouldRemoveBottomMargin ? '0px' : '20px',
        }}
      >
        {this.getMappedContent(node, {
          ...options,
          parent: node,
        })}
      </blockquote>
    );
  }
  private code(_: MarkType, text: React.JSX.Element): React.JSX.Element {
    return (
      <code
        style={{
          backgroundColor: this.config.theme?.colors?.codeBackground,
          color: this.config.theme?.colors?.codeText,
          padding: '2px 4px',
          borderRadius: '6px',
          fontFamily: CODE_FONT_FAMILY,
          fontWeight: 400,
          letterSpacing: 0,
        }}
      >
        {text}
      </code>
    );
  }
  private linkCard(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );

    const { title, description, link, linkTitle, image, badgeText, subTitle } =
      attrs || {};
    // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review HIGH fix):
    // `linkCard` has no `isXVariable` flag upstream — this lookup into
    // `variableValues` runs UNCONDITIONALLY, so an author who sets `link` to
    // the literal string `"firstName"` reaches the same hostile-recipient-
    // name vector as every `isXVariable`-flagged sink, with no flag for the
    // write gate to key off at all (see `tiptapEmail.ts#NODE_URL_ATTR_RULES`'s
    // comment on this node — it already documents this asymmetry and always
    // validates `link` as a literal URL for exactly this reason). The lookup
    // itself is kept (removing it would be a behavior change to a
    // load-bearing feature — an author WANTING `link` to reference a set
    // variable, upstream's actual intent for this field) and the chokepoint
    // covers it instead: gated below before it becomes a real `href`.
    const href = safeRenderHref(
      this.linkValues.get(link) || this.variableValues.get(link) || link || '#',
    );

    return (
      <a
        href={href}
        rel="noopener noreferrer"
        style={{
          border: '1px solid #eaeaea',
          borderRadius: '10px',
          textDecoration: 'none',
          color: 'inherit',
          display: 'block',
          marginBottom: shouldRemoveBottomMargin ? '0px' : '20px',
        }}
        target="_blank"
      >
        {image ? (
          <Row
            style={{
              marginBottom: '6px',
            }}
          >
            <Column
              style={{
                width: '100%',
                height: '100%',
              }}
            >
              <Img
                alt={title || 'Link Card'}
                src={image}
                style={{
                  borderRadius: '10px 10px 0 0',
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
                title={title || 'Link Card'}
              />
            </Column>
          </Row>
        ) : null}

        <Row
          style={{
            padding: '15px',
            marginTop: 0,
            marginBottom: 0,
          }}
        >
          <Column
            style={{
              verticalAlign: 'top',
            }}
          >
            <Row
              align={undefined}
              style={{
                marginBottom: '8px',
                marginTop: '0px',
              }}
              width="auto"
            >
              <Column>
                <Text
                  style={{
                    fontSize: '18px',
                    fontWeight: 600,
                    color: this.config.theme?.colors?.linkCardTitle,
                    margin: '0px',
                    ...antialiased,
                  }}
                >
                  {title}
                </Text>
              </Column>
              {badgeText || subTitle ? (
                <Column
                  style={{
                    paddingLeft: '6px',
                    verticalAlign: 'middle',
                  }}
                >
                  {badgeText ? (
                    <span
                      style={{
                        fontWeight: 600,
                        color: this.config.theme?.colors?.linkCardBadgeText,
                        padding: '4px 8px',
                        borderRadius: '8px',
                        backgroundColor:
                          this.config.theme?.colors?.linkCardBadgeBackground,
                        fontSize: '12px',
                        lineHeight: '12px',
                      }}
                    >
                      {badgeText}
                    </span>
                  ) : null}{' '}
                  {subTitle && !badgeText ? (
                    <span
                      style={{
                        fontWeight: 'normal',
                        color: this.config.theme?.colors?.linkCardSubTitle,
                        fontSize: '12px',
                        lineHeight: '12px',
                      }}
                    >
                      {subTitle}
                    </span>
                  ) : null}
                </Column>
              ) : null}
            </Row>
            <Text
              style={{
                fontSize: '16px',
                color: this.config.theme?.colors?.linkCardDescription,
                marginTop: '0px',
                marginBottom: '0px',
                ...antialiased,
              }}
            >
              {description}{' '}
              {linkTitle ? (
                <a
                  href={href}
                  rel="noopener noreferrer"
                  style={{
                    color: this.config.theme?.colors?.linkCardTitle,
                    fontSize: '14px',
                    fontWeight: 600,
                    textDecoration: 'underline',
                  }}
                >
                  {linkTitle}
                </a>
              ) : null}
            </Text>
          </Column>
        </Row>
      </a>
    );
  }

  private section(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const {
      borderRadius = 0,
      backgroundColor = DEFAULT_SECTION_BACKGROUND_COLOR,
      align = DEFAULT_SECTION_ALIGN,
      borderWidth = DEFAULT_SECTION_BORDER_WIDTH,
      borderColor = DEFAULT_SECTION_BORDER_COLOR,

      marginTop = DEFAULT_SECTION_MARGIN_TOP,
      marginRight = DEFAULT_SECTION_MARGIN_RIGHT,
      marginBottom = DEFAULT_SECTION_MARGIN_BOTTOM,
      marginLeft = DEFAULT_SECTION_MARGIN_LEFT,

      paddingTop = DEFAULT_SECTION_PADDING_TOP,
      paddingRight = DEFAULT_SECTION_PADDING_RIGHT,
      paddingBottom = DEFAULT_SECTION_PADDING_BOTTOM,
      paddingLeft = DEFAULT_SECTION_PADDING_LEFT,
    } = attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    return (
      <Row
        style={{
          marginTop,
          marginRight,
          marginBottom,
          marginLeft,
        }}
      >
        <Column
          align={align}
          style={{
            borderColor,
            borderWidth,
            borderStyle: 'solid',
            backgroundColor,
            borderRadius,

            paddingTop,
            paddingRight,
            paddingBottom,
            paddingLeft,
          }}
        >
          {this.getMappedContent(node, {
            ...options,
            parent: node,
          })}
        </Column>
      </Row>
    );
  }

  private columns(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    const [newNode, totalWidth] = this.adjustColumnsContent(node);

    return (
      <Row
        width={`${totalWidth}%`}
        style={{
          margin: 0,
          padding: 0,
          width: `${totalWidth}%`,
        }}
        className="tab-row-full"
      >
        {this.getMappedContent(newNode, {
          ...options,
          parent: newNode,
        })}
      </Row>
    );
  }

  private adjustColumnsContent(node: JSONContent): [JSONContent, number] {
    const { content = [] } = node;
    const totalWidth = 100;
    const columnsWithWidth = content.filter(
      (c) => c.type === 'column' && Boolean(Number(c.attrs?.width || 0))
    );
    const autoWidthColumns = content.filter(
      (c) =>
        c.type === 'column' && (c.attrs?.width === 'auto' || !c.attrs?.width)
    );

    const totalWidthUsed = columnsWithWidth.reduce(
      (acc, c) => acc + Number(c.attrs?.width),
      0
    );

    const remainingWidth = totalWidth - totalWidthUsed;
    const measuredWidth = Math.round(remainingWidth / autoWidthColumns.length);

    const columnCount = content.filter((c) => c.type === 'column').length;
    const gap = node.attrs?.gap ?? DEFAULT_COLUMNS_GAP;

    return [
      {
        ...node,
        content: content.map((c, index) => {
          const isAutoWidthColumn =
            c.type === 'column' &&
            (c.attrs?.width === 'auto' || !c.attrs?.width);
          const isFirstColumn = index === 0;
          const isMiddleColumn = index > 0 && index < columnCount - 1;
          const isLastColumn = index === content.length - 1;

          let paddingLeft = 0;
          let paddingRight = 0;

          // For 2 columns, apply a simple gap logic
          if (columnCount < 3) {
            paddingLeft = isFirstColumn ? 0 : gap / 2;
            paddingRight = isLastColumn ? 0 : gap / 2;
          } else {
            // For more than 2 columns, apply more gap in the first and last columns
            // and less gap in the middle columns to make it look more balanced
            // because the first and last columns have more space to fill
            const leftAndRightPadding = (gap / 2) * 1.5;
            const middleColumnPadding = leftAndRightPadding / 2;

            paddingLeft = isFirstColumn
              ? 0
              : isMiddleColumn
                ? middleColumnPadding
                : leftAndRightPadding;
            paddingRight = isLastColumn
              ? 0
              : isMiddleColumn
                ? middleColumnPadding
                : leftAndRightPadding;
          }

          paddingLeft = Math.round(paddingLeft * 100) / 100;
          paddingRight = Math.round(paddingRight * 100) / 100;

          return {
            ...c,
            attrs: {
              ...c.attrs,
              width: isAutoWidthColumn ? measuredWidth : c.attrs?.width,

              isFirstColumn,
              isLastColumn,
              index,

              paddingLeft,
              paddingRight,
            },
          };
        }),
      },
      autoWidthColumns.length === 0
        ? Math.min(totalWidth, totalWidthUsed)
        : totalWidth,
    ];
  }

  private column(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const {
      width,
      verticalAlign = 'top',
      paddingLeft = 0,
      paddingRight = 0,
    } = attrs || {};

    return (
      <Column
        width={`${Number(width)}%`}
        style={{
          width: `${Number(width)}%`,
          margin: 0,
          verticalAlign,
        }}
        className="tab-col-full"
      >
        <Section
          style={{
            margin: 0,
            paddingLeft,
            paddingRight,
          }}
          className="tab-pad"
        >
          {this.getMappedContent(node, {
            ...options,
            parent: node,
          })}
        </Section>
      </Column>
    );
  }

  private repeat(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const { each = '' } = attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    let { payloadValue } = options || {};
    payloadValue = typeof payloadValue === 'object' ? payloadValue : {};

    const values = this.payloadValues.get(each) ?? payloadValue[each] ?? [];
    if (!Array.isArray(values)) {
      throw new Error(`Payload value for each "${each}" is not an array`);
    }

    return (
      <>
        {values.map((value) => {
          return (
            <Fragment key={generateKey()}>
              {this.getMappedContent(node, {
                ...options,
                parent: node,
                payloadValue: value,
              })}
            </Fragment>
          );
        })}
      </>
    );
  }

  /**
   * @deprecated
   * This for node is an alias for the repeat node
   * we will remove this in the future
   * @param node
   * @param options
   * @returns React.JSX.Element
   */
  private for(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    return this.repeat(node, options);
  }

  private shouldShow(node: JSONContent, options?: NodeOptions): boolean {
    const showIfKey = node?.attrs?.showIfKey ?? '';
    if (!showIfKey) {
      return true;
    }

    let { payloadValue } = options || {};
    payloadValue = typeof payloadValue === 'object' ? payloadValue : {};
    return !!(this.payloadValues.get(showIfKey) ?? payloadValue[showIfKey]);
  }

  htmlCodeBlock(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const show = this.shouldShow(node, options);
    if (!show) {
      return <></>;
    }

    // the text can be a proper html code block
    // or only the body of the html
    // so we need to wrap it in a proper html tag
    const text =
      node.content?.reduce((acc, n) => {
        if (n?.type === 'text') {
          return acc + n?.text;
        } else if (n?.type === 'variable') {
          const value = this.getVariableValue(
            n?.attrs?.id,
            n?.attrs?.fallback,
            options
          );
          return acc + value;
        }

        return acc;
      }, '') || '';

    // we will inline the css in the html
    // so that it can be rendered properly
    const inlineCssHtml = juice(text);
    const doc = parse(inlineCssHtml);
    const head = doc?.querySelector('head');
    head?.remove();
    const html = doc.toString();

    return (
      <table
        align="left"
        width="100%"
        border={0}
        cellPadding="0"
        cellSpacing="0"
        role="presentation"
      >
        <tbody>
          <tr style={{ width: '100%' }}>
            <td
              style={{ width: '100%' }}
              dangerouslySetInnerHTML={{
                __html: html,
              }}
            />
          </tr>
        </tbody>
      </table>
    );
  }

  private inlineImage(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    let {
      src,
      isSrcVariable,
      alt = '',
      title = '',
      height = DEFAULT_INLINE_IMAGE_HEIGHT,
      width = DEFAULT_INLINE_IMAGE_WIDTH,
      externalLink = '',
      isExternalLinkVariable,
    } = attrs || {};

    // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review HIGH fix): same
    // gate, same reasoning, as `image()` above.
    src = safeRenderImageSrc(isSrcVariable ? this.variableUrlValue(src, options) : src);
    externalLink = safeRenderHref(
      isExternalLinkVariable ? this.variableUrlValue(externalLink, options) : externalLink,
      '',
    );

    const image = (
      <img
        src={src}
        alt={alt}
        title={title}
        width={width}
        height={height}
        style={{
          display: 'inline',
          verticalAlign: 'middle',
          width: `${width}px`,
          height: `${height}px`,
          outline: 'none',
          border: 'none',
          textDecoration: 'none',
        }}
      />
    );

    if (!externalLink) {
      return image;
    }

    return (
      <a
        href={externalLink}
        rel="noopener noreferrer"
        style={{
          display: 'inline',
          textDecoration: 'none',
        }}
        target="_blank"
      >
        {image}
      </a>
    );
  }

  // ── WS1: The Public Worship node pack (continued) ─────────────────────────
  // `pwHeading`/`pwParagraph` (free typography) and the `textStyle`/`button`
  // extensions (letter-spacing, max-width) live inline next to the stock
  // methods they parallel, above. The two entirely-new SHAPES — an
  // edge-to-edge image and a poll — are grouped here instead.

  /**
   * `pwBleedImage` — an edge-to-edge image with NO container gutter (see the
   * plan doc's recon: stock maily has no such node; every stock `image` sits
   * inside the theme's container padding). Placed as its own top-level
   * SEGMENT by `renderSegmentedBody` (see that method's doc for why) so it
   * renders OUTSIDE the theme-padded `<Container>` instead of fighting it
   * with a negative margin — its own `<table>` therefore supplies zero
   * padding itself (`<td style={{ padding: 0 }}>`), capped at the theme's
   * own container `maxWidth` so it lines up with every other row's width.
   *
   * `src`/`href` are re-checked here (`safeRenderImageSrc`/`safeRenderHref`,
   * `urlSanitize.ts`) as defense-in-depth on top of the write gate
   * (`validateTiptapEmailDoc`) — this was the FIRST sink in this class to get
   * a post-resolution check (WS4) and every other href/src sink now shares
   * the exact same chokepoint (2026-07-29, adversarial-review HIGH fix) —
   * see `urlSanitize.ts`'s module doc for why the others didn't have one
   * until then.
   *
   * DEVIATION FROM UPSTREAM (WS4, fidelity gap 1 fix, 2026-07-29): this node
   * doesn't exist upstream at all (see the "provenance" comment atop this
   * file), so there's no prior behavior to preserve — but the FIRST version
   * of this method, written for WS1, returned an empty fragment for an
   * empty/invalid `src`, and WS4's fidelity gate (`newsletter.fidelity.
   * test.ts`) caught it: `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP` ships every
   * artwork slot with `src: ""` (mirroring the blocks format's convention),
   * and four of its eleven sections are `pwBleedImage` banners that carry
   * their section heading AS the artwork — a template sent before artwork
   * import silently lost those four sections' entire structure, with no
   * `<img>`, no alt text, no trace. The blocks format's equivalent
   * (`emailRender.ts#renderBleedImage`) never had this problem: an unfilled
   * slot there draws a dashed "add artwork" band carrying the block's `alt`.
   * Below mirrors that INTENT — a visible band that HOLDS THE GEOMETRY and
   * carries whatever words the node's `alt` has — without inventing a new
   * theme knob for it (see `PW_BLEED_IMAGE_PLACEHOLDER_*`'s own comment for
   * why those are fixed neutrals, not a `ThemeOptions` field). Zero external
   * requests (no `<img>` at all, so no broken-image icon either), and the
   * same Outlook-safe `<table>` shape as the filled path below.
   */
  private pwBleedImage(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    let { src, isSrcVariable, alt, href } = attrs || {};

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    src = safeRenderImageSrc(isSrcVariable ? this.variableUrlValue(src, options) : src);
    href = safeRenderHref(href ? this.linkValues.get(href) || href : href, '');

    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );
    const containerMaxWidth = this.config.theme?.container?.maxWidth;
    const maxWidth = typeof containerMaxWidth === 'string' ? containerMaxWidth : '600px';

    const tableStyle: CSSProperties = {
      width: '100%',
      maxWidth,
      marginLeft: 'auto',
      marginRight: 'auto',
      marginTop: 0,
      marginBottom: shouldRemoveBottomMargin ? 0 : 32,
    };

    if (!src) {
      const label =
        typeof alt === 'string' && alt.trim().length > 0
          ? alt
          : PW_BLEED_IMAGE_PLACEHOLDER_LABEL;

      return (
        <table
          align="center"
          width="100%"
          border={0}
          cellPadding="0"
          cellSpacing="0"
          role="presentation"
          style={tableStyle}
        >
          <tbody>
            <tr style={{ width: '100%' }}>
              <td
                align="center"
                valign="middle"
                style={{
                  padding: 0,
                  height: `${PW_BLEED_IMAGE_PLACEHOLDER_HEIGHT}px`,
                  background: PW_BLEED_IMAGE_PLACEHOLDER_BG,
                  textAlign: 'center',
                  fontFamily:
                    this.config.theme?.font?.fontFamily ||
                    'Inter,-apple-system,sans-serif',
                  fontSize: '13px',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: PW_BLEED_IMAGE_PLACEHOLDER_FG,
                }}
              >
                {label}
              </td>
            </tr>
          </tbody>
        </table>
      );
    }
    // `safeRenderHref(…, '')` above already resolved an invalid/missing href
    // to `''` (falsy) — `safeHref` here is just that value made explicitly
    // `undefined` for the `? :` below, matching this method's pre-existing
    // "falsy href means unwrapped image" convention (same as `image()`'s/
    // `inlineImage()`'s `externalLink`).
    const safeHref = href || undefined;

    const image = (
      <Img
        alt={alt || ''}
        src={src}
        style={{
          width: '100%',
          maxWidth: '100%',
          height: 'auto',
          display: 'block',
          border: 'none',
          outline: 'none',
        }}
      />
    );

    return (
      <table
        align="center"
        width="100%"
        border={0}
        cellPadding="0"
        cellSpacing="0"
        role="presentation"
        style={tableStyle}
      >
        <tbody>
          <tr style={{ width: '100%' }}>
            <td style={{ padding: 0 }}>
              {safeHref ? (
                <a
                  href={safeHref}
                  rel="noopener noreferrer"
                  style={{ display: 'block', textDecoration: 'none' }}
                  target="_blank"
                >
                  {image}
                </a>
              ) : (
                image
              )}
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  /**
   * `pwPoll` — question + option rows, each option a link/pill (see the plan
   * doc's recon: stock maily has no poll concept). The hrefs are per-
   * RECIPIENT vote URLs resolved through the SAME variable machinery every
   * other node in this class uses (`setVariableValues` before `.render()`),
   * keyed `pw_poll_<nodeId>_<optionId>_url` — mirroring
   * `packages/shared/src/emailRender.ts`'s `RenderEmailOptions.pollVoteUrl`
   * semantics exactly: the link lands on a CONFIRM page, never records a
   * vote on GET (Apple Mail Privacy Protection and corporate link scanners
   * fetch every href in a message before a human ever sees it — that GET/
   * POST split is the send loop's job, not this renderer's; this method only
   * emits whatever URL it's given). With no matching variable set for an
   * option (composer preview, `sendTest` — no recipient token to key a vote
   * to), that option renders as an inert, unclickable pill instead of a link
   * to a URL that would 404 — the same graceful-degradation the old
   * renderer's `renderPollBlock` uses.
   */
  private pwPoll(node: JSONContent, options?: NodeOptions): React.JSX.Element {
    const { attrs } = node;
    const pollId = typeof attrs?.id === 'string' ? attrs.id : '';
    const question = typeof attrs?.question === 'string' ? attrs.question : '';
    const pollOptions: { id?: unknown; label?: unknown }[] = Array.isArray(attrs?.options)
      ? attrs.options
      : [];

    const shouldShow = this.shouldShow(node, options);
    if (!shouldShow) {
      return <></>;
    }

    const { shouldRemoveBottomMargin } = this.getMarginOverrideConditions(
      node,
      options
    );
    const headingColor = this.config.theme?.colors?.heading;

    const optionRows = pollOptions
      .map((opt) => {
        if (typeof opt?.id !== 'string' || typeof opt?.label !== 'string') {
          return null;
        }
        const variableName = `pw_poll_${pollId}_${opt.id}_url`;
        const hasRealUrl = this.shouldReplaceVariableValues && this.variableValues.has(variableName);
        const optionStyle: CSSProperties = {
          display: 'block',
          padding: '12px 16px',
          border: '1px solid #E5E7EB',
          borderRadius: '8px',
          fontWeight: 600,
          fontSize: '14px',
          color: headingColor,
          textAlign: 'center',
          textDecoration: 'none',
        };

        return (
          <Row key={generateKey()} style={{ marginBottom: '8px' }}>
            <Column>
              {hasRealUrl ? (
                // DEVIATION FROM UPSTREAM (2026-07-29, adversarial-review
                // HIGH fix): this href used to reach `<Link>` with NO scheme
                // check at all — the "own variable machinery" this method's
                // doc describes shares its `variableValues` map with every
                // hostile-recipient-name vector this file's other sinks now
                // guard against, and this one had no guard of its own. In
                // practice this key (`pw_poll_<id>_<optId>_url`) is always
                // server-built (`apps/convex/campaigns.ts`), never authored —
                // but "the caller only ever sets this key to something safe"
                // is exactly the property a chokepoint exists so nothing has
                // to assume. Root-relative allowed (`safeRenderHref`'s
                // default): `siteUrl()` legitimately returns a root-relative
                // vote URL when neither site-URL env var is configured.
                <Link href={safeRenderHref(this.getVariableValue(variableName, undefined, options))} style={optionStyle}>
                  {opt.label}
                </Link>
              ) : (
                <span style={optionStyle}>{opt.label}</span>
              )}
            </Column>
          </Row>
        );
      })
      .filter((el): el is React.JSX.Element => el !== null);

    return (
      <Container
        style={{
          marginBottom: shouldRemoveBottomMargin ? '0px' : '20px',
        }}
      >
        <Text
          style={{
            fontWeight: 700,
            fontSize: '16px',
            color: headingColor,
            margin: '0 0 12px 0',
          }}
        >
          {question}
        </Text>
        {optionRows}
      </Container>
    );
  }
}
