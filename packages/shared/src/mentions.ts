/**
 * @mentions markup for plain-text `notes` fields.
 *
 * A mention is encoded directly inside the existing plain-text string as a
 * markdown-link-shaped token — `@[label](mention:type:id)` — so no schema
 * change is needed anywhere a `notes: v.string()` column already exists.
 * `encodeMention` produces the token; `splitMentionSegments` walks a string
 * back into alternating text/mention segments for rendering. Resolving a
 * token (id → live person/seat data) is a separate concern — see
 * `apps/mobile/components/mentions/mentionResolve.logic.ts`.
 */

export type MentionType = "person" | "seat";

export type MentionToken = { type: MentionType; id: string; label: string };

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; token: MentionToken };

const MENTION_RE = /@\[([^\]]+)\]\(mention:(person|seat):([^)]+)\)/g;

export function encodeMention(
  type: MentionType,
  id: string,
  label: string,
): string {
  return `@[${label}](mention:${type}:${id})`;
}

export function splitMentionSegments(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index!;
    if (start > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, start) });
    }
    segments.push({
      kind: "mention",
      token: { type: match[2] as MentionType, id: match[3], label: match[1] },
    });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
