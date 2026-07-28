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
 * ── The two doors that make it a designer's library ────────────────────────
 * Renaming and archiving is not owning. "New template" (`NewTemplateAction` →
 * `campaignTemplates.createTemplate`) authors one from scratch without needing
 * a campaign to snapshot — the design-only door, since
 * `createTemplateFromCampaign` requires compose power a Graphic Designer
 * doesn't hold — and "Edit design" opens the row in the block composer
 * (`app/(app)/campaign-template/[id].tsx`), which is where a template's
 * CONTENT is actually changed. Both are `canDesign`-only, matching the
 * server's `requireCampaignDesign` on every write here.
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
import { useRouter } from "expo-router";
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
import { useActionRunner, type ActionRunner } from "../../lib/useActionToast";
import { confirmAction } from "./helpers";
import {
  newTemplateArgs,
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
  // Already resolved (and cached) by the route's own gate — `canDesign` is what
  // separates "owns this library" from "reads it before starting a campaign".
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  const { run, toast, dismiss } = useActionRunner();
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_BREAKPOINT;
  const [editingId, setEditingId] = useState<Id<"campaignTemplates"> | null>(null);

  if (templates === undefined) return <Screen loading />;

  const rows = templates as TemplateRow[];
  const canDesign = access?.canDesign === true;

  return (
    <Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
      <Narrow>
        <Text className="mb-1 font-display text-lg text-ink">Templates</Text>
        <Text className="mb-4 text-sm text-muted">
          A template is a saved starting point — the blocks and the theme of an
          email you liked, ready to copy into a new campaign. Creating a campaign
          from one copies it, so editing a template here never touches a campaign
          already in flight. Start one from scratch below, or save one from any
          campaign&apos;s designer with &ldquo;Save as template&rdquo;.
        </Text>

        {canDesign ? <NewTemplateAction existing={rows} run={run} /> : null}

        <SectionHeader title="Templates" count={rows.length} />

        {rows.length === 0 ? (
          <EmptyState
            icon="bookmark"
            title="No templates yet"
            message={
              canDesign
                ? "Choose “New template” above to build one block by block — or open a campaign you're happy with, go to Design, and choose “Save as template”."
                : "Open a campaign you're happy with, go to Design, and choose “Save as template” — it'll show up here, preview and all."
            }
          />
        ) : (
          <View className="gap-4">
            {rows.map((row) => (
              <TemplateCard
                key={row._id}
                row={row}
                split={split}
                canDesign={canDesign}
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

/**
 * "New template" — a template built from scratch, which until now was
 * impossible for the person whose job it is.
 *
 * The only way to author a template was `createTemplateFromCampaign` ("Save as
 * template", in a campaign's designer), and that starts from a CAMPAIGN — so
 * it needs `campaigns.compose` power, which a design-only Graphic Designer
 * deliberately does not hold. `campaignTemplates.createTemplate` is the design
 * door: name it, and it opens EMPTY in the composer
 * (`app/(app)/campaign-template/[id].tsx`), themed with the scope default.
 *
 * Expand-in-place rather than a dialog, the `SaveAsTemplateAction` /
 * `CampaignsListView` inline-creator idiom — the app has no modal primitive
 * and `Alert.prompt` is iOS-only.
 */
function NewTemplateAction({
  existing,
  run,
}: {
  existing: readonly TemplateRow[];
  run: ActionRunner["run"];
}) {
  const router = useRouter();
  const createTemplate = useMutation(api.campaignTemplates.createTemplate);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const args = newTemplateArgs({ name, description }, existing);

  async function create() {
    if (!args.ok) return;
    const { ok: _ok, ...rest } = args;
    setSaving(true);
    try {
      const templateId = await run(() => createTemplate({ scope: SCOPE, ...rest }), {
        errorTitle: "Couldn't create the template",
      });
      // `run` resolves undefined when it swallowed a failure — only navigate
      // when a real id came back.
      if (templateId === undefined) return;
      setOpen(false);
      setName("");
      setDescription("");
      // Straight into the composer: a template with no blocks is not a
      // deliverable, and making the designer find the row she just made before
      // she can fill it in is the kind of step that turns "simple" into "fine,
      // I'll do it in Canva".
      router.push(`/campaign-template/${templateId}` as never);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <View className="mb-4 flex-row">
        <Button
          title="New template"
          size="sm"
          icon="plus"
          onPress={() => setOpen(true)}
        />
      </View>
    );
  }

  return (
    <Card padding="sm" className="mb-4">
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Monthly newsletter"
        autoFocus
      />
      <TextField
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="e.g. The monthly newsletter — send on the first Tuesday."
        hint="Optional. Say when to reach for this one."
        multiline
      />
      {!args.ok && name.trim() !== "" ? (
        <Text className="text-xs text-danger">{args.error}</Text>
      ) : null}
      <View className="mt-1 flex-row justify-end gap-2">
        <Button title="Cancel" size="sm" variant="ghost" onPress={() => setOpen(false)} />
        <Button
          title="Create and design"
          size="sm"
          loading={saving}
          disabled={!args.ok}
          onPress={() => void create()}
        />
      </View>
    </Card>
  );
}

/** One template: its rendered preview, what it is, and what you can do to it. */
function TemplateCard({
  row,
  split,
  canDesign,
  editing,
  onEdit,
  onCloseEdit,
  run,
}: {
  row: TemplateRow;
  split: boolean;
  canDesign: boolean;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  run: ReturnType<typeof useActionRunner>["run"];
}) {
  const router = useRouter();
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

          {/* Every action here — rename, describe, restyle, remove — is a
              write to the SHARED design system and needs `campaigns.design`
              server-side. A caller without it gets the preview and the
              details, which is the whole story they're entitled to, rather
              than three buttons that would each come back FORBIDDEN. */}
          {!canDesign ? null : editing ? (
            <TemplateDetailsForm row={row} onDone={onCloseEdit} run={run} />
          ) : (
            <View className="mt-2 flex-row flex-wrap items-center gap-2">
              {/* First, and the only PRIMARY button on the card: what a
                  template mostly needs is its CONTENT changed, and until this
                  existed the answer to "how do I fix the newsletter template?"
                  was "you can't — rename it or delete it". */}
              <Button
                title="Edit design"
                size="sm"
                icon="edit-3"
                onPress={() => router.push(`/campaign-template/${row._id}` as never)}
              />
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
