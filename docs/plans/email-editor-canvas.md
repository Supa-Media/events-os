# Email editor: from form-and-preview to a direct-manipulation canvas

**Status:** proposed, not started. Awaiting two product decisions (§3).
**Ask, verbatim:** *"right now the email and template editor is more of a put
information on the left and then preview on the right. I instead want it to be
more drag and drop similar to Canva… easier and more intuitive for our
designers."*

Every file:line below was verified by recon against `main` at `9af5d0e`.

---

## 1. The diff against the artefact

The artefact here is Canva's editing model. Reproducing an artefact starts with
a table of what it actually does, not a vibe — so:

| Canva does | Can we? | Why |
| --- | --- | --- |
| Click an element on the design itself to select it | **Yes** | Needs blocks drawn as real components, not form cards |
| Edit text in place, where it will appear | **Yes** | CM6 already conceals markdown syntax on inactive lines |
| Drag an element from a side panel onto the design | **Yes** | `dragToReschedule.tsx` already does measure-targets → ghost → hit-test, universally |
| Drag to reorder | **Already exists** | `SortableRows` (RNGH + Reanimated), both platforms |
| Drag a handle to resize | **Yes** | `ResizeHandle.tsx` is a working universal primitive; `react-rnd` is installed for web |
| Contextual toolbar for the selected element | **Yes** | Both `SiteMapEditor` (floating bar) and `BlockCard` (inline toolbar) already do this |
| Snapping / alignment guides | **Yes, trivially** | Only a handful of legal positions exist in a flow model |
| Recolour one element directly | **Model says no** — see §3 | `emailTheme.ts:18-20`: *"THEME-LEVEL ONLY… This is the designer's own stated model."* |
| Crop an image to a shape | **Not without new infrastructure** | No crop/transform pipeline exists; `object-fit` is unusable in Outlook |
| **Place anything at any x/y, overlap, layer, rotate** | **No — and not because of us** | Outlook renders with Word. Absolute positioning is dropped |

The last row is the whole design constraint. **`position:absolute` appears
nowhere in any email path in this repo** — only on web pages
(`landingPage.ts:354` et al). That is not an oversight; the table shell → one
`<tr>` per block → percentage `<td>` architecture is the shape you get once you
accept the Word engine.

**So: Canva's *feel*, not Canva's *document*.** Every serious email tool
(Mailchimp, Beefree, Stripo, Klaviyo) made this same concession. A literal
Canva clone would be a lovely editor that produces broken email.

### What "form-shaped" actually means today

Worth stating because it explains the complaint precisely. Layout is a **closed
set of five card treatments** (`CARD_SPECS`, `emailRender.ts:386-418`). Fixed
per variant, with no author control: fill, border, padY, padX, heading size,
heading line-height, body colour, CTA alignment, CTA max-width. Body font-size
is hardcoded 16px (`:508`).

**The entire card system exposes two free parameters** — `align` and
`imageWidthPct` (20–80) — plus `ctaStyle`. The designer is not designing; she is
choosing between five presets and filling in their text. That is why it feels
like a form: structurally, it is one.

---

## 2. The architecture decision

The preview is `<iframe srcDoc sandbox="">` on web
(`EmailHtmlPreview.web.tsx:15-25`) and a WebView with
`javaScriptEnabled={false}` on native (`.native.tsx:14-26`). No scripts, no
same-origin, deliberately — the content is author-controlled (merge tags, pasted
markdown) and there is an XSS regression test behind that choice
(`emailRender.test.ts:114`). The renderer also stamps **no block identity** into
the HTML, so "which block did she click?" is currently unanswerable from the
preview.

Three ways to make a canvas, and only one is honest:

1. **Make the iframe interactive** (postMessage bridge). Requires
   `allow-scripts allow-same-origin` — which together defeat the sandbox — plus
   a parallel native bridge. **Rejected: trades a security property for an
   interaction nicety.**
2. **Overlay a drag layer on the iframe.** The industry trick, and already this
   repo's pattern (`SiteMapEditor.tsx:2385-2390`). But the parent must know each
   block's pixel geometry *inside* the iframe — which means either a script in
   the iframe (back to 1) or duplicating the renderer's layout maths in the
   parent. **Rejected: drifts every time the renderer changes.**
3. **Draw the canvas as real components; keep the iframe as a read-only
   fidelity pane.** The editing surface becomes measurable, gesture-capable RN
   Views. Both sandboxes stay hard. Native keeps working. **Chosen.**

**The cost, stated plainly: two renderers that must agree** — the email-HTML one
and the on-canvas one. That is the tax every WYSIWYG pays, and it is the main
risk in this plan. Mitigation: the iframe stays on screen as the arbiter, and
CARD_SPECS becomes a *shared* geometry table both renderers read, so drift is a
one-file fix rather than a hunt.

**No new dependencies.** Everything needed is installed or already written:

| Need | Use | Status |
| --- | --- | --- |
| Reorder | `components/grid/SortableRows.tsx` | Written, universal |
| Palette → canvas drop | generalize `moduleCalendar/dragToReschedule.tsx` | Written, universal |
| Resize handles | `components/grid/ResizeHandle.tsx` | Written, universal |
| Web resize polish (optional) | `react-rnd` ^10.5.3 | Installed, proven in `SiteMapEditor` |
| Text editing | CodeMirror 6 + `livePreview.ts` | Written, both platforms |

`dnd-kit` was evaluated and rejected: 0.5.0 pre-1.0, the v6 line static since
Dec 2024, ~235KB, web-only (so native needs a second stack anyway), and it does
nothing the two written systems don't. `react-dnd` last shipped April 2022.

**Native stays supported.** The composer runs on native today with zero
`Platform.OS` gating, and `EmailHtmlPreview.native.tsx` / `MarkdownEditor.native.tsx`
were written specifically to make it work there. Going web-only would be
*deleting* working functionality, not accepting a constraint. If we ever decide
email design is a desktop job, gate the route — don't leave a half-working screen.

---

## 3. Two product decisions needed before building

**(a) Per-block colour: does the theme rule stand?**
`emailTheme.ts:18-20` states it as a principle — *"Blocks inherit; no block
carries its own colour. A rebrand is one edit, not fifty, and a non-designer
can't drift a single campaign off-brand. This is the designer's own stated
model."* The Academy teaches it as a rule (`development.ts:307`, "The THEME
carries the brand — you never colour a block") with a quiz whose correct answer
is *"there's no per-block colour control"* (`:361`).

A Canva-like canvas normally implies per-element styling. **We cannot ship both.**
Options: keep the rule and give freedom in *layout* rather than colour
(recommended — it is her own rule, and it is what keeps a covering volunteer from
wrecking the brand); or open per-block colour deliberately, which additionally
costs a dark-mode answer (`darkRules` swaps fills by class; an arbitrary hex has
no dark counterpart) and an Academy rewrite.

**(b) How much layout freedom?**
Recommended: expose the parameters `CARD_SPECS` currently freezes — width,
alignment, spacing — as per-block values, keeping the five variants as *presets*
rather than a cage. All additive; no schema migration (`doc` is `v.any()`,
`schema/campaigns.ts:356`, because Convex validators can't express the block
union); no new email-client risk (percentage cells, `td` padding, `text-align`
are the most reliable primitives in email).

---

## 4. Staged plan

Each stage ships on its own and is useful alone. Stage 1 is most of the felt win.

### Stage 1 — The canvas replaces the card stack *(the big one)*
Blocks render as what they look like, at 600px scale, in document order. Click a
block to select; a contextual toolbar appears for it. Text and headings edit in
place. The iframe moves alongside as a "what Gmail will show" pane rather than
being the only place you see your design.

- Replaces: `BlockCard.tsx` (1,106) + `CardContentEditor.tsx` (442).
- Keeps untouched: **all** of `lib/emailDesigner.ts` (782 React-free lines — the
  document algebra, `History` zipper, validator mirrors, `explainDocError`) and
  its 1,149-line test suite; autosave with the in-flight re-save fix;
  `ReadOnlyProvider`; the image library; theme picker; `MergeTagRow`.
- Must solve: where ~15 inline validation warnings live when there is no form
  field to sit beneath. This is real product logic, not decoration.

### Stage 2 — Direct manipulation
Drag from the palette onto the canvas with a drop indicator; drag to reorder on
the canvas itself; drag the divider between a card's image and text to set
`imageWidthPct` (already a free 20–80 parameter — the ± stepper at
`CardContentEditor.tsx:366` becomes a handle).

**Keep the arrow buttons.** They exist because dragging a fifteen-block
newsletter on a phone was *"a long-press-and-scroll fight"*
(`DocumentComposer.tsx:268-274`). Drag is an addition, not a replacement.

### Stage 3 — Real layout freedom *(gated on §3b)*
Per-block `widthPct`, `align`, and spacing, additively in `emailBlocks.ts` +
`emailRender.ts`, surfaced as handles. Fix the known bug where a card's
`align: center` moves everything *except* the CTA (`emailRender.ts:522` ignores
the author's align). Optionally per-block background (gated on §3a, and owes a
dark-mode answer).

### Stage 4 — Image crop *(genuinely new infrastructure)*
No crop pipeline exists; `emailImages` stores no dimensions
(`schema/campaigns.ts:650-663`). `object-fit` is unusable in Word. The only
email-safe crop is a **pre-cropped derivative**: crop rect on the block →
generate and cache a cropped blob in Convex storage → emit its URL with explicit
`width`/`height`. Additive to the model, but real backend work. Lowest priority.

### Stage 5 — Native parity
Canvas + tap-to-select on phones, with resize as steppers rather than 15px
handles. Today's sub-960px layout stacks the preview *under* the editor, so it
is off-screen while typing — the phone experience is currently the weakest and
this stage is where it gets better.

---

## 5. Cost, risk, and what to leave alone

**Size.** Keeping the stacked-block document model: ~5,200 lines in play
(`designer/` 2,932 + `theme/` 1,073 + editor logic 1,202), ~150 assertions at
risk. Changing the model to free positioning: additionally the 2,868-line shared
layer and its 3,924 lines of tests — **~12,000 lines and ~900 assertions.** A
factor of three, hanging on one decision. This plan keeps the model.

**`designer/` has zero test coverage.** 2,932 lines, no test file references any
of it. Nothing blocks a rewrite; nothing catches us breaking it either. Stage 1
should land with component tests, since it is the first time this surface will
have any.

**Don't casually discard #460.** Roughly 2,900 of the designer's 2,932 lines were
written in the last four days, and #460 was pure visual-fidelity tuning to match
the real newsletter. The canvas renderer must reproduce that fidelity or the
designer will — correctly — say it looks nothing like her newsletter again.

**Sequencing hazard.** PR #439 is open and changes quiz grading keys to an FNV-1a
hash of the prompt text. Today rewording a quiz is free (progress keys on section
slug, grading on option index). After #439 merges, rewording *mints a new key*.
The Academy edits this work needs should land **before** #439, or coordinate.

**Framework.** Build here; this is product surface, not infrastructure, and the
framework has no email or content-editing code at all. But the *renderer* is
~90% generic already (`MERGE_TAGS` is two entries) and would make a good
`@supa-media/email` later — so don't let app concepts leak into the block schema.

**Two `CLAUDE.md` corrections found in passing:** the supa-framework checkout is
at `/home/user/supa-framework`, not `~/Code/supa-framework`. And despite
extensive MSO commentary, the repo ships **no `<!--[if mso]>` conditionals and no
VML** — so `border-radius` on every card and button is silently square in Outlook
today. Worth knowing before promising designers rounded corners.
