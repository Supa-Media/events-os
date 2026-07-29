/**
 * CAMPAIGN DESIGNER — the email editor for a CAMPAIGN, blocks OR tiptap.
 *
 * The editing surface itself is
 * `components/campaign/designer/DocumentComposer.tsx` — the FORMAT SWITCH
 * (docs/plans/maily-editor-overhaul.md, WS3) between the block canvas
 * (history, autosave, palette, block stack, live preview, merge tags, theme
 * picker) and the maily host (meta fields inline, the real editor on web,
 * read-only + meta on native) — shared with the template editor
 * (`app/(app)/campaign-template/[id].tsx`) so a designer meets exactly one
 * composer wherever she is. What stays HERE is what is genuinely the
 * campaign's: the access gate, the record header with "Save as template",
 * and what saving/restyling MEAN (`campaigns.updateCampaignDoc` /
 * `campaigns.setCampaignTheme` / `campaigns.updateCampaignMeta`).
 *
 * Read-only once the campaign leaves `draft`/`changes_requested`
 * (`updateCampaignDoc` throws `NOT_EDITABLE` server-side past that point —
 * see `campaigns.ts#assertEditable`), or for a caller without compose power
 * (see `editable` below). "Read-only" means it: the block cards (or the
 * maily host) render with no editing affordance, instead of the no-op
 * handlers that used to let a reviewer type into a locked campaign and lose
 * the words on reload.
 *
 * TODO(WS2b): `docFormat` is computed via `emailDocFormatOf(campaign)`, but
 * `campaigns.docFormat` isn't a schema column yet — every campaign here
 * resolves `"blocks"` in production until that lands. See
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
  Screen,
  FULL_WIDTH,
  Narrow,
  Button,
  EmptyState,
  ToastView,
} from "../../../../components/ui";
import { useActionRunner } from "../../../../lib/useActionToast";
import { DocumentComposer } from "../../../../components/campaign/designer/DocumentComposer";
import type { ThemeChoice } from "../../../../components/campaign/designer/CampaignThemePicker";
import { useDesignerImageUploader } from "../../../../components/campaign/designer/useImageUploader";
import { fromLineText } from "../../../../components/campaign/designer/mailyMetaText";
import { SaveAsTemplateAction } from "../../../../components/campaign/SaveAsTemplateAction";

/**
 * Gated the same way `campaigns/index.tsx` (and `giving/donors.tsx` before
 * it) gates its own screen: `myCampaignsAccess` is checked here, in the
 * OUTER component, before `CampaignDesignBody` ever mounts — a
 * non-privileged caller deep-linking straight to `/campaign/<id>/design`
 * must never reach `getCampaign`/`updateCampaignDoc` (`FORBIDDEN`, thrown
 * into the ErrorBoundary).
 */
export default function CampaignDesignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const campaignId = id as Id<"campaigns">;
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
  return <CampaignDesignBody campaignId={campaignId} canCompose={access.canCompose} />;
}

function CampaignDesignBody({
  campaignId,
  canCompose,
}: {
  campaignId: Id<"campaigns">;
  canCompose: boolean;
}) {
  const router = useRouter();

  const campaign = useQuery(api.campaigns.getCampaign, { campaignId });
  const updateDoc = useMutation(api.campaigns.updateCampaignDoc);
  const setTheme = useMutation(api.campaigns.setCampaignTheme);
  const updateMeta = useMutation(api.campaigns.updateCampaignMeta);
  // Only meaningful for the tiptap host's read-only "From" line — same query
  // `CampaignMetaCard.tsx` reads for its own From hint text.
  const senderDefaults = useQuery(api.campaigns.getSenderDefaults, {});
  // `storage.getUrl` / `getCampaign` are queries, not mutations — resolved on
  // demand via the imperative Convex client (`app/(app)/doc/[id].tsx`'s
  // precedent), not `useQuery` (which subscribes reactively, not what a
  // one-off read after a write needs).
  const convex = useConvex();
  const { run, toast, dismiss } = useActionRunner();

  // Editable in `draft` OR `changes_requested` (a reviewer sent it back —
  // `campaigns.ts#assertEditable` enforces the same pair server-side) AND
  // only for a caller who can compose: `updateCampaignDoc` /
  // `setCampaignTheme` both require `campaigns.compose`, so without this a
  // design-only holder typed into a live-looking composer whose every
  // autosave came back "Not saved — … requires email compose power."
  const editable =
    canCompose && (campaign?.status === "draft" || campaign?.status === "changes_requested");

  const saveDoc = useCallback(
    (doc: EmailDocument) => updateDoc({ campaignId, doc }),
    [updateDoc, campaignId],
  );

  // TODO(WS2b): `updateCampaignDoc` still validates the OLD blocks format —
  // this call is written CORRECTLY against the target contract (save a
  // tiptap JSON doc through the SAME mutation `saveDoc` above uses) and will
  // reject with `INVALID_DOC` until the backend lane dispatches by
  // `docFormat`. See `MailyDocumentHost.web.tsx`'s own TODO(WS2b) for the
  // autosave code this feeds.
  const saveTiptapDoc = useCallback(
    (doc: JSONContent) => updateDoc({ campaignId, doc }),
    [updateDoc, campaignId],
  );

  const uploadImage = useDesignerImageUploader(editable);

  /**
   * Restyle the campaign (`campaigns.setCampaignTheme`).
   *
   * The mutation applies the theme SERVER-side to the document as stored, so
   * the theme that actually landed is read back (rather than trusting a
   * locally-guessed one, which would drop the normalisation the server
   * applied) and handed to the composer, which folds it into its local
   * history — see `DocumentComposer`'s `onApplyTheme` for why that fold is
   * required.
   */
  const applyTheme = useCallback(
    async (choice: ThemeChoice): Promise<EmailTheme | null> => {
      const result = await run(() => setTheme({ campaignId, ...choice }), {
        errorTitle: "Couldn't apply that theme",
      });
      if (result === undefined) return null;
      const fresh = await convex.query(api.campaigns.getCampaign, { campaignId });
      return (fresh?.doc as EmailDocument | undefined)?.theme ?? null;
    },
    [run, setTheme, campaignId, convex],
  );

  if (campaign === undefined) return <Screen loading />;

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <ToastView toast={toast} onDismiss={dismiss} />
      <View className="mb-3 flex-row flex-wrap items-start justify-between gap-3">
        <Text className="font-display text-lg text-ink" numberOfLines={1}>
          {campaign.name}
        </Text>
        <View className="flex-row items-start gap-2">
          <SaveAsTemplateAction
            campaignId={campaignId}
            campaignName={campaign.name}
            run={run}
          />
          {/* `back()`, not `push()`: the composer is always opened FROM the
              record, so pushing a second copy of it grew the stack by one
              screen every round trip (design → record → design → record …)
              and left "back" walking through a corridor of duplicates.
              `replace` is the deep-link fallback, matching `ui/BackLink`. */}
          <Button
            title="Done"
            variant="secondary"
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace(`/campaign/${campaignId}` as never);
            }}
          />
        </View>
      </View>
      {/* TODO(WS2b): `campaign` has no `docFormat` field yet (not a schema
          column) — the cast is a "weak type" workaround (TS2559: the row and
          `{docFormat?}` share zero properties today) that resolves to
          `"blocks"` for every real row until the column lands. */}
      {emailDocFormatOf(campaign as unknown as { docFormat?: string | null }) === "tiptap" ? (
        <DocumentComposer
          docFormat="tiptap"
          campaignId={campaignId}
          doc={campaign.doc as JSONContent}
          editable={editable}
          lockedNotice={lockNote(campaign.status, canCompose)}
          onSave={saveTiptapDoc}
          run={run}
          uploadImage={uploadImage}
          meta={{
            subject: campaign.subject ?? "",
            previewText: campaign.previewText ?? "",
            fromLine: fromLineText({
              fromName: campaign.fromName,
              fromEmail: campaign.fromEmail,
              orgFromAddress: senderDefaults?.orgFromAddress,
            }),
            onSaveSubject: (subject) =>
              run(() => updateMeta({ campaignId, subject }), {
                errorTitle: "Couldn't save the subject line",
              }),
            onSavePreviewText: (previewText) =>
              run(() => updateMeta({ campaignId, previewText }), {
                errorTitle: "Couldn't save the preview text",
              }),
          }}
        />
      ) : (
        <DocumentComposer
          docFormat="blocks"
          doc={campaign.doc as EmailDocument}
          editable={editable}
          lockedNotice={lockNote(campaign.status, canCompose)}
          onSave={saveDoc}
          onApplyTheme={applyTheme}
          run={run}
        />
      )}
    </Screen>
  );
}

/**
 * Why the composer is locked, in one line above the block stack.
 *
 * The STATUS reasons come first because they're the ones that change: a
 * campaign someone else already submitted is locked for everybody, and
 * saying "you'd need compose power" about it would be answering a question
 * nobody asked. The missing-power line is only reachable on a campaign that
 * would otherwise be editable — a design-only holder reading a draft — and it
 * points at what she DOES own rather than only at what she doesn't.
 */
function lockNote(status: string | undefined, canCompose: boolean): string {
  if (status === "pending_approval") {
    return "Awaiting approval — the design is locked until a reviewer decides.";
  }
  if (status === "draft" || status === "changes_requested") {
    return canCompose
      ? "The design is locked."
      : "Read-only — editing an email takes compose power. Themes, templates and the image library are yours to change.";
  }
  return "This email has been sent (or is on its way) — the design is locked.";
}
