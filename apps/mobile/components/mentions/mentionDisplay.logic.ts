/**
 * Display projection for editing text that contains `@mention` markup.
 *
 * The STORED string keeps the full token — `@[Label](mention:type:id)` — but
 * showing that raw markup in an edit-mode `TextInput` made typing after a
 * mention miserable (a wall of random id digits mid-sentence). Instead the
 * input now edits a DISPLAY projection where each token renders as just
 * `@Label`, and every edit the user makes to the display string is mapped
 * back onto the raw string:
 *
 * - `buildMentionDisplay` projects raw → display, keeping a span table that
 *   maps display ranges to raw ranges.
 * - `applyDisplayEdit` takes the display string BEFORE and AFTER a user edit,
 *   locates the single splice between them, and applies the equivalent
 *   splice to the raw string. A mention behaves as an ATOMIC chip: any edit
 *   that touches a mention's interior (backspacing into it, selecting across
 *   it, typing inside it) expands to replace the WHOLE token — so one
 *   backspace after `@Abigail Sekyere` removes the entire mention rather
 *   than stranding a half-broken token in the raw string.
 *
 * Pure string logic, no React — unit-tested in `mentionDisplay.logic.test.ts`.
 */
import { splitMentionSegments } from "@events-os/shared";

export type DisplaySpan = {
  /** Range in the DISPLAY string. */
  dStart: number;
  dEnd: number;
  /** Corresponding range in the RAW (stored) string. */
  rStart: number;
  rEnd: number;
  /** True when this span is one whole mention token (atomic while editing). */
  mention: boolean;
};

export type MentionDisplay = { display: string; spans: DisplaySpan[] };

/** How a mention token reads while EDITING — `@Label`. The read-mode renderer
 *  (`MentionText`) shows the bare label as a link; the `@` here marks "this
 *  is a token, not text you typed" inside a plain-text input. */
export function mentionDisplayLabel(label: string): string {
  return `@${label}`;
}

export function buildMentionDisplay(raw: string): MentionDisplay {
  const spans: DisplaySpan[] = [];
  let display = "";
  let rPos = 0;
  for (const segment of splitMentionSegments(raw)) {
    if (segment.kind === "text") {
      spans.push({
        dStart: display.length,
        dEnd: display.length + segment.text.length,
        rStart: rPos,
        rEnd: rPos + segment.text.length,
        mention: false,
      });
      display += segment.text;
      rPos += segment.text.length;
    } else {
      const { type, id, label } = segment.token;
      const rawLen = `@[${label}](mention:${type}:${id})`.length;
      const dLabel = mentionDisplayLabel(label);
      spans.push({
        dStart: display.length,
        dEnd: display.length + dLabel.length,
        rStart: rPos,
        rEnd: rPos + rawLen,
        mention: true,
      });
      display += dLabel;
      rPos += rawLen;
    }
  }
  return { display, spans };
}

/** Map a display position to its raw position. Positions inside a mention
 *  are snapped to the token's nearest edge (callers only pass interior
 *  positions after `applyDisplayEdit` has already expanded edits to whole
 *  tokens, so in practice this resolves boundaries). */
export function displayPosToRaw(projection: MentionDisplay, dPos: number): number {
  for (const span of projection.spans) {
    if (dPos < span.dStart || dPos > span.dEnd) continue;
    if (!span.mention) return span.rStart + (dPos - span.dStart);
    // Mention: snap to the nearer edge.
    return dPos - span.dStart <= span.dEnd - dPos ? span.rStart : span.rEnd;
  }
  // Past the end (or empty projection).
  return projection.spans.length > 0
    ? projection.spans[projection.spans.length - 1].rEnd
    : 0;
}

/** True when a display position sits inside (or at the `@` of) a mention
 *  token — used to suppress the `@`-picker trigger for an EXISTING token's
 *  own `@Label` text. */
export function posTouchesMention(spans: DisplaySpan[], dPos: number): boolean {
  return spans.some((s) => s.mention && dPos >= s.dStart && dPos < s.dEnd);
}

export type DisplayEditResult = {
  /** The raw string with the user's display edit applied. */
  raw: string;
  /** The re-projected display of `raw`, with its span table. */
  display: string;
  spans: DisplaySpan[];
  /** Where the caret belongs in the NEW display string. */
  cursor: number;
  /** True when the applied edit differs from what the input already shows —
   *  a mention was atomically expanded — so the caller must force the
   *  caret to `cursor` after re-rendering. */
  cursorNeedsForce: boolean;
};

/**
 * Translate a user edit made against the display projection into the
 * equivalent edit on the raw string. `prevDisplay` must be the projection of
 * `raw` (i.e. `buildMentionDisplay(raw).display`); `nextDisplay` is what the
 * input reports after the user's keystroke/paste/cut.
 */
export function applyDisplayEdit(
  raw: string,
  prevDisplay: string,
  nextDisplay: string,
): DisplayEditResult {
  const projection = buildMentionDisplay(raw);

  // Locate the single splice between the two display strings: longest common
  // prefix, then longest common suffix over what remains.
  let prefix = 0;
  const maxPrefix = Math.min(prevDisplay.length, nextDisplay.length);
  while (prefix < maxPrefix && prevDisplay[prefix] === nextDisplay[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < Math.min(prevDisplay.length, nextDisplay.length) - prefix &&
    prevDisplay[prevDisplay.length - 1 - suffix] ===
      nextDisplay[nextDisplay.length - 1 - suffix]
  ) {
    suffix++;
  }
  let start = prefix;
  let end = prevDisplay.length - suffix;
  const inserted = nextDisplay.slice(prefix, nextDisplay.length - suffix);

  // Atomic chips: expand the edited range over every mention whose interior
  // it touches. (A pure insertion AT a token boundary — start === end at
  // dStart or dEnd — touches no interior and inserts plain text beside the
  // token, which is the "type after the mention" case this exists to fix.)
  let expanded = false;
  for (const span of projection.spans) {
    if (!span.mention) continue;
    if (span.dStart < end && span.dEnd > start) {
      if (span.dStart < start) {
        start = span.dStart;
        expanded = true;
      }
      if (span.dEnd > end) {
        end = span.dEnd;
        expanded = true;
      }
    }
  }

  const rStart = displayPosToRaw(projection, start);
  const rEnd = displayPosToRaw(projection, end);
  const nextRaw = raw.slice(0, rStart) + inserted + raw.slice(rEnd);
  const nextProjection = buildMentionDisplay(nextRaw);
  return {
    raw: nextRaw,
    display: nextProjection.display,
    spans: nextProjection.spans,
    cursor: start + inserted.length,
    cursorNeedsForce: expanded || nextProjection.display !== nextDisplay,
  };
}
