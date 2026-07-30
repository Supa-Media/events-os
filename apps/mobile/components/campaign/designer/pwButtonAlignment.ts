/**
 * BUTTON ALIGNMENT — founder bug #5 ("can't center a button within a
 * block"), round two. `MailyDocumentHost.web.tsx`'s own module doc records
 * the investigation: both the render pipeline (`maily.tsx`'s `Container
 * style={{textAlign: alignment}}`) and the editor's own `ButtonView` CSS
 * (`style={{textAlign: alignment}}` on its `NodeViewWrapper`) already center
 * a button correctly whenever `node.attrs.alignment === "center"` — proven
 * by direct pixel measurement in the harness, both for the editor and for
 * `renderEmailTiptap`'s actual HTML output. The ONLY broken thing is
 * *setting* that attr: maily's own alignment control is a Popover nested
 * inside ANOTHER Popover (`ButtonView`'s bubble menu → `AlignmentSwitch`'s
 * own `Popover`), and clicking through it did not reliably persist a change
 * in this environment — reproduced identically with every other fix in this
 * PR disabled, so it isn't something this PR's other changes caused. Rather
 * than debug (or fork) a vendored, nested-Popover interaction we don't own,
 * this ships OUR OWN reliable control that writes the exact same attr maily's
 * control was supposed to.
 *
 * ── Design ───────────────────────────────────────────────────────────────
 * Pure, ProseMirror-free helpers here (unit-testable without a real editor,
 * same duck-typing discipline as `pwImagePlaceholderIntercept.ts`'s
 * `PosAtDomView`/`NodeAtDoc`) — `MailyDocumentHost.web.tsx` owns the actual
 * wiring: a `transaction` listener on the editor keeps a small piece of
 * state ("is a button currently selected, and what's its alignment") in
 * sync, which drives whether the control renders in the main toolbar at
 * all; clicking Left/Center/Right dispatches a DIRECT position-based update
 * (`tr.setNodeMarkup(pos, undefined, {...attrs, alignment})`) — the SAME
 * technique `@tiptap/core`'s own `NodeView.updateAttributes` helper uses
 * internally (not `editor.commands.updateAttributes(name, attrs)`, which
 * walks the CURRENT selection instead of a captured position — a real
 * difference if selection has drifted by click time, exactly the kind of
 * timing sensitivity that made maily's own control unreliable here).
 */

export type ButtonAlignment = "left" | "center" | "right";

/** Mirrors `@maily-to/core`'s own `allowedLogoAlignment` set (reused by its
 *  button `AlignmentSwitch` too) — the exact three values maily's schema,
 *  render, and editor CSS all already understand. */
export const BUTTON_ALIGNMENTS: readonly ButtonAlignment[] = ["left", "center", "right"];

export function isButtonAlignment(value: unknown): value is ButtonAlignment {
  return typeof value === "string" && (BUTTON_ALIGNMENTS as readonly string[]).includes(value);
}

/** The minimal shape this module needs from a ProseMirror `NodeSelection` —
 *  duck-typed so `resolveSelectedButtonAlignment` is unit-testable without a
 *  real `prosemirror-state`. The real caller passes `editor.state.selection`
 *  after already narrowing it with `@tiptap/core`'s own `isNodeSelection`
 *  (this module has no opinion on THAT check — it only cares about a
 *  selection that's already known to be node-shaped). */
export type SelectedNodeLike = {
  node: { type: { name: string }; attrs: Record<string, unknown> };
  from: number;
};

/**
 * Given a (possibly null) node-shaped selection, return the selected
 * button's ProseMirror position and CURRENT alignment — or `null` when
 * nothing's selected, or the selection is a different node type entirely
 * (an image, a section, …). `alignment` defaults to `"left"` when the attr
 * is absent/invalid, matching maily's own `DEFAULT_BUTTON_ALIGNMENT` so a
 * freshly-inserted button (no alignment ever authored) shows the CORRECT
 * current state rather than a blank/undefined control.
 */
export function resolveSelectedButtonAlignment(
  selection: SelectedNodeLike | null,
): { pos: number; alignment: ButtonAlignment } | null {
  if (!selection) return null;
  if (selection.node.type.name !== "button") return null;
  const raw = selection.node.attrs.alignment;
  return { pos: selection.from, alignment: isButtonAlignment(raw) ? raw : "left" };
}

/** The minimal shape this module needs from a ProseMirror `Node` at a doc
 *  position — duck-typed like `NodeAtDoc` in `pwImagePlaceholderIntercept.ts`. */
export type ButtonNodeAtDoc = {
  nodeAt(pos: number): { type: { name: string }; attrs: Record<string, unknown> } | null | undefined;
};

/**
 * Re-verify, AT CLICK TIME, that `pos` still actually points at a `button`
 * node — a stale-position guard (the doc may have changed between "we
 * observed this button selected" and "the designer clicked our control": an
 * autosave-triggered remote update isn't a thing here, but an intervening
 * Delete/edit is) — and if so, return the attrs to write (the node's OWN
 * current attrs, re-read fresh from the doc, not a stale closure copy,
 * merged with the new alignment). Returns `null` when `pos` no longer
 * resolves to a button — the caller then simply does nothing, rather than
 * corrupting whatever node now happens to sit there.
 */
export function buttonAlignmentUpdate(
  doc: ButtonNodeAtDoc,
  pos: number,
  alignment: ButtonAlignment,
): { attrs: Record<string, unknown> } | null {
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== "button") return null;
  return { attrs: { ...node.attrs, alignment } };
}
