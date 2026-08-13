/**
 * PASTE A LIST — the pure parser behind the attendee section's "Paste a
 * list" affordance (founder, 2026-08-12: "allow me to copy and paste a csv
 * list of people or a line broken list of people"). Framework-free so it's
 * testable without mounting the form, and reused as-is by whichever host
 * calls it — `CodingFieldSet.tsx` today, any future host tomorrow.
 *
 * INPUT SHAPES THIS ACCEPTS:
 *  - A plain newline-broken list of names ("Alice\nBob\nCharlie").
 *  - CSV-ish lines: NAME, AFFILIATION per line, using tab/comma/semicolon as
 *    the cell separator ("Alice, volunteer" / "Bob\tteam" / "Charlie;guest").
 *    The affiliation cell is matched case-insensitively against either an
 *    `ATTENDEE_AFFILIATIONS` key ("community_member") or its display label
 *    ("Community member") — whichever the pasted source happened to use.
 *  - A line with MORE THAN TWO cells and no affiliation token anywhere in it
 *    ("Alice, Bob, Charlie") is read as multiple bare names rather than one
 *    name plus two unrecognized cells — the shape a name-only CSV column
 *    produces when copied out of a spreadsheet with commas as the row's own
 *    separator, not the field's.
 *  - A line with MORE THAN TWO cells where exactly one cell matches an
 *    affiliation AND it's the LAST cell ("Alice, Bob, volunteer") is read as
 *    every other cell being a name that shares that one trailing
 *    affiliation — the shape a spreadsheet produces when several people on
 *    one row share a single affiliation column.
 *
 * WHAT AFFILIATION A NAME GETS WHEN THE LINE DOESN'T SAY: the MOST RECENTLY
 * USED affiliation so far in this same paste (seeded from whatever the form's
 * existing rows most recently used), falling back to "team" if nothing has
 * set one yet. This is deliberately not always "team" — a pasted block where
 * the first few lines say "volunteer" and the rest don't bother repeating it
 * should read as "still volunteer", not silently drop to team.
 *
 * DEDUPE is case-insensitive against BOTH the names already on the form and
 * the names already parsed earlier in this same paste — pasting the same
 * list twice, or a list that already contains a duplicate, never doubles a
 * row.
 */
import {
  ATTENDEE_AFFILIATIONS,
  ATTENDEE_AFFILIATION_LABELS,
  type AttendeeAffiliation,
} from "@events-os/shared";

export interface ParsedAttendee {
  name: string;
  affiliation: AttendeeAffiliation;
}

/** Cell separators a pasted line might use — a spreadsheet copy uses tabs, a
 *  hand-typed CSV uses commas or semicolons. All three are tried at once so
 *  the caller never has to guess which one a given paste used. */
const CELL_SPLIT_RE = /[\t,;]/;

/** Match one cell against an `ATTENDEE_AFFILIATIONS` key or its display
 *  label, case-insensitively, tolerant of the key's underscore vs. the
 *  label's space ("community_member" and "Community member" both match).
 *  Returns `null` for a cell that names nobody's affiliation, which is the
 *  common case — it's usually just a stray cell or, per the multi-name
 *  heuristic above, another name. */
function matchAffiliation(cell: string): AttendeeAffiliation | null {
  const needle = cell.trim().toLowerCase();
  if (!needle) return null;
  for (const a of ATTENDEE_AFFILIATIONS) {
    if (a.toLowerCase() === needle) return a;
    if (a.replace(/_/g, " ").toLowerCase() === needle) return a;
    if (ATTENDEE_AFFILIATION_LABELS[a].toLowerCase() === needle) return a;
  }
  return null;
}

/**
 * Parse a pasted block of text into attendee rows, ready to append to the
 * form's existing rows.
 *
 * `existingNames` — every name already on the form (any casing), so a
 * pasted duplicate is silently skipped rather than doubled.
 * `lastAffiliation` — the affiliation the form's rows most recently used, if
 * any; the starting fallback for lines that don't name one themselves.
 * Defaults to `"team"` when the form has no rows yet.
 */
export function parseAttendeePaste(
  text: string,
  opts: {
    existingNames?: readonly string[];
    lastAffiliation?: AttendeeAffiliation;
  } = {},
): ParsedAttendee[] {
  const seen = new Set(
    (opts.existingNames ?? []).map((n) => n.trim().toLowerCase()),
  );
  let lastAffiliation: AttendeeAffiliation = opts.lastAffiliation ?? "team";
  const results: ParsedAttendee[] = [];

  const addName = (name: string, affiliation: AttendeeAffiliation) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ name: trimmed, affiliation });
  };

  // Handles every line-ending style a paste can arrive with: "\r\n"
  // (Windows), "\n" (Unix), and a BARE "\r" alone (classic Mac / some
  // spreadsheet exports). `/\r?\n/` — the original regex — only matched when
  // a "\n" was present, so a bare "\r" wasn't a line break at all: it stayed
  // embedded mid-line, folding the next person's whole line into the current
  // one's cells and silently dropping them from the results. Ordering the
  // alternation "\r\n?" before "\n" makes sure a real "\r\n" pair consumes
  // both characters as ONE break rather than leaving a stray blank line.
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const cells = line
      .split(CELL_SPLIT_RE)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length === 0) continue;

    if (cells.length === 1) {
      addName(cells[0], lastAffiliation);
      continue;
    }

    // Look for an affiliation token anywhere after the first (name) cell —
    // "Name, Affiliation" is the common shape, but tolerate it landing
    // anywhere a person happened to paste it.
    const matchedIdxs: number[] = [];
    for (let i = 1; i < cells.length; i++) {
      if (matchAffiliation(cells[i])) matchedIdxs.push(i);
    }

    // A SHARED TRAILING AFFILIATION (FINDING 3, adversarial review
    // 2026-08-13): more than two cells, and exactly one of them matches an
    // affiliation — landing in the LAST position. That's the shape a
    // spreadsheet produces when several people on one row share one
    // affiliation column ("Alice, Bob, volunteer") — every cell except the
    // matching one is a name carrying it, not just the first (the previous
    // behavior kept only "Alice" and silently dropped "Bob").
    if (
      cells.length > 2 &&
      matchedIdxs.length === 1 &&
      matchedIdxs[0] === cells.length - 1
    ) {
      const affiliation = matchAffiliation(cells[matchedIdxs[0]])!;
      lastAffiliation = affiliation;
      for (let i = 0; i < cells.length; i++) {
        if (i === matchedIdxs[0]) continue;
        addName(cells[i], affiliation);
      }
      continue;
    }

    if (matchedIdxs.length > 0) {
      // A match somewhere else (a lone "Name, Affiliation" pair, or a match
      // that isn't uniquely trailing) — the plain NAME, AFFILIATION reading:
      // the first cell is the name, the matched cell sets the affiliation.
      const affiliation = matchAffiliation(cells[matchedIdxs[0]])!;
      lastAffiliation = affiliation;
      addName(cells[0], affiliation);
      continue;
    }

    if (cells.length > 2) {
      // No cell named an affiliation and there are more than two of them —
      // read the whole line as bare names, not "one name plus junk".
      for (const c of cells) addName(c, lastAffiliation);
    } else {
      // Exactly two cells, neither recognized as an affiliation: read it as
      // "name, (attempted but unrecognized affiliation)" — the first cell is
      // the name, the second is dropped rather than guessed at as a second
      // person (a 2-column paste is far more often NAME, SOMETHING than two
      // bare names on one line).
      addName(cells[0], lastAffiliation);
    }
  }

  return results;
}

// ── Capping a bulk addition at the meal-names threshold ─────────────────────
export interface BulkAdditionCap<T> {
  /** The candidates that fit, in order, up to `maxTotal`. */
  accepted: T[];
  /** How many candidates didn't fit — 0 means nothing was left out. */
  overflow: number;
}

/**
 * Cap a list of bulk-add candidates (parsed paste rows, or team-roster
 * fills) so `existingCount + accepted.length` never exceeds `maxTotal`.
 *
 * THE DEFECT THIS CLOSES (FINDING 1, adversarial review 2026-08-13): meal
 * names are only REQUIRED up to a headcount threshold
 * (`mealNamesRequired`/`namesMaxHeadcount`) — past it, the form asks for a
 * headcount + group description instead, and `namesMode` flips to `false`.
 * Before this cap existed, a bulk add (paste or "start with the team") could
 * push headcount past that threshold as a side effect of growing it to match
 * the new total. On the VERY NEXT RENDER `namesMode` would flip, and since
 * `rows` is empty and a coding's submittable `attendees` value is only
 * populated `namesMode === true` (`useCodingFormState`'s `value`
 * computation), the entire roster — including the people who were JUST
 * added — would vanish from both the screen and the value about to be
 * submitted, with an inflated headcount and an empty, unexplained
 * group-description box left behind. Capping the addition here means
 * headcount can never be pushed past the threshold by these paths in the
 * first place; the caller reports `overflow` so the UI can say plainly how
 * many people were left out and why, instead of losing them silently.
 */
export function capBulkAdditions<T>(
  candidates: readonly T[],
  existingCount: number,
  maxTotal: number,
): BulkAdditionCap<T> {
  const room = Math.max(0, maxTotal - existingCount);
  const accepted = candidates.slice(0, room);
  return { accepted, overflow: candidates.length - accepted.length };
}
