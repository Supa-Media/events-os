/**
 * People → Identify — pure queue/ordering logic for the guest-identity review
 * screen (`app/(app)/people/identify.tsx`). Kept dependency-free and testable
 * on its own, matching this codebase's convention of extracting business
 * logic out of screens (see `components/money/duplicateMatch.ts`,
 * `components/event/ticketing/helpers.ts`).
 *
 * Mirrors `apps/convex/identity.ts`'s three "queue" query return shapes
 * (`listNameMatchCandidates`, `listDuplicatePersonCandidates`,
 * `listUnidentifiedGuests`) and the founder's decisions from the identify
 * spec:
 *  - "Same"/"Different" are committed to the server immediately (the item
 *    then disappears from the reactive query on its own — a "different"
 *    verdict is suppressed server-side via the evidence-hash check, a "same"
 *    verdict links/merges the record away). This module never removes an
 *    item from a queue array itself; the SOURCE arrays already shrink.
 *  - "Not sure" / "Don't know" record nothing — they just reorder the
 *    CURRENT session's display so the item is seen again after everything
 *    else, per `applySkipOrder` below.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";

export type PersonCandidate = {
  _id: Id<"people">;
  name: string;
  email: string | null;
  phone: string | null;
  userId: Id<"users"> | null;
  isTeamMember: boolean;
  notes: string | null;
  status: string | null;
  role: string | null;
  company: string | null;
  createdAt: number;
};

export type NameMatchRow = {
  guestNameKey: string;
  displayName: string;
  eventCount: number;
  candidate: PersonCandidate;
};

export type DuplicateMatchKind = "email" | "phone" | "name" | "similar";

export type DuplicateRow = {
  matchKind: DuplicateMatchKind;
  subject: PersonCandidate;
  candidate: PersonCandidate;
};

export type UnidentifiedRow = {
  nameKey: string;
  displayName: string;
  eventCount: number;
  eventNames: string[];
};

export type HighConfidenceCard =
  | { kind: "name_match"; key: string; row: NameMatchRow }
  | { kind: "duplicate"; key: string; row: DuplicateRow };

/**
 * Combines buckets 2 (name matches) and 3 (duplicate people) into one
 * "same/different" queue — both are small (~62 total in production) and get
 * served before bucket 4's 1,179 unidentified guests. Order between the two
 * sub-kinds is arbitrary (duplicates first — shared-phone clusters are the
 * fewest and highest-signal); what matters is neither ever mixes with
 * bucket 4.
 */
export function buildHighConfidenceQueue(
  nameMatches: NameMatchRow[],
  duplicates: DuplicateRow[],
): HighConfidenceCard[] {
  const dupeCards: HighConfidenceCard[] = duplicates.map((row) => ({
    kind: "duplicate",
    key: `dup:${row.subject._id}:${row.candidate._id}`,
    row,
  }));
  const nameCards: HighConfidenceCard[] = nameMatches.map((row) => ({
    kind: "name_match",
    key: `name:${row.guestNameKey}:${row.candidate._id}`,
    row,
  }));
  return [...dupeCards, ...nameCards];
}

/**
 * "Not sure"/"Don't know" pushes an item to the BACK of the current
 * session's queue without recording anything server-side. Stable-partitions
 * `items` into [not-skipped, in original order] followed by [skipped, in the
 * order they were skipped — the earliest "not sure" resurfaces first once
 * the front of the queue clears]. An item whose key isn't in `items` (e.g.
 * already resolved) is silently dropped from the skip tail.
 */
export function applySkipOrder<T>(
  items: T[],
  keyOf: (item: T) => string,
  skippedKeys: string[],
): T[] {
  const skippedSet = new Set(skippedKeys);
  const head = items.filter((item) => !skippedSet.has(keyOf(item)));
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const tail = skippedKeys
    .map((key) => byKey.get(key))
    .filter((item): item is T => item !== undefined);
  return [...head, ...tail];
}

/** Records a fresh "not sure"/"don't know" for `key`, moving it to the end
 *  of the skip order (re-skipping an already-skipped item just re-queues it
 *  at the very back again rather than duplicating it mid-list). */
export function pushToBack(skippedKeys: string[], key: string): string[] {
  return [...skippedKeys.filter((k) => k !== key), key];
}

/**
 * Picks which of a duplicate pair survives a merge: whichever looks more
 * "real" (a team member, or already has a sign-in account) wins; a tie
 * defaults to `candidate` (arbitrary but deterministic). The SAME pair must
 * be used for both `mergeDuplicatePeople({fromId, toId})` and, if the
 * verdict is instead "different", `recordDecision({subjectKey: String(fromId),
 * candidatePersonId: toId})` — the suppression/resurfacing lookup is keyed
 * on that exact pair, so the two call sites must derive it identically.
 */
export function pickMergeDirection(
  subject: PersonCandidate,
  candidate: PersonCandidate,
): { fromId: Id<"people">; toId: Id<"people"> } {
  const strength = (p: PersonCandidate) => (p.isTeamMember ? 2 : 0) + (p.userId ? 1 : 0);
  const survivor = strength(subject) > strength(candidate) ? subject : candidate;
  const duplicate = survivor === subject ? candidate : subject;
  return { fromId: duplicate._id, toId: survivor._id };
}

/** The evidence line a human reviews alongside a same/different card — WHY
 *  the two records look alike, never just "these might match." */
export function evidenceLine(card: HighConfidenceCard): string {
  if (card.kind === "name_match") return "matching name";
  switch (card.row.matchKind) {
    case "email":
      return "same email address";
    case "phone":
      return "same phone number";
    case "name":
      return "same name";
    case "similar":
      return "similar name";
  }
}

/** A short tag describing a person candidate on a comparison card, e.g.
 *  "Team member", a role, a company, or a bare "Contact" fallback. */
export function candidateTagLine(p: PersonCandidate): string {
  const parts: string[] = [];
  if (p.role) parts.push(p.role);
  if (p.isTeamMember) parts.push("Team member");
  if (parts.length === 0 && p.company) parts.push(p.company);
  if (parts.length === 0) parts.push("Contact");
  return parts.join(" · ");
}

/** "5 events · Eden, Pop the Balloon, +3" — `eventNames` may already be
 *  capped (the backend sends at most 3); the "+N" always reconciles against
 *  the true `eventCount`, not `eventNames.length`. */
export function formatEventSummary(eventCount: number, eventNames: string[]): string {
  const label = `${eventCount} event${eventCount === 1 ? "" : "s"}`;
  if (eventNames.length === 0) return label;
  const shown = eventNames.slice(0, 2);
  const rest = eventCount - shown.length;
  const namesPart = rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
  return `${label} · ${namesPart}`;
}
