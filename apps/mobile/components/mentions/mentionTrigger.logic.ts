/**
 * Detects an in-progress `@query` at the cursor, for opening/filtering the
 * mention picker as the user types. Scans left from the cursor: an `@` at
 * the start of the text or preceded by whitespace starts a trigger; any
 * whitespace hit first (or reaching the start without an `@`) means no
 * trigger. This is why `user@example.com` never opens the picker (the `@`
 * is preceded by `r`, not whitespace/start) while `Hi @jo` does.
 */
export type MentionTrigger = { query: string; start: number } | null;

export function detectMentionTrigger(
  text: string,
  cursorIndex: number,
): MentionTrigger {
  for (let i = cursorIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const precedingChar = i === 0 ? null : text[i - 1];
      if (precedingChar !== null && !/\s/.test(precedingChar)) return null;
      return { query: text.slice(i + 1, cursorIndex), start: i };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}
