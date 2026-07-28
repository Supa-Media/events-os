/**
 * TARGETING COPY — the plain-language sentences the segment builder, the
 * "Check a person" readout, and the segment-list summary all speak.
 *
 * Split out of `TargetingBuilder.tsx` so the wording is (a) impossible to
 * fork between those three surfaces and (b) unit-testable: this module is
 * dependency-free at runtime (types only from the Convex API), so it runs
 * under the repo's node-environment Jest config the same way
 * `audienceFilterFields.ts` does.
 *
 * ── Vocabulary ─────────────────────────────────────────────────────────────
 * A saved recipe is a SEGMENT (the Convex table is still `audiences` — this
 * is a label change only). Its two halves are RULE GROUPS ("group" alone
 * collides with Mailchimp's Groups, which are interest tags) and EXCLUSIONS
 * (formerly "skip lists"). We count PEOPLE, never "recipients" — a recipient
 * is a delivery row on one specific send.
 *
 * ── Why `targetingSentences` exists ────────────────────────────────────────
 * The builder's boolean model is genuinely counter-intuitive: lines AND
 * inside a rule group, rule groups OR between each other, and exclusions OR
 * between each other too. It used to be explained only in prose above the
 * controls, which is exactly where nobody reads it. `targetingSentences`
 * turns whatever is currently on screen into the sentence it actually means,
 * so the builder can show the reading back to the author instead of asking
 * them to hold the algebra in their head.
 */
import type { FunctionArgs } from "convex/server";
// Type-only: `typeof api` is a type position, so this import is fully erased
// and this module stays runtime-dependency-free (see the file doc).
import type { api } from "@events-os/convex/_generated/api";
import { centsToDollarsStr } from "./audienceFilterFields";

type PreviewArgs = FunctionArgs<typeof api.audiences.previewAudience>;
export type Targeting = NonNullable<PreviewArgs["targeting"]>;
export type TargetingGroup = Targeting["groups"][number];
export type TargetingCondition = TargetingGroup["conditions"][number];

const DONOR_STATUS_PHRASE: Record<string, string> = {
  any: "a donor",
  prospect: "a prospect donor",
  active: "an active donor",
  lapsed: "a lapsed donor",
};

export type ConditionLookups = {
  eventName?: (id: string) => string | undefined;
  seatTitle?: (id: string) => string | undefined;
  chapterName?: (id: string) => string | undefined;
  serviceLabel?: (id: string) => string | undefined;
};

/** One condition as the sentence the row's controls spell — used verbatim by
 *  the person-check readout, the plain-English recap, and the segment-list
 *  summary so the surfaces can never describe the same condition
 *  differently. */
export function describeCondition(c: TargetingCondition, lookups: ConditionLookups = {}): string {
  switch (c.field) {
    case "donor_status":
      return `${c.op === "is_not" ? "is not" : "is"} ${DONOR_STATUS_PHRASE[c.status]}`;
    case "giving_lifetime":
      return `has given ${c.op === "gte" ? "at least" : "at most"} $${centsToDollarsStr(c.cents)} in total`;
    case "gift_count":
      return `has given ${c.op === "gte" ? "at least" : "at most"} ${c.count} time${c.count === 1 ? "" : "s"}`;
    case "last_gift":
      return c.op === "within_days"
        ? `gave in the last ${c.days} days`
        : `hasn't given in the last ${c.days} days`;
    case "backer":
      return `${c.op === "is_not" ? "is not" : "is"} ${c.status === "active" ? "an active backer" : "a lapsed backer"}`;
    case "attended_event": {
      const name = lookups.eventName?.(c.eventId) ?? "the chosen event";
      return `${c.op === "has_not" ? "has never been to" : "has been to"} ${name}${
        c.rsvpStatus ? ` (RSVP: ${c.rsvpStatus.replace("_", " ")})` : ""
      }${c.withinDays != null ? ` in the last ${c.withinDays} days` : ""}`;
    }
    case "attended_any": {
      const where = c.chapterId
        ? `an event${lookups.chapterName?.(c.chapterId) ? ` in ${lookups.chapterName(c.chapterId)}` : ""}`
        : "any event";
      return `${c.op === "has_not" ? "has never been to" : "has been to"} ${where}${
        c.rsvpStatus ? ` (RSVP: ${c.rsvpStatus.replace("_", " ")})` : ""
      }${c.withinDays != null ? ` in the last ${c.withinDays} days` : ""}`;
    }
    case "chapter": {
      const name = lookups.chapterName?.(c.chapterId) ?? "the chosen chapter";
      return `${c.op === "is_not" ? "is not in" : "is in"} ${name}`;
    }
    case "seat": {
      const title = lookups.seatTitle?.(c.seatId) ?? "the chosen role";
      return `${c.op === "not_holds" ? "is not" : "is"} ${title}`;
    }
    case "kind":
      return c.kind === "team" ? "is a team member" : "is a contact";
    case "email_verified":
      return "has a verified email";
    case "has_service": {
      const label = lookups.serviceLabel?.(c.serviceId) ?? "the chosen service";
      return `${c.op === "has_not" ? "does not have" : "has"} "${label}"`;
    }
  }
}

/** One rule group (or one exclusion) as a noun phrase — "anyone who has been
 *  to any event in the last 90 days". An empty group matches everyone, which
 *  is worth saying out loud rather than rendering as "anyone who ". */
export function describeGroupSentence(
  conditions: readonly TargetingCondition[],
  lookups: ConditionLookups = {},
): string {
  if (conditions.length === 0) return "everyone";
  return `anyone who ${conditions.map((c) => describeCondition(c, lookups)).join(" and ")}`;
}

/**
 * The whole definition read back as sentences — what the builder's
 * "In plain English" panel renders.
 *
 * `send` is one phrase per rule group (the caller joins them with "or",
 * because that IS the relationship between groups); `skip` is one per
 * exclusion, joined the same way. Rendering them as a list rather than one
 * pre-joined string keeps the OR visible as a separate, styled word instead
 * of burying it mid-sentence.
 */
export function targetingSentences(
  targeting: Targeting,
  lookups: ConditionLookups = {},
): { send: string[]; skip: string[] } {
  const groups = targeting.groups.length > 0 ? targeting.groups : [{ conditions: [] }];
  return {
    send: groups.map((g) => describeGroupSentence(g.conditions, lookups)),
    skip: (targeting.excludeGroups ?? []).map((g) => describeGroupSentence(g.conditions, lookups)),
  };
}

/** Compact one-line summary for the segments list ("Anyone who has never been
 *  to any event · or 1 more rule group · 1 exclusion · +2 hand-picked"). No
 *  name lookups on the list — generic phrases stand in for chosen
 *  events/roles/chapters. */
export function summarizeTargeting(
  targeting: Targeting,
  handPicks?: { includeCount?: number; excludeCount?: number },
): string {
  const first = targeting.groups[0];
  const firstText =
    first && first.conditions.length > 0
      ? `Anyone who ${first.conditions.map((c) => describeCondition(c)).join(" and ")}`
      : "Everyone";
  const parts = [firstText];
  if (targeting.groups.length > 1) {
    const more = targeting.groups.length - 1;
    parts.push(`or ${more} more rule group${more === 1 ? "" : "s"}`);
  }
  const skips = targeting.excludeGroups?.length ?? 0;
  if (skips > 0) parts.push(`${skips} exclusion${skips === 1 ? "" : "s"}`);
  if (handPicks?.includeCount) parts.push(`+${handPicks.includeCount} hand-picked`);
  if (handPicks?.excludeCount) parts.push(`−${handPicks.excludeCount} excluded`);
  return parts.join(" · ");
}
