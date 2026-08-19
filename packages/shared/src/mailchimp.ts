/**
 * Mailchimp audience sync — the PURE half (no I/O, no Convex), so the payload
 * we hand Mailchimp and the eligibility rules that decide who gets into it are
 * unit-testable without a network or a database. The I/O half lives in
 * `apps/convex/lib/mailchimpApi.ts` + `apps/convex/mailchimpSync.ts`.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * Public Worship's bulk email moved to Mailchimp (2026-08-19). The in-app
 * email desk stays in the tree but is parked — see `docs/plans/email-desk-parked.md`
 * for the decision and the gap list. events-os is no longer the thing that
 * SENDS the newsletter; it is the thing that keeps Mailchimp's list HONEST:
 * who exists, who may be mailed, and what they can be segmented by.
 *
 * ── Segmentation is MERGE FIELDS, deliberately not tags ─────────────────────
 * Mailchimp has two ways to attach attributes to a member, and only one of
 * them survives an update through the batch endpoint:
 *
 *  - MERGE FIELDS overwrite on every batch upsert (`POST /lists/{id}` with
 *    `update_existing: true`). A person who moves from Brooklyn to Queens has
 *    `CHAPTER` rewritten on the next sync, automatically. One HTTP request per
 *    500 people, no per-member calls.
 *  - TAGS are only reliably applied when a member is CREATED. Keeping them
 *    correct on update needs `POST /lists/{id}/members/{subscriber_hash}/tags`
 *    — one request per member, keyed by an MD5 of the lowercased address.
 *
 * Half-updating tags is worse than not using them: a marketer builds a segment
 * on "tag = backer", and it silently keeps people who lapsed months ago. So
 * this integration puts every segmentable attribute in a merge field and uses
 * no tags at all. Mailchimp segments on merge fields natively ("CHAPTER is
 * Brooklyn", "BACKER is active"), so nothing is lost but the tag chips in
 * Mailchimp's own UI.
 *
 * If tags are ever genuinely wanted, the shape of that change is: an MD5
 * helper, a stored per-member tag set to diff against, and a per-member tag
 * call for the members whose set actually changed. Do NOT reach for the batch
 * endpoint's `tags` field and hope.
 */

/**
 * Mailchimp's batch-subscribe endpoint accepts up to 500 members per request.
 * Matching it exactly means one HTTP round trip per 500 people rather than
 * per 100 — the `campaigns.ts#DELIVER_BATCH_SIZE` reasoning, different vendor
 * ceiling.
 */
export const MAILCHIMP_BATCH_SIZE = 500;

/**
 * The merge fields this integration owns on the audience. `tag` is Mailchimp's
 * identifier (what a segment condition and a `*|MERGE|*` template token refer
 * to); `name` is the human label shown in Mailchimp's audience settings.
 *
 * FNAME/LNAME are Mailchimp built-ins on every audience — they are listed here
 * because we WRITE them, but `ensureMergeFields` never tries to create them
 * (see its doc). Everything else is ours to create.
 */
export const MAILCHIMP_MERGE_FIELDS = [
  { tag: "FNAME", name: "First Name", type: "text", builtIn: true },
  { tag: "LNAME", name: "Last Name", type: "text", builtIn: true },
  { tag: "CHAPTER", name: "Chapter", type: "text", builtIn: false },
  { tag: "BACKER", name: "Backer status", type: "text", builtIn: false },
  { tag: "ROLE", name: "Role", type: "text", builtIn: false },
] as const;

/** The merge fields we may need to CREATE on a fresh audience. */
export const MAILCHIMP_CUSTOM_MERGE_FIELDS = MAILCHIMP_MERGE_FIELDS.filter(
  (f) => !f.builtIn,
);

/**
 * Backer standing as Mailchimp sees it. Mirrors
 * `schema/campaigns.ts#AUDIENCE_BACKER_STATUSES` plus an explicit `"none"` —
 * a merge field cannot be "absent" in a segment condition the way a filter can
 * be skipped, so "has never backed" needs a value of its own rather than an
 * empty string that also means "we never computed this".
 */
export const MAILCHIMP_BACKER_VALUES = ["active", "lapsed", "none"] as const;
export type MailchimpBackerValue = (typeof MAILCHIMP_BACKER_VALUES)[number];

/**
 * The ROLE merge field's vocabulary, most-specific first — a person is
 * summarized by ONE role because a merge field holds one value. Someone who is
 * both core team and a volunteer is `"team"`: the narrower, more privileged
 * description is the useful one for segmenting.
 */
export const MAILCHIMP_ROLE_VALUES = ["team", "volunteer", "contact"] as const;
export type MailchimpRoleValue = (typeof MAILCHIMP_ROLE_VALUES)[number];

/** Member status as this integration sets it. We never write `"pending"` —
 *  double opt-in is not part of this sync (see the gap list). */
export type MailchimpMemberStatus = "subscribed" | "unsubscribed";

/** What the sync knows about one person, flattened by the Convex side. */
export interface MailchimpPersonInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Full name, used only to derive first/last when those are absent. */
  name?: string | null;
  chapterName?: string | null;
  backer: MailchimpBackerValue;
  role: MailchimpRoleValue;
}

/** One entry in the batch-subscribe payload's `members` array. */
export interface MailchimpMemberPayload {
  email_address: string;
  /** Set on EVERY member, not `status_if_new`: this is how a person who
   *  became ineligible gets flipped to `unsubscribed` on an existing row.
   *  `update_existing: true` on the request is what makes it apply. */
  status: MailchimpMemberStatus;
  merge_fields: Record<string, string>;
}

/**
 * Mailchimp's datacenter prefix, which every API call's hostname needs. It is
 * the suffix of the API key itself (`…-us21`), so a separate stored setting
 * would just be a second copy that can disagree with the key — derive it.
 *
 * Returns `null` for a key with no suffix, which is how a malformed key is
 * caught at configuration time instead of as a DNS failure at send time.
 */
export function deriveMailchimpServerPrefix(apiKey: string): string | null {
  const trimmed = apiKey.trim();
  const dash = trimmed.lastIndexOf("-");
  if (dash < 0) return null;
  const prefix = trimmed.slice(dash + 1);
  // Datacenter prefixes look like `us21`, `us6`, `eu1` — letters then digits.
  return /^[a-z]{2}\d{1,3}$/.test(prefix) ? prefix : null;
}

/** Base URL for the Mailchimp Marketing API v3 in a given datacenter. */
export function mailchimpApiBase(serverPrefix: string): string {
  return `https://${serverPrefix}.api.mailchimp.com/3.0`;
}

/** Lowercased + trimmed, the form Mailchimp dedups on and the form our own
 *  `emailSuppressions` ledger stores. Kept here so the sync and the webhook
 *  agree without importing Convex's `lib/access.ts` into shared code. */
export function normalizeMailchimpEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Split a full name into first/last for the FNAME/LNAME merge fields. Only
 * consulted when the person has no explicit `firstName`/`lastName` — the
 * roster's own fields always win, because a parsed name is a guess and
 * "Mary Anne van der Berg" is exactly the guess that goes wrong.
 */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Build one member entry. `status` is passed in rather than derived here
 * because eligibility is a Convex-side question (it needs the suppression
 * ledger and the opt-out flag) — this function's only job is SHAPE.
 *
 * Merge-field values are always written, never omitted: omitting a field
 * leaves Mailchimp's previous value in place, so a person who stopped being a
 * backer would keep `BACKER: active` forever. An empty string is a real
 * "cleared" instruction; absence is not.
 */
export function buildMailchimpMember(
  person: MailchimpPersonInput,
  status: MailchimpMemberStatus,
): MailchimpMemberPayload {
  const fallback = person.name ? splitName(person.name) : { first: "", last: "" };
  return {
    email_address: normalizeMailchimpEmail(person.email),
    status,
    merge_fields: {
      FNAME: (person.firstName ?? "").trim() || fallback.first,
      LNAME: (person.lastName ?? "").trim() || fallback.last,
      CHAPTER: (person.chapterName ?? "").trim(),
      BACKER: person.backer,
      ROLE: person.role,
    },
  };
}

/** Split a list into fixed-size chunks. Trivial, but the batch ceiling is a
 *  correctness constraint (Mailchimp rejects >500) so it gets a named home
 *  and a test rather than an inline `slice` loop at the call site. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The Mailchimp webhook event types this integration acts on, mapped to the
 * `emailSuppressions.reason` they write. Anything not in this map is a
 * deliberate no-op — mirrors `http.ts`'s `/resend/webhook`, which also only
 * cares about deliverability signals.
 *
 *  - `unsubscribe` — the recipient used Mailchimp's unsubscribe link.
 *  - `cleaned`     — Mailchimp retired the address after hard bounces.
 *  - `spam`        — an abuse complaint.
 *
 * `subscribe` and `profile` are NOT here on purpose: a person subscribing
 * through a Mailchimp signup form does not create a roster row in events-os,
 * and silently un-suppressing an address because Mailchimp saw a re-subscribe
 * would override a suppression our own side may have set for a different
 * reason (a hard bounce on transactional mail, an admin's manual block).
 * Un-suppressing stays a deliberate human act (`emailSuppressions.unsuppressEmail`).
 */
export const MAILCHIMP_SUPPRESSION_EVENTS: Record<
  string,
  "unsubscribe" | "bounce" | "complaint"
> = {
  unsubscribe: "unsubscribe",
  cleaned: "bounce",
  spam: "complaint",
};
