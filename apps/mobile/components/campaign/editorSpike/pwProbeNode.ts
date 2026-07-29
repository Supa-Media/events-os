/**
 * WS0 SPIKE ONLY — not a real Public Worship node-pack node. Proves that a
 * hand-rolled `@tiptap/core` `Node` reaches maily's `<Editor extensions={...}>`
 * prop (a real, code-level extension point per the plan doc's Bet 1) and that
 * both TypeScript and a jsdom render accept it.
 *
 * Deliberately inert: renders a `<span data-pw-probe>` with no commands, no
 * NodeView, no attributes worth naming. The real node pack (`pwHeading`,
 * bleed image, poll, …) is WS1's job — this only needs to exist and be
 * schema-valid.
 *
 * See `docs/plans/maily-editor-overhaul.md` (WS0 spike, Bet 1, point 4).
 */
import { Node, mergeAttributes } from "@tiptap/core";

export const pwProbeNode = Node.create({
  name: "pwProbe",
  group: "inline",
  inline: true,
  atom: true,

  parseHTML() {
    return [{ tag: "span[data-pw-probe]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-pw-probe": "true" }), "pw-probe"];
  },
});

export default pwProbeNode;
