/**
 * TEMPLATE EDITOR — the block composer, pointed at a saved template.
 *
 * ── Why this screen had to exist ───────────────────────────────────────────
 * "It should be simple for designers to create and update templates" was the
 * ask; what shipped was a library that could rename, re-describe and archive.
 * `campaignTemplates.updateTemplate` accepted a `doc` from the day it was
 * written and NOTHING ever sent one — the only client
 * (`CampaignTemplatesView`'s details form) can emit `name` and `description`
 * and nothing else. A design-only Graphic Designer therefore owned a library
 * whose contents she could not edit, and could not author one either
 * (`createTemplateFromCampaign` starts from a campaign, which takes
 * `campaigns.compose` power she deliberately doesn't hold). This screen and
 * `campaignTemplates.createTemplate` are the two halves of that gap.
 *
 * ── Why it reuses the campaign composer ────────────────────────────────────
 * A blocks-format template IS an `EmailDocument` — the same blocks, the same
 * theme, the same write gate (`validateEmailDocument`). A tiptap-format one
 * is a tiptap JSON document instead, routed the same way a campaign is
 * (`DocumentComposer`'s format switch — `docs/plans/maily-editor-overhaul.md`,
 * WS3). Either way it is the SAME `DocumentComposer` a campaign uses: same
 * undo/redo (or, on the maily side, ProseMirror's own), same debounced
 * autosave, same live preview. Only what SAVING means differs —
 * `campaignTemplates.updateTemplate({ templateId, doc })` here, where the
 * campaign designer calls `campaigns.updateCampaignDoc`. Templates have no
 * subject/audience/sender of their own, so — unlike the campaign screen —
 * this one never builds a `meta` prop for the maily host.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * `myCampaignsAccess.canView` opens the screen (a composer needs to READ the
 * template she's about to start from), `canDesign` is what makes it editable —
 * `updateTemplate` requires `campaigns.design` server-side, and rendering a
 * live-looking composer whose every autosave comes back FORBIDDEN is the
 * exact failure the campaign designer's own `canCompose` check exists to
 * avoid.
 *
 * `docFormat` is a real, optional schema column (`emailDocFormatOf(template)`
 * resolves it — WS2b). Themes are RETIRED (2026-07-29, "Themes freeze") —
 * `campaignTemplates.setTemplateTheme` throws `THEMES_RETIRED` for every row
 * now, so there is no restyle affordance here either.
 */
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { JSONContent } from "@tiptap/core";
import { emailDocFormatOf, type EmailDocument } from "@events-os/shared";
import {
  Badge,
  Button,
  EmptyState,
  FULL_WIDTH,
  Narrow,
  Screen,
  ToastView,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { confirmAction } from "../../../components/campaign/helpers";
import { DocumentComposer } from "../../../components/campaign/designer/DocumentComposer";
import { useDesignerImageUploader } from "../../../components/campaign/designer/useImageUploader";

export default function CampaignTemplateDesignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const templateId = id as Id<"campaigns">;
  const access = useQuery(api.audiences.myCampaignsAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="The Emails desk is available to org leadership"
            message="Ask a central Executive Director, Financial Manager, or Marketing Director to grant you email design, compose, or approve power."
          />
        </Narrow>
      </Screen>
    );
  }
  return <TemplateDesignBody templateId={templateId} canDesign={access.canDesign} />;
}

function TemplateDesignBody({
  templateId,
  canDesign,
}: {
  templateId: Id<"campaigns">;
  canDesign: boolean;
}) {
  const router = useRouter();

  const template = useQuery(api.campaignTemplates.getTemplate, { templateId });
  const updateTemplate = useMutation(api.campaignTemplates.updateTemplate);
  const resetBuiltInTemplate = useMutation(api.campaignTemplates.resetBuiltInTemplate);
  const { run, toast, dismiss } = useActionRunner();

  // The runtime escape hatch for "I just typed test content into the
  // built-in newsletter and autosave already wrote it" — the deploy-time
  // reseed (`campaignTemplates.ts#resetBuiltInTemplate`'s own doc) restores a
  // drifted built-in too, but only the next time something ELSE re-invokes
  // the seeder, which could be hours away. Only shown for a built-in row —
  // there is no "shipped default" to reset an authored template back to.
  function handleReset() {
    if (!template) return;
    confirmAction({
      title: "Reset to the shipped default?",
      message: `This throws away every change made to “${template.name}” since it was seeded and restores the version that ships with the app.`,
      confirmLabel: "Reset",
      destructive: true,
      onConfirm: () => {
        // No separate success toast needed: `getTemplate` is a live query, so
        // the composer's own content flips back to the shipped default the
        // instant this mutation commits — the same reactive feedback every
        // other autosave in this screen already relies on.
        void run(() => resetBuiltInTemplate({ templateId }), {
          errorTitle: "Couldn't reset the template",
        });
      },
    });
  }

  const saveDoc = useCallback(
    (doc: EmailDocument) => updateTemplate({ templateId, doc }),
    [updateTemplate, templateId],
  );

  const saveTiptapDoc = useCallback(
    (doc: JSONContent) => updateTemplate({ templateId, doc }),
    [updateTemplate, templateId],
  );

  const uploadImage = useDesignerImageUploader(canDesign);

  if (template === undefined) return <Screen loading />;

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <ToastView toast={toast} onDismiss={dismiss} />
      <View className="mb-3 flex-row flex-wrap items-start justify-between gap-3">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="font-display text-lg text-ink" numberOfLines={1}>
            {template.name}
          </Text>
          <Badge label="Template" tone="neutral" />
          {template.isBuiltIn ? <Badge label="Built-in" tone="neutral" /> : null}
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          {template.isBuiltIn && canDesign ? (
            <Button title="Reset to default" variant="secondary" onPress={handleReset} />
          ) : null}
          {/* `back()` with a `replace` deep-link fallback — the composer is
              always opened FROM the library, and pushing a second copy of the
              library would leave "back" walking through duplicates. Matches
              `campaign/[id]/design.tsx`. */}
          <Button
            title="Done"
            variant="secondary"
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace("/campaigns/templates" as never);
            }}
          />
        </View>
      </View>
      <Text className="mb-3 text-xs text-muted">
        Edits save as you type and change this template only — an email copies
        a template when it&apos;s created, so nothing already in flight moves.
      </Text>
      {emailDocFormatOf(template) === "tiptap" ? (
        <DocumentComposer
          docFormat="tiptap"
          campaignId={templateId}
          doc={template.doc as JSONContent}
          editable={canDesign}
          lockedNotice="Read-only — editing templates takes design power on the Emails desk."
          onSave={saveTiptapDoc}
          run={run}
          uploadImage={uploadImage}
        />
      ) : (
        <DocumentComposer
          docFormat="blocks"
          doc={template.doc as EmailDocument}
          editable={canDesign}
          lockedNotice="Read-only — editing templates takes design power on the Emails desk."
          onSave={saveDoc}
          run={run}
          emptyMessage="Add a block above to start building this template."
          lockedEmptyMessage="This template has no blocks yet."
        />
      )}
    </Screen>
  );
}
