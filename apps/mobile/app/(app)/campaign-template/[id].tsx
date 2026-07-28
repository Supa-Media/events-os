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
 * A template IS an `EmailDocument` — the same blocks, the same theme, the same
 * write gate (`validateEmailDocument`). Editing one is editing an email, so it
 * is the same `DocumentComposer`: same undo/redo, same 600ms debounced
 * autosave, same live preview, same block palette, same rejection copy
 * (`explainDocError`). Only what SAVING means differs —
 * `campaignTemplates.updateTemplate({ templateId, doc })` here, where the
 * campaign designer calls `campaigns.updateCampaignDoc`.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * `myCampaignsAccess.canView` opens the screen (a composer needs to READ the
 * template she's about to start from), `canDesign` is what makes it editable —
 * `updateTemplate`/`setTemplateTheme` both require `campaigns.design`
 * server-side, and rendering a live-looking composer whose every autosave
 * comes back FORBIDDEN is the exact failure the campaign designer's own
 * `canCompose` check exists to avoid.
 */
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { EmailDocument, EmailTheme } from "@events-os/shared";
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

export default function CampaignTemplateDesignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const templateId = id as Id<"campaignTemplates">;
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
  templateId: Id<"campaignTemplates">;
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
        Edits save as you type and change this template only — a campaign copies
        a template when it&apos;s created, so nothing already in flight moves.
      </Text>
      <DocumentComposer
        doc={template.doc as EmailDocument}
        editable={canDesign}
        lockedNotice="Read-only — editing templates takes campaign design power."
        onSave={saveDoc}
        onApplyTheme={applyTheme}
        run={run}
        emptyMessage="Add a block above to start building this template."
        lockedEmptyMessage="This template has no blocks yet."
      />
    </Screen>
  );
}
