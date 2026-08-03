/**
 * Google Chat send core — the ONE webhook POST per Comms Schedule send
 * (`commsSend.ts`). A Google Chat Incoming Webhook URL carries the target
 * space's auth token in the URL itself, so `postGoogleChatMessage` never lets
 * that URL leak into a thrown error message — only the response status/body,
 * which is safe to surface in a toast a non-superuser caller might see.
 *
 * `fetch()` works in the default Convex runtime, so no `"use node"` — mirrors
 * `lib/twilio.ts`'s note.
 */

/**
 * Format one Comms Schedule row's saved copy for Google Chat: a bold
 * "*{item title}* — {event name}" heading (Google Chat's basic markdown),
 * blank line, then the copy verbatim. An untitled row (`itemTitle: ""`) drops
 * the heading down to just the event name — no dangling "* — ". With
 * `includeTitle: false` (the sender unchecked "Include title" in the send
 * popover) the whole heading line goes away and the copy is sent verbatim.
 */
export function buildGoogleChatMessage({
  eventName,
  itemTitle,
  copy,
  includeTitle = true,
}: {
  eventName: string;
  itemTitle: string;
  copy: string;
  includeTitle?: boolean;
}): string {
  if (!includeTitle) return copy;
  const heading = itemTitle ? `*${itemTitle}* — ${eventName}` : eventName;
  return `${heading}\n\n${copy}`;
}

/**
 * POST one message to a Google Chat Incoming Webhook. Throws on a non-2xx
 * response with the status + response body — NEVER the webhook URL, which
 * carries the space's auth token.
 */
export async function postGoogleChatMessage(
  webhookUrl: string,
  text: string,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(
      `Google Chat send failed (${response.status}): ${await response.text()}`,
    );
  }
}
