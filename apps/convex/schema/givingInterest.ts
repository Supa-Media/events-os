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
 * PII discipline: `name`/`email`/`location`/`message` are ALL optional (a
 * submission needs only one of them — see `submitInterest`'s validation) and
 * are NEVER exposed by a public query. Only `publicInterestStats`'s bounded
 * counts leave the public surface; the full row (name/email/location/message)
 * is triage-only, reachable exclusively through the central-gated
 * `listInterest`.
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
  kind: v.union(...GIVING_INTEREST_KINDS.map((k) => v.literal(k))),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  location: v.optional(v.string()),
  // Free-text ask/context. Capped at submit time (see `submitInterest`) — the
  // validator itself stays a plain string so the cap can be tuned without a
  // schema migration.
  message: v.optional(v.string()),
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
  // The desk's per-kind breakdown (volunteers vs. space suggestions, etc.).
  .index("by_kind", ["kind"])
  // Newest-first read for `listInterest` and `publicInterestStats`'s counts.
  .index("by_createdAt", ["createdAt"]);
