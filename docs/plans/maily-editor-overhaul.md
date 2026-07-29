# Email editor overhaul: maily.to

**Status:** in build. Decisions below are the founder's, made 2026-07-29, and are
settled — this doc records them so nobody relitigates.

- *"I kind of hate the system we have right now… use maily.to instead and
  completely overhaul the system."*
- *"I particularly love this editor and previewer"* — the maily editing
  anatomy (document-as-surface, floating toolbar, `+`/drag gutter, meta fields
  inline at the top) is the spec for the editing experience.
- *"The concept of themes is pretty dumb… no need as long as we have
  templates."* Themes are removed. Rebrand-by-hand is the accepted model.
- *"Templates should literally just be saved emails… like Google Docs
  templates… in the backend I don't think it should be a separate table."*
  `campaignTemplates` merges into `campaigns` with a kind discriminator.

Recon: four lanes, 2026-07-29, all findings verified against maily's cloned
source (`arikchakma/maily.to`), not its docs.

## Architecture

**Editor: `@maily-to/core` as a dependency.** MIT. The `<Editor>` `extensions`
prop is a real, code-level API for custom Tiptap nodes. Stable 0.3.7 peers on
`react ^18||^19` (we ship 19.1.0 — fits). Tiptap 2 underneath.

**Renderer: vendored, not depended on.** `@maily-to/render` is a closed class —
~30 hardcoded private methods, throws on unknown node types, no plugin API.
Rather than subclass an undocumented internal of a single-maintainer package
(92% single-author, 5-month release gaps), we take the render source into
`packages/shared` under its MIT license and own it. Consequences, all good:

- Custom nodes get first-class render methods, not a subclass hack.
- We pick our own `@react-email/render` — **2.x ships an explicit `convex`
  package.json export condition**, targeting exactly our send runtime. Maily's
  stable line pins 1.x, which has no such condition; vendoring unpins us.
- Upstream churn (low anyway — 23 commits on main in 12 months) can't break
  the send path.

The spike verifies end-to-end render inside a Convex **default-isolate**
action; the known risk is `juice` (CSS inliner) reaching for Node APIs. If the
isolate fails, fallback is a `"use node"` render action per batch — precedent:
`receiptPdf.ts`.

**Compliance stays ours, wrapped around maily's output.** Maily emits a full
HTML document with no injection hooks and *no* CAN-SPAM/unsubscribe concept,
and it force-declares `color-scheme: light`. Our shell post-processes the
returned HTML: inject the unsubscribe + postal footer before `</body>` (the
`injectBeforeBodyClose` pattern already in production for approval emails),
override the meta tags, append our dark-mode `<style>`/`[data-ogsc]` rules.
Plaintext comes free (`plainText: true` → react-email's html-to-text).
List-Unsubscribe headers are unchanged (headers, not body). **Send-blocking
guarantees (postal address, working unsubscribe) remain enforced in
`campaigns.ts`/`blasts.ts`, not in the editor — the editor changed, the law
didn't.**

**Per-recipient rendering:** the convenience `render()` export does not accept
variables; the send loop instantiates the vendored `Maily` class per recipient
and calls `setVariableValues()` (merge tags, unsubscribe URL, poll vote URLs).

## The Public Worship node pack

Reproducibility lane verdict: the newsletter's **layout** is expressible in
stock nodes (section fills/radius/borders, arbitrary column splits incl.
44/56, image-with-link, grey canvas + white 600px container). The
**typographic finish is not**: headings are hardcoded to three size/weight
triples, paragraph size is one global value per document, letter-spacing does
not exist anywhere in maily, buttons cannot be width-capped, and there is no
poll. Each gap = an editor extension (real API) + a render method (ours now):

1. `pwHeading` — free size / line-height / letter-spacing.
2. Tracking on text runs (mark) and per-node paragraph sizing (testimonial 20px
   vs body 16px).
3. Button `maxWidth`.
4. Bleed image (edge-to-edge; stock images sit inside the container gutter).
5. **Poll** — question + options; render emits per-recipient vote links via
   variables. Backend vote/tally/confirm-page survives untouched; the two
   independent "find polls in this doc" walks (backend + mobile) are replaced
   by ONE shared format-aware helper — they must never disagree again.

**Acceptance gate: the designer's newsletter, rebuilt as a maily-format
template, recognisable to her.** We have failed this test once; it is the test.

## Data model

- `docFormat: "blocks" | "tiptap"` (optional field; doc columns are already
  `v.any()`, no schema migration). Old sent campaigns render via the old
  pipeline **forever**; no in-place conversion — converting a
  pending/approved doc would change its snapshot hash and burn its approval.
- **Templates merge:** `campaignTemplates` rows fold into `campaigns` as
  template-kind rows. "Start from template" ≡ "duplicate email" — one code
  path. Two invariants the merge must design in, not catch in review:
  - The table boundary was doing authorization work: `campaigns.design` may
    write template-kind rows but NOT email-kind rows. Gates re-split on row
    kind. (Run-10 escalation class — this time by design.)
  - Approval/submit/send functions refuse template-kind rows structurally.
- **Themes:** `emailThemes` frozen (no writes, UI removed), theme picker and
  ThemeEditor deleted. Legacy docs keep their baked snapshot for the old
  renderer. Guest pages (`pollPage`, `unsubscribePage`) that styled themselves
  from `campaign.doc.theme` fall back to `DEFAULT_EMAIL_THEME` for
  tiptap-format docs.

## Platform

Editing is **web** (contenteditable). Native: read-only preview + meta
editing in v1; a WebView-hosted editor with a **bundled** asset (not the
markdown editor's CDN-load gap) is the follow-up stage if wanted.

## Workstreams

- **WS0 spike (blocks WS2):** install `@maily-to/core@0.3.7`, mount under
  react-native-web behind the design gate, confirm Metro bundles it; vendor
  the renderer + `@react-email/render@^2.1`; prove a render in a Convex
  default-isolate test, or return the `"use node"` verdict.
- **WS1 shared:** vendored renderer + node pack + tiptap-doc validator
  (URL-scheme allowlists re-homed from `emailBlocks.ts`) + compliance/dark
  shell + shared poll-walk helper.
- **WS2 backend:** `docFormat` dispatch in send/test/approval paths;
  templates-table merge + gates + migration; themes freeze.
- **WS3 mobile:** maily host screen (meta fields inline at top, image library
  → image nodes, save/autosave into `campaigns.doc`), native read-only,
  delete canvas/designer/theme UI.
- **WS4:** newsletter rebuilt as tiptap template; reseed; artwork slots
  re-keyed to node ids.
- **WS5:** Academy (third rewrite of the composer lesson; themes lesson dies)
  + terminology doc.
- Adversarial review before each PR, as always.

## Cost/risk honestly stated

~700 tests / ~11,600 lines die or rebuild (all canvas/designer code and its
tests; the block renderer stays alive only for legacy sends). Single-maintainer
upstream is mitigated by MIT + vendoring the part we depend on at send time.
Outlook safety is inherited from react-email rather than our hand-rolled
tables — recurring image-width bugs exist upstream; the review pass renders
the rebuilt newsletter and diffs against the old renderer's output before we
promise anything.
