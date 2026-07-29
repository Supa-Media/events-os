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
 * PROVENANCE: vendored verbatim from `arikchakma/maily.to`,
 * `packages/render/src/render.ts`, commit
 * 042d13169b39e0ae8c692a25693bebdbb9b894c0 (2026-07-21), on 2026-07-29.
 *
 * NOTE for our send loop: this convenience `render()` has no way to pass
 * `setVariableValues` — per-recipient rendering instantiates `Maily` directly
 * and calls `setVariableValues()` before `.render()`, same as upstream's own
 * docs recommend. This export stays for the no-variables case (e.g. the
 * "raw preview" path).
 */
import type { JSONContent } from "@tiptap/core";
import { Maily } from "./maily";
import type { MailyConfig, RenderOptions } from "./maily";

export async function render(
  content: JSONContent,
  config?: MailyConfig & RenderOptions,
): Promise<string> {
  const { theme, preview, ...rest } = config || {};

  const maily = new Maily(content);
  maily.setPreviewText(preview);
  maily.setTheme(theme || {});

  return maily.render(rest);
}
