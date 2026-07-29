/**
 * WS2b — the send/preview-side glue between a `docFormat: "tiptap"` campaign
 * doc and `@events-os/email-render`'s `renderEmailTiptap`: turning a
 * recipient into the `variables` map maily's `setVariableValues` expects.
 *
 * Kept as its own small file (not inlined into `campaigns.ts`) because THREE
 * call sites need the exact same rule — `campaigns.ts#deliverCampaignBatch`/
 * `sendTest`, `campaignApprovalEmails.ts`'s test pair, and
 * `emailPreview.ts#renderCampaignPreview` — and a merge-tag or poll-key
 * mismatch between any two of them is a recipient seeing `{{firstName}}` or
 * a poll link that 404s.
 */
import { findPollNodes, firstNameOf } from "@events-os/shared";

/** Merge-tag variables — `firstName`/`name`, matching
 *  `@events-os/shared`'s `MERGE_TAGS` (the blocks-format renderer's own
 *  `resolveMergeTagValue`) semantics EXACTLY, including the "friend" fallback
 *  when the recipient has no name on file. Always sets BOTH keys (never
 *  omits one for maily to fall back on its own): `Maily`'s `variable()` node
 *  falls back to the AUTHOR's own node-level `fallback` attr, then to the
 *  raw un-substituted `{{tag}}` text, when a key is missing from the
 *  variables map — leaving either behind would either drop the "friend"
 *  default's guarantee that no send ever leaks a literal `{{firstName}}`, or
 *  make a preview/test send read differently from the same document sent for
 *  real. */
export function tiptapMergeVariables(recipient: {
  name: string | null;
  email: string;
}): Record<string, string> {
  return {
    firstName: firstNameOf(recipient.name),
    name: recipient.name?.trim() || "friend",
  };
}

/** Per-recipient poll vote URLs, keyed `pw_poll_<pollId>_<optionId>_url` —
 *  the exact format `maily.tsx#pwPoll` looks up (see that method's doc).
 *  Walks every `pwPoll` node in `doc` (any depth, any format — `findPollNodes`
 *  is format-dual so this only ever emits variables tiptap docs actually have
 *  a `pwPoll` node for) and asks `urlFor` to build each option's link.
 *
 *  Omitted entirely (an empty object) when `urlFor` isn't given — `sendTest`
 *  and the approval test pair have no `campaignRecipients` row and therefore
 *  no token to key a vote to, so the poll should render its options as inert,
 *  unclickable pills (`pwPoll`'s own graceful-degradation: no matching
 *  variable → no link) rather than links to a URL that would 404. */
export function tiptapPollVariables(
  doc: unknown,
  urlFor?: (pollId: string, optionId: string) => string,
): Record<string, string> {
  if (!urlFor) return {};
  const variables: Record<string, string> = {};
  for (const poll of findPollNodes(doc)) {
    for (const option of poll.options) {
      variables[`pw_poll_${poll.id}_${option.id}_url`] = urlFor(poll.id, option.id);
    }
  }
  return variables;
}

/** The full `variables` map for one recipient — merge tags plus (when a real
 *  send has a token to build links from) poll vote URLs. The one function
 *  every call site should actually use, so "merge tags" and "poll URLs" can
 *  never be wired by only one of them. */
export function tiptapVariablesFor(
  doc: unknown,
  recipient: { name: string | null; email: string },
  pollVoteUrl?: (pollId: string, optionId: string) => string,
): Record<string, string> {
  return {
    ...tiptapMergeVariables(recipient),
    ...tiptapPollVariables(doc, pollVoteUrl),
  };
}
