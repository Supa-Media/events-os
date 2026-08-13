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

  for (const rawLine of text.split(/\r?\n/)) {
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
    let matched: AttendeeAffiliation | null = null;
    for (let i = 1; i < cells.length; i++) {
      matched = matchAffiliation(cells[i]);
      if (matched) break;
    }

    if (matched) {
      lastAffiliation = matched;
      addName(cells[0], matched);
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
