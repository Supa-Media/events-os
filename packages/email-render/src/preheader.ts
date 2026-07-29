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
 * `packages/render/src/preheader.ts`, commit
 * 042d13169b39e0ae8c692a25693bebdbb9b894c0 (2026-07-21), on 2026-07-29.
 */
import type { JSONContent } from "@tiptap/core";
import type { Maily } from "./maily";

export class Preheader {
  constructor(private readonly maily: Maily) {}

  render(content: string | JSONContent): string {
    if (typeof content === "string") {
      return content;
    }

    return this.renderNode(content);
  }

  private renderNode(node: JSONContent): string {
    const type = node.type || "";
    switch (type) {
      case "doc":
        return this.doc(node);
      case "paragraph":
        return this.paragraph(node);
      case "text":
        return this.text(node);
      case "variable":
        return this.variable(node);
      default:
        // it's fine to ignore unknown nodes
        // because we don't want to break the rendering process
        return "";
    }
  }

  private doc(node: JSONContent): string {
    const children = node.content || [];
    if (children.length === 0) {
      return "";
    }

    return children.map((child) => this.renderNode(child)).join("");
  }

  private paragraph(node: JSONContent): string {
    const children = node.content || [];
    if (children.length === 0) {
      return "";
    }

    return children.map((child) => this.renderNode(child)).join("");
  }

  private text(node: JSONContent): string {
    return node.text || "";
  }

  private variable(node: JSONContent): string {
    const { id: variable, fallback } = node.attrs || {};
    return this.maily.getVariableValue(variable, fallback);
  }
}
