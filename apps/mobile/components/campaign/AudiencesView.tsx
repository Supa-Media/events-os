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
 */
import { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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
import { colors, spacing } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { confirmAction, describeAudience, pluralCount } from "./helpers";

type Audience = FunctionReturnType<typeof api.audiences.listAudiences>[number];
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;
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

  const preview = useQuery(api.audiences.previewAudience, {
    scope,
    source,
    filters,
    includePersonIds: includeIds.length ? includeIds : undefined,
    excludePersonIds: excludeIds.length ? excludeIds : undefined,
  }) as PreviewResult | undefined;

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
            {describeAudience(source, filters)} — this audience predates the filter picker and keeps
            its original targeting; only its name can be changed here.
          </Text>
        ) : null}
      </Field>

      {isPersonFilters ? (
        <>
          <FilterChipsBuilder filters={filters} onChange={setFilters} />
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
        </>
      ) : null}

      <AudiencePreviewCard preview={preview} />

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
  const events = useQuery(api.events.list, { scope: "all" }) ?? [];
  const chart = useQuery(api.seats.chart, expanded.has("role") ? {} : "skip");
  const seatOptions =
    chart === undefined || chart === null
      ? []
      : dedupeSeatOptions(
          chart.kind === "full"
            ? [...chart.central, ...(chart.chapters[0]?.seats ?? [])]
            : chart.seats,
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
            onPress={() => toggleGroup(key)}
            onRemove={expanded.has(key) ? () => toggleGroup(key) : undefined}
          />
        ))}
      </View>

      {expanded.has("giving") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <TextField
                label="Lifetime giving ≥"
                placeholder="$0"
                keyboardType="numeric"
                value={centsToDollarsStr(filters.givingLifetimeMinCents)}
                onChangeText={(v) => patch({ givingLifetimeMinCents: dollarsStrToCents(v) })}
              />
            </View>
            <View className="flex-1">
              <TextField
                label="Lifetime giving ≤"
                placeholder="No max"
                keyboardType="numeric"
                value={centsToDollarsStr(filters.givingLifetimeMaxCents)}
                onChangeText={(v) => patch({ givingLifetimeMaxCents: dollarsStrToCents(v) })}
              />
            </View>
          </View>
          <TextField
            label="Gift count ≥"
            placeholder="0"
            keyboardType="numeric"
            value={filters.giftCountMin != null ? String(filters.giftCountMin) : ""}
            onChangeText={(v) => {
              const n = Number(v.trim());
              patch({ giftCountMin: v.trim() && Number.isFinite(n) ? Math.round(n) : undefined });
            }}
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
          <Select
            label="Event"
            hint="Leave unset to match anyone who attended anything."
            value={filters.attendedEventId ?? null}
            options={[
              { value: "", label: "Any event" },
              ...events.map((e: { _id: string; name: string }) => ({ value: e._id, label: e.name })),
            ]}
            onChange={(v) =>
              patch({ attendedEventId: v ? (v as Id<"events">) : undefined })
            }
          />
          <TextField
            label="Attended within N days"
            placeholder="No limit"
            keyboardType="numeric"
            value={filters.attendedWithinDays != null ? String(filters.attendedWithinDays) : ""}
            onChangeText={(v) => {
              const n = Number(v.trim());
              patch({ attendedWithinDays: v.trim() && Number.isFinite(n) ? Math.round(n) : undefined });
            }}
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
          <Select
            label="Holds a seat"
            hint="Matches anyone holding this role in any chapter or centrally."
            value={filters.seatId ?? null}
            options={[
              { value: "", label: "Any role" },
              ...seatOptions.map((o) => ({ value: o.value, label: o.label })),
            ]}
            onChange={(v) => patch({ seatId: v ? (v as Id<"seatDefs">) : undefined })}
          />
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
  const results = useQuery(
    api.audiences.searchPeopleForAudience,
    search.trim() ? { search: search.trim() } : "skip",
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
      {search.trim() && results !== undefined ? (
        <View className="mt-2 gap-1">
          {results.length === 0 ? (
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
                onRemove={() => onRemoveExclude(id)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </Field>
  );
}

// ── Preview card ──────────────────────────────────────────────────────────

function AudiencePreviewCard({ preview }: { preview: PreviewResult | undefined }) {
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
          Includes {pluralCount(preview.unlinkedCentralDonors, "central donor")} (unlinked)
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
});
