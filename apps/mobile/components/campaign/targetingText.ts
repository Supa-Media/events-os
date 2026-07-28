/**
 * TARGETING COPY AND ROW MODEL — the plain-language sentences the segment
 * builder, the "Check a person" readout, and the segment-list summary all
 * speak, plus the UI-row ⇄ wire-condition conversion those sentences and the
 * live preview are both computed from.
 *
 * Split out of `TargetingBuilder.tsx` so the wording is (a) impossible to
 * fork between those three surfaces and (b) unit-testable: this module is
 * dependency-free at runtime (types only from the Convex API), so it runs
 * under the repo's node-environment Jest config the same way
 * `audienceFilterFields.ts` does. `toWireTargeting` moved here for exactly
 * that second reason — it decides which cards reach the wire and therefore
 * which live count belongs to which card, which is precisely the kind of
 * arithmetic that has to be pinned by tests rather than by reading; it can't
 * be reached from a test while it lives in a module that imports
 * `react-native`.
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
import type { Id } from "@events-os/convex/_generated/dataModel";
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
      // The unresolved-id fallback NAMES the qualifier ("the chosen chapter")
      // exactly as `attended_event`/`chapter`/`seat` do below. It used to drop
      // the chapter clause entirely when no lookup resolved it, so a
      // chapter-scoped condition read as "an event" — one article away from
      // the unscoped "any event", and the segments list passes no lookups AT
      // ALL by design (`summarizeTargeting`), so every list row silently lost
      // its chapter restriction. Reachable, not hypothetical: migration
      // 0042 emits `attended_any` + `chapterId` for wrapped legacy guests
      // audiences and no UI control exposes the field.
      const where = c.chapterId
        ? `an event in ${lookups.chapterName?.(c.chapterId) ?? "the chosen chapter"}`
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

/**
 * A card as it sits ON SCREEN: the conditions that are finished plus how many
 * of its rows still have an unchosen value control ("Role is [Pick a role…]").
 *
 * The wire shape can't express a half-written row — `toWireTargeting` drops
 * those — so anything reading the builder back to its author has to be handed
 * the count separately, or it describes a definition narrower (or, for an
 * empty group, infinitely wider) than the one on screen. `Targeting` itself
 * satisfies this type, which is how the saved-segment surfaces keep passing
 * stored rows straight in.
 */
export type ReadingGroup = {
  conditions: readonly TargetingCondition[];
  /** Rows whose id-valued control hasn't been chosen yet. Defaults to 0. */
  unfinishedCount?: number;
};

export type TargetingReading = {
  groups: readonly ReadingGroup[];
  excludeGroups?: readonly ReadingGroup[];
};

/** How an unfinished row reads. It is never simply omitted: a row with no
 *  value chosen yet is a restriction the author is halfway through writing,
 *  and saying nothing about it makes the sentence claim a WIDER reach than
 *  the screen shows — at the extreme, "everyone". */
function unfinishedPhrase(n: number): string {
  return `matches ${n === 1 ? "a line" : `${n} lines`} you haven't finished yet`;
}

/** One rule group (or one exclusion) as a noun phrase — "anyone who has been
 *  to any event in the last 90 days". An empty group matches everyone, which
 *  is worth saying out loud rather than rendering as "anyone who " — but a
 *  group that is empty only because its rows are unfinished is NOT everyone,
 *  and says so. */
export function describeGroupSentence(
  conditions: readonly TargetingCondition[],
  lookups: ConditionLookups = {},
  unfinishedCount = 0,
): string {
  const parts = conditions.map((c) => describeCondition(c, lookups));
  if (unfinishedCount > 0) parts.push(unfinishedPhrase(unfinishedCount));
  if (parts.length === 0) return "everyone";
  return `anyone who ${parts.join(" and ")}`;
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
 *
 * Takes a `TargetingReading` — one entry per CARD ON SCREEN, unfinished rows
 * included — so the phrases stay positionally aligned with the cards (an
 * exclusion held back from the wire still gets its phrase, in its place) and
 * a half-written row can never read as "no restriction".
 */
export function targetingSentences(
  targeting: TargetingReading,
  lookups: ConditionLookups = {},
): { send: string[]; skip: string[] } {
  const groups: readonly ReadingGroup[] =
    targeting.groups.length > 0 ? targeting.groups : [{ conditions: [] }];
  const phrase = (g: ReadingGroup) =>
    describeGroupSentence(g.conditions, lookups, g.unfinishedCount ?? 0);
  return {
    send: groups.map(phrase),
    skip: (targeting.excludeGroups ?? []).map(phrase),
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

// ── UI row model ────────────────────────────────────────────────────────────
//
// One UI row per condition. `attended_event`/`attended_any` collapse into a
// single "Events" row whose value select offers "any event" plus every real
// event — the wire field is derived from the selection. Rows whose id-valued
// control hasn't been chosen yet hold `null` and are dropped from the wire
// shape (counted, never silently).

export type UiRow =
  | { key: string; kind: "donor"; op: "is" | "is_not"; status: "any" | "prospect" | "active" | "lapsed" }
  | { key: string; kind: "giving"; op: "gte" | "lte"; cents: number }
  | { key: string; kind: "gifts"; op: "gte" | "lte"; count: number }
  | { key: string; kind: "last_gift"; op: "within_days" | "not_within_days"; days: number }
  | { key: string; kind: "backer"; op: "is" | "is_not"; status: "active" | "lapsed" }
  | {
      key: string;
      kind: "attended";
      op: "has" | "has_not";
      eventId: Id<"events"> | "any";
      rsvpStatus?: "going" | "maybe" | "not_going";
      withinDays?: number;
      /** Carried through for wrapped legacy guests audiences (no UI control
       *  — see `schema/campaigns.ts`'s `attended_any.chapterId` doc). */
      chapterId?: Id<"chapters">;
    }
  | { key: string; kind: "chapter"; op: "is" | "is_not"; chapterId: Id<"chapters"> | null }
  | { key: string; kind: "seat"; op: "holds" | "not_holds"; seatId: Id<"seatDefs"> | null }
  | { key: string; kind: "kind"; personKind: "team" | "contact" }
  | { key: string; kind: "email_verified" }
  | {
      key: string;
      kind: "service";
      op: "has" | "has_not";
      // Service Catalog id (`serviceOptions`), not free text — see
      // `schema/campaigns.ts`'s `has_service` doc. `null` = not yet chosen
      // (mirrors "chapter"/"seat"'s own not-yet-chosen-id shape).
      serviceId: Id<"serviceOptions"> | null;
    };

export type UiGroup = { key: string; rows: UiRow[] };

let keyCounter = 0;
export function nextKey(): string {
  keyCounter += 1;
  return `row-${keyCounter}`;
}

export function conditionToRow(c: TargetingCondition): UiRow {
  const key = nextKey();
  switch (c.field) {
    case "donor_status":
      return { key, kind: "donor", op: c.op, status: c.status };
    case "giving_lifetime":
      return { key, kind: "giving", op: c.op, cents: c.cents };
    case "gift_count":
      return { key, kind: "gifts", op: c.op, count: c.count };
    case "last_gift":
      return { key, kind: "last_gift", op: c.op, days: c.days };
    case "backer":
      return { key, kind: "backer", op: c.op, status: c.status };
    case "attended_event":
      return {
        key,
        kind: "attended",
        op: c.op,
        eventId: c.eventId,
        rsvpStatus: c.rsvpStatus,
        withinDays: c.withinDays,
      };
    case "attended_any":
      return {
        key,
        kind: "attended",
        op: c.op,
        eventId: "any",
        rsvpStatus: c.rsvpStatus,
        withinDays: c.withinDays,
        chapterId: c.chapterId,
      };
    case "chapter":
      return { key, kind: "chapter", op: c.op, chapterId: c.chapterId };
    case "seat":
      return { key, kind: "seat", op: c.op, seatId: c.seatId };
    case "kind":
      return { key, kind: "kind", personKind: c.kind };
    case "email_verified":
      return { key, kind: "email_verified" };
    case "has_service":
      return { key, kind: "service", op: c.op, serviceId: c.serviceId };
  }
}

/** null = the row is incomplete (an id control not chosen yet) — dropped from
 *  the wire shape and counted by `toWireTargeting`. */
export function rowToCondition(r: UiRow): TargetingCondition | null {
  switch (r.kind) {
    case "donor":
      return { field: "donor_status", op: r.op, status: r.status };
    case "giving":
      return { field: "giving_lifetime", op: r.op, cents: r.cents };
    case "gifts":
      return { field: "gift_count", op: r.op, count: r.count };
    case "last_gift":
      return { field: "last_gift", op: r.op, days: r.days };
    case "backer":
      return { field: "backer", op: r.op, status: r.status };
    case "attended":
      if (r.eventId === "any") {
        return {
          field: "attended_any",
          op: r.op,
          ...(r.rsvpStatus ? { rsvpStatus: r.rsvpStatus } : {}),
          ...(r.withinDays != null ? { withinDays: r.withinDays } : {}),
          ...(r.chapterId ? { chapterId: r.chapterId } : {}),
        };
      }
      return {
        field: "attended_event",
        op: r.op,
        eventId: r.eventId,
        ...(r.rsvpStatus ? { rsvpStatus: r.rsvpStatus } : {}),
        ...(r.withinDays != null ? { withinDays: r.withinDays } : {}),
      };
    case "chapter":
      return r.chapterId ? { field: "chapter", op: r.op, chapterId: r.chapterId } : null;
    case "seat":
      return r.seatId ? { field: "seat", op: r.op, seatId: r.seatId } : null;
    case "kind":
      return { field: "kind", op: "is", kind: r.personKind };
    case "email_verified":
      return { field: "email_verified", op: "is" };
    case "service":
      return r.serviceId ? { field: "has_service", op: r.op, serviceId: r.serviceId } : null;
  }
}

export function targetingToUi(targeting: Targeting): { groups: UiGroup[]; excludeGroups: UiGroup[] } {
  return {
    groups: targeting.groups.map((g) => ({
      key: nextKey(),
      rows: g.conditions.map(conditionToRow),
    })),
    excludeGroups: (targeting.excludeGroups ?? []).map((g) => ({
      key: nextKey(),
      rows: g.conditions.map(conditionToRow),
    })),
  };
}

export type WireTargeting = {
  /** What the preview asks for and Save stores. */
  targeting: Targeting;
  /** Rows on screen with an unchosen value control, across both sides. Save
   *  blocks on this, and every count on screen has to hold while it's > 0. */
  incompleteCount: number;
  /**
   * For each exclusion CARD (UI order), its index in
   * `targeting.excludeGroups` — or `null` when the card was held back from
   * the wire and therefore produced no count at all.
   *
   * Held-back cards RENUMBER every exclusion after them, so
   * `perExcludeGroupCounts[cardIndex]` is simply the wrong figure once any
   * exclusion is unfinished: the count computed for exclusion 2 lands on the
   * card labelled "Exclusion 1", which excludes nobody. Every count lookup
   * goes through this map instead of the card's own position.
   */
  excludeWireIndexes: (number | null)[];
  /** Every card exactly as it sits on screen — unfinished rows counted, and
   *  held-back exclusions still present in their own position — for the
   *  sentences that read the builder back to its author. */
  reading: { groups: ReadingGroup[]; excludeGroups: ReadingGroup[] };
};

export function toWireTargeting(groups: UiGroup[], excludeGroups: UiGroup[]): WireTargeting {
  let incompleteCount = 0;
  const read = (gs: UiGroup[]): ReadingGroup[] =>
    gs.map((g) => {
      let unfinishedCount = 0;
      const conditions = g.rows.flatMap((r) => {
        const c = rowToCondition(r);
        if (c === null) {
          unfinishedCount += 1;
          return [];
        }
        return [c];
      });
      incompleteCount += unfinishedCount;
      return { conditions, unfinishedCount };
    });
  const readGroups = read(groups);
  const readExclude = read(excludeGroups);

  const wireGroups = readGroups.map((g) => ({ conditions: [...g.conditions] }));
  // An exclusion whose only rows are incomplete would become an EMPTY exclude
  // group — which the backend rejects outright ("an empty one would skip
  // everyone"). Hold those back from the wire shape; the incomplete-row count
  // already blocks Save and the preview simply doesn't apply the
  // still-unfinished exclusion yet. Record where each surviving card landed
  // so its count can never be read off the wrong index (see
  // `excludeWireIndexes`).
  const wireExclude: { conditions: TargetingCondition[] }[] = [];
  const excludeWireIndexes = readExclude.map((g) => {
    if (g.conditions.length === 0) return null;
    wireExclude.push({ conditions: [...g.conditions] });
    return wireExclude.length - 1;
  });

  return {
    targeting: {
      groups: wireGroups.length > 0 ? wireGroups : [{ conditions: [] }],
      ...(wireExclude.length > 0 ? { excludeGroups: wireExclude } : {}),
    },
    incompleteCount,
    excludeWireIndexes,
    reading: { groups: readGroups, excludeGroups: readExclude },
  };
}
