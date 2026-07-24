import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Interest capture + suggest-a-space (giving-territories addendum, the `/give`
 * redesign) — the OS's triage inbox for everyone who engages the public
 * `/give` page WITHOUT paying: "I want this in my city," volunteer, join the
 * founding team, help fund (non-monetary interest), or suggest a physical
 * space for a gathering. Deliberately separate from `donors`/`pledges`/`gifts`
 * (which are ALWAYS money) and from `territories` (places already raising) —
 * this table is pure LEAD CAPTURE, no payment rail attached and no scoping
 * discipline beyond the optional `territorySlug` the submission mentions.
 *
 * Write path: `givingInterest.submitInterest` (PUBLIC mutation, no auth —
 * mirrors the public pledge/donation flow) inserts ONE row per submission,
 * status `"new"`. Central `giving.manage`/`giving.view` triage the inbox via
 * `listInterest` / `setInterestStatus` (see `givingInterest.ts`);
 * `publicInterestStats` feeds the `/give` page's PII-free aggregate counts
 * (`{ total, wantInCity }`) the same bounded-count way
 * `territories.getPublicMapData` feeds the map.
 *
 * PII discipline: `name`/`email`/`phone`/`socialHandle`/`location`/`message`/
 * `roles`/`skills`/`church` are ALL optional (a submission needs only one of
 * name/email/location/message UNLESS `kinds` includes `join_team`, which
 * requires name+phone+email+roles — see `submitInterest`'s validation) and
 * are NEVER exposed by a public query. Only `publicInterestStats`'s bounded
 * counts leave the public surface; the full row (including the
 * founding-team fields below) is triage-only, reachable exclusively through
 * the central-gated `listInterest`.
 *
 * MULTI-SELECT (wave 2, F4): a submission can express several intents at
 * once ("want it in my city" + "volunteer" + "help fund" — someone is rarely
 * just one of these). The table's single `kind` field is superseded by
 * `kinds: v.array(<the 5 literals>)`, at least one entry required (see
 * `submitInterest`). This SUPERSEDES the wave-1 single-`kind` shape outright —
 * there is no production data yet (this branch introduced the table), so no
 * data migration is needed; the array shape simply replaces the scalar one.
 */

/** The five interest-capture flavors the public `/give` page's CTAs submit:
 *  - `want_in_city`   — "I want Public Worship in my city";
 *  - `volunteer`      — wants to help hands-on, not necessarily give money;
 *  - `join_team`      — wants to join a founding/launch team;
 *  - `fund`           — wants to help fund but isn't ready to pledge/donate
 *                       through the payment flow yet (a warm lead, not a gift);
 *  - `suggest_space`  — is suggesting a physical space for a gathering. */
export const GIVING_INTEREST_KINDS = [
  "want_in_city",
  "volunteer",
  "join_team",
  "fund",
  "suggest_space",
] as const;
export type GivingInterestKind = (typeof GIVING_INTEREST_KINDS)[number];

/**
 * A submission's triage lifecycle:
 *  - `new`       — just submitted, unread by the desk;
 *  - `contacted` — a human has reached out;
 *  - `archived`  — done / not actionable, kept for the record (rows are never
 *                  deleted — `archived` is the "closed" state, not erasure).
 */
export const GIVING_INTEREST_STATUSES = [
  "new",
  "contacted",
  "archived",
] as const;
export type GivingInterestStatus = (typeof GIVING_INTEREST_STATUSES)[number];

export const givingInterest = defineTable({
  // Multi-select (wave 2, F4): one or more of the five kinds above, e.g. a
  // person can be BOTH "want_in_city" and "volunteer" in the same
  // submission. `submitInterest` validates every entry is a known kind,
  // dedupes, and requires at least one. Small (≤5 possible entries), so a
  // plain array field is fine here — not the unbounded-list case the schema
  // guidelines warn about.
  kinds: v.array(v.union(...GIVING_INTEREST_KINDS.map((k) => v.literal(k)))),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  // Contact fields beyond email — mainly for founding-team follow-up (a
  // `join_team` submission requires `phone`; see `submitInterest`).
  phone: v.optional(v.string()),
  // A public social handle/profile ("@handle", a link) the person offered as
  // an alternate way to find/verify them — optional everywhere.
  socialHandle: v.optional(v.string()),
  location: v.optional(v.string()),
  // Free-text ask/context. Capped at submit time (see `submitInterest`) — the
  // validator itself stays a plain string so the cap can be tuned without a
  // schema migration.
  message: v.optional(v.string()),
  // ── Founding-team fields (F7 — "who we're looking for"). REQUIRED (along
  // with name/phone/email) when `kinds` includes `join_team`; optional for
  // every other submission — see `submitInterest`'s conditional validation.
  // Role interests, e.g. "Chapter Director," "Music Lead." Deliberately
  // free strings, NOT a strict union of `CHAPTER_CORE_ROLES` — central needs
  // to evolve this list (new roles, wording tweaks) without a schema
  // migration; capped at submit time (see `submitInterest`).
  roles: v.optional(v.array(v.string())),
  // Freeform: what skills/experience they bring.
  skills: v.optional(v.string()),
  // Freeform: what local church they attend — ties to the "already serving a
  // local church" founding-team qualification (see F7 copy).
  church: v.optional(v.string()),
  // The territory this interest is ABOUT (e.g. "I want this in Queens"), set
  // when the submission came from a territory page rather than the central
  // `/give` map. Not a foreign key — a slug can outlive/precede its territory
  // row (a "want it in my city" submission for a city with no territory yet).
  territorySlug: v.optional(v.string()),
  status: v.union(...GIVING_INTEREST_STATUSES.map((s) => v.literal(s))),
  createdAt: v.number(),
  // Stamped together by `setInterestStatus` when the desk moves a row off
  // `"new"` — absent on a fresh, untouched submission.
  handledAt: v.optional(v.number()),
  handledBy: v.optional(v.id("users")),
})
  // The triage inbox's default filter (unread-first workflow).
  .index("by_status", ["status"])
  // Newest-first read for `listInterest` and `publicInterestStats`'s counts.
  .index("by_createdAt", ["createdAt"]);
// NOTE (wave 2, F4): the wave-1 `by_kind` index (on the old scalar `kind`
// field) is dropped, not renamed — indexing an array field like `kinds`
// would only support exact whole-array equality, not "does this submission
// include X" membership, so it wouldn't serve the per-kind breakdown it was
// documented for anyway. That breakdown (see `publicInterestStats`) reads
// the bounded scan and filters in memory instead, same as before.
