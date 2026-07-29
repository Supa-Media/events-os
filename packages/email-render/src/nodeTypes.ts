/**
 * The node `type` strings `Maily`'s `renderNode` (`if (type in this) return
 * this[type](node, options); throw ...` — see `maily.tsx`) actually resolves
 * to a per-type render method for.
 *
 * HAND-MAINTAINED, not derived by reflection over `Maily.prototype`: the
 * class also carries private HELPER methods with the exact same "instance
 * method" shape that are never looked up by node `type` — `getMappedContent`,
 * `isValidUrl`, `removeLinkProtocol`, `variableUrlValue`, `getVariableValue`,
 * `getMarginOverrideConditions`, `adjustColumnsContent`, `renderNode`,
 * `renderMark`, `renderTopLevelRun`, `renderSegmentedBody`, `shouldShow`, …
 * `Object.getOwnPropertyNames` can't tell those apart from a real per-type
 * dispatch target, so there is no reliable reflection-based alternative to
 * hand-listing exactly what `renderNode`'s `type in this` is meant to reach.
 *
 * Deliberately EXCLUDES `htmlCodeBlock`, even though the vendored class still
 * defines (and can still render) that method: it lets an author embed raw
 * HTML verbatim via `dangerouslySetInnerHTML` — any href/src scheme inside
 * that HTML is invisible to `validateTiptapEmailDoc`'s URL allowlist
 * entirely, since it never surfaces as a checkable node attr. Public
 * Worship's campaign authors are church volunteers, not developers, and the
 * plan doc's editing surface has no "insert raw HTML" affordance — so the
 * safer default is for this list (and therefore the write-gate whitelist it
 * mirrors) to never accept that node type, rather than trust that no future
 * editor surface exposes the escape hatch. If a future need for raw HTML
 * ever surfaces, that decision belongs to a real, explicit review — not to
 * silently inheriting whatever the vendored upstream class happened to ship.
 *
 * `EMAIL_TIPTAP_NODE_TYPES` (`@events-os/shared`) is the WRITE-gate's copy of
 * this same set. `nodeTypes.drift.test.ts` asserts the two are set-equal AND
 * that every listed name really does resolve to a function on
 * `Maily.prototype` — so the two can never silently disagree about what
 * "a known node type" means.
 */
export const MAILY_DISPATCHED_NODE_TYPES = [
  // ── Maily's stock set (see maily.tsx's `renderNode`/`this[type]` dispatch,
  // and the plan doc's recon: "the newsletter's layout is expressible in
  // stock nodes"). ──────────────────────────────────────────────────────────
  "paragraph",
  "text",
  "variable",
  "heading",
  "horizontalRule",
  "orderedList",
  "bulletList",
  "listItem",
  "button",
  "spacer",
  "hardBreak",
  "logo",
  "image",
  "footer",
  "blockquote",
  "linkCard",
  "section",
  "columns",
  "column",
  "repeat",
  "for",
  "inlineImage",
  // ── The Public Worship node pack (WS1) — new render methods added to the
  // vendored `Maily` class in `maily.tsx`. ─────────────────────────────────
  "pwHeading",
  "pwParagraph",
  "pwBleedImage",
  "pwPoll",
] as const;

export type MailyDispatchedNodeType = (typeof MAILY_DISPATCHED_NODE_TYPES)[number];

/** Mark types `Maily`'s `renderMark` dispatches on — same "hand-maintained,
 *  not reflected" reasoning as the node list above. Mirrors
 *  `EMAIL_TIPTAP_MARK_TYPES` (`@events-os/shared`). */
export const MAILY_DISPATCHED_MARK_TYPES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "textStyle",
  "link",
  "code",
] as const;

export type MailyDispatchedMarkType = (typeof MAILY_DISPATCHED_MARK_TYPES)[number];
