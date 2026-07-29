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
 * PROVENANCE: vendored verbatim (formatting only) from `arikchakma/maily.to`,
 * `packages/render/src/meta.tsx`, commit
 * 042d13169b39e0ae8c692a25693bebdbb9b894c0 (2026-07-21), on 2026-07-29.
 *
 * DEVIATION FROM UPSTREAM (2026-07-29): bare `JSX.Element` → `React.JSX.Element`
 * throughout (with the `import type React from "react"` below to match) —
 * `@types/react@19` no longer merges a global ambient `JSX` namespace; it only
 * lives at `React.JSX` (or the `react/jsx-runtime` module), so upstream's own
 * bare references don't compile against the React 19 types this repo pins.
 * Formatting only otherwise (repo's Prettier config: double quotes).
 */
import type React from "react";

export type MetaDescriptor =
  | {
      charSet: "utf-8";
    }
  | {
      title: string;
    }
  | {
      name: string;
      content: string;
    }
  | {
      property: string;
      content: string;
    }
  | {
      httpEquiv: string;
      content: string;
    }
  | {
      tagName: "meta" | "link";
      [attribute: string]: string;
    }
  | {
      [name: string]: string;
    };

export type MetaDescriptors = MetaDescriptor[];

export function meta(meta: MetaDescriptors) {
  return (
    meta
      // only filter unique meta tags
      // so that we don't have duplicate meta tags
      .filter((meta, index, self) => {
        const meta_hash = hash(meta);
        return (
          index ===
          self.findIndex((t) => {
            return hash(t) === meta_hash;
          })
        );
      })
      .map(process)
      .filter(Boolean) as React.JSX.Element[]
  );
}

function process(props: MetaDescriptor) {
  if ("tagName" in props) {
    const { tagName, ...attributes } = props;
    const Comp = tagName;
    return <Comp key={JSON.stringify(attributes)} {...attributes} />;
  }

  if ("title" in props) {
    return <title>{props.title}</title>;
  }

  if ("charSet" in props) {
    return <meta charSet={props.charSet} />;
  }

  return <meta key={JSON.stringify(props)} {...props} />;
}

/**
 * hash the meta object to string
 * so that we can filter out duplicates
 * for that we have to sort the object keys
 * and then stringify it and hash it
 */
function hash(meta: MetaDescriptor) {
  const sortedMeta = Object.keys(meta)
    .sort()
    .reduce((acc, key) => {
      const _key = key as keyof MetaDescriptor;
      acc[_key] = meta[_key];
      return acc;
    }, {} as MetaDescriptor);

  return JSON.stringify(sortedMeta);
}
