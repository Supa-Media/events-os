/**
 * WS1: the validator↔renderer correspondence guarantee, half A — the SET of
 * node/mark types the write gate (`@events-os/shared`'s `EMAIL_TIPTAP_NODE_
 * TYPES`/`EMAIL_TIPTAP_MARK_TYPES`) accepts must be EXACTLY the set the
 * vendored renderer (`Maily`) can actually dispatch — never a superset (an
 * "accepted but unrenderable" type would throw at send time) and never a
 * subset (a "renderable but rejected" type would just be a needless gap).
 *
 * `nodeTypes.ts`'s `MAILY_DISPATCHED_NODE_TYPES`/`MAILY_DISPATCHED_MARK_TYPES`
 * are the render side's hand-maintained copy of "what does `renderNode`/
 * `renderMark`'s `type in this` actually reach" (see that file's doc for why
 * reflection can't derive this automatically). This test is what makes the
 * two lists' agreement a CHECKED property instead of a comment promising it.
 */
import { describe, expect, test } from "vitest";
import { EMAIL_TIPTAP_MARK_TYPES, EMAIL_TIPTAP_NODE_TYPES } from "@events-os/shared";
import { Maily } from "./maily";
import { MAILY_DISPATCHED_MARK_TYPES, MAILY_DISPATCHED_NODE_TYPES } from "./nodeTypes";

describe("node/mark type drift: shared whitelist vs. Maily's dispatch table", () => {
  test("MAILY_DISPATCHED_NODE_TYPES is set-equal to EMAIL_TIPTAP_NODE_TYPES", () => {
    expect(new Set(MAILY_DISPATCHED_NODE_TYPES)).toEqual(new Set(EMAIL_TIPTAP_NODE_TYPES));
  });

  test("MAILY_DISPATCHED_MARK_TYPES is set-equal to EMAIL_TIPTAP_MARK_TYPES", () => {
    expect(new Set(MAILY_DISPATCHED_MARK_TYPES)).toEqual(new Set(EMAIL_TIPTAP_MARK_TYPES));
  });

  test("every listed node type resolves to a real function on Maily.prototype", () => {
    for (const type of MAILY_DISPATCHED_NODE_TYPES) {
      expect(typeof (Maily.prototype as unknown as Record<string, unknown>)[type]).toBe("function");
    }
  });

  test("every listed mark type resolves to a real function on Maily.prototype", () => {
    for (const type of MAILY_DISPATCHED_MARK_TYPES) {
      expect(typeof (Maily.prototype as unknown as Record<string, unknown>)[type]).toBe("function");
    }
  });

  test("node types and mark types never overlap on either side", () => {
    const nodeSet = new Set<string>(MAILY_DISPATCHED_NODE_TYPES);
    for (const mark of MAILY_DISPATCHED_MARK_TYPES) {
      expect(nodeSet.has(mark)).toBe(false);
    }
  });

  test("htmlCodeBlock is intentionally excluded from the whitelist despite still having a render method", () => {
    // Documents the security decision (see nodeTypes.ts's module doc) as a
    // living assertion rather than only a comment: the method still exists
    // (nothing broke it), but it must never be reachable through the
    // write-gated whitelist.
    expect(typeof (Maily.prototype as unknown as Record<string, unknown>).htmlCodeBlock).toBe("function");
    expect(MAILY_DISPATCHED_NODE_TYPES as readonly string[]).not.toContain("htmlCodeBlock");
    expect(EMAIL_TIPTAP_NODE_TYPES as readonly string[]).not.toContain("htmlCodeBlock");
  });
});
