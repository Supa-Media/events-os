/**
 * SEGMENT BUILDER (targeting v2 — specs/audience-targeting-v2.md, Phase C)
 * — the rule-group/condition editor that replaced the flat criteria-chip
 * builder for every segment carrying `targeting` (migration 0042 wraps all
 * legacy rows, so that's effectively everything; `AudiencesView.tsx` keeps
 * the old chip builder mounted only for a not-yet-wrapped row).
 *
 * The model the founder approved (interactive mockup, 2026-07-24), in the
 * builder's own vocabulary — plain words, no boolean jargon:
 *  - "Send to" RULE GROUPS — someone gets the email if they match ANY one
 *    rule group; inside one, every sentence-row must be true ("and also…").
 *    A rule group with no rows means "everyone". ("Rule group" rather than
 *    bare "group": Mailchimp's Groups are interest tags, a different thing.)
 *  - EXCLUSIONS (formerly "skip lists") — anyone matching one is removed,
 *    even if a rule group (or a hand-pick) includes them. Exclusions are
 *    OR'd with each other, which is the model's least obvious corner: "skip
 *    Worship Leaders or Tech Leads" is TWO exclusions, not two lines in one.
 *  - Negation is ON the row ("has never been to", "is not"), not a separate
 *    mode.
 *  - Every card shows its own live match count; the check-a-person box
 *    (`PersonCheckSection`) explains any individual, condition by condition.
 *
 * ── Making the logic legible, not merely documented ────────────────────────
 * The AND/OR structure used to be stated only in the two `Field` hints, i.e.
 * in prose above the controls where nobody reads it. It's now visible IN the
 * UI: a plain-English recap panel reads the whole definition back as the
 * sentence it actually means (`targetingText.ts#targetingSentences`), each
 * card says in one line how its own rows combine, AND connectors sit between
 * rows, and OR dividers sit between rule groups AND between exclusions — the
 * exclusion side had no divider at all before, which is precisely where the
 * either/or was invisible.
 *
 * ── Choosing the field FIRST ───────────────────────────────────────────────
 * "+ and also…" used to insert a Donor row and "+ Add a skip list" a Role
 * row, so every condition began as the wrong condition: you picked a field,
 * the row reset, then you filled it in. Adding a row now opens
 * `AddConditionMenu` — pick what the line is about, and the row arrives as
 * that. Nothing is inserted until a field is chosen, so there is never work
 * to delete before starting.
 *
 * State model: the UI edits `UiGroup[]` rows that mirror the wire conditions
 * but allow a not-yet-chosen id (`eventId`/`seatId`/`chapterId` = null) while
 * the author is mid-edit — `toWireTargeting` drops incomplete rows for the
 * live preview and reports their count so Save can block on them instead of
 * silently sending a narrower segment than what's on screen. Numeric inputs
 * commit on every valid keystroke (no field-level debounce to flush at save
 * time — WYSIWYG by construction); the PREVIEW is what debounces, one level
 * up in `AudiencesView.tsx`.
 */
import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Field, Icon, OptionTag, Select, ServiceOptionsPicker, TextField } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { buildServiceLabelMap, parentIdsWithChildren } from "../../lib/serviceCatalog";
import {
  centsToDollarsStr,
  dollarsStrToCents,
  intStrToNumber,
  intToStr,
  resolveNumberField,
} from "./audienceFilterFields";
import {
  describeCondition,
  targetingSentences,
  type ConditionLookups,
  type Targeting,
  type TargetingCondition,
} from "./targetingText";

type PreviewArgs = FunctionArgs<typeof api.audiences.previewAudience>;
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;
// The sentence layer lives in `targetingText.ts` (dependency-free, so it's
// unit-testable); re-exported here because this module is the import path
// every consumer already uses.
export {
  describeCondition,
  describeGroupSentence,
  summarizeTargeting,
  targetingSentences,
  type ConditionLookups,
  type Targeting,
  type TargetingCondition,
  type TargetingGroup,
} from "./targetingText";
type ExplainResult = FunctionReturnType<typeof api.audiences.explainAudiencePerson>;
type SearchResult = FunctionReturnType<typeof api.audiences.searchPeopleForAudience>[number];

const SEARCH_DEBOUNCE_MS = 400;

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
function nextKey(): string {
  keyCounter += 1;
  return `row-${keyCounter}`;
}

function conditionToRow(c: TargetingCondition): UiRow {
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
function rowToCondition(r: UiRow): TargetingCondition | null {
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

export function toWireTargeting(
  groups: UiGroup[],
  excludeGroups: UiGroup[],
): { targeting: Targeting; incompleteCount: number } {
  let incompleteCount = 0;
  const convert = (gs: UiGroup[]) =>
    gs.map((g) => ({
      conditions: g.rows.flatMap((r) => {
        const c = rowToCondition(r);
        if (c === null) {
          incompleteCount += 1;
          return [];
        }
        return [c];
      }),
    }));
  const wireGroups = convert(groups);
  // A skip list whose only rows are incomplete would become an EMPTY exclude
  // group — which the backend rejects outright ("an empty one would skip
  // everyone"). Hold those back from the wire shape; the incomplete-row
  // count already blocks Save and the preview simply doesn't apply the
  // still-unfinished skip list yet.
  const wireExclude = convert(excludeGroups).filter((g) => g.conditions.length > 0);
  return {
    targeting: {
      groups: wireGroups.length > 0 ? wireGroups : [{ conditions: [] }],
      ...(wireExclude.length > 0 ? { excludeGroups: wireExclude } : {}),
    },
    incompleteCount,
  };
}

// ── Option data (events / seats / chapters), shared across rows ────────────

function useTargetingOptions() {
  const events = useQuery(api.events.list, { scope: "all" }) ?? [];
  const chart = useQuery(api.seats.chart, {});
  const serviceTree = useQuery(api.serviceOptions.list, { includeInactive: true });
  const serviceLabelById = useMemo(
    () => (serviceTree ? buildServiceLabelMap(serviceTree) : new Map<string, string>()),
    [serviceTree],
  );
  // Which top-level ids actually have children — only those get the "matches
  // everyone under it too" note (a childless top-level row IS the whole
  // match set, same as any leaf).
  const serviceParentIdsWithChildren = useMemo(
    () => (serviceTree ? parentIdsWithChildren(serviceTree) : new Set<Id<"serviceOptions">>()),
    [serviceTree],
  );
  const seatOptions = useMemo(() => {
    if (chart === undefined) return [];
    const seats =
      chart.kind === "full" ? [...chart.central, ...(chart.chapters[0]?.seats ?? [])] : chart.seats;
    const seen = new Map<string, string>();
    for (const s of seats) {
      if (s.derived) continue;
      if (!seen.has(s.defId)) seen.set(s.defId, s.title);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [chart]);
  const chapterOptions =
    chart?.kind === "full"
      ? chart.chapters.map((c) => ({ value: c.chapterId, label: c.chapterName }))
      : [];
  const eventOptions = events.map((e: { _id: string; name: string }) => ({
    value: e._id,
    label: e.name,
  }));
  const lookups: ConditionLookups = {
    eventName: (id) => eventOptions.find((o) => o.value === id)?.label,
    seatTitle: (id) => seatOptions.find((o) => o.value === id)?.label,
    chapterName: (id) => chapterOptions.find((o) => o.value === id)?.label,
    serviceLabel: (id) => serviceLabelById.get(id as Id<"serviceOptions">),
  };
  return {
    eventOptions,
    seatOptions,
    chapterOptions,
    lookups,
    serviceLabelById,
    serviceParentIdsWithChildren,
  };
}

type TargetingOptions = ReturnType<typeof useTargetingOptions>;

// ── Row editor ──────────────────────────────────────────────────────────────

const FIELD_OPTIONS = [
  { value: "donor", label: "Donor" },
  { value: "giving", label: "Total giving" },
  { value: "gifts", label: "Number of gifts" },
  { value: "last_gift", label: "Last gift" },
  { value: "backer", label: "Backer" },
  { value: "attended", label: "Events" },
  { value: "chapter", label: "Chapter" },
  { value: "seat", label: "Role" },
  { value: "kind", label: "Person type" },
  { value: "email_verified", label: "Email" },
  { value: "service", label: "Has service" },
];

/** Fields a given side of the builder may offer. #424 finding C:
 *  verified-email reads backwards as an exclusion ("leave out anyone whose
 *  address IS verified") and the backend rejects it, so it isn't offered
 *  there at all. */
function fieldOptionsFor(excludeSide: boolean) {
  return excludeSide ? FIELD_OPTIONS.filter((o) => o.value !== "email_verified") : FIELD_OPTIONS;
}

function defaultRow(kind: string): UiRow {
  const key = nextKey();
  switch (kind) {
    case "giving":
      return { key, kind: "giving", op: "gte", cents: 10_000 };
    case "gifts":
      return { key, kind: "gifts", op: "gte", count: 1 };
    case "last_gift":
      return { key, kind: "last_gift", op: "within_days", days: 90 };
    case "backer":
      return { key, kind: "backer", op: "is", status: "active" };
    case "attended":
      return { key, kind: "attended", op: "has", eventId: "any" };
    case "chapter":
      return { key, kind: "chapter", op: "is", chapterId: null };
    case "seat":
      return { key, kind: "seat", op: "holds", seatId: null };
    case "kind":
      return { key, kind: "kind", personKind: "team" };
    case "email_verified":
      return { key, kind: "email_verified" };
    case "service":
      return { key, kind: "service", op: "has", serviceId: null };
    default:
      return { key, kind: "donor", op: "is", status: "any" };
  }
}

const RSVP_QUAL_OPTIONS = [
  { value: "any", label: "Any RSVP" },
  { value: "going", label: "RSVP'd going" },
  { value: "maybe", label: "RSVP'd maybe" },
  { value: "not_going", label: "RSVP'd not going" },
];

function withinDaysOptions(current: number | undefined) {
  const base = [
    { value: "any", label: "Any time" },
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "365", label: "Last year" },
  ];
  if (current != null && !["30", "90", "365"].includes(String(current))) {
    base.push({ value: String(current), label: `Last ${current} days` });
  }
  return base;
}

/** A numeric value control that commits every VALID keystroke immediately
 *  (WYSIWYG — nothing to flush at save time) and reports invalid text up so
 *  Save can stay disabled while it's malformed. */
function ImmediateNumberField({
  fieldKey,
  value,
  format,
  parse,
  onCommit,
  onInvalid,
  placeholder,
}: {
  fieldKey: string;
  value: number;
  format: (n: number | undefined) => string;
  parse: (raw: string) => number | undefined;
  onCommit: (n: number) => void;
  onInvalid: (key: string, invalid: boolean) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(() => format(value));
  const resolution = resolveNumberField(raw, parse);
  const invalid = resolution.invalid || resolution.value === undefined;

  useEffect(() => {
    onInvalid(fieldKey, invalid);
    return () => onInvalid(fieldKey, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, invalid]);

  return (
    <TextField
      placeholder={placeholder}
      keyboardType="numeric"
      value={raw}
      onChangeText={(text) => {
        setRaw(text);
        const r = resolveNumberField(text, parse);
        if (!r.invalid && r.value !== undefined) onCommit(r.value);
      }}
      hint={invalid ? "Enter a number." : undefined}
    />
  );
}

function ConditionRow({
  row,
  excludeSide,
  options,
  onChange,
  onRemove,
  onInvalid,
}: {
  row: UiRow;
  excludeSide: boolean;
  options: TargetingOptions;
  onChange: (next: UiRow) => void;
  onRemove: () => void;
  onInvalid: (key: string, invalid: boolean) => void;
}) {
  const [servicePickerOpen, setServicePickerOpen] = useState(false);
  // Swapping the field keeps the row identity (its `key`) so list order and
  // focus don't jump; everything else resets to that field's default shape.
  const fieldOptions = fieldOptionsFor(excludeSide);

  const opSelect = (opts: { value: string; label: string }[], value: string, set: (v: string) => void) => (
    <View style={rowStyles.opBox}>
      <Select value={value} options={opts} onChange={set} />
    </View>
  );

  return (
    <View style={rowStyles.row}>
      <View style={rowStyles.fieldBox}>
        <Select
          value={row.kind}
          options={fieldOptions}
          onChange={(v) => onChange({ ...defaultRow(v), key: row.key })}
        />
      </View>

      {row.kind === "donor" ? (
        <>
          {opSelect(
            [
              { value: "is", label: "is" },
              { value: "is_not", label: "is not" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "is" | "is_not" }),
          )}
          <View style={rowStyles.valueBox}>
            <Select
              value={row.status}
              options={[
                { value: "any", label: "a donor (any status)" },
                { value: "prospect", label: "a prospect donor" },
                { value: "active", label: "an active donor" },
                { value: "lapsed", label: "a lapsed donor" },
              ]}
              onChange={(v) => onChange({ ...row, status: v as typeof row.status })}
            />
          </View>
        </>
      ) : null}

      {row.kind === "giving" ? (
        <>
          {opSelect(
            [
              { value: "gte", label: "is at least" },
              { value: "lte", label: "is at most" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "gte" | "lte" }),
          )}
          <Text style={rowStyles.unit}>$</Text>
          <View style={rowStyles.numBox}>
            <ImmediateNumberField
              fieldKey={`${row.key}:cents`}
              value={row.cents}
              format={centsToDollarsStr}
              parse={dollarsStrToCents}
              onCommit={(n) => onChange({ ...row, cents: n })}
              onInvalid={onInvalid}
              placeholder="100"
            />
          </View>
        </>
      ) : null}

      {row.kind === "gifts" ? (
        <>
          {opSelect(
            [
              { value: "gte", label: "is at least" },
              { value: "lte", label: "is at most" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "gte" | "lte" }),
          )}
          <View style={rowStyles.numBox}>
            <ImmediateNumberField
              fieldKey={`${row.key}:count`}
              value={row.count}
              format={intToStr}
              parse={intStrToNumber}
              onCommit={(n) => onChange({ ...row, count: n })}
              onInvalid={onInvalid}
              placeholder="1"
            />
          </View>
          <Text style={rowStyles.unit}>gifts</Text>
        </>
      ) : null}

      {row.kind === "last_gift" ? (
        <>
          {opSelect(
            [
              { value: "within_days", label: "was in the last" },
              { value: "not_within_days", label: "was NOT in the last" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "within_days" | "not_within_days" }),
          )}
          <View style={rowStyles.numBox}>
            <ImmediateNumberField
              fieldKey={`${row.key}:days`}
              value={row.days}
              format={intToStr}
              parse={intStrToNumber}
              onCommit={(n) => onChange({ ...row, days: n })}
              onInvalid={onInvalid}
              placeholder="90"
            />
          </View>
          <Text style={rowStyles.unit}>days</Text>
        </>
      ) : null}

      {row.kind === "backer" ? (
        <>
          {opSelect(
            [
              { value: "is", label: "is" },
              { value: "is_not", label: "is not" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "is" | "is_not" }),
          )}
          <View style={rowStyles.valueBox}>
            <Select
              value={row.status}
              options={[
                { value: "active", label: "an active backer" },
                { value: "lapsed", label: "a lapsed backer" },
              ]}
              onChange={(v) => onChange({ ...row, status: v as "active" | "lapsed" })}
            />
          </View>
        </>
      ) : null}

      {row.kind === "attended" ? (
        <>
          {opSelect(
            [
              { value: "has", label: "has been to" },
              { value: "has_not", label: "has never been to" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "has" | "has_not" }),
          )}
          <View style={rowStyles.valueBox}>
            <Select
              searchable
              value={row.eventId}
              options={[{ value: "any", label: "any event" }, ...options.eventOptions]}
              onChange={(v) =>
                onChange({ ...row, eventId: (v || "any") as Id<"events"> | "any" })
              }
            />
          </View>
          <View style={rowStyles.qualBox}>
            <Select
              value={row.rsvpStatus ?? "any"}
              options={RSVP_QUAL_OPTIONS}
              onChange={(v) =>
                onChange({
                  ...row,
                  rsvpStatus: v === "any" ? undefined : (v as "going" | "maybe" | "not_going"),
                })
              }
            />
          </View>
          <View style={rowStyles.qualBox}>
            <Select
              value={row.withinDays != null ? String(row.withinDays) : "any"}
              options={withinDaysOptions(row.withinDays)}
              onChange={(v) => onChange({ ...row, withinDays: v === "any" ? undefined : Number(v) })}
            />
          </View>
        </>
      ) : null}

      {row.kind === "chapter" ? (
        <>
          {opSelect(
            [
              { value: "is", label: "is in" },
              { value: "is_not", label: "is not in" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "is" | "is_not" }),
          )}
          <View style={rowStyles.valueBox}>
            <Select
              value={row.chapterId ?? ""}
              options={[{ value: "", label: "Pick a chapter…" }, ...options.chapterOptions]}
              onChange={(v) => onChange({ ...row, chapterId: v ? (v as Id<"chapters">) : null })}
            />
          </View>
        </>
      ) : null}

      {row.kind === "seat" ? (
        <>
          {opSelect(
            [
              { value: "holds", label: "is" },
              { value: "not_holds", label: "is not" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "holds" | "not_holds" }),
          )}
          <View style={rowStyles.valueBox}>
            <Select
              value={row.seatId ?? ""}
              options={[{ value: "", label: "Pick a role…" }, ...options.seatOptions]}
              onChange={(v) => onChange({ ...row, seatId: v ? (v as Id<"seatDefs">) : null })}
            />
          </View>
        </>
      ) : null}

      {row.kind === "kind" ? (
        <View style={rowStyles.valueBox}>
          <Select
            value={row.personKind}
            options={[
              { value: "team", label: "is a team member" },
              { value: "contact", label: "is a contact" },
            ]}
            onChange={(v) => onChange({ ...row, personKind: v as "team" | "contact" })}
          />
        </View>
      ) : null}

      {row.kind === "email_verified" ? <Text style={rowStyles.unit}>is verified</Text> : null}

      {row.kind === "service" ? (
        <>
          {opSelect(
            [
              { value: "has", label: "has" },
              { value: "has_not", label: "does not have" },
            ],
            row.op,
            (v) => onChange({ ...row, op: v as "has" | "has_not" }),
          )}
          <View style={rowStyles.valueBox}>
            <Pressable
              onPress={() => setServicePickerOpen(true)}
              className="flex-row items-center justify-between rounded-md border border-border-strong bg-raised px-3 py-2.5"
            >
              <Text
                className={row.serviceId ? "text-base text-ink" : "text-base text-faint"}
                numberOfLines={1}
              >
                {row.serviceId
                  ? (options.serviceLabelById.get(row.serviceId) ?? "…")
                  : "Pick a service…"}
              </Text>
              <Icon name="chevron-down" size={16} color={colors.muted} />
            </Pressable>
            {/* Choosing a group (e.g. "Vocals") is presented — both in the
                picker's own header and here — as matching everyone under it
                too, since that's the whole point of the hierarchy (backend
                subtree rollup, `lib/audienceTargeting.ts`). */}
            {row.serviceId && options.serviceParentIdsWithChildren.has(row.serviceId) ? (
              <Text style={rowStyles.serviceHint}>Matches everyone under this too.</Text>
            ) : null}
            <ServiceOptionsPicker
              visible={servicePickerOpen}
              onClose={() => setServicePickerOpen(false)}
              mode="single"
              selectedIds={row.serviceId ? [row.serviceId] : []}
              onChange={(ids) => onChange({ ...row, serviceId: ids[0] ?? null })}
              title="Pick a service"
            />
          </View>
        </>
      ) : null}

      <Button
        title="✕"
        variant="ghost"
        onPress={onRemove}
        className="ml-auto"
      />
    </View>
  );
}

// ── Adding a line: pick the field FIRST ─────────────────────────────────────

/**
 * A button that, instead of inserting a row, first asks what the line is
 * about — then inserts a row of exactly that kind.
 *
 * Every "add" in this builder used to insert a fixed default (a Donor row
 * from "+ and also…", a Role row from "+ Add a skip list"), so the common
 * case was: get the wrong condition, hunt for the field select, change it,
 * watch the row reset, then fill it in. Choosing first removes that whole
 * detour and means a half-built row never exists — there is nothing to
 * delete to get started. It also cuts the founder's benchmark ("came to an
 * event in the last 90 days, except staff") from ~12 interactions to 6.
 */
function AddConditionMenu({
  label,
  excludeSide,
  onPick,
}: {
  label: string;
  excludeSide: boolean;
  onPick: (kind: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        title={label}
        variant="secondary"
        onPress={() => setOpen(true)}
        className="mt-2 self-start"
      />
    );
  }

  return (
    <View style={addStyles.menu}>
      <Text style={addStyles.prompt}>What should this line be about?</Text>
      <View style={addStyles.chips}>
        {fieldOptionsFor(excludeSide).map((o) => (
          <OptionTag
            key={o.value}
            label={o.label}
            size="md"
            onPress={() => {
              onPick(o.value);
              setOpen(false);
            }}
          />
        ))}
      </View>
      <Button
        title="Cancel"
        variant="ghost"
        onPress={() => setOpen(false)}
        className="self-start"
      />
    </View>
  );
}

// ── Group cards ─────────────────────────────────────────────────────────────

/** The one-liner INSIDE a card that says how its own rows combine — the
 *  AND/OR model where it's being used, rather than only in the section hint
 *  above every card. */
function combineNote(excludeSide: boolean, rowCount: number): string | null {
  if (rowCount === 0) return null;
  if (excludeSide) {
    return rowCount === 1
      ? "Anyone this is true of is left out. Need a second, unrelated reason? Add another exclusion — they're either/or."
      : `Left out only when ALL ${rowCount} lines are true of the same person. For an either/or, use separate exclusions.`;
  }
  return rowCount === 1
    ? "Anyone this is true of is in."
    : `In only when ALL ${rowCount} lines are true of the same person.`;
}

function GroupCard({
  group,
  index,
  excludeSide,
  count,
  options,
  onChange,
  onDelete,
  onInvalid,
  canDelete,
}: {
  group: UiGroup;
  index: number;
  excludeSide: boolean;
  count: number | undefined;
  options: TargetingOptions;
  onChange: (next: UiGroup) => void;
  onDelete: () => void;
  onInvalid: (key: string, invalid: boolean) => void;
  canDelete: boolean;
}) {
  const note = combineNote(excludeSide, group.rows.length);
  return (
    <View style={[groupStyles.card, excludeSide ? groupStyles.cardExclude : null]}>
      <View style={groupStyles.head}>
        <View style={[groupStyles.tag, excludeSide ? groupStyles.tagExclude : null]}>
          <Text style={[groupStyles.tagText, excludeSide ? groupStyles.tagTextExclude : null]}>
            {excludeSide ? `Exclusion ${index + 1}` : `Rule group ${index + 1}`}
          </Text>
        </View>
        <Text style={groupStyles.count}>
          {count === undefined
            ? "…"
            : excludeSide
              ? `${count} ${count === 1 ? "person" : "people"} left out`
              : `${count} ${count === 1 ? "person matches" : "people match"}`}
        </Text>
        {canDelete ? (
          <Button
            title="✕"
            variant="ghost"
            onPress={onDelete}
          />
        ) : null}
      </View>

      {note ? <Text style={groupStyles.combine}>{note}</Text> : null}

      {group.rows.length === 0 ? (
        <Text style={groupStyles.everyone}>
          {excludeSide
            ? "Add at least one line — an exclusion that says nothing isn't allowed."
            : "No conditions yet — as it stands, this rule group means everyone."}
        </Text>
      ) : (
        group.rows.map((row, ri) => (
          <View key={row.key}>
            {ri > 0 ? (
              <View style={groupStyles.andRow}>
                <View style={groupStyles.andChip}>
                  <Text style={groupStyles.andChipText}>AND</Text>
                </View>
                <Text style={groupStyles.andHint}>this has to be true of them too</Text>
              </View>
            ) : null}
            <ConditionRow
              row={row}
              excludeSide={excludeSide}
              options={options}
              onChange={(next) =>
                onChange({ ...group, rows: group.rows.map((r, i) => (i === ri ? next : r)) })
              }
              onRemove={() => onChange({ ...group, rows: group.rows.filter((_, i) => i !== ri) })}
              onInvalid={onInvalid}
            />
          </View>
        ))
      )}

      <AddConditionMenu
        label={group.rows.length === 0 ? "+ Add a condition" : "+ and also…"}
        excludeSide={excludeSide}
        onPick={(kind) => onChange({ ...group, rows: [...group.rows, defaultRow(kind)] })}
      />
    </View>
  );
}

/** The OR seam between two cards — the relationship the model has always had
 *  between rule groups AND between exclusions, but which only the rule-group
 *  side ever drew. `caption` says what the OR does on this side. */
function OrDivider({ caption }: { caption: string }) {
  return (
    <View style={groupStyles.orDivider}>
      <View style={groupStyles.orLine} />
      <View style={groupStyles.orMid}>
        <Text style={groupStyles.orText}>OR</Text>
        <Text style={groupStyles.orCaption}>{caption}</Text>
      </View>
      <View style={groupStyles.orLine} />
    </View>
  );
}

/**
 * "In plain English" — the whole definition on screen read back as the
 * sentence it means (`targetingText.ts#targetingSentences`).
 *
 * This is the piece that makes the AND/OR model legible rather than merely
 * documented: whatever the author just did to the controls, this line says
 * who that reaches. It reads off the SAME `UiGroup[]` the cards render (via
 * the wire conversion, so incomplete rows are dropped exactly as the preview
 * drops them) — never off the debounced preview args, so it never lags a
 * beat behind the thing it's describing.
 */
function PlainEnglishRecap({
  targeting,
  lookups,
}: {
  targeting: Targeting;
  lookups: ConditionLookups;
}) {
  const { send, skip } = targetingSentences(targeting, lookups);
  return (
    <View style={recapStyles.box}>
      <Text style={recapStyles.head}>In plain English</Text>
      <Text style={recapStyles.line}>
        <Text style={recapStyles.lead}>Send to </Text>
        {send.map((s, i) => (
          <Text key={i}>
            {i > 0 ? <Text style={recapStyles.joiner}> — or </Text> : null}
            {s}
          </Text>
        ))}
        .
      </Text>
      {skip.length > 0 ? (
        <Text style={recapStyles.line}>
          <Text style={recapStyles.lead}>Never send to </Text>
          {skip.map((s, i) => (
            <Text key={i}>
              {i > 0 ? <Text style={recapStyles.joiner}> — or </Text> : null}
              {s}
            </Text>
          ))}
          .
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The full builder: "Send to" groups (or-joined) + "Don't send to" skip
 * lists. Controlled — `AudiencesView.tsx`'s form owns the state; this
 * component owns nothing but the option queries and its own preview
 * subscription for per-group counts (`previewArgs` is the form's DEBOUNCED
 * shape, so this subscription dedups against the form's other preview
 * consumers).
 */
export function TargetingBuilder({
  groups,
  excludeGroups,
  onGroupsChange,
  onExcludeGroupsChange,
  previewArgs,
  onInvalid,
}: {
  groups: UiGroup[];
  excludeGroups: UiGroup[];
  onGroupsChange: (next: UiGroup[]) => void;
  onExcludeGroupsChange: (next: UiGroup[]) => void;
  previewArgs: PreviewArgs;
  onInvalid: (key: string, invalid: boolean) => void;
}) {
  const options = useTargetingOptions();
  const preview = useQuery(api.audiences.previewAudience, previewArgs) as PreviewResult | undefined;
  // Read straight off the LIVE ui state (not the form's debounced preview
  // args) so the recap never trails the controls it's describing.
  const liveTargeting = useMemo(
    () => toWireTargeting(groups, excludeGroups).targeting,
    [groups, excludeGroups],
  );

  return (
    <View>
      <PlainEnglishRecap targeting={liveTargeting} lookups={options.lookups} />

      <Field
        label="Send to"
        hint="Someone gets the email if they match ANY ONE rule group below. Inside a rule group, every line has to be true of the same person."
      >
        {groups.map((g, gi) => (
          <View key={g.key}>
            {gi > 0 ? <OrDivider caption="matching either one is enough" /> : null}
            <GroupCard
              group={g}
              index={gi}
              excludeSide={false}
              count={preview?.perGroupCounts[gi]}
              options={options}
              onChange={(next) => onGroupsChange(groups.map((x, i) => (i === gi ? next : x)))}
              onDelete={() => onGroupsChange(groups.filter((_, i) => i !== gi))}
              onInvalid={onInvalid}
              canDelete={groups.length > 1}
            />
          </View>
        ))}
        <AddConditionMenu
          label="+ Add another rule group"
          excludeSide={false}
          onPick={(kind) =>
            onGroupsChange([...groups, { key: nextKey(), rows: [defaultRow(kind)] }])
          }
        />
      </Field>

      <Field
        label="Exclusions"
        hint="Anyone matching an exclusion is left out, even if a rule group above (or a hand-pick) includes them. Each exclusion is all-or-nothing, and exclusions are either/or: to leave out Worship Leaders OR Tech Leads, add two."
      >
        {excludeGroups.map((g, gi) => (
          <View key={g.key}>
            {gi > 0 ? <OrDivider caption="either one leaves them out" /> : null}
            <GroupCard
              group={g}
              index={gi}
              excludeSide
              count={preview?.perExcludeGroupCounts[gi]}
              options={options}
              onChange={(next) =>
                onExcludeGroupsChange(excludeGroups.map((x, i) => (i === gi ? next : x)))
              }
              onDelete={() => onExcludeGroupsChange(excludeGroups.filter((_, i) => i !== gi))}
              onInvalid={onInvalid}
              canDelete
            />
          </View>
        ))}
        <AddConditionMenu
          label="+ Add an exclusion"
          excludeSide
          onPick={(kind) =>
            onExcludeGroupsChange([...excludeGroups, { key: nextKey(), rows: [defaultRow(kind)] }])
          }
        />
      </Field>
    </View>
  );
}

// ── Check a person ─────────────────────────────────────────────────────────

const VERDICT_COPY: Record<
  ExplainResult["verdict"],
  { text: (name: string) => string; tone: "in" | "out" }
> = {
  recipient: { text: (n) => `${n} will get this email`, tone: "in" },
  no_match: { text: (n) => `${n} won't get it — doesn't match any rule group`, tone: "out" },
  excluded: { text: (n) => `${n} won't get it — caught by an exclusion`, tone: "out" },
  hand_pick_excluded: { text: (n) => `${n} won't get it — excluded by hand`, tone: "out" },
  opted_out: { text: (n) => `${n} won't get it — asked not to receive emails like this`, tone: "out" },
  suppressed: { text: (n) => `${n} won't get it — unsubscribed`, tone: "out" },
  no_address: { text: (n) => `${n} won't get it — no email address on file`, tone: "out" },
};

/**
 * "Wondering about someone?" — search a person, get the exact why: every
 * condition's pass/fail from `audiences.explainAudiencePerson` (the SAME
 * evaluator the real send uses — see that query's doc), rendered as the
 * sentence rows above with a ✓/✗ each, then the final decision.
 */
export function PersonCheckSection({
  scope,
  targeting,
  includePersonIds,
  excludePersonIds,
}: {
  scope: PreviewArgs["scope"];
  targeting: Targeting;
  includePersonIds?: Id<"people">[];
  excludePersonIds?: Id<"people">[];
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<{ personId: Id<"people">; name: string } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useQuery(
    api.audiences.searchPeopleForAudience,
    debouncedSearch.trim() && !selected ? { search: debouncedSearch.trim() } : "skip",
  );
  const explanation = useQuery(
    api.audiences.explainAudiencePerson,
    selected
      ? { scope, targeting, includePersonIds, excludePersonIds, personId: selected.personId }
      : "skip",
  ) as ExplainResult | undefined;
  const options = useTargetingOptions();

  return (
    <Field
      label="Check a person"
      hint="Wondering about someone? Look them up and we'll show exactly why they're in or out."
    >
      <TextField
        placeholder="Search people by name or email…"
        value={selected ? selected.name : search}
        onChangeText={(text) => {
          setSelected(null);
          setSearch(text);
        }}
      />
      {!selected && search.trim() ? (
        <View className="mt-2 gap-1">
          {results === undefined ? (
            <Text className="text-xs text-faint">Searching…</Text>
          ) : results.length === 0 ? (
            <Text className="text-xs text-muted">No matches.</Text>
          ) : (
            results.map((p: SearchResult) => (
              <Button
                key={p.personId}
                title={`${p.name}${p.email ? ` · ${p.email}` : ""}`}
                variant="ghost"
                onPress={() => setSelected({ personId: p.personId, name: p.name })}
                className="self-start"
              />
            ))
          )}
        </View>
      ) : null}

      {selected && explanation ? (
        <View className="mt-2">
          <View
            style={[
              checkStyles.verdict,
              explanation.verdict === "recipient" ? checkStyles.verdictIn : checkStyles.verdictOut,
            ]}
          >
            <Text
              style={[
                checkStyles.verdictText,
                explanation.verdict === "recipient"
                  ? checkStyles.verdictTextIn
                  : checkStyles.verdictTextOut,
              ]}
            >
              {VERDICT_COPY[explanation.verdict].text(selected.name)}
            </Text>
          </View>
          {explanation.handPicked ? (
            <Text className="mt-1 text-xs text-muted">Hand-picked into this segment.</Text>
          ) : null}

          {explanation.groups.map((g, gi) => (
            <View key={`g-${gi}`} className="mt-2">
              <Text style={checkStyles.groupHead}>
                Rule group {gi + 1} — {g.matched ? `yes, ${selected.name} matches` : "not a match"}
              </Text>
              {g.conditions.length === 0 ? (
                <Text style={checkStyles.cond}>
                  <Text style={checkStyles.pass}>✓</Text> everyone (no conditions)
                </Text>
              ) : (
                g.conditions.map((cv, ci) => (
                  <Text key={ci} style={[checkStyles.cond, cv.pass ? null : checkStyles.condFail]}>
                    <Text style={cv.pass ? checkStyles.pass : checkStyles.fail}>
                      {cv.pass ? "✓" : "✗"}
                    </Text>{" "}
                    {describeCondition(cv.condition, options.lookups)}
                  </Text>
                ))
              )}
            </View>
          ))}
          {explanation.excludeGroups.map((g, gi) => (
            <View key={`x-${gi}`} className="mt-2">
              <Text style={checkStyles.groupHead}>
                Exclusion {gi + 1} —{" "}
                {g.matched ? "matches, so they're left out" : "doesn't apply"}
              </Text>
              {g.conditions.map((cv, ci) => (
                <Text key={ci} style={[checkStyles.cond, cv.pass ? null : checkStyles.condFail]}>
                  <Text style={cv.pass ? checkStyles.pass : checkStyles.fail}>
                    {cv.pass ? "✓" : "✗"}
                  </Text>{" "}
                  {describeCondition(cv.condition, options.lookups)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : selected ? (
        <Text className="mt-2 text-xs text-faint">Checking…</Text>
      ) : null}
    </Field>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  fieldBox: { minWidth: 130 },
  opBox: { minWidth: 110 },
  valueBox: { minWidth: 160, flexShrink: 1 },
  qualBox: { minWidth: 120 },
  numBox: { width: 90 },
  serviceHint: { marginTop: 4, fontSize: 11, color: colors.muted },
  unit: { fontSize: 13, color: colors.muted },
});

const groupStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  cardExclude: {
    borderLeftWidth: 3,
    borderLeftColor: colors.warn,
  },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  tag: {
    backgroundColor: colors.accentSoft,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  tagExclude: { backgroundColor: colors.warnBg },
  tagText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: colors.accentHover,
  },
  tagTextExclude: { color: colors.warn },
  count: { marginLeft: "auto", fontSize: 13, color: colors.muted },
  everyone: { fontSize: 13, color: colors.muted, paddingVertical: spacing.xs },
  combine: { fontSize: 12, color: colors.faint, marginTop: 2, marginBottom: 2 },
  andRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  andChip: {
    backgroundColor: colors.sunken,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  andChipText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: colors.muted,
  },
  andHint: { fontSize: 11, color: colors.faint },
  orDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginVertical: spacing.sm,
  },
  orLine: { flex: 1, height: 1, backgroundColor: colors.border },
  orMid: { alignItems: "center", gap: 2 },
  orText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: colors.faint,
    backgroundColor: colors.sunken,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 3,
  },
  orCaption: { fontSize: 11, color: colors.faint },
});

const addStyles = StyleSheet.create({
  menu: {
    marginTop: spacing.sm,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.sunken,
    padding: spacing.md,
  },
  prompt: { fontSize: 13, fontWeight: "600", color: colors.text },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});

const recapStyles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 12,
    backgroundColor: colors.sunken,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: 2,
  },
  head: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.faint,
  },
  line: { fontSize: 14, color: colors.text, lineHeight: 20 },
  lead: { fontWeight: "700", color: colors.text },
  joiner: { fontWeight: "700", color: colors.muted },
});

const checkStyles = StyleSheet.create({
  verdict: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  verdictIn: { backgroundColor: colors.successBg },
  verdictOut: { backgroundColor: colors.dangerBg },
  verdictText: { fontSize: 13, fontWeight: "700" },
  verdictTextIn: { color: colors.success },
  verdictTextOut: { color: colors.accentHover },
  groupHead: { fontSize: 13, fontWeight: "700", color: colors.text },
  cond: { fontSize: 13, color: colors.text, paddingLeft: 10, paddingVertical: 1 },
  condFail: { color: colors.muted },
  pass: { color: colors.success, fontWeight: "700" },
  fail: { color: colors.faint, fontWeight: "700" },
});
