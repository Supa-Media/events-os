/**
 * WS1: the validator↔renderer correspondence guarantee, half B — the
 * PROPERTY itself: "a doc that validates must render without throwing."
 * (The reverse direction — "a doc that would throw at render must fail
 * validation" — is what each specific hostile-input test in
 * `packages/shared/src/tiptapEmail.test.ts` and `nodePack.test.ts` pins down
 * one failure mode at a time: unknown types, bad heading levels, malformed
 * polls, disallowed URL schemes.)
 *
 * This file generates a batch of pseudo-random but STRUCTURALLY VALID tiptap
 * docs (only whitelisted node/mark types, well-formed attrs) from a small
 * seeded PRNG — deterministic across runs, no external property-testing
 * dependency needed (`packages/shared` must stay zero-dependency, and this
 * package doesn't have one either) — and asserts EVERY generated doc both
 * validates AND renders without throwing.
 *
 * ── `is*Variable` docs (2026-07-29, adversarial-review HIGH fix follow-up) ──
 * The generator ALSO produces `isUrlVariable`/`isSrcVariable`/
 * `isExternalLinkVariable`-flagged attrs (referencing the `firstName`
 * variable — every doc's own `variableValues.firstName` is exactly the
 * "recipient's own profile name" vector `urlSanitize.ts`'s module doc
 * describes) at a fixed, deterministic rate, so this property test's own
 * "every seed" sweep exercises the render-time URL chokepoint (`urlSanitize.
 * ts`) too, not just the ordinary literal-URL path. The first three tests
 * below resolve `firstName` to a BENIGN value ("Alex") — unaffected by
 * whether a given seed happens to route it through an `isXVariable` attr, so
 * this addition doesn't change what those tests were already pinning. A
 * fourth test resolves the SAME generated docs against a HOSTILE `firstName`
 * (a `javascript:`/`data:` payload) and asserts render still never throws
 * AND the raw payload never reaches the output — pinning this whole class of
 * bug (not just the specific sinks the original adversarial review's PoC
 * happened to try) against ever regressing.
 */
import { describe, expect, test } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { validateTiptapEmailDoc } from "@events-os/shared";
import { Maily } from "./maily";

// ── A tiny seeded PRNG (mulberry32) — deterministic, no dependency. ────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function genText(rng: () => number, withMarks: boolean): JSONContent {
  const words = ["hello", "worship", "gathering", "join", "us", "this", "month", "friend"];
  const text = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => pick(rng, words)).join(" ");
  if (!withMarks || rng() < 0.5) return { type: "text", text };
  type Mark = { type: string; attrs?: Record<string, unknown> };
  const markPool: Mark[] = [
    { type: "bold" },
    { type: "italic" },
    { type: "underline" },
    { type: "textStyle", attrs: { color: "#111827", letterSpacing: rng() < 0.5 ? "0.02em" : undefined } },
    { type: "link", attrs: { href: "https://example.com" } },
    // `isUrlVariable`: `href` holds a variable NAME, not a URL — the write
    // gate correctly skips its scheme check here (see `tiptapEmail.ts
    // #checkUrlAttr`); the render-time chokepoint (`urlSanitize.ts`) is what
    // has to catch a hostile resolved value instead.
    { type: "link", attrs: { href: "firstName", isUrlVariable: true } },
  ];
  const marks = [pick(rng, markPool)];
  return { type: "text", text, marks };
}

function genInline(rng: () => number, count: number): JSONContent[] {
  return Array.from({ length: count }, () => genText(rng, true));
}

function genUrl(rng: () => number): string {
  return pick(rng, ["https://example.com/a", "https://example.com/b", "http://example.org/c"]);
}

function genImageUrl(rng: () => number): string {
  return pick(rng, ["https://example.com/i1.png", "https://example.com/i2.png"]);
}

/** One randomly-chosen, well-formed top-level node. */
function genTopLevelNode(rng: () => number): JSONContent {
  const kind = pick(rng, [
    "heading",
    "pwHeading",
    "paragraph",
    "pwParagraph",
    "button",
    "buttonUrlVariable",
    "pwBleedImage",
    "pwPoll",
    "horizontalRule",
    "spacer",
    "blockquote",
    "image",
    "imageSrcVariable",
    "logoSrcVariable",
    "inlineImageVariable",
  ] as const);

  switch (kind) {
    // ── `is*Variable` sinks (see this file's module doc) — same "resolves
    // through `variableValues.firstName`" shape as the `link` mark's
    // variable variant above, one per node-pack sink that has one. ─────────
    case "buttonUrlVariable":
      return { type: "button", attrs: { text: "Go", url: "firstName", isUrlVariable: true } };
    // `pwBleedImage` deliberately has NO `isSrcVariable` variant here, unlike
    // every sibling case below: `NODE_URL_ATTR_RULES.pwBleedImage` in
    // `tiptapEmail.ts` has no `variableFlag` entry for `src` (a pre-existing
    // write-gate/renderer correspondence GAP this task didn't ask this file
    // to fix — the gate is merely stricter than it needs to be here, not
    // unsafe, since it always demands a literal allowed-scheme URL), so a
    // doc setting `isSrcVariable: true` on this node fails validation and
    // this generator only ever produces docs meant to validate.
    // `maily.urlSanitize.test.ts` covers that sink's render-time behavior
    // directly instead.
    case "image":
      return { type: "image", attrs: { src: genImageUrl(rng), alt: "Photo" } };
    case "imageSrcVariable":
      return { type: "image", attrs: { src: "firstName", isSrcVariable: true, alt: "Photo" } };
    case "logoSrcVariable":
      return { type: "logo", attrs: { src: "firstName", isSrcVariable: true, size: "md" } };
    case "inlineImageVariable":
      return {
        type: "paragraph",
        content: [
          {
            type: "inlineImage",
            attrs: { src: "firstName", isSrcVariable: true, externalLink: "firstName", isExternalLinkVariable: true },
          },
        ],
      };
    // `linkCard.link` deliberately has NO variant here: it has no
    // `isXVariable` flag upstream at all (`link()` always consults
    // `variableValues` for whatever literal string `link` holds — see
    // `tiptapEmail.ts#NODE_URL_ATTR_RULES`'s comment on this node, and
    // `maily.tsx#linkCard`'s matching "DEVIATION FROM UPSTREAM" comment), so
    // the write gate always validates `link` as a literal URL — a doc that
    // set it to a bare variable NAME like `"firstName"` would never pass
    // validation in the first place, and this generator only ever produces
    // docs meant to validate. `maily.urlSanitize.test.ts` covers that sink's
    // render-time behavior directly instead.
    case "heading":
      return { type: "heading", attrs: { level: pick(rng, [1, 2, 3]) }, content: genInline(rng, 3) };
    case "pwHeading":
      return {
        type: "pwHeading",
        attrs: {
          level: pick(rng, [1, 2, 3]),
          fontSize: pick(rng, [18, 24, 32, 40]),
          lineHeight: pick(rng, [24, 30, "1.2"]),
          letterSpacing: pick(rng, ["0.01em", "0.05em"]),
          color: pick(rng, ["#111827", "#1a1412"]),
        },
        content: genInline(rng, 3),
      };
    case "paragraph":
      return { type: "paragraph", content: genInline(rng, 1 + Math.floor(rng() * 6)) };
    case "pwParagraph":
      return {
        type: "pwParagraph",
        attrs: { fontSize: pick(rng, [14, 16, 20]), lineHeight: pick(rng, [20, 24, "1.5"]) },
        content: genInline(rng, 1 + Math.floor(rng() * 6)),
      };
    case "button":
      return {
        type: "button",
        attrs: {
          text: "Click here",
          url: genUrl(rng),
          variant: pick(rng, ["filled", "outline"]),
          maxWidth: pick(rng, [undefined, 200, 280]),
        },
      };
    case "pwBleedImage":
      return { type: "pwBleedImage", attrs: { src: genImageUrl(rng), alt: "Banner" } };
    case "pwPoll": {
      const optionCount = 2 + Math.floor(rng() * 3);
      return {
        type: "pwPoll",
        attrs: {
          id: `poll_${Math.floor(rng() * 100000)}`,
          question: "What do you think?",
          options: Array.from({ length: optionCount }, (_, i) => ({ id: `opt${i}`, label: `Option ${i}` })),
        },
      };
    }
    case "horizontalRule":
      return { type: "horizontalRule" };
    case "spacer":
      return { type: "spacer", attrs: { height: pick(rng, [8, 16, 24]) } };
    case "blockquote":
      return { type: "blockquote", content: [{ type: "paragraph", content: genInline(rng, 2) }] };
  }
}

function genDoc(seed: number): JSONContent {
  const rng = mulberry32(seed);
  const nodeCount = 1 + Math.floor(rng() * 8);
  return { type: "doc", content: Array.from({ length: nodeCount }, () => genTopLevelNode(rng)) };
}

describe("correspondence property: generated valid docs validate AND render without throwing", () => {
  const SEED_COUNT = 200;

  test(`${SEED_COUNT} generated docs all validate`, () => {
    for (let seed = 0; seed < SEED_COUNT; seed++) {
      const doc = genDoc(seed);
      const result = validateTiptapEmailDoc(doc);
      if (!result.ok) {
        throw new Error(`seed ${seed} failed validation: ${result.error}\n${JSON.stringify(doc)}`);
      }
    }
  });

  test(`${SEED_COUNT} generated docs all render without throwing`, async () => {
    for (let seed = 0; seed < SEED_COUNT; seed++) {
      const doc = genDoc(seed);
      const maily = new Maily(doc);
      maily.setVariableValues({ firstName: "Alex" });
      await expect(maily.render(), `seed ${seed} threw at render:\n${JSON.stringify(doc)}`).resolves.toBeTypeOf(
        "string",
      );
    }
  });

  test(`${SEED_COUNT} generated docs all render plaintext without throwing`, async () => {
    for (let seed = 0; seed < SEED_COUNT; seed++) {
      const doc = genDoc(seed);
      const maily = new Maily(doc);
      maily.setVariableValues({ firstName: "Alex" });
      await expect(
        maily.render({ plainText: true }),
        `seed ${seed} threw at plaintext render:\n${JSON.stringify(doc)}`,
      ).resolves.toBeTypeOf("string");
    }
  });
});

describe("correspondence property, hostile variant: is*Variable docs with a HOSTILE resolved value never leak it raw", () => {
  // Same generated docs as above (a fraction of every seed routes at least
  // one link/src through an `isXVariable` attr — see `genText`/
  // `genTopLevelNode`'s variable-flagged cases) — resolved against a
  // recipient-controlled `firstName` carrying an XSS/phishing payload
  // instead of a benign name. See `urlSanitize.ts`'s module doc for exactly
  // this scenario: a hostile profile name, reached through a doc attr the
  // write gate correctly can't scheme-check because it only ever holds a
  // variable NAME.
  const SEED_COUNT = 200;
  const HOSTILE_VALUES = ["javascript:alert(document.cookie)", "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>"];

  test(`${SEED_COUNT} generated docs, rendered with a hostile firstName, never throw and never leak the raw payload`, async () => {
    for (let seed = 0; seed < SEED_COUNT; seed++) {
      const doc = genDoc(seed);
      const hostile = HOSTILE_VALUES[seed % HOSTILE_VALUES.length];
      const maily = new Maily(doc);
      maily.setVariableValues({ firstName: hostile, name: "friend" });

      let html: string;
      try {
        html = await maily.render();
      } catch (e) {
        throw new Error(`seed ${seed} threw at render with hostile firstName:\n${JSON.stringify(doc)}\n${e}`);
      }
      if (html.includes(hostile)) {
        throw new Error(`seed ${seed} leaked the raw hostile value "${hostile}" into rendered HTML:\n${html}`);
      }
    }
  });
});
