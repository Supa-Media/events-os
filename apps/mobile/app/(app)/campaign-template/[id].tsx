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
 * `updateTemplate`/`setTemplateTheme` both require `campaigns.design`
 * server-side, and rendering a live-looking composer whose every autosave
 * comes back FORBIDDEN is the exact failure the campaign designer's own
 * `canCompose` check exists to avoid.
 *
 * TODO(WS2b): `docFormat` is computed via `emailDocFormatOf(template)`, but
 * `campaigns.docFormat` isn't a schema column yet — see
 * `composerFormat.ts`'s own doc.
 */
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { JSONContent } from "@tiptap/core";
import { emailDocFormatOf, type EmailDocument, type EmailTheme } from "@events-os/shared";
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
import { DocumentComposer } from "../../../components/campaign/designer/DocumentComposer";
import type { ThemeChoice } from "../../../components/campaign/designer/CampaignThemePicker";
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
  const setTemplateTheme = useMutation(api.campaignTemplates.setTemplateTheme);
  // A one-off read after a write, not a subscription — the campaign
  // designer's own `applyTheme` precedent.
  const convex = useConvex();
  const { run, toast, dismiss } = useActionRunner();

  const saveDoc = useCallback(
    (doc: EmailDocument) => updateTemplate({ templateId, doc }),
    [updateTemplate, templateId],
  );

  // TODO(WS2b): `updateTemplate` still validates the OLD blocks format —
  // written correctly against the target contract; see
  // `MailyDocumentHost.web.tsx`'s TODO(WS2b) for the autosave code this
  // feeds, and `campaign/[id]/design.tsx`'s twin for the campaign side.
  const saveTiptapDoc = useCallback(
    (doc: JSONContent) => updateTemplate({ templateId, doc }),
    [updateTemplate, templateId],
  );

  const uploadImage = useDesignerImageUploader(canDesign);

  /**
   * Restyle the template. Same shape as the campaign designer's: the mutation
   * stamps the theme server-side onto the document AS STORED, so the theme
   * that actually landed is read back and handed to the composer, which folds
   * it into its local history — otherwise the next keystroke autosaves a
   * `history.present` still carrying the old theme, silently undoing the
   * restyle. This is also what makes a template's theme ROUND-TRIP: it lives
   * in `doc.theme` and nowhere else.
   */
  const applyTheme = useCallback(
    async (choice: ThemeChoice): Promise<EmailTheme | null> => {
      const result = await run(() => setTemplateTheme({ templateId, ...choice }), {
        errorTitle: "Couldn't apply that theme",
      });
      if (result === undefined) return null;
      const fresh = await convex.query(api.campaignTemplates.getTemplate, { templateId });
      return (fresh?.doc as EmailDocument | undefined)?.theme ?? null;
    },
    [run, setTemplateTheme, templateId, convex],
  );

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
      <Text className="mb-3 text-xs text-muted">
        Edits save as you type and change this template only — an email copies
        a template when it&apos;s created, so nothing already in flight moves.
      </Text>
      {/* TODO(WS2b): see `campaign/[id]/design.tsx`'s identical cast note —
          `template` has no `docFormat` field yet. */}
      {emailDocFormatOf(template as unknown as { docFormat?: string | null }) === "tiptap" ? (
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
          onApplyTheme={applyTheme}
          run={run}
          emptyMessage="Add a block above to start building this template."
          lockedEmptyMessage="This template has no blocks yet."
        />
      )}
    </Screen>
  );
}
