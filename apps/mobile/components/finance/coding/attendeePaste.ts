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

// ── Merging a bulk addition into the roster ─────────────────────────────────

/** More named rows than anyone can prune through is group-description
 *  territory, full stop — a hard sanity ceiling for a runaway paste, far
 *  above any real meal roster. Distinct from `namesMaxHeadcount` (the org's
 *  names-REQUIRED threshold, usually 15), which bulk adds may exceed on
 *  purpose — see `mergeBulkAttendees`. */
export const HARD_BULK_ATTENDEE_CAP = 50;

export interface BulkMergeResult<T> {
  /** The merged roster: every already-FILLED existing row, then every
   *  accepted addition, in order. */
  merged: T[];
  /** How many additions actually landed (post-dedupe, post-hard-cap). */
  added: number;
  /** Additions dropped as case-insensitive duplicates of existing names. */
  deduped: number;
  /** Additions dropped by `HARD_BULK_ATTENDEE_CAP` — 0 in any sane use. */
  capped: number;
}

/**
 * Merge bulk-add candidates (parsed paste rows, or the team roster) into the
 * existing FILLED rows. Deliberately NOT capped at `namesMaxHeadcount`:
 *
 * THE PRUNE-DOWN MODEL (founder, 2026-08-13): "what I was expecting with
 * start with team was that it would populate with ALL the team members, and
 * then I could go in and start ✕-ing people who weren't there… most of the
 * time it's everybody on the team, but this person was missing." Filling
 * only the first N of an 18-person team is worse than useless — WHICH N is
 * arbitrary — and the earlier cap-at-threshold design (FINDING 1's fix)
 * answered the wrong question: the threshold is where names stop being
 * REQUIRED, not where a roster stops being editable. So a bulk add may
 * exceed the threshold, the editor keeps rendering every row for pruning
 * (`useCodingFormState`'s overflow-pruning state), and a banner explains the
 * two honest ways down: ✕ the absentees, or keep the headcount and describe
 * the group. Nothing is silently dropped and nothing silently changes mode —
 * the failure FINDING 1 originally closed stays closed, from the other side.
 */
export function mergeBulkAttendees<T extends { name: string }>(
  existing: readonly T[],
  additions: readonly T[],
): BulkMergeResult<T> {
  const filled = existing.filter((r) => r.name.trim().length > 0);
  const seen = new Set(filled.map((r) => r.name.trim().toLowerCase()));
  const fresh: T[] = [];
  let deduped = 0;
  for (const a of additions) {
    const key = a.name.trim().toLowerCase();
    if (key.length === 0) continue;
    if (seen.has(key)) {
      deduped += 1;
      continue;
    }
    seen.add(key);
    fresh.push(a);
  }
  const room = Math.max(0, HARD_BULK_ATTENDEE_CAP - filled.length);
  const accepted = fresh.slice(0, room);
  return {
    merged: [...filled, ...accepted],
    added: accepted.length,
    deduped,
    capped: fresh.length - accepted.length,
  };
}
