/**
 * AUDIENCES — the audience-segment list + inline create/edit form.
 *
 * An audience is a saved `{name, source, filters}` recipe (`api.audiences.*`)
 * that campaigns send to. The editor shows a LIVE preview
 * (`api.audiences.previewAudience`) as the source/filters change, so an
 * author sees the recipient count (and who gets excluded as suppressed /
 * unverified) before saving — the same "see it before you commit" idea as
 * `BlastComposerCard`'s cost preview.
 *
 * Filters are source-specific, per the audiences contract:
 *   - guests: an optional event (unset = every guest, any event)
 *   - donors: donor status + a "gave recently" preset (30 / 365 days / any)
 *   - people: no filters — every roster person with an email
 * `filters.chapterId` (chapter-scope narrowing) exists on the schema but
 * isn't exposed here — no per-source rule in the design brief calls for it.
 * Every audience this UI creates is `scope: "central"` (org-wide) — no scope
 * picker yet (see `CampaignsListView`'s file doc for the same call).
 *
 * `source` is set once at creation and is NOT part of `updateAudience`'s args
 * (`apps/convex/audiences.ts`) — an existing audience's source renders as a
 * static badge in the edit form rather than an editable Select.
 */
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, Badge, TextField, Select, Field, EmptyState, ToastView } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { confirmAction, pluralCount } from "./helpers";

type Audience = FunctionReturnType<typeof api.audiences.listAudiences>[number];
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;

/** Every audience/campaign this UI creates is org-wide — see the file doc. */
const CENTRAL_SCOPE = "central" as const;

type SourceValue = "guests" | "donors" | "people";

const SOURCE_OPTIONS: { value: SourceValue; label: string }[] = [
  { value: "guests", label: "Guests" },
  { value: "donors", label: "Donors" },
  { value: "people", label: "People" },
];

// Mirrors `apps/convex/schema/givingPlatform.ts`'s `DONOR_STATUSES` by hand —
// same small-stable-union precedent as `giving/donors.tsx`'s `STATUS_FILTERS`.
const DONOR_STATUS_OPTIONS = [
  { value: "any", label: "Any status" },
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "lapsed", label: "Lapsed" },
];

const GAVE_RECENTLY_OPTIONS = [
  { value: "none", label: "Any time" },
  { value: "30", label: "Last 30 days" },
  { value: "365", label: "Last year" },
];

function sourceLabel(source: string): string {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? source;
}

/** A short human summary of an audience's filters, for the list-card meta line. */
function filterSummary(source: string, filters: Audience["filters"]): string | null {
  if (source === "donors") {
    const parts: string[] = [];
    if (filters?.donorStatus) parts.push(filters.donorStatus);
    if (filters?.gaveWithinDays) parts.push(`gave in last ${filters.gaveWithinDays}d`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  if (source === "guests" && filters?.eventId) return "one event";
  return null;
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
            message="Create a segment above — guests, donors, or all people — to send a campaign to."
          />
        </View>
      ) : (
        <View style={styles.list}>
          {(audiences as Audience[]).map((a) => {
            const summary = filterSummary(a.source, a.filters);
            return (
              <Card key={a._id} onPress={() => setEditingId(a._id)}>
                <View style={styles.cardTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Badge label={sourceLabel(a.source)} tone="accent" />
                </View>
                {summary ? <Text style={styles.meta}>{summary}</Text> : null}
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
  const [source, setSource] = useState<SourceValue>((initial?.source as SourceValue) ?? "guests");
  const [eventId, setEventId] = useState<string>(initial?.filters?.eventId ?? "");
  const [donorStatus, setDonorStatus] = useState<string>(initial?.filters?.donorStatus ?? "any");
  const [gaveWithinDays, setGaveWithinDays] = useState<string>(
    initial?.filters?.gaveWithinDays ? String(initial.filters.gaveWithinDays) : "none",
  );
  const [saving, setSaving] = useState(false);

  const events = useQuery(api.events.list, { scope: "all" }) ?? [];

  const filters: Audience["filters"] = {
    eventId: source === "guests" && eventId ? (eventId as Id<"events">) : undefined,
    donorStatus:
      source === "donors" && donorStatus !== "any"
        ? (donorStatus as Audience["filters"]["donorStatus"])
        : undefined,
    gaveWithinDays:
      source === "donors" && gaveWithinDays !== "none" ? Number(gaveWithinDays) : undefined,
  };

  const scope = initial?.scope ?? CENTRAL_SCOPE;
  const preview = useQuery(api.audiences.previewAudience, { scope, source, filters }) as
    | PreviewResult
    | undefined;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      // `source` can only be set at creation — `updateAudience` has no source
      // arg (see the file doc), so an edit only ever sends name + filters.
      const result = initial
        ? await run(() => update({ audienceId: initial._id, name: trimmed, filters }), {
            errorTitle: "Couldn't save audience",
          })
        : await run(() => create({ scope: CENTRAL_SCOPE, name: trimmed, source, filters }), {
            errorTitle: "Couldn't create audience",
          });
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

      {initial ? (
        // Source is fixed after creation (`updateAudience` has no source arg)
        // — show it as a plain label instead of an editable control.
        <Field label="Source">
          <Badge label={sourceLabel(initial.source)} tone="accent" />
        </Field>
      ) : (
        <Select
          label="Source"
          value={source}
          options={SOURCE_OPTIONS}
          onChange={(v) => setSource(v as SourceValue)}
        />
      )}

      {source === "guests" ? (
        <Select
          label="Event"
          hint="Leave unset to include guests from every event."
          value={eventId || null}
          options={[
            { value: "", label: "Any event" },
            ...events.map((e: { _id: string; name: string }) => ({
              value: e._id,
              label: e.name,
            })),
          ]}
          onChange={setEventId}
        />
      ) : null}

      {source === "donors" ? (
        <>
          <Select
            label="Donor status"
            value={donorStatus}
            options={DONOR_STATUS_OPTIONS}
            onChange={setDonorStatus}
          />
          <Select
            label="Has given recently"
            value={gaveWithinDays}
            options={GAVE_RECENTLY_OPTIONS}
            onChange={setGaveWithinDays}
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

function AudiencePreviewCard({ preview }: { preview: PreviewResult | undefined }) {
  if (preview === undefined) {
    return (
      <Field label="Recipients">
        <Text className="text-sm text-faint">Calculating…</Text>
      </Field>
    );
  }
  return (
    <Field label="Recipients">
      <Text className="text-base font-semibold text-ink">
        {pluralCount(preview.count, "person")}
      </Text>
      {preview.excludedSuppressed > 0 || preview.excludedUnverified > 0 ? (
        <Text className="mt-0.5 text-xs text-muted">
          {preview.excludedSuppressed > 0
            ? `${pluralCount(preview.excludedSuppressed, "suppressed contact")} excluded`
            : ""}
          {preview.excludedSuppressed > 0 && preview.excludedUnverified > 0 ? " · " : ""}
          {preview.excludedUnverified > 0
            ? `${pluralCount(preview.excludedUnverified, "unverified contact")} excluded`
            : ""}
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
