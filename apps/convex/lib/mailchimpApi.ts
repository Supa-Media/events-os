/**
 * Mailchimp Marketing API v3 client — the I/O half of the audience sync (the
 * pure half is `@events-os/shared`'s `mailchimp.ts`).
 *
 * Deliberately tiny and dependency-free, the way `givebutterSync.ts`'s `gbGet`
 * is: `fetch` + Basic auth + a readable error. The official Mailchimp SDK
 * would pull a Node-only dependency into an action that otherwise doesn't need
 * `"use node"`, and this integration uses exactly three endpoints.
 *
 * Auth is HTTP Basic with any username and the API key as the password —
 * Mailchimp's documented scheme. The datacenter prefix in the hostname is
 * derived from the key itself (`deriveMailchimpServerPrefix`), never stored
 * separately, so a key and its host can never disagree.
 */
import {
  mailchimpApiBase,
  type MailchimpMemberPayload,
} from "@events-os/shared";

/** Everything a call needs: the key, and the datacenter derived from it. */
export interface MailchimpCredentials {
  apiKey: string;
  serverPrefix: string;
  audienceId: string;
}

/**
 * A Mailchimp error surfaced as something a human can act on. Mailchimp
 * returns RFC 7807 problem documents (`{title, detail, status, errors}`); the
 * bare status code alone ("request failed with 400") is useless when the
 * actual cause is "MERGE field CHAPTER doesn't exist on this audience".
 */
export class MailchimpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailchimpError";
  }
}

/** Basic-auth header. Mailchimp ignores the username; `anystring` is the value
 *  their own docs use. */
function authHeader(apiKey: string): string {
  // `btoa` is available in Convex's default runtime — no Buffer, no "use node".
  return `Basic ${btoa(`anystring:${apiKey}`)}`;
}

/** Pull the most specific message out of a Mailchimp problem document,
 *  including the first field-level error when there is one. */
async function errorDetail(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return `HTTP ${res.status}`;
  }
  const doc = body as {
    title?: string;
    detail?: string;
    errors?: { field?: string; message?: string }[];
  };
  const parts = [doc.title, doc.detail].filter(Boolean);
  const first = doc.errors?.[0];
  if (first?.message) parts.push(`${first.field ?? "field"}: ${first.message}`);
  return parts.length > 0 ? parts.join(" — ") : `HTTP ${res.status}`;
}

async function mcFetch(
  creds: MailchimpCredentials,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${mailchimpApiBase(creds.serverPrefix)}${path}`, {
    method: init.method,
    headers: {
      Authorization: authHeader(creds.apiKey),
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new MailchimpError(await errorDetail(res), res.status);
  // A 204 has no body; every endpoint we call otherwise returns JSON.
  if (res.status === 204) return null;
  return await res.json();
}

/**
 * Verify the credentials and return the audience's name + member count.
 * Called before every sync so a misconfigured key fails ONCE, loudly, with a
 * real message — rather than 500 members at a time inside the batch loop.
 */
export async function fetchAudience(
  creds: MailchimpCredentials,
): Promise<{ name: string; memberCount: number }> {
  const body = (await mcFetch(creds, `/lists/${creds.audienceId}`, {
    method: "GET",
  })) as { name?: string; stats?: { member_count?: number } };
  return {
    name: body.name ?? "(unnamed audience)",
    memberCount: body.stats?.member_count ?? 0,
  };
}

/**
 * Create any of our custom merge fields the audience is missing.
 *
 * Mailchimp REJECTS a batch whose members carry a merge field the audience has
 * never heard of, so this has to run before the first push. It reads the
 * existing fields and creates only what's absent — idempotent, and safe to run
 * on every sync (one extra GET per run).
 *
 * FNAME/LNAME are skipped: they exist on every audience by default, and trying
 * to create them is a 400.
 */
export async function ensureMergeFields(
  creds: MailchimpCredentials,
  fields: readonly { tag: string; name: string; type: string }[],
): Promise<string[]> {
  const existing = (await mcFetch(
    creds,
    // The default page size is 10 — smaller than the field count on a
    // well-used audience, which would make us try to re-create fields that
    // already exist. 100 is the endpoint's documented maximum.
    `/lists/${creds.audienceId}/merge-fields?count=100`,
    { method: "GET" },
  )) as { merge_fields?: { tag?: string }[] };
  const have = new Set((existing.merge_fields ?? []).map((f) => f.tag));

  const created: string[] = [];
  for (const field of fields) {
    if (have.has(field.tag)) continue;
    await mcFetch(creds, `/lists/${creds.audienceId}/merge-fields`, {
      method: "POST",
      body: {
        tag: field.tag,
        name: field.name,
        type: field.type,
        // Never force a value: a member Mailchimp already holds (added through
        // a signup form, imported by hand) would otherwise fail validation on
        // the next update because it has no value for our new field.
        required: false,
      },
    });
    created.push(field.tag);
  }
  return created;
}

/** One member's outcome inside a batch — Mailchimp reports per-member errors
 *  alongside the successes rather than failing the whole request. */
export interface MailchimpBatchResult {
  /** Addresses Mailchimp accepted (created or updated). */
  succeeded: string[];
  /** Addresses Mailchimp rejected, with its reason. */
  errors: { email: string; message: string }[];
}

/**
 * Upsert up to `MAILCHIMP_BATCH_SIZE` members in one request
 * (`POST /lists/{id}` — Mailchimp's "batch subscribe or unsubscribe").
 *
 * `update_existing: true` is what makes this an UPSERT rather than an
 * insert-only: without it, every member we already know about comes back as a
 * "already exists" error and no merge field is ever refreshed. It is also what
 * lets a member's `status` be flipped to `unsubscribed` here instead of
 * needing a per-member PATCH keyed by an MD5 subscriber hash.
 *
 * ── The one thing this cannot do ────────────────────────────────────────────
 * Mailchimp will NOT let an API call move a member OUT of `unsubscribed` back
 * to `subscribed` — that transition legally requires the member's own action.
 * Such a member comes back in `errors` on every run. That is correct behavior,
 * not a bug to route around, and it is why `mailchimpMembers.lastError` exists
 * rather than the sync retrying forever in silence.
 */
export async function batchUpsertMembers(
  creds: MailchimpCredentials,
  members: MailchimpMemberPayload[],
): Promise<MailchimpBatchResult> {
  const body = (await mcFetch(creds, `/lists/${creds.audienceId}`, {
    method: "POST",
    body: { members, update_existing: true },
  })) as {
    new_members?: { email_address?: string }[];
    updated_members?: { email_address?: string }[];
    errors?: { email_address?: string; error?: string }[];
  };

  const succeeded = [
    ...(body.new_members ?? []),
    ...(body.updated_members ?? []),
  ]
    .map((m) => m.email_address)
    .filter((e): e is string => typeof e === "string");

  const errors = (body.errors ?? [])
    .filter((e) => typeof e.email_address === "string")
    .map((e) => ({
      email: e.email_address as string,
      message: e.error ?? "Rejected by Mailchimp",
    }));

  return { succeeded, errors };
}
