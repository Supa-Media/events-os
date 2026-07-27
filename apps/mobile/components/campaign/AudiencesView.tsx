/**
 * AUDIENCES — the audience-segment list + inline create/edit form.
 *
 * An audience is a saved recipe (`api.audiences.*`) that campaigns send to.
 * Targeting v2 (specs/audience-targeting-v2.md, founder-approved mockup
 * 2026-07-24) made the editor a GROUP builder (`TargetingBuilder.tsx`):
 * "Send to" groups of plain-sentence conditions (match ANY group; every line
 * in a group must hold; negation is on the line), "Don't send to" skip
 * lists, hand-picked include/exclude (`searchPeopleForAudience`), and a
 * "Check a person" box (`api.audiences.explainAudiencePerson`) that explains
 * any individual condition by condition. The editor shows a LIVE preview
 * (`api.audiences.previewAudience`) as the definition changes — the overall
 * count, per-group counts, and every exclusion reason, including the
 * invariant that suppression/opt-out beat a hand-pick.
 *
 * Every NEW audience gets `targeting`, and migration
 * (`migrations/0042_wrap_targeting.ts`) wraps stored rows; the pre-v2 chip
 * builder (`FilterChipsBuilder` below) stays mounted ONLY for a
 * not-yet-wrapped `person_filters` row (e.g. one referenced by an in-flight
 * approval at deploy time — see 0042's doc). A legacy
 * `guests`/`donors`/`people`-sourced row without `targeting` renders
 * READ-ONLY: badge + summary, editable name/archive only.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  centsToDollarsStr,
  dollarsStrToCents,
  EXCLUDE_FIELD_PREFIX,
  flushPendingNumberFields,
  intStrToNumber,
  intToStr,
  resolveNumberField,
  splitExcludePatch,
  type PendingNumberField,
} from "./audienceFilterFields";
import {
  PersonCheckSection,
  TargetingBuilder,
  summarizeTargeting,
  targetingToUi,
  toWireTargeting,
  type Targeting,
  type UiGroup,
} from "./TargetingBuilder";

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

function sourceLabel(source: string, hasTargeting: boolean): string {
  if (hasTargeting) return "Groups";
  if (source === "person_filters") return "Filters + hand-picked";
  if (source === "guests") return "Guests";
  if (source === "donors") return "Donors";
  if (source === "people") return "People";
  return source;
}

export function AudiencesView({
  seedIncludeIds,
}: {
  /**
   * People-CRM UX — the People grid's "Email selected" bridge: a set of
   * hand-picked person ids to pre-seed into a brand-NEW audience's draft the
   * moment this view mounts (never applied to an existing/editing audience —
   * only meaningful for the "+ New audience" flow). Purely a client-side
   * draft seed: nothing is written until the marketer reviews and hits Save,
   * same as picking each person by hand in `HandPickSection` below.
   */
  seedIncludeIds?: Id<"people">[];
} = {}) {
  const audiences = useQuery(api.audiences.listAudiences, {});
  const [editingId, setEditingId] = useState<Id<"audiences"> | "new" | null>(null);
  const { run, toast, dismiss } = useActionRunner();

  // Auto-open a fresh draft when arriving with a seed — the marketer lands
  // straight in the form with their picks already in the hand-pick list,
  // rather than having to tap "+ New audience" themselves.
  useEffect(() => {
    if (seedIncludeIds && seedIncludeIds.length > 0) setEditingId("new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          seedIncludeIds={editingId === "new" ? seedIncludeIds : undefined}
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
            const handPickCounts = {
              includeCount: a.includePersonIds?.length,
              excludeCount: a.excludePersonIds?.length,
            };
            const summary = a.targeting
              ? summarizeTargeting(a.targeting, handPickCounts)
              : describeAudience(a.source, a.filters, handPickCounts, a.excludeFilters);
            return (
              <Card key={a._id} onPress={() => setEditingId(a._id)}>
                <View style={styles.cardTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Badge label={sourceLabel(a.source, a.targeting != null)} tone="accent" />
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {summary}
                </Text>
                {a.source !== "person_filters" && !a.targeting ? (
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
  seedIncludeIds,
}: {
  initial: Audience | null;
  run: ReturnType<typeof useActionRunner>["run"];
  onDone: () => void;
  /** People-CRM UX seed (see `AudiencesView`'s doc) — only ever passed for a
   *  brand-new draft (`initial` is null whenever this is set). */
  seedIncludeIds?: Id<"people">[];
}) {
  const create = useMutation(api.audiences.createAudience);
  const update = useMutation(api.audiences.updateAudience);
  const archive = useMutation(api.audiences.archiveAudience);

  const [name, setName] = useState(initial?.name ?? "");
  const [filters, setFilters] = useState<PersonFilters>(initial?.filters ?? {});

  // ── Targeting v2 (the group/skip-list builder) ────────────────────────────
  // Every NEW audience is v2, and every stored row that carries `targeting`
  // (migration 0042 wraps legacy rows) edits through the group builder; the
  // legacy chip builder below stays mounted ONLY for a not-yet-wrapped row.
  // Rows commit into UI state on every valid keystroke (WYSIWYG — see
  // `TargetingBuilder.tsx`'s doc); the PREVIEW debounces here instead, so the
  // live counts don't refetch per keystroke.
  const isTargetingV2 = initial ? initial.targeting != null : true;
  const initialUi = useMemo(
    () => targetingToUi(initial?.targeting ?? { groups: [{ conditions: [] }] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [uiGroups, setUiGroups] = useState<UiGroup[]>(initialUi.groups);
  const [uiExcludeGroups, setUiExcludeGroups] = useState<UiGroup[]>(initialUi.excludeGroups);
  const wire = useMemo(() => toWireTargeting(uiGroups, uiExcludeGroups), [uiGroups, uiExcludeGroups]);
  const [debouncedTargeting, setDebouncedTargeting] = useState<Targeting>(wire.targeting);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTargeting(wire.targeting), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [wire.targeting]);
  // Property-level exclusions ("Exclude people who…") — same shape as
  // `filters`, AND-combined the same way; see `helpers.ts#describeFilterCriteria`'s
  // doc and `lib/audienceResolve.ts#personMatchesCriteria`'s doc for why the
  // two blocks share every bit of logic except which side of the audience
  // they land on.
  const [excludeFilters, setExcludeFilters] = useState<PersonFilters>(initial?.excludeFilters ?? {});
  const [includeIds, setIncludeIds] = useState<Id<"people">[]>(
    initial?.includePersonIds ?? seedIncludeIds ?? [],
  );
  const [excludeIds, setExcludeIds] = useState<Id<"people">[]>(initial?.excludePersonIds ?? []);
  const [includeNames, setIncludeNames] = useState<Record<string, string>>({});
  const [excludeNames, setExcludeNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // People-CRM UX: seeded ids arrive as bare ids (the People tab's OWN list,
  // not `searchPeopleForAudience`) — resolve their display names from
  // `api.people.list` so `HandPickSection`'s chips show a name instead of a
  // raw id. Skipped entirely once there's nothing to seed. `persona: "all"`:
  // the People tab's "Email selected" can hand-pick ANY persona, contacts
  // included (audiences deliberately target contacts — that's the whole
  // point of a contact row), so this lookup must see everyone too, not just
  // `people.list`'s conservative roster-only default.
  const needsSeedNames = (seedIncludeIds?.length ?? 0) > 0;
  const seedRoster = useQuery(
    api.people.list,
    needsSeedNames ? { persona: "all" } : "skip",
  );
  useEffect(() => {
    if (!seedRoster || !seedIncludeIds?.length) return;
    setIncludeNames((names) => {
      let changed = false;
      const next = { ...names };
      for (const id of seedIncludeIds) {
        if (next[id]) continue;
        const p = seedRoster.find((r: { _id: string }) => r._id === id);
        if (p) {
          next[id] = (p as { name: string }).name;
          changed = true;
        }
      }
      return changed ? next : names;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedRoster]);

  // Every mounted numeric filter field mirrors its raw typed text in here so
  // `handleSave` can flush exactly what's on screen — see
  // `audienceFilterFields.ts`'s doc on why Save must be WYSIWYG rather than
  // reading `filters`, which only has whatever's already debounce-committed.
  const rawFieldsRef = useRef<Map<string, PendingNumberField>>(new Map());
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set());
  const setFieldStatus = useCallback((key: string, dirty: boolean, invalid: boolean) => {
    setDirtyKeys((prev) => {
      if (prev.has(key) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
    setInvalidKeys((prev) => {
      if (prev.has(key) === invalid) return prev;
      const next = new Set(prev);
      if (invalid) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const numberFieldController: NumberFieldController = useMemo(
    () => ({ rawFieldsRef, setFieldStatus }),
    [setFieldStatus],
  );

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
    filters: isTargetingV2 ? (initial?.filters ?? {}) : filters,
    excludeFilters: isTargetingV2 ? undefined : excludeFilters,
    targeting: isTargetingV2 ? debouncedTargeting : undefined,
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

    if (isTargetingV2) {
      // Incomplete rows (an id control not chosen yet) never reach the wire
      // shape — blocking Save on them (with the hint below the buttons)
      // beats silently saving a narrower audience than what's on screen.
      if (wire.incompleteCount > 0) return;
      setSaving(true);
      try {
        const result = initial
          ? await run(
              () =>
                update({
                  audienceId: initial._id,
                  name: trimmed,
                  targeting: wire.targeting,
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
                  filters: {},
                  targeting: wire.targeting,
                  includePersonIds: includeIds.length ? includeIds : undefined,
                  excludePersonIds: excludeIds.length ? excludeIds : undefined,
                }),
              { errorTitle: "Couldn't create audience" },
            );
        if (result !== undefined) onDone();
      } finally {
        setSaving(false);
      }
      return;
    }

    // Flush every mounted numeric field's RAW text synchronously — Save must
    // persist what's on screen, not the last value each field's own 400ms
    // debounce happened to have committed (see `audienceFilterFields.ts`).
    // A still-malformed field blocks the whole save; its "Enter a number."
    // hint is already visible (computed live, not gated behind the
    // debounce) so there's nothing extra to surface here. The Filters group
    // AND the Exclude-people-who group's numeric fields share this ONE
    // registry (the exclude side's fields register with an `exclude:`
    // fieldKey prefix — see `FilterChipsBuilder`'s `keyPrefix` prop), so one
    // flush covers both; `splitExcludePatch` routes the combined result back
    // into the two separate patches.
    const flushed = flushPendingNumberFields<Record<string, number | undefined>>([
      ...rawFieldsRef.current.values(),
    ]);
    if (!flushed.ok) return;
    const { include: includePatch, exclude: excludePatch } =
      splitExcludePatch<PersonFilters>(flushed.patch);
    const finalFilters: PersonFilters = { ...filters, ...includePatch };
    const finalExcludeFilters: PersonFilters = { ...excludeFilters, ...excludePatch };
    if (finalFilters !== filters) setFilters(finalFilters);
    if (finalExcludeFilters !== excludeFilters) setExcludeFilters(finalExcludeFilters);

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
                filters: finalFilters,
                excludeFilters: finalExcludeFilters,
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
                filters: finalFilters,
                excludeFilters: finalExcludeFilters,
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

      {!isTargetingV2 ? (
        <Field label="Source">
          <Badge label={sourceLabel(source, false)} tone="accent" />
          {!isPersonFilters ? (
            <Text className="mt-1 text-xs text-muted">
              {describeAudience(source, filters)} — this is a previous-format audience. It still
              works for sending, and will move to the new group builder automatically; until then,
              only its name can be changed here.
            </Text>
          ) : null}
        </Field>
      ) : null}

      <ErrorBoundary inline>
        <LiveRecipientsSummary
          args={previewArgs}
          pendingEdit={
            dirtyKeys.size > 0 || (isTargetingV2 && wire.targeting !== debouncedTargeting)
          }
        />
      </ErrorBoundary>

      {isTargetingV2 ? (
        <>
          <ErrorBoundary inline>
            <TargetingBuilder
              groups={uiGroups}
              excludeGroups={uiExcludeGroups}
              onGroupsChange={setUiGroups}
              onExcludeGroupsChange={setUiExcludeGroups}
              previewArgs={previewArgs}
              onInvalid={(key, invalid) => setFieldStatus(key, false, invalid)}
            />
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
          <ErrorBoundary inline>
            <PersonCheckSection
              scope={scope}
              targeting={debouncedTargeting}
              includePersonIds={includeIds.length ? includeIds : undefined}
              excludePersonIds={excludeIds.length ? excludeIds : undefined}
            />
          </ErrorBoundary>
        </>
      ) : null}

      {!isTargetingV2 && isPersonFilters ? (
        <>
          <ErrorBoundary inline>
            <FilterChipsBuilder filters={filters} onChange={setFilters} controller={numberFieldController} />
          </ErrorBoundary>
          <ErrorBoundary inline>
            <FilterChipsBuilder
              filters={excludeFilters}
              onChange={setExcludeFilters}
              controller={numberFieldController}
              keyPrefix={EXCLUDE_FIELD_PREFIX}
              label="Exclude people who…"
              hint="Anyone matching these is removed from the audience, even if hand-picked."
              tone="exclude"
              // Verification round finding C: "only verified email" reads
              // backwards as an exclude criterion ("exclude anyone whose
              // address IS verified") — hidden here entirely rather than
              // offering a footgun; the resolver ignores it too, as
              // defense in depth (see lib/audienceResolve.ts).
              hiddenGroups={["email"]}
            />
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
            disabled={
              !name.trim() ||
              invalidKeys.size > 0 ||
              (isTargetingV2 && wire.incompleteCount > 0)
            }
          />
          <Button title="Cancel" variant="secondary" onPress={onDone} />
        </View>
        {initial ? (
          <Button title="Archive" variant="danger" onPress={handleArchive} />
        ) : null}
      </View>
      {invalidKeys.size > 0 ? (
        <Text className="mt-2 text-xs text-danger">
          Fix the highlighted field{invalidKeys.size === 1 ? "" : "s"} above before saving.
        </Text>
      ) : null}
      {isTargetingV2 && wire.incompleteCount > 0 ? (
        <Text className="mt-2 text-xs text-danger">
          {wire.incompleteCount === 1 ? "One line above still needs" : `${wire.incompleteCount} lines above still need`}{" "}
          a choice (a role, chapter, or event) before saving.
        </Text>
      ) : null}
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

/**
 * `AudienceForm` owns one of these: a `rawFieldsRef` every mounted
 * `DebouncedNumberField` mirrors its raw typed text into on every keystroke
 * (so `handleSave` can flush the literal on-screen text synchronously — see
 * `audienceFilterFields.ts`'s doc on why Save must be WYSIWYG), plus a
 * `setFieldStatus` callback each field uses to report whether it currently
 * has an uncommitted edit and/or invalid text, so the form can show a
 * pending cue on the sticky summary and disable Save while anything's
 * malformed.
 */
type NumberFieldController = {
  rawFieldsRef: React.RefObject<Map<string, PendingNumberField>>;
  setFieldStatus: (key: string, dirty: boolean, invalid: boolean) => void;
};

/**
 * A numeric TextField that keeps the raw typed string in local state and
 * only lands a PARSED value into `filters` after `FILTER_DEBOUNCE_MS` of no
 * typing — a stray non-numeric keystroke shows "Enter a number." (computed
 * live off the raw text, not gated behind the debounce) instead of silently
 * clearing the whole criterion. Also mirrors its raw text into the shared
 * `controller.rawFieldsRef` so `handleSave` can flush exactly what's on
 * screen even if the debounce hasn't fired yet — see the file doc.
 */
function DebouncedNumberField({
  fieldKey,
  label,
  placeholder,
  committedValue,
  format,
  parse,
  onCommit,
  controller,
}: {
  fieldKey: string;
  label: string;
  placeholder?: string;
  committedValue: number | undefined;
  format: (n: number | undefined) => string;
  parse: (raw: string) => number | undefined;
  onCommit: (n: number | undefined) => void;
  controller: NumberFieldController;
}) {
  const [raw, setRaw] = useState(() => format(committedValue));

  // The committed value can also change from OUTSIDE this field (its whole
  // group gets collapsed/cleared) — stay in sync when that happens.
  useEffect(() => {
    setRaw(format(committedValue));
  }, [committedValue]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolution = resolveNumberField(raw, parse);
  const isDirty = resolution.invalid || resolution.value !== committedValue;

  // Mirror the CURRENT raw text into the shared ref map on every keystroke so
  // a flush-on-save can read it synchronously (see the file doc).
  useEffect(() => {
    controller.rawFieldsRef.current.set(fieldKey, { key: fieldKey, raw, parse });
    return () => {
      controller.rawFieldsRef.current.delete(fieldKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, raw, parse]);

  // Report dirty/invalid status up only when it actually flips, so the
  // sticky summary's pending cue and Save's disabled state stay accurate
  // without re-rendering the whole form on every keystroke that doesn't
  // change either.
  useEffect(() => {
    controller.setFieldStatus(fieldKey, isDirty, resolution.invalid);
    return () => {
      controller.setFieldStatus(fieldKey, false, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, isDirty, resolution.invalid]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!resolution.invalid && resolution.value !== committedValue) {
        onCommit(resolution.value);
      }
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
      hint={resolution.invalid ? "Enter a number." : undefined}
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
 *
 * Reused VERBATIM for both halves of the picker — the include-side "Filters"
 * block (`keyPrefix=""`) and the exclude-side "Exclude people who…" block
 * (`keyPrefix={EXCLUDE_FIELD_PREFIX}`, `tone="exclude"`) — so the two can
 * never grow different chip groups, options, or numeric-field behavior.
 * `keyPrefix` disambiguates each `DebouncedNumberField`'s `fieldKey` so both
 * blocks' numeric fields can register into the SAME shared
 * `controller.rawFieldsRef` (one WYSIWYG flush covers both — see
 * `AudiencesView`'s `handleSave`/`splitExcludePatch`) without colliding.
 * `tone="exclude"` only changes the wrapping container's left accent, for
 * visual separation from the include block above it.
 */
function FilterChipsBuilder({
  filters,
  onChange,
  controller,
  keyPrefix = "",
  label = "Filters",
  hint = "Every active filter must match (AND) — leave all off to target everyone.",
  tone = "include",
  hiddenGroups = [],
}: {
  filters: PersonFilters;
  onChange: (next: PersonFilters) => void;
  controller: NumberFieldController;
  keyPrefix?: string;
  label?: string;
  hint?: string;
  tone?: "include" | "exclude";
  /** Chip groups this instance never renders — verification-round finding C:
   *  the exclude-side instance hides `"email"` (`verifiedEmailOnly`) entirely,
   *  since that criterion reads backwards inside `excludeFilters` ("exclude
   *  anyone whose address IS verified" — see
   *  `lib/audienceResolve.ts#hasEffectiveExcludeCriteria`'s doc, the
   *  resolver-side belt to this UI's suspenders). */
  hiddenGroups?: FilterGroupKey[];
}) {
  const visibleGroupKeys = (Object.keys(FILTER_GROUP_LABELS) as FilterGroupKey[]).filter(
    (k) => !hiddenGroups.includes(k),
  );
  const [expanded, setExpanded] = useState<Set<FilterGroupKey>>(
    () =>
      new Set(
        (Object.keys(GROUP_FIELDS) as FilterGroupKey[]).filter(
          (k) => !hiddenGroups.includes(k) && groupHasData(filters, k),
        ),
      ),
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

  const body = (
    <Field label={label} hint={hint}>
      <View className="flex-row flex-wrap gap-2">
        {visibleGroupKeys.map((key) => (
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
          {tone === "exclude"
            ? "Tap a category above to remove anyone matching it — leave everything off to exclude nobody."
            : "Tap a category above to narrow this audience — leave everything off to target everyone."}
        </Text>
      ) : null}

      {expanded.has("giving") ? (
        <View className="mt-3 gap-2 rounded-md border border-border bg-sunken p-3">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <DebouncedNumberField
                fieldKey={`${keyPrefix}givingLifetimeMinCents`}
                label="Lifetime giving ≥"
                placeholder="$0"
                committedValue={filters.givingLifetimeMinCents}
                format={centsToDollarsStr}
                parse={dollarsStrToCents}
                onCommit={(n) => patch({ givingLifetimeMinCents: n })}
                controller={controller}
              />
            </View>
            <View className="flex-1">
              <DebouncedNumberField
                fieldKey={`${keyPrefix}givingLifetimeMaxCents`}
                label="Lifetime giving ≤"
                placeholder="No max"
                committedValue={filters.givingLifetimeMaxCents}
                format={centsToDollarsStr}
                parse={dollarsStrToCents}
                onCommit={(n) => patch({ givingLifetimeMaxCents: n })}
                controller={controller}
              />
            </View>
          </View>
          <DebouncedNumberField
            fieldKey={`${keyPrefix}giftCountMin`}
            label="Gift count ≥"
            placeholder="0"
            committedValue={filters.giftCountMin}
            format={intToStr}
            parse={intStrToNumber}
            onCommit={(n) => patch({ giftCountMin: n })}
            controller={controller}
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
            fieldKey={`${keyPrefix}attendedWithinDays`}
            label="Attended within N days"
            placeholder="No limit"
            committedValue={filters.attendedWithinDays}
            format={intToStr}
            parse={intStrToNumber}
            onCommit={(n) => patch({ attendedWithinDays: n })}
            controller={controller}
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

      {/* Defense in depth, mirroring `visibleGroupKeys` above: the chip that
          expands this block is never rendered when "email" is hidden, so
          `expanded` can't normally gain it here — but a stale legacy row
          (excludeFilters.verifiedEmailOnly set before this fix existed)
          could still seed `expanded` with "email" on mount; this guard keeps
          the block from rendering even then. */}
      {expanded.has("email") && !hiddenGroups.includes("email") ? (
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

  // The exclude block gets a colored left rail so it reads as a clearly
  // separate, "this removes people" section rather than another Filters
  // group — the founder-requested "clear visual separation."
  if (tone === "exclude") {
    return <View style={styles.excludeSection}>{body}</View>;
  }
  return body;
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
 *
 * `pendingEdit` (true while any numeric filter field has an uncommitted
 * keystroke sitting in it, mid-debounce) ALSO drives the "Updating…" cue —
 * without it, the count would read as settled during the exact window where
 * it's about to change once the debounce fires (or WOULD change, if the
 * field weren't flushed straight into Save first — see `handleSave`).
 */
function LiveRecipientsSummary({
  args,
  pendingEdit,
}: {
  args: PreviewArgs;
  pendingEdit: boolean;
}) {
  const preview = useQuery(api.audiences.previewAudience, args) as PreviewResult | undefined;
  const [lastKnown, setLastKnown] = useState<PreviewResult | null>(null);
  useEffect(() => {
    if (preview !== undefined) setLastKnown(preview);
  }, [preview]);

  const shown = preview ?? lastKnown;
  const isUpdating = pendingEdit || (preview === undefined && lastKnown !== null);

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
    // Property-level exclusions (`excludeFilters`) — a PRIMARY count, like
    // the others above (never diagnostics-gated — see
    // `lib/audienceResolve.ts#AudienceResolution`'s doc).
    preview.excludedByFilters > 0
      ? `${pluralCount(preview.excludedByFilters, "person")} matched an exclude filter`
      : null,
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
      {/* Stitched-in #417 diagnostics — real data-trust signals that
          landed with the preview payload but were never rendered anywhere
          until now. Plain-language, matching the #418 copy style. */}
      {preview.unlinkedGuests > 0 ? (
        <Text className="mt-0.5 text-xs text-warn">
          {pluralCount(preview.unlinkedGuests, "earlier guest")}{" "}
          {preview.unlinkedGuests === 1 ? "isn't" : "aren't"} linked yet and can't be counted
          {preview.unlinkedGuestsIsLowerBound ? " (at least)" : ""}.
        </Text>
      ) : null}
      {preview.handPickedUnverified > 0 ? (
        <Text className="mt-0.5 text-xs text-muted">
          {pluralCount(preview.handPickedUnverified, "hand-picked person")}{" "}
          {preview.handPickedUnverified === 1 ? "has" : "have"} no verified email.
        </Text>
      ) : null}
      {preview.centralDonorsExcludedByChapterFilter > 0 ? (
        <Text className="mt-0.5 text-xs text-muted">
          {pluralCount(preview.centralDonorsExcludedByChapterFilter, "central donor")}{" "}
          {preview.centralDonorsExcludedByChapterFilter === 1 ? "was" : "were"} left out by the chapter
          filter.
        </Text>
      ) : null}
      {preview.handPickedExcludedByFilters > 0 ? (
        <Text className="mt-0.5 text-xs text-muted">
          {pluralCount(preview.handPickedExcludedByFilters, "hand-picked person")}{" "}
          {preview.handPickedExcludedByFilters === 1 ? "was" : "were"} removed by an exclude filter.
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
  excludeSection: {
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    paddingLeft: spacing.sm,
    marginTop: spacing.xs,
  },
});
