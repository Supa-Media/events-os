/**
 * TEMPLATES — the campaign template library.
 *
 * The body of `app/(app)/campaigns/templates.tsx`, split out the same way
 * `CampaignThemesView` is split out of `campaigns/themes.tsx`: the route file
 * keeps only the access gate, the view owns loading, editing, and removal.
 *
 * ── Why this screen had to exist ───────────────────────────────────────────
 * Templates were previously reachable only as names in the campaign
 * creator's dropdown plus a "Save as template" button in the designer. You
 * picked a name and found out what it looked like afterwards; there was no
 * way to rename one, describe one, or get rid of one — even though
 * `campaignTemplates.updateTemplate` and `archiveTemplate` were both already
 * written (the latter's own doc promising "an org that doesn't want the
 * newsletter template can actually get rid of it"), with zero callers.
 * `SaveAsTemplateAction` even told the author "it's in the template list
 * now." This is that list.
 *
 * ── Why every row renders the real email ───────────────────────────────────
 * A template IS its layout — "Monthly newsletter" tells you nothing next to
 * seeing the actual thing, exactly as `CampaignThemesView` leads with a
 * theme's colour swatches rather than its name. Each row renders the stored
 * document through `renderCampaignEmail` into the same `EmailHtmlPreview`
 * the designer uses (`campaign/[id]/design.tsx`), against the same sample
 * recipient, so what you see here is literally what the composer will start
 * from. The render is wrapped in its own inline `ErrorBoundary`: a row
 * written before a validation rule existed shows a scoped notice instead of
 * taking down the whole library.
 *
 * ── Built-ins ──────────────────────────────────────────────────────────────
 * A built-in row (`isBuiltIn`, seeded by `ensureBuiltInTemplates`) is an
 * ordinary editable row — the flag is provenance, not a lock — so it shows a
 * badge but is renamed, described, and removed like any other. The one
 * asymmetry is spelled out at the point of removal rather than hidden:
 * `ensureBuiltInTemplates` deliberately never resurrects an archived
 * built-in, so removing one is effectively permanent (see
 * `templateFields.ts#templateArchiveCopy`).
 *
 * Scope is `"central"` throughout, matching `CampaignsListView` and
 * `CampaignThemesView`: the whole campaigns desk is central-only today and
 * there is no scope picker to feed.
 */
import { useMemo, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { renderCampaignEmail, type EmailDocument } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  TextField,
  ToastView,
} from "../ui";
import { ErrorBoundary } from "../ErrorBoundary";
import EmailHtmlPreview from "../email/EmailHtmlPreview";
import { formatDate } from "../../lib/format";
import { useActionRunner } from "../../lib/useActionToast";
import { confirmAction } from "./helpers";
import {
  templateArchiveCopy,
  templateBlockSummary,
  templateDetailsPatch,
} from "./templateFields";

type TemplateRow = FunctionReturnType<typeof api.campaignTemplates.listTemplates>[number];

/** Every campaign surface in the app is org-wide today (see the module doc). */
const SCOPE = "central" as const;

/** Below this width the preview stacks above the details instead of beside
 *  them — the composer's and theme editor's own breakpoint. */
const SPLIT_BREAKPOINT = 860;

/** Sample recipient the thumbnails render against — never sent anywhere.
 *  Same person the designer's live preview uses, so the two match. */
const PREVIEW_RECIPIENT = { name: "Ada Lovelace", email: "ada@example.com" };

export function CampaignTemplatesView() {
  const templates = useQuery(api.campaignTemplates.listTemplates, { scope: SCOPE });
  const { run, toast, dismiss } = useActionRunner();
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_BREAKPOINT;
  const [editingId, setEditingId] = useState<Id<"campaignTemplates"> | null>(null);

  if (templates === undefined) return <Screen loading />;

  const rows = templates as TemplateRow[];

  return (
    <Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
      <Narrow>
        <Text className="mb-1 font-display text-lg text-ink">Templates</Text>
        <Text className="mb-4 text-sm text-muted">
          A template is a saved starting point — the blocks and the theme of an
          email you liked, ready to copy into a new campaign. Creating a campaign
          from one copies it, so editing a template here never touches a campaign
          already in flight. Save a new one from any campaign&apos;s designer with
          &ldquo;Save as template&rdquo;.
        </Text>

        <SectionHeader title="Templates" count={rows.length} />

        {rows.length === 0 ? (
          <EmptyState
            icon="bookmark"
            title="No templates yet"
            message="Open a campaign you're happy with, go to Design, and choose “Save as template” — it'll show up here, preview and all."
          />
        ) : (
          <View className="gap-4">
            {rows.map((row) => (
              <TemplateCard
                key={row._id}
                row={row}
                split={split}
                editing={editingId === row._id}
                onEdit={() => setEditingId(row._id)}
                onCloseEdit={() => setEditingId(null)}
                run={run}
              />
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

/** One template: its rendered preview, what it is, and what you can do to it. */
function TemplateCard({
  row,
  split,
  editing,
  onEdit,
  onCloseEdit,
  run,
}: {
  row: TemplateRow;
  split: boolean;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  run: ReturnType<typeof useActionRunner>["run"];
}) {
  const archiveTemplate = useMutation(api.campaignTemplates.archiveTemplate);

  function handleRemove() {
    const copy = templateArchiveCopy(row.name, row.isBuiltIn === true);
    confirmAction({
      title: copy.title,
      message: copy.message,
      confirmLabel: copy.confirmLabel,
      destructive: true,
      onConfirm: () => {
        void run(() => archiveTemplate({ templateId: row._id }), {
          errorTitle: "Couldn't remove the template",
        });
      },
    });
  }

  return (
    <Card>
      <View className={split ? "flex-row gap-4" : "gap-3"}>
        <View style={split ? { width: 260 } : undefined}>
          <ErrorBoundary inline>
            <TemplatePreview doc={row.doc} height={split ? 280 : 240} />
          </ErrorBoundary>
        </View>

        <View className="flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-base font-semibold text-ink">{row.name}</Text>
            {row.isBuiltIn ? <Badge label="Built-in" tone="neutral" /> : null}
          </View>

          {row.description ? (
            <Text className="text-sm text-muted">{row.description}</Text>
          ) : (
            <Text className="text-sm text-faint">
              No description yet — add one so the next person knows when to reach
              for it.
            </Text>
          )}

          <Text className="mt-1 text-xs text-faint">
            {templateBlockSummary(row.doc)} · Updated {formatDate(row.updatedAt)}
          </Text>

          {editing ? (
            <TemplateDetailsForm row={row} onDone={onCloseEdit} run={run} />
          ) : (
            <View className="mt-2 flex-row flex-wrap items-center gap-2">
              <Button
                title="Rename or describe"
                size="sm"
                variant="secondary"
                icon="edit-2"
                onPress={onEdit}
              />
              <Button title="Remove" size="sm" variant="ghost" onPress={handleRemove} />
            </View>
          )}
        </View>
      </View>
    </Card>
  );
}

/**
 * The stored document rendered exactly as it will send. `doc` is `v.any()` on
 * the row (validated at the write gate by `validateEmailDocument`, not by
 * Convex), so the cast matches what `campaign/[id]/design.tsx` does with
 * `campaign.doc`; anything genuinely malformed throws into this component's
 * inline ErrorBoundary rather than blanking the library.
 */
function TemplatePreview({ doc, height }: { doc: unknown; height: number }) {
  const html = useMemo(
    () =>
      renderCampaignEmail(doc as EmailDocument, {
        recipient: PREVIEW_RECIPIENT,
        unsubscribeUrl: "#",
      }),
    [doc],
  );
  return <EmailHtmlPreview html={html} height={height} />;
}

/**
 * Rename + describe, in place. Both land through one
 * `campaignTemplates.updateTemplate` call whose args come from
 * `templateDetailsPatch` — see that function's doc for why an untouched
 * description must not be sent at all, and an emptied one must be sent as an
 * explicit `null`.
 */
function TemplateDetailsForm({
  row,
  onDone,
  run,
}: {
  row: TemplateRow;
  onDone: () => void;
  run: ReturnType<typeof useActionRunner>["run"];
}) {
  const updateTemplate = useMutation(api.campaignTemplates.updateTemplate);
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description ?? "");
  const [saving, setSaving] = useState(false);

  const patch = templateDetailsPatch({ name, description }, row);

  async function save() {
    if (!patch.ok) return;
    if (!patch.changed) {
      onDone();
      return;
    }
    const { ok: _ok, changed: _changed, ...args } = patch;
    setSaving(true);
    try {
      const result = await run(() => updateTemplate({ templateId: row._id, ...args }), {
        errorTitle: "Couldn't save the template",
      });
      if (result !== undefined) onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mt-3 gap-1 rounded-md border border-border bg-sunken p-3">
      <TextField label="Name" value={name} onChangeText={setName} autoFocus />
      <TextField
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="e.g. The monthly newsletter — send on the first Tuesday."
        hint="Shown here and nowhere else. Say when to reach for this one."
        multiline
      />
      {!patch.ok ? <Text className="text-xs text-danger">{patch.error}</Text> : null}
      <View className="mt-1 flex-row justify-end gap-2">
        <Button title="Cancel" size="sm" variant="ghost" onPress={onDone} />
        <Button
          title="Save"
          size="sm"
          loading={saving}
          disabled={!patch.ok}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
