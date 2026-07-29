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
    "pwBleedImage",
    "pwPoll",
    "horizontalRule",
    "spacer",
    "blockquote",
  ] as const);

  switch (kind) {
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
