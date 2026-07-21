# Feature: AI autofill for the RSVP page

## Feature Description
A "Fill from planning doc" control on the Design phase of the admin RSVP-page
editor (`DesignPhase.tsx`). The organizer pastes the free text of whatever
planning doc they already have (a Google Doc export, notes, a Slack message —
anything), presses one button, and an LLM call (via the existing OpenRouter
gateway) extracts the narrative copy fields — tagline, description, giving
prompt — and drops them into the same local edit buffers the form already
uses. Nothing is saved until the organizer reviews and presses the existing
"Save page" button.

## User Story
As a chapter organizer setting up an event's RSVP page
I want to paste in my planning doc and have AI draft the page copy for me
So that I don't have to hand-write a tagline, description, and giving prompt
from scratch every time

## Problem Statement
Filling in `tagline`, `description`, and `givingPrompt` by hand is repetitive
busywork the organizer has usually already done once, in prose, somewhere
else (a planning doc). There is no way today to turn that prose into page
copy without retyping it.

Two fields the user explicitly called out — event name and location — are
**not** part of this problem: `eventName`/`eventDate` are already read-only
props sourced from the `events` table (never edited on this form at all,
`DesignPhase.tsx:35-46`), and `venueName`/`address` are deliberately left to
the deterministic Google-Places autocomplete (`LocationAutocomplete`,
`DesignPhase.tsx:166-172`) rather than free-text AI generation, since a
guessed address is actively harmful (wrong street address vs. merely
mediocre marketing copy).

## Solution Statement
Add one Convex action, `autofillEventPage` in `apps/convex/aiActions.ts`, that
follows the exact shape of the existing per-row grid Autofill
(`autofillItem`, `aiActions.ts:2270-2401`): tenant-checked internal query for
context, budget + API-key gates, a run logged to `aiRuns` for audit, one
`openRouterCall`, then return the extracted fields to the caller. Unlike
`autofillItem`, this action does **not** patch the database itself — it
returns a plain `{ tagline?, description?, givingPrompt? }` object, and the
client (not the server) merges those into the local edit buffers `DesignPhase`
already keeps (`useState` for `tagline`/`description`/`givingPrompt`,
`DesignPhase.tsx:51-58`). The organizer reviews the AI's draft inline, can
edit it like anything else they typed, and only "Save page" commits it —
identical review gate to every other field on this form. This sidesteps the
one real risk of LLM-authored copy (a plausible-sounding hallucination landing
directly on a public page) without inventing a new review/undo UI, since the
existing "buffer until Save" pattern already *is* the review step.

Alternatives considered:
- **Have the action call `ticketing.updatePage` directly** (mirroring
  `autofillItem`'s direct `applyItemPatch`). Rejected: the grid's items are
  low-stakes internal data with a revert log; this form edits a *public-facing*
  page, and immediately overwriting whatever the organizer had already typed
  with unreviewed AI text is a worse default than handing it back for review.
- **A new persisted "planning doc" field/table.** Rejected — researched and
  confirmed there is no existing narrative planning-doc concept in this
  codebase (`planning_doc` is a task-grid module key, recently renamed to
  "Tasks" specifically because it wasn't a document —
  `packages/shared/src/index.ts:160-166`). Inventing persistence for a
  paste-once input nobody asked to keep is unwarranted scope; the pasted text
  is used once, synchronously, and discarded.

## Scope
**In scope:**
- One new Convex action, `apps/convex/aiActions.ts` `autofillEventPage`.
- One new internal query, `apps/convex/ai.ts` `eventPageAutofillContext`, for
  the tenant-checked event context the prompt needs (name, date, existing
  tagline/description/givingPrompt so the model can improve rather than
  ignore what's already there).
- Extracting exactly three fields: `tagline`, `description`, `givingPrompt`.
- A new collapsible "Fill from planning doc" `SetupCard` at the top of
  `DesignPhase.tsx`'s checklist, with a paste-text `TextField` and a
  "Fill page with AI" button.
- Populating the three local edit buffers from the action's response;
  auto-opening the "Cover & story" card afterward so the organizer sees the
  result immediately.
- Input length cap (paste too much → a clear error, not silent truncation or
  an unbounded LLM bill).

**Out of scope:**
- `eventName`, `eventDate` — already deterministic/read-only, untouched.
- `venueName`, `address` — deliberately left to `LocationAutocomplete`, not
  AI-filled, per the problem statement.
- Any boolean/enum toggle (`rsvpEnabled`, `addressVisibility`,
  `ticketsEnabled`, `givingEnabled`, `showGuestList`, `activityRestricted`).
- Any money/number field (`capacity`, `goalCents`, ticket type prices).
- Cover image generation/selection.
- Persisting the pasted planning-doc text anywhere.
- A per-chapter "bring your own API key" setting — this reuses the existing
  deployment-wide `OPENROUTER_API_KEY` env var, same as every other AI feature
  in this codebase.

## Relevant Files
- `apps/convex/aiActions.ts` — add `autofillEventPage` action; **pattern to
  follow: `autofillItem` (lines 2270-2401)** for the budget/key gates, run
  lifecycle (`startRun`/`finishRun`/`logUsage`), and `openRouterCall` usage.
- `apps/convex/ai.ts` — add internal query `eventPageAutofillContext`
  (mirrors `itemForAutofill`, lines 233-258, for the tenant-boundary shape).
- `apps/mobile/components/event/ticketing/DesignPhase.tsx` — add the new
  `SetupCard`, wire its result into the existing `tagline`/`description`/
  `givingPrompt` buffers (lines 51-55), extend the `CardKey` union (line 27).
- `apps/convex/tests/aiTenant.test.ts` — extend with the new internal query's
  tenant-boundary characterization test, alongside `itemForAutofill`'s.

### New Files
- `apps/convex/tests/aiAutofillEventPage.test.ts` — action + internal-query
  tests for this feature (budget gate, missing key, tenant boundary, a
  successful fill, a malformed-JSON reply, an over-length paste).

## Implementation Plan

### Phase 1: Foundation
Add the tenant-checked internal query the action needs: `eventPageAutofillContext`
in `apps/convex/ai.ts`, returning the event's name/date and the page's current
tagline/description/givingPrompt (or `null` on missing/cross-chapter, mirroring
`itemForAutofill`). No schema changes — every field already exists.

### Phase 2: Core Implementation
Add `autofillEventPage` to `apps/convex/aiActions.ts`: gate on budget + API
key, gate on input length, fetch context via the new internal query, log a run,
call OpenRouter with a system prompt constrained to the three target fields
(explicit instruction: omit any field the doc doesn't address, never invent a
venue/address/date), parse the JSON reply defensively, log usage, finish the
run, and return the parsed (possibly partial) fields — no database write.

### Phase 3: Integration
Wire a new "Fill from planning doc" `SetupCard` into `DesignPhase.tsx`: a
multiline `TextField` for the pasted text, a "Fill page with AI" `Button`
that calls the action via the existing `run` (`ActionRunner`) wrapper, and on
success calls `setTagline`/`setDescription`/`setGivingPrompt` for whichever
fields came back, then opens the "cover" card so the result is visible without
another click.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### Milestone 1 — `eventPageAutofillContext` tenant boundary
**a. RED.** In `apps/convex/tests/aiTenant.test.ts`, add a
`describe("ai.eventPageAutofillContext (read) tenant boundary")` block (next
to the existing `itemForAutofill` block) with two tests:
- same-chapter `eventId` → returns `{ name, eventDate, tagline, description,
  givingPrompt }` matching the seeded event/page.
- cross-chapter `eventId` (seed a second chapter via a second
  `setupChapter(t)` and pass its `eventId` with the first chapter's
  `chapterId`) → returns `null`.
Run `cd apps/convex && pnpm vitest run tests/aiTenant.test.ts` — it must fail
because `internal.ai.eventPageAutofillContext` doesn't exist yet (a real
import/reference error, not a passing assertion).

**b. GREEN.** Add `eventPageAutofillContext` to `apps/convex/ai.ts`, next to
`itemForAutofill`:
```ts
export const eventPageAutofillContext = internalQuery({
  args: { eventId: v.id("events"), chapterId: v.id("chapters") },
  handler: async (ctx, { eventId, chapterId }) => {
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page || page.chapterId !== chapterId) return null;
    return {
      pageId: page._id,
      name: event.name,
      eventDate: event.eventDate,
      tagline: page.tagline ?? null,
      description: page.description ?? null,
      givingPrompt: page.givingPrompt ?? null,
    };
  },
});
```

**c.** Run `cd apps/convex && pnpm vitest run tests/aiTenant.test.ts` — both
new tests pass, and the existing `itemForAutofill` tests in the same file
still pass.

### Milestone 2 — `autofillEventPage` action: gates + happy path
**a. RED.** Create `apps/convex/tests/aiAutofillEventPage.test.ts`. Follow
`aiUsage.test.ts`'s `stubOpenRouterOk`/`stubOpenRouterFail` helpers
(`aiUsage.test.ts:117-133`) and `setup.helpers.ts`'s `newT`/`setupChapter`/
`s.as.action`. Seed a chapter, an event, and its `eventPages` row (via
`s.as.mutation(api.ticketing.createPage, { eventId })`, the real creation
path). Write these tests first:
- no `OPENROUTER_API_KEY` set → calling
  `s.as.action(api.aiActions.autofillEventPage, { eventId, pageId,
  planningDocText: "We're hosting a rooftop worship night..." })` throws a
  `ConvexError` with `code: "NO_OPENROUTER_KEY"`.
- a successful OpenRouter reply (`stubOpenRouterOk('{"tagline":"A rooftop
  night of worship","description":"Join us..."}')`) → the action returns
  `{ ok: true, fields: { tagline: "A rooftop night of worship", description:
  "Join us..." } }` (no `givingPrompt` key, since the model didn't return one).
- an empty/whitespace-only `planningDocText` → throws `ConvexError` with
  `code: "EMPTY_INPUT"` (no OpenRouter call made — assert the fetch stub is
  never invoked).
- a `planningDocText` longer than the cap (define and export a constant,
  e.g. `MAX_PLANNING_DOC_CHARS = 20_000`, from `aiActions.ts`) → throws
  `ConvexError` with `code: "TEXT_TOO_LONG"`.

Run `cd apps/convex && pnpm vitest run tests/aiAutofillEventPage.test.ts` —
fails because `api.aiActions.autofillEventPage` doesn't exist.

**b. GREEN.** Add `autofillEventPage` to `apps/convex/aiActions.ts`, modeled
directly on `autofillItem` (lines 2270-2401):
```ts
export const autofillEventPage = action({
  args: {
    eventId: v.id("events"),
    pageId: v.id("eventPages"),
    planningDocText: v.string(),
  },
  handler: async (ctx, { eventId, pageId, planningDocText }): Promise<{
    ok: boolean;
    fields: { tagline?: string; description?: string; givingPrompt?: string };
  }> => {
    const text = planningDocText.trim();
    if (!text)
      throw new ConvexError({ code: "EMPTY_INPUT", message: "Paste your planning doc first." });
    if (text.length > MAX_PLANNING_DOC_CHARS)
      throw new ConvexError({
        code: "TEXT_TOO_LONG",
        message: `That's too long (max ${MAX_PLANNING_DOC_CHARS.toLocaleString()} characters) — paste a shorter excerpt.`,
      });

    const { userId, chapterId } = await ctx.runQuery(internal.ai.myContext, {});
    const budget = await ctx.runQuery(api.ai.budgetStatus, {});
    if (budget.over)
      throw new ConvexError({ code: "AI_BUDGET", message: `AI budget reached (${budget.over}).` });
    if (!process.env.OPENROUTER_API_KEY)
      throw new ConvexError({ code: "NO_OPENROUTER_KEY", message: "OPENROUTER_API_KEY is not configured." });

    const info = await ctx.runQuery(internal.ai.eventPageAutofillContext, { eventId, chapterId });
    if (!info || info.pageId !== pageId)
      throw new ConvexError({ code: "NOT_FOUND", message: "Page not found." });

    const cfg = await ctx.runQuery(api.ai.aiConfig, {});
    const slug = cfg.activeModel;
    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId, userId, feature: "autofill_event_page", eventId, model: slug,
    });

    try {
      const { message, usage } = await openRouterCall(
        slug,
        [
          { role: "system", content: EVENT_PAGE_AUTOFILL_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Event name: ${info.name}\n` +
              `Event date: ${new Date(info.eventDate).toDateString()}\n` +
              `Current tagline: ${info.tagline ?? "(none)"}\n` +
              `Current description: ${info.description ?? "(none)"}\n` +
              `Current giving prompt: ${info.givingPrompt ?? "(none)"}\n\n` +
              `Planning doc:\n${text}`,
          },
        ],
        { maxTokens: 600, effort: "low" },
      );
      const cost = callCost(slug, usage);
      const fields = parseEventPageAutofillReply(message.content);

      await ctx.runMutation(internal.ai.logUsage, {
        chapterId, userId, runId, feature: "autofill_event_page", model: slug,
        inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, costUsd: cost,
      });
      await ctx.runMutation(internal.ai.finishRun, {
        runId, status: "done", itemsTouched: Object.keys(fields).length, costUsd: cost,
        summary: `Suggested ${Object.keys(fields).join(", ") || "nothing"}`,
      });
      return { ok: Object.keys(fields).length > 0, fields };
    } catch (err) {
      await ctx.runMutation(internal.ai.finishRun, {
        runId, status: "error", itemsTouched: 0, costUsd: 0,
        summary: err instanceof Error ? err.message : "Autofill failed",
      });
      throw err;
    }
  },
});
```
Add the constant, prompt, and a small defensive parser above it:
```ts
const MAX_PLANNING_DOC_CHARS = 20_000;

const EVENT_PAGE_AUTOFILL_SYSTEM_PROMPT =
  "You write short, warm copy for a church event's public RSVP page from " +
  "an organizer's planning notes. Reply with ONLY a JSON object with up to " +
  "three optional string keys: tagline (one line, under 80 chars), " +
  "description (2-4 short sentences), givingPrompt (one line inviting " +
  "donations, only if the notes mention giving/donations/offering). Omit " +
  "any key the notes don't give you enough to write confidently — never " +
  "invent specifics (names, dollar amounts, dates, addresses) that aren't " +
  "in the notes. No markdown, no code fences, no extra keys, no commentary.";

function parseEventPageAutofillReply(
  content: unknown,
): { tagline?: string; description?: string; givingPrompt?: string } {
  const raw = String(content ?? "").trim();
  const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: { tagline?: string; description?: string; givingPrompt?: string } = {};
  for (const key of ["tagline", "description", "givingPrompt"] as const) {
    const val = (parsed as Record<string, unknown>)[key];
    if (typeof val === "string" && val.trim()) out[key] = val.trim();
  }
  return out;
}
```

**c.** Run `cd apps/convex && pnpm vitest run tests/aiAutofillEventPage.test.ts`
— all four tests pass. Then run `cd apps/convex && pnpm test` (full suite) to
confirm nothing else broke.

### Milestone 3 — malformed reply is a no-op, not a crash
**a. RED.** Add to `aiAutofillEventPage.test.ts`: stub OpenRouter to reply
with plain non-JSON prose (e.g. `stubOpenRouterOk("Sure, here's some copy: ...")`)
→ the action still returns `{ ok: false, fields: {} }` (does not throw), and
the run in `aiRuns` finishes with `status: "done"` and `itemsTouched: 0` (query
`ctx.db.query("aiRuns").collect()` inside `run(t, ...)` to assert). Run the
test file — fails today because `parseEventPageAutofillReply` doesn't exist
yet (this milestone's test can be written together with Milestone 2's, but
listed separately since it pins down the *parse-failure* path specifically,
which a loose "returns something" assertion from Milestone 2 wouldn't catch).

**b. GREEN.** Already implemented in Milestone 2's `parseEventPageAutofillReply`
(returns `{}` on a JSON-parse failure) — no additional code, just confirm the
test passes against the Milestone 2 implementation.

**c.** Run `cd apps/convex && pnpm vitest run tests/aiAutofillEventPage.test.ts`.

### Milestone 4 — the "Fill from planning doc" card in `DesignPhase.tsx`
**a. RED.** This is a client-side React Native form with no component render
tests in this codebase (per `.claude/PROJECT.md`'s Testing Conventions: "no
component render tests" for mobile). There is no test to write RED-first here
— skip the test-first cycle for this milestone and say so explicitly (per the
plan format's guidance for when a milestone has no meaningful failing test).
Verification for this milestone is manual: `pnpm dev` → open an event's RSVP
tab → Design phase → confirm the new card renders, the button is disabled
while empty, and a successful fill populates the tagline/description fields
visibly.

**b. Implement.** In `apps/mobile/components/event/ticketing/DesignPhase.tsx`:
- Extend `type CardKey` (line 27) to include `"autofill"`.
- Add local state: `const [planningDocText, setPlanningDocText] = useState("");`
  and `const [autofilling, setAutofilling] = useState(false);`.
- Add `const autofillEventPage = useAction(api.aiActions.autofillEventPage);`
  (import `useAction` from `convex/react` alongside the existing `useMutation`
  import).
- Add a handler:
  ```ts
  async function handleAutofill() {
    setAutofilling(true);
    const result = await run(
      () => autofillEventPage({ eventId, pageId: page._id, planningDocText }),
      { errorTitle: "Couldn't fill from doc" },
    );
    setAutofilling(false);
    if (!result) return;
    if (result.fields.tagline !== undefined) setTagline(result.fields.tagline);
    if (result.fields.description !== undefined) setDescription(result.fields.description);
    if (result.fields.givingPrompt !== undefined) setGivingPrompt(result.fields.givingPrompt);
    setOpenCard("cover");
  }
  ```
- Add a new `SetupCard` as the FIRST card in the checklist (before "Cover &
  story"), icon `"sparkles"`, title `"Fill from planning doc"`, status
  `{ label: planningDocText.trim() ? "Ready" : "Optional", tone: planningDocText.trim() ? "done" : "opt" }`,
  containing a multiline `TextField` (`label="Paste your planning doc"`,
  `value={planningDocText}`, `onChangeText={setPlanningDocText}`, `multiline`,
  `numberOfLines={6}`, `style={{ minHeight: 140, textAlignVertical: "top" }}`,
  `hint="Paste your planning notes — AI drafts the tagline, description, and giving prompt from it."`)
  and a `Button` (`title="Fill page with AI"`, `icon="sparkles"`,
  `loading={autofilling}`, `disabled={!planningDocText.trim()}`,
  `onPress={() => void handleAutofill()}`).

**c.** Run `pnpm typecheck` and `pnpm lint` (root, all three packages) to
confirm the new component compiles and lints clean. Manually verify per (a).

### Milestone 5 — full validation
Run every command in Validation Commands below. All must exit clean.

## Testing Strategy

### Tests by Milestone
| # | Milestone | Test file | The test asserts | Why it fails today |
|---|---|---|---|---|
| 1 | `eventPageAutofillContext` tenant boundary | `apps/convex/tests/aiTenant.test.ts` | Same-chapter returns event/page fields; cross-chapter returns `null` | `internal.ai.eventPageAutofillContext` doesn't exist |
| 2 | `autofillEventPage` gates + happy path | `apps/convex/tests/aiAutofillEventPage.test.ts` (new) | No-key throws `NO_OPENROUTER_KEY`; successful reply returns parsed `fields`; empty input throws `EMPTY_INPUT` with zero fetch calls; over-length input throws `TEXT_TOO_LONG` | `api.aiActions.autofillEventPage` doesn't exist |
| 3 | Malformed reply is a no-op | `apps/convex/tests/aiAutofillEventPage.test.ts` | Non-JSON reply → `{ ok: false, fields: {} }`, run finishes `"done"` with `itemsTouched: 0`, no throw | `parseEventPageAutofillReply` doesn't exist |
| 4 | "Fill from planning doc" card | Manual verification (no mobile render-test convention in this repo) | Card renders, button disabled when empty, successful fill visibly populates tagline/description | Component doesn't exist |

**Pattern followed:** `apps/convex/tests/aiUsage.test.ts` (OpenRouter fetch
stubbing via `vi.stubGlobal`) and `apps/convex/tests/aiTenant.test.ts`
(tenant-boundary characterization tests for the AI internal fns) — both
already exercise the exact seams this feature adds to.

### Integration Tests
N/A beyond Milestones 1-3 — the action IS the integration seam between the
client and OpenRouter/the DB; there's no further backend wiring (no schema
change, no other function calls this action).

### Edge Cases
- Empty/whitespace-only paste → `EMPTY_INPUT`, no LLM call (Milestone 2).
- Over-length paste → `TEXT_TOO_LONG`, no LLM call (add this assertion to the
  same test as the cap check in Milestone 2 — confirm the fetch stub was never
  invoked, same as the empty-input case).
- Non-JSON / malformed-JSON model reply → treated as "nothing extracted", not
  a thrown error (Milestone 3) — a flaky model output must never crash the
  organizer's save flow.
- OpenRouter transient failure (429/5xx) — already handled by the shared
  `openRouterCall` throwing `OpenRouterError`; this action does not add retry
  logic (`autofillItem` doesn't either), it lets the error propagate to `run()`
  which surfaces it as a toast/alert. No new test needed — this is inherited,
  untouched behavior from the shared helper.
- Budget already exhausted → `AI_BUDGET` (mirrors `autofillItem`; not
  re-tested here since `aiModelBudget.test.ts` already covers
  `budgetStatus`/`overBudgetScope` at the shared-logic level and this action
  calls the same query).
- Cross-chapter `eventId`/`pageId` → `NOT_FOUND` (Milestone 1's tenant test
  covers the query; the action test doesn't need to re-derive this, since
  `eventPageAutofillContext` returning `null` is what drives the action's
  `NOT_FOUND` throw).

## Acceptance Criteria
- [ ] `internal.ai.eventPageAutofillContext` returns event/page fields for a
      same-chapter `eventId`, and `null` for a cross-chapter `eventId`.
- [ ] `api.aiActions.autofillEventPage` throws `ConvexError({code:
      "NO_OPENROUTER_KEY"})` when `OPENROUTER_API_KEY` is unset.
- [ ] `api.aiActions.autofillEventPage` throws `ConvexError({code:
      "EMPTY_INPUT"})` for blank input, with zero OpenRouter fetch calls made.
- [ ] `api.aiActions.autofillEventPage` throws `ConvexError({code:
      "TEXT_TOO_LONG"})` for input over `MAX_PLANNING_DOC_CHARS`, with zero
      OpenRouter fetch calls made.
- [ ] A successful OpenRouter reply returns only the fields the model
      supplied, trimmed, as `{ ok, fields }`.
- [ ] A non-JSON/malformed reply returns `{ ok: false, fields: {} }` without
      throwing, and logs the run as `"done"` with `itemsTouched: 0`.
- [ ] `DesignPhase.tsx` renders a "Fill from planning doc" card whose button
      is disabled until text is pasted, and whose successful result visibly
      updates the Tagline/Description fields (and Giving prompt, when
      returned) without saving until "Save page" is pressed.
- [ ] `eventName`, `eventDate`, `venueName`, and `address` are never written
      by this feature — confirmed by `autofillEventPage`'s return type having
      no such keys, and by code review of `handleAutofill`.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all exit clean.

## Validation Commands
Execute every command. Every one must exit clean.

- `cd apps/convex && pnpm vitest run tests/aiTenant.test.ts tests/aiAutofillEventPage.test.ts` — this feature's tests
- `pnpm test` — full suite, zero regressions
- `pnpm typecheck` — `tsc --noEmit` × 3 packages
- `pnpm lint` — 0 errors (pre-existing 97 mobile warnings are not from this change)
- `pnpm build` — web bundle export

## Notes
- No new dependencies — reuses the existing raw-`fetch` OpenRouter gateway
  already vendored in `aiActions.ts`.
- No schema/migration needed — every field this feature reads or writes
  (`eventPages.tagline/description/givingPrompt`, `events.name/eventDate`)
  already exists.
- This does not touch `packages/shared/src/academy/` — it's a new tool inside
  an existing screen (the RSVP-page Design phase), not a renamed concept,
  vocabulary change, money rule, or role/seat change, so per `CLAUDE.md`'s
  Academy rule this is explicitly **not training-worthy** on its own. If a
  later PR adds AI autofill as a *taught* workflow step, revisit then.
- Deliberately deferred: extracting `venueName`/`capacity`/ticket-type copy
  from the planning doc. The research for this plan flagged them as
  "borderline" AI candidates; starting with the three unambiguously-safe
  narrative fields (tagline/description/givingPrompt) keeps the first version
  low-risk. Revisit if organizers ask for more.
- **Design decision to confirm with the user before implementation:** the
  pasted planning-doc text is used once and never persisted (no new table,
  no field on `eventPages`). If the user instead wants the pasted doc to be
  saved/reusable (e.g. re-run autofill later without re-pasting), that's a
  small but real scope change (a new optional string column, or a `docs`-table
  entry) — flagged explicitly rather than assumed.
