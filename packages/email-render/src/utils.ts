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
 * PROVENANCE: `generateKey` vendored verbatim from `arikchakma/maily.to`,
 * `packages/render/src/utils.ts`, commit
 * 042d13169b39e0ae8c692a25693bebdbb9b894c0 (2026-07-21), on 2026-07-29.
 */
export function generateKey() {
  // Length of 6 is enough to avoid collisions
  // for react keys
  return Math.random().toString(36).substr(2, 6);
}

/**
 * PROVENANCE: adapted from `@antfu/utils`'s `deepMerge` (MIT, © Anthony Fu),
 * https://github.com/antfu/utils, `src/object.ts`. Upstream `maily.tsx` used
 * `@antfu/utils` for exactly this one function (`setTheme`'s recursive merge
 * of the caller's theme onto `DEFAULT_RENDERER_THEME`); rather than take on a
 * whole extra dependency for one ~15-line function, it's reproduced here with
 * the same behavior (mutates and returns `target`; plain-object-only merge —
 * arrays and other non-plain values are replaced, not merged; guards against
 * prototype pollution via `__proto__`/`constructor`/`prototype` keys).
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  if (!isMergableObject(target) || !isMergableObject(source)) {
    return target;
  }

  for (const key of Object.keys(source) as Array<keyof T & string>) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }

    const targetRecord = target as Record<string, unknown>;
    const sourceValue = (source as Record<string, unknown>)[key];
    if (isMergableObject(sourceValue)) {
      if (!isMergableObject(targetRecord[key])) {
        targetRecord[key] = {};
      }
      deepMerge(targetRecord[key] as Record<string, unknown>, sourceValue);
    } else {
      targetRecord[key] = sourceValue;
    }
  }

  return target;
}

function isMergableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
