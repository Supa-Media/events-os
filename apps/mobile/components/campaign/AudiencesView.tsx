/**
 * AUDIENCES — the audience-segment list + inline create/edit form.
 *
 * An audience is a saved recipe (`api.audiences.*`) that campaigns send to.
 * Person-centric audiences Phase 3 (specs/person-centric-audiences.md
 * "Phase 3") replaced the source dropdown for every NEW audience: the source
 * is always `"person_filters"` — a set of AND-combined criteria chips
 * (Giving / Backer / Attendance / Role / Type / Email) plus an optional
 * hand-picked include/exclude list (`searchPeopleForAudience`). The editor
 * shows a LIVE preview (`api.audiences.previewAudience`) as the criteria
 * change, so an author sees the recipient count — and every exclusion
 * reason, including the Phase 3 invariant that suppression/opt-out beat a
 * hand-pick — before saving.
 *
 * Legacy `guests`/`donors`/`people`-sourced audiences (pre-Phase-3, `source`
 * is immutable after creation — see `audiences.ts#updateAudience`) render
 * READ-ONLY here: their badge + a plain-language filter summary, editable
 * name/archive only. The migration (`migrations/0040_migrate_legacy_audiences.ts`)
 * moves most of them onto `person_filters` automatically; any that remain
 * (deliberately, for `"guests"` — see that migration's doc) keep working
 * exactly as before through `lib/audienceResolve.ts`'s legacy resolvers.
 *
 * UI-polish pass (founder feedback: the picker "looks and feels clunky"): a
 * slim recipients count (`LiveRecipientsSummary`) is pinned above the filter
 * + hand-pick stack and never blanks back to "Calculating…" once it's loaded
 * once; the numeric filter fields and the hand-pick search box are debounced
 * (`FILTER_DEBOUNCE_MS`) before they drive a query; and every query besides
 * `listAudiences` itself (`previewAudience`, `searchPeopleForAudience`,
 * `events.list`, `seats.chart`) is owned by a small leaf component wrapped in
 * its own inline `ErrorBoundary`, so one query failing shows a scoped notice
 * instead of taking down the whole form.
 */
import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useQuery, useMutation } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Card,
  Button,
  Badge,
  TextField,
  Select,
  Field,
  EmptyState,
  ToastView,
  OptionTag,
  Icon,
} from "../ui";
import { ErrorBoundary } from "../ErrorBoundary";
import { colors, spacing } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { confirmAction, describeAudience, pluralCount } from "./helpers";

/** Debounce for both the numeric filter TextFields and the hand-pick search
 *  box before they drive their query — matches the house pattern in
 *  `BlastComposerCard.tsx` (`BODY_DEBOUNCE_MS`). */
const FILTER_DEBOUNCE_MS = 400;

type Audience = FunctionReturnType<typeof api.audiences.listAudiences>[number];
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;
type PreviewArgs = FunctionArgs<typeof api.audiences.previewAudience>;
type PersonFilters = Audience["filters"];
type SearchResult = FunctionReturnType<typeof api.audiences.searchPeopleForAudience>[number];

/** Every audience/campaign this UI creates is org-wide — see the file doc. */
const CENTRAL_SCOPE = "central" as const;

function sourceLabel(source: string): string {
  if (source === "person_filters") return "Filters + hand-picked";
  if (source === "guests") return "Guests";
  if (source === "donors") return "Donors";
  if (source === "people") return "People";
  return source;
}

export function AudiencesView() {
  const audiences = useQuery(api.audiences.listAudiences, {});
  const [editingId, setEditingId] = useState<Id<"audiences"> | "new" | null>(null);
  const { run, toast, dismiss } = useActionRunner();

  if (audiences === undefined) {
    return (
      <View style={{ paddingVertical: spacing.lg }}>
        <Text className="text-sm text-faint">Loading audiences…</Text>
      </View>
    );
  }

  const editingAudience =
    editingId && editingId !== "new"
      ? (audiences as Audience[]).find((a) => a._id === editingId) ?? null
      : null;

  return (
    <>
      <ToastView toast={toast} onDismiss={dismiss} />

      {editingId === "new" || editingAudience ? (
        <AudienceForm
          key={editingId === "new" ? "new" : editingAudience!._id}
          initial={editingAudience}
          run={run}
          onDone={() => setEditingId(null)}
        />
      ) : (
        <Button title="+ New audience" onPress={() => setEditingId("new")} className="self-start" />
      )}

      {audiences.length === 0 && editingId !== "new" ? (
        <View className="mt-4">
          <EmptyState
            icon="users"
            title="No audiences yet"
            message="Create a segment above — filters, hand-picked people, or both — to send a campaign to."
          />
        </View>
      ) : (
        <View style={styles.list}>
          {(audiences as Audience[]).map((a) => {
            const summary = describeAudience(a.source, a.filters, {
              includeCount: a.includePersonIds?.length,
              excludeCount: a.excludePersonIds?.length,
            });
            return (
              <Card key={a._id} onPress={() => setEditingId(a._id)}>
                <View style={styles.cardTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Badge label={sourceLabel(a.source)} tone="accent" />
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {summary}
                </Text>
                {a.source !== "person_filters" ? (
                  <Text style={styles.legacyNote}>
                    Previous-format audience — still works for sending, and will move to the new
                    filter picker automatically.
                  </Text>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}
    </>
  );
}

function AudienceForm({
  initial,
  run,
  onDone,
}: {
  initial: Audience | null;
  run: ReturnType<typeof useActionRunner>["run"];
  onDone: () => void;
}) {
  const create = useMutation(api.audiences.createAudience);
  const update = useMutation(api.audiences.updateAudience);
  const archive = useMutation(api.audiences.archiveAudience);

  const [name, setName] = useState(initial?.name ?? "");
  const [filters, setFilters] = useState<PersonFilters>(initial?.filters ?? {});
  const [includeIds, setIncludeIds] = useState<Id<"people">[]>(initial?.includePersonIds ?? []);
  const [excludeIds, setExcludeIds] = useState<Id<"people">[]>(initial?.excludePersonIds ?? []);
  const [includeNames, setIncludeNames] = useState<Record<string, string>>({});
  const [excludeNames, setExcludeNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // New audiences are ALWAYS person_filters (the source dropdown is gone —
  // see the file doc); an existing legacy-sourced row stays read-only.
  const source = initial?.source ?? "person_filters";
  const isPersonFilters = source === "person_filters";
  const scope = initial?.scope ?? CENTRAL_SCOPE;

  // Passed to the two independent leaf components below that each own their
  // OWN `previewAudience` subscription (Convex dedups identical query+args
  // across components) — kept as leaves, each wrapped in its own inline
  // ErrorBoundary, so a preview failure can't take down the rest of the form.
  const previewArgs: PreviewArgs = {
    scope,
    source,
    filters,
    includePersonIds: includeIds.length ? includeIds : undefined,
    excludePersonIds: excludeIds.length ? excludeIds : undefined,
  };

  function rememberName(kind: "include" | "exclude", personId: Id<"people">, name_: string) {
    if (kind === "include") setIncludeNames((m) => ({ ...m, [personId]: name_ }));
    else setExcludeNames((m) => ({ ...m, [personId]: name_ }));
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      // `source` can only be set at creation — `updateAudience` has no source
      // arg (see the file doc), so an edit only ever sends name + filters +
      // hand-picks.
      const result = initial
        ? await run(
            () =>
              update({
                audienceId: initial._id,
                name: trimmed,
                filters,
                includePersonIds: includeIds,
                excludePersonIds: excludeIds,
              }),
            { errorTitle: "Couldn't save audience" },
          )
        : await run(
            () =>
              create({
                scope: CENTRAL_SCOPE,
                name: trimmed,
                source: "person_filters",
                filters,
                includePersonIds: includeIds.length ? includeIds : undefined,
                excludePersonIds: excludeIds.length ? excludeIds : undefined,
              }),
            { errorTitle: "Couldn't create audience" },
          );
      if (result !== undefined) onDone();
    } finally {
      setSaving(false);
    }
  }

  function handleArchive() {
    if (!initial) return;
    confirmAction({
      title: "Archive audience?",
      message: `"${initial.name}" will be hidden from campaigns. Campaigns already using it are unaffected.`,
      confirmLabel: "Archive",
      destructive: true,
      onConfirm: () => {
        void run(() => archive({ audienceId: initial._id }), {
          errorTitle: "Couldn't archive audience",
        }).then((result) => {
          if (result !== undefined) onDone();
        });
      },
    });
  }

  return (
    <Card style={styles.form}>
      <TextField label="Name" placeholder="e.g. Active donors" value={name} onChangeText={setName} />

      <Field label="Source">
        <Badge label={sourceLabel(source)} tone="accent" />
        {!isPersonFilters ? (
          <Text className="mt-1 text-xs text-muted">
            {describeAudience(source, filters)} — this is a previous-format audience. It still works
            for sending, and will move to the new filter picker automatically; until then, only its
            name can be changed here.
          </Text>
        ) : null}
      </Field>

      <ErrorBoundary inline>
        <LiveRecipientsSummary args={previewArgs} />
      </ErrorBoundary>

      {isPersonFilters ? (
        <>
          <ErrorBoundary inline>
            <FilterChipsBuilder filters={filters} onChange={setFilters} />
          </ErrorBoundary>
          <ErrorBoundary inline>
            <HandPickSection
              includeIds={includeIds}
              excludeIds={excludeIds}
              includeNames={includeNames}
              excludeNames={excludeNames}
              onAddInclude={(p) => {
                setIncludeIds((ids) => (ids.includes(p.personId) ? ids : [...ids, p.personId]));
                setExcludeIds((ids) => ids.filter((id) => id !== p.personId));
                rememberName("include", p.personId, p.name);
              }}
              onAddExclude={(p) => {
                setExcludeIds((ids) => (ids.includes(p.personId) ? ids : [...ids, p.personId]));
                setIncludeIds((ids) => ids.filter((id) => id !== p.personId));
                rememberName("exclude", p.personId, p.name);
              }}
              onRemoveInclude={(id) => setIncludeIds((ids) => ids.filter((x) => x !== id))}
              onRemoveExclude={(id) => setExcludeIds((ids) => ids.filter((x) => x !== id))}
            />
          </ErrorBoundary>
        </>
      ) : null}

      <ErrorBoundary inline>
        <AudiencePreviewCard args={previewArgs} />
      </ErrorBoundary>

      <View className="mt-3 flex-row items-center justify-between gap-2">
        <View className="flex-row gap-2">
          <Button
            title={initial ? "Save" : "Create audience"}
            onPress={handleSave}
            loading={saving}
            disabled={!name.trim()}
          />
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        {initial ? (
          <Button title="Archive" variant="danger" onPress={handleArchive} />
        ) : null}
      </View>
    </Card>
  );
}

// ── Filter criteria chips (Phase 3) ─────────────────────────────────────────

type FilterGroupKey = "giving" | "backer" | "attendance" | "role" | "type" | "email";

const FILTER_GROUP_LABELS: Record<FilterGroupKey, string> = {
  giving: "Giving",
  backer: "Backer",
  attendance: "Attendance",
  role: "Role",
  type: "Type",
  email: "Email",
};

/** Which of `filters`' fields belong to each chip group — used to decide
 *  whether a group starts expanded (it has data) and what to clear when a
 *  group is removed. */
const GROUP_FIELDS: Record<FilterGroupKey, (keyof PersonFilters)[]> = {
  giving: ["givingLifetimeMinCents", "givingLifetimeMaxCents", "giftCountMin", "donorStatus", "gaveWithinDays"],
  backer: ["backerStatus"],
  attendance: ["attendedEventId", "attendedWithinDays", "rsvpStatus"],
  role: ["seatId"],
  type: ["teamOnly", "contactsOnly", "chapterId"],
  email: ["verifiedEmailOnly"],
};

function groupHasData(filters: PersonFilters, key: FilterGroupKey): boolean {
  return GROUP_FIELDS[key].some((f) => filters[f] != null);
}

function centsToDollarsStr(cents?: number | null): string {
  if (cents == null) return "";
  return String(Math.round(cents) / 100);
}

function dollarsStrToCents(str: string): number | undefined {
  const trimmed = str.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

function intToStr(n?: number | null): string {
  return n != null ? String(n) : "";
}

function intStrToNumber(str: string): number | undefined {
  const n = Number(str.trim());
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * A numeric TextField that only lands its value in `filters` after
 * `FILTER_DEBOUNCE_MS` of no typing AND only once the entry parses cleanly —
 * a stray non-numeric keystroke used to silently clear the whole criterion.
 * Keeps the raw string in local state so a mid-typo digit never gets erased
 * out from under the person typing it.
 */
function DebouncedNumberField({
  label,
  placeholder,
  committedValue,
  format,
  parse,
  onCommit,
}: {
  label: string;
  placeholder?: string;
  committedValue: number | undefined;
  format: (n: number | undefined) => string;
  parse: (raw: string) => number | undefined;
  onCommit: (n: number | undefined) => void;
}) {
  const [raw, setRaw] = useState(() => format(committedValue));
  const [invalid, setInvalid] = useState(false);

  // The committed value can also change from OUTSIDE this field (its whole
  // group gets collapsed/cleared) — stay in sync when that happens.
  useEffect(() => {
    setRaw(format(committedValue));
    setInvalid(false);
  }, [committedValue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setInvalid(false);
        if (committedValue !== undefined) onCommit(undefined);
        return;
      }
      const parsed = parse(trimmed);
      if (parsed === undefined) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      if (parsed !== committedValue) onCommit(parsed);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  return (
    <TextField
      label={label}
      placeholder={placeholder}
      keyboardType="numeric"
      value={raw}
      onChangeText={setRaw}
      hint={invalid ? "Enter a number." : undefined}
    />
  );
}

const DONOR_STATUS_OPTIONS = [
  { value: "any", label: "Any status" },
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "lapsed", label: "Lapsed" },
];

const GAVE_RECENTLY_OPTIONS = [
  { value: "none", label: "Any time" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
];

const BACKER_STATUS_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "active", label: "Active backer" },
  { value: "lapsed", label: "Lapsed backer" },
];

const RSVP_STATUS_OPTIONS = [
  { value: "any", label: "Any status" },
  { value: "going", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "not_going", label: "Not going" },
];

const TYPE_OPTIONS = [
  { value: "any", label: "Team + contacts" },
  { value: "team", label: "Team only" },
  { value: "contacts", label: "Contacts only" },
];

/**
 * Criteria-chip builder: a chip per filter GROUP (Giving / Backer /
 * Attendance / Role / Type / Email) — tapping an inactive chip expands that
 * group's inline editor and seeds a group-appropriate default; tapping an
 * ACTIVE chip's ✕ clears every field in that group. Groups AND-combine (see
 * `lib/audienceResolve.ts#resolvePersonFilters`); a group with no fields set
 * contributes nothing.
 */
function FilterChipsBuilder({
  filters,
  onChange,
}: {
  filters: PersonFilters;
  onChange: (next: PersonFilters) => void;
}) {
  const [expanded, setExpanded] = useState<Set<FilterGroupKey>>(
    () => new Set((Object.keys(GROUP_FIELDS) as FilterGroupKey[]).filter((k) => groupHasData(filters, k))),
  );

  function patch(fields: Partial<PersonFilters>) {
    onChange({ ...filters, ...fields });
  }

  function toggleGroup(key: FilterGroupKey) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        // Clearing a group's chip clears its fields too — an expanded-but-
        // empty group is indistinguishable from "not filtering on this" so
        // there's nothing lost by collapsing = clearing.
        const cleared: Partial<PersonFilters> = {};
        for (const f of GROUP_FIELDS[key]) (cleared as Record<string, unknown>)[f] = undefined;
        onChange({ ...filters, ...cleared });
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <Field label="Filters" hint="Every active filter must match (AND) — leave all off to target everyone.">
      <View className="flex-row flex-wrap gap-2">
        {(Object.keys(FILTER_GROUP_LABELS) as FilterGroupKey[]).map((key) => (
          <OptionTag
            key={key}
            label={FILTER_GROUP_LABELS[key]}
            selected={expanded.has(key)}
            size="md"
            // A single tap toggles the group open/closed either way — the chip
            // no longer ALSO shows a redundant ✕ that did the exact same thing.
            onPress={() => toggleGroup(key)}
          />
        ))}
      </View>

      {expanded.size === 0 ? (
        <Text className="mt-2 text-xs text-faint">
          Tap a category above to narrow this audience — leave everything off to target everyone.
        </Text>
      ) : null}

      {expanded.has("giving") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <DebouncedNumberField
                label="Lifetime giving ≥"
                placeholder="$0"
                committedValue={filters.givingLifetimeMinCents}
                format={centsToDollarsStr}
                parse={dollarsStrToCents}
                onCommit={(n) => patch({ givingLifetimeMinCents: n })}
              />
            </View>
            <View className="flex-1">
              <DebouncedNumberField
                label="Lifetime giving ≤"
                placeholder="No max"
                committedValue={filters.givingLifetimeMaxCents}
                format={centsToDollarsStr}
                parse={dollarsStrToCents}
                onCommit={(n) => patch({ givingLifetimeMaxCents: n })}
              />
            </View>
          </View>
          <DebouncedNumberField
            label="Gift count ≥"
            placeholder="0"
            committedValue={filters.giftCountMin}
            format={intToStr}
            parse={intStrToNumber}
            onCommit={(n) => patch({ giftCountMin: n })}
          />
          <Select
            label="Donor status"
            value={filters.donorStatus ?? "any"}
            options={DONOR_STATUS_OPTIONS}
            onChange={(v) =>
              patch({ donorStatus: v === "any" ? undefined : (v as PersonFilters["donorStatus"]) })
            }
          />
          <Select
            label="Has given recently"
            value={filters.gaveWithinDays ? String(filters.gaveWithinDays) : "none"}
            options={GAVE_RECENTLY_OPTIONS}
            onChange={(v) => patch({ gaveWithinDays: v === "none" ? undefined : Number(v) })}
          />
        </View>
      ) : null}

      {expanded.has("backer") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <Select
            label="Backer status"
            hint="Active = a currently-live monthly pledge. Lapsed = backed before, not currently."
            value={filters.backerStatus ?? "any"}
            options={BACKER_STATUS_OPTIONS}
            onChange={(v) =>
              patch({ backerStatus: v === "any" ? undefined : (v as PersonFilters["backerStatus"]) })
            }
          />
        </View>
      ) : null}

      {expanded.has("attendance") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <ErrorBoundary inline>
            <EventPicker
              value={filters.attendedEventId ?? null}
              onChange={(v) => patch({ attendedEventId: v })}
            />
          </ErrorBoundary>
          <DebouncedNumberField
            label="Attended within N days"
            placeholder="No limit"
            committedValue={filters.attendedWithinDays}
            format={intToStr}
            parse={intStrToNumber}
            onCommit={(n) => patch({ attendedWithinDays: n })}
          />
          <Select
            label="RSVP status"
            value={filters.rsvpStatus ?? "any"}
            options={RSVP_STATUS_OPTIONS}
            onChange={(v) =>
              patch({ rsvpStatus: v === "any" ? undefined : (v as PersonFilters["rsvpStatus"]) })
            }
          />
        </View>
      ) : null}

      {expanded.has("role") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <ErrorBoundary inline>
            <RoleFilterSelect
              value={filters.seatId ?? null}
              onChange={(v) => patch({ seatId: v })}
            />
          </ErrorBoundary>
        </View>
      ) : null}

      {expanded.has("type") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <Select
            label="Team vs. contacts"
            value={filters.teamOnly ? "team" : filters.contactsOnly ? "contacts" : "any"}
            options={TYPE_OPTIONS}
            onChange={(v) =>
              patch({
                teamOnly: v === "team" ? true : undefined,
                contactsOnly: v === "contacts" ? true : undefined,
              })
            }
          />
          <ErrorBoundary inline>
            <ChapterFilterSelect
              value={filters.chapterId ?? null}
              onChange={(v) => patch({ chapterId: v })}
            />
          </ErrorBoundary>
        </View>
      ) : null}

      {expanded.has("email") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <Pressable
            className="flex-row items-center gap-2"
            onPress={() => patch({ verifiedEmailOnly: !filters.verifiedEmailOnly })}
          >
            <Icon
              name={filters.verifiedEmailOnly ? "check-square" : "square"}
              size={18}
              color={filters.verifiedEmailOnly ? colors.accent : colors.muted}
            />
            <Text className="text-sm text-ink">Only people with a verified email on file</Text>
          </Pressable>
        </View>
      ) : null}
    </Field>
  );
}

function dedupeSeatOptions(
  seats: { defId: string; title: string; derived: boolean }[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of seats) {
    if (s.derived) continue; // a derived/rolled-up seat is never real occupancy
    if (!seen.has(s.defId)) seen.set(s.defId, s.title);
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}

/** The Attendance group's event picker — every org event, so it's `searchable`
 *  (Field.tsx's Select) rather than a plain unfiltered list; a leaf component
 *  so its own `events.list` failure is scoped to just this control by the
 *  inline ErrorBoundary at its call site. */
function EventPicker({
  value,
  onChange,
}: {
  value: Id<"events"> | null;
  onChange: (v: Id<"events"> | undefined) => void;
}) {
  const events = useQuery(api.events.list, { scope: "all" }) ?? [];
  return (
    <Select
      label="Event"
      hint="Leave unset to match anyone who attended anything."
      searchable
      value={value}
      options={[
        { value: "", label: "Any event" },
        ...events.map((e: { _id: string; name: string }) => ({ value: e._id, label: e.name })),
      ]}
      onChange={(v) => onChange(v ? (v as Id<"events">) : undefined)}
    />
  );
}

/** The Role group's seat picker — a leaf component so a `seats.chart` failure
 *  is scoped to just this control (see `EventPicker`'s doc). */
function RoleFilterSelect({
  value,
  onChange,
}: {
  value: Id<"seatDefs"> | null;
  onChange: (v: Id<"seatDefs"> | undefined) => void;
}) {
  const chart = useQuery(api.seats.chart, {});
  const seatOptions =
    chart === undefined
      ? []
      : dedupeSeatOptions(
          chart.kind === "full" ? [...chart.central, ...(chart.chapters[0]?.seats ?? [])] : chart.seats,
        );
  return (
    <Select
      label="Holds a seat"
      hint="Matches anyone holding this role in any chapter or centrally."
      value={value}
      options={[{ value: "", label: "Any role" }, ...seatOptions]}
      onChange={(v) => onChange(v ? (v as Id<"seatDefs">) : undefined)}
    />
  );
}

/** The Type group's chapter picker — chapters come from `seats.chart`'s own
 *  chapter enumeration (the org chart's pattern, see `ScopePills.tsx`), not a
 *  separate `chapters.list` call. A leaf component for the same error-scoping
 *  reason as `EventPicker`/`RoleFilterSelect`. */
function ChapterFilterSelect({
  value,
  onChange,
}: {
  value: Id<"chapters"> | null;
  onChange: (v: Id<"chapters"> | undefined) => void;
}) {
  const chart = useQuery(api.seats.chart, {});
  const chapterOptions =
    chart?.kind === "full"
      ? chart.chapters.map((c) => ({ value: c.chapterId, label: c.chapterName }))
      : [];
  return (
    <Select
      label="Limit to chapter"
      hint="Leave unset to include every chapter."
      value={value}
      options={[{ value: "", label: "All chapters" }, ...chapterOptions]}
      onChange={(v) => onChange(v ? (v as Id<"chapters">) : undefined)}
    />
  );
}

// ── Hand-picked include/exclude (Phase 3) ────────────────────────────────

function HandPickSection({
  includeIds,
  excludeIds,
  includeNames,
  excludeNames,
  onAddInclude,
  onAddExclude,
  onRemoveInclude,
  onRemoveExclude,
}: {
  includeIds: Id<"people">[];
  excludeIds: Id<"people">[];
  includeNames: Record<string, string>;
  excludeNames: Record<string, string>;
  onAddInclude: (p: SearchResult) => void;
  onAddExclude: (p: SearchResult) => void;
  onRemoveInclude: (id: Id<"people">) => void;
  onRemoveExclude: (id: Id<"people">) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useQuery(
    api.audiences.searchPeopleForAudience,
    debouncedSearch.trim() ? { search: debouncedSearch.trim() } : "skip",
  );

  return (
    <Field
      label="Hand-picked"
      hint="Included people are always members, regardless of the filters above — unless suppressed or opted out. Excluded people are always removed."
    >
      <TextField
        placeholder="Search people by name or email…"
        value={search}
        onChangeText={setSearch}
      />
      {search.trim() ? (
        <View className="mt-2 gap-1">
          {results === undefined ? (
            <Text className="text-xs text-faint">Searching…</Text>
          ) : results.length === 0 ? (
            <Text className="text-xs text-muted">No matches.</Text>
          ) : (
            results.map((p) => (
              <View key={p.personId} className="flex-row items-center justify-between py-1">
                <Text className="text-sm text-ink" numberOfLines={1}>
                  {p.name} {p.email ? `· ${p.email}` : ""}
                  {p.isContactOnly ? " (contact)" : ""}
                </Text>
                <View className="flex-row gap-2">
                  <Button title="Include" variant="secondary" onPress={() => onAddInclude(p)} />
                  <Button title="Exclude" variant="secondary" onPress={() => onAddExclude(p)} />
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}

      {includeIds.length > 0 ? (
        <View className="mt-3">
          <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-faint">
            Included ({includeIds.length})
          </Text>
          <View className="flex-row flex-wrap gap-1">
            {includeIds.map((id) => (
              <OptionTag
                key={id}
                label={includeNames[id] ?? id}
                color="green"
                size="md"
                onRemove={() => onRemoveInclude(id)}
              />
            ))}
          </View>
        </View>
      ) : null}

      {excludeIds.length > 0 ? (
        <View className="mt-3">
          <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-faint">
            Excluded ({excludeIds.length})
          </Text>
          <View className="flex-row flex-wrap gap-1">
            {excludeIds.map((id) => (
              <OptionTag
                key={id}
                label={excludeNames[id] ?? id}
                color="red"
                size="md"
                onRemove={() => onRemoveExclude(id)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </Field>
  );
}

// ── Live recipients summary (pinned) ────────────────────────────────────────

/**
 * A slim, always-visible recipient count pinned above the filter + hand-pick
 * stack — the detailed `AudiencePreviewCard` sits below all of it, so it's
 * easy to lose track of the count while adjusting criteria above it. Once a
 * count has loaded once, this NEVER blanks back to "Calculating…" on a
 * refetch — it keeps showing the last known count with a small "Updating…"
 * indicator instead, so the number on screen is always meaningful.
 */
function LiveRecipientsSummary({ args }: { args: PreviewArgs }) {
  const preview = useQuery(api.audiences.previewAudience, args) as PreviewResult | undefined;
  const [lastKnown, setLastKnown] = useState<PreviewResult | null>(null);
  useEffect(() => {
    if (preview !== undefined) setLastKnown(preview);
  }, [preview]);

  const shown = preview ?? lastKnown;
  const isUpdating = preview === undefined && lastKnown !== null;

  return (
    <View className="mb-3 flex-row items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2">
      <Icon name="users" size={15} color={colors.muted} />
      {shown ? (
        <Text className="text-sm font-semibold text-ink">{pluralCount(shown.count, "recipient")}</Text>
      ) : (
        <Text className="text-sm text-faint">Calculating…</Text>
      )}
      {isUpdating ? <Text className="text-xs text-muted">Updating…</Text> : null}
    </View>
  );
}

// ── Preview card ──────────────────────────────────────────────────────────

function AudiencePreviewCard({ args }: { args: PreviewArgs }) {
  const preview = useQuery(api.audiences.previewAudience, args) as PreviewResult | undefined;
  if (preview === undefined) {
    return (
      <Field label="Recipients">
        <Text className="text-sm text-faint">Calculating…</Text>
      </Field>
    );
  }
  const exclusionBits = [
    preview.excludedSuppressed > 0 ? `${pluralCount(preview.excludedSuppressed, "suppressed contact")}` : null,
    preview.excludedUnverified > 0 ? `${pluralCount(preview.excludedUnverified, "unverified contact")}` : null,
    preview.excludedOptOut > 0 ? `${pluralCount(preview.excludedOptOut, "person")} opted out` : null,
  ].filter((b): b is string => b !== null);

  return (
    <Field label="Recipients">
      <Text className="text-base font-semibold text-ink">
        {pluralCount(preview.count, "person")}
      </Text>
      {exclusionBits.length > 0 ? (
        <Text className="mt-0.5 text-xs text-muted">{exclusionBits.join(" · ")} excluded</Text>
      ) : null}
      {preview.unlinkedCentralDonors > 0 ? (
        <Text className="mt-0.5 text-xs text-muted">
          Also includes {pluralCount(preview.unlinkedCentralDonors, "org-level donor")} not yet in the
          people list
        </Text>
      ) : null}
      {preview.truncated ? (
        <Text className="mt-0.5 text-xs text-warn">
          Showing the first 5,000 — this audience matches more than the cap.
        </Text>
      ) : null}
      {preview.sample.length > 0 ? (
        <View className="mt-2 gap-1">
          {preview.sample.slice(0, 5).map((p: { name?: string | null; email: string }, i: number) => (
            <Text key={`${p.email}-${i}`} className="text-xs text-muted" numberOfLines={1}>
              {p.name ? `${p.name} · ` : ""}
              {p.email}
            </Text>
          ))}
        </View>
      ) : null}
    </Field>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: spacing.md, gap: spacing.md },
  form: { gap: spacing.xs, marginBottom: spacing.md },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  name: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  meta: { fontSize: 13, color: colors.muted, marginTop: spacing.sm },
  legacyNote: { fontSize: 12, color: colors.faint, marginTop: spacing.xs },
});
