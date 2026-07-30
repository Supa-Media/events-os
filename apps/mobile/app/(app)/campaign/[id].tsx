import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Screen,
  Narrow,
  BackLink,
  Badge,
  Button,
  ToastView,
  EmptyState,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { CampaignMetaCard } from "../../../components/campaign/CampaignMetaCard";
import { CampaignStatusCard } from "../../../components/campaign/CampaignStatusCard";
import { CampaignRepliesSection } from "../../../components/campaign/CampaignRepliesSection";
import { CampaignPollResults } from "../../../components/campaign/CampaignPollResults";
import { campaignStatusLabel, campaignStatusTone } from "../../../components/campaign/helpers";

/**
 * CAMPAIGN DETAIL — metadata (eager-autosave), the send workflow (status
 * card), replies scoped to this campaign, and the door into the block
 * designer. Mirrors `template/[id].tsx`'s shape: a `Narrow` metadata column
 * with a prominent action into the heavier editor screen.
 *
 * `getCampaign` throws (`NOT_FOUND`) rather than returning null for a bad id
 * — same shape as `givingPlatform.getDonor`, which `giving/donor/[id].tsx`
 * doesn't special-case either — so there's no "not found" branch here; an
 * unreachable id surfaces as an unhandled query error the same way it does
 * on that screen.
 *
 * Gated the same way `campaigns/index.tsx` (and `giving/donors.tsx` before
 * it) gates its own screen: `myCampaignsAccess` is checked here, in the
 * OUTER component, before any campaign-scoped query ever fires — a
 * non-privileged caller deep-linking straight to `/campaign/<id>` must never
 * reach `getCampaign` (`FORBIDDEN`, thrown into the ErrorBoundary). The rest
 * of the screen's hooks/logic live in `CampaignDetailBody`, which only
 * mounts once access is confirmed.
 */
export default function CampaignDetailScreen() {
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
  return <CampaignDetailBody campaignId={campaignId} />;
}

function CampaignDetailBody({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const router = useRouter();

  const campaign = useQuery(api.campaigns.getCampaign, { campaignId });
  const audiences = useQuery(api.audiences.listAudiences, {});
  const updateMeta = useMutation(api.campaigns.updateCampaignMeta);
  const { run, toast, dismiss } = useActionRunner();

  // Every hook above (and the preview query below) runs unconditionally, on
  // every render — the loading guard comes AFTER, same rule `EditableGrid`
  // calls out: an early return ahead of a hook call flips hook order between
  // renders and React throws.
  const selectedAudience = audiences?.find((a) => a._id === campaign?.audienceId) ?? null;
  // BY ID, never a hand-assembled field list. This call site used to spread
  // `{ scope, source, filters, excludeFilters }` off the row — complete when
  // written, then silently wrong once hand-picks and targeting-v2 shipped, so
  // a 4-person hand-picked segment reported "Reaches 440 people" right above
  // "Request approval". See `audiences.ts#previewAudienceById`.
  const preview =
    useQuery(
      api.audiences.previewAudienceById,
      selectedAudience ? { audienceId: selectedAudience._id } : "skip",
    ) ?? undefined;

  if (campaign === undefined || audiences === undefined) return <Screen loading />;

  function saveMeta(patch: {
    name?: string;
    subject?: string;
    previewText?: string;
    audienceId?: Id<"audiences">;
    fromName?: string | null;
    fromEmail?: string | null;
  }) {
    return run(() => updateMeta({ campaignId, ...patch }), {
      errorTitle: "Couldn't save this email",
    });
  }

  return (
    <Screen>
      <Narrow>
        <ToastView toast={toast} onDismiss={dismiss} />

        {/* This screen used to open with an empty flex spacer and a single
            button: no title, no status, and no way back to the desk — the
            campaigns tabs belong to `campaigns/_layout` and disappear the
            moment you open one campaign, so a reader could not tell WHICH
            campaign this was or how to leave it except with the browser's
            own back button. */}
        <BackLink fallback="/campaigns" label="Emails" />
        <View className="mb-4 flex-row flex-wrap items-start justify-between gap-3">
          <View className="flex-1">
            <Text className="font-display text-2xl text-ink">{campaign.name}</Text>
            <View className="mt-1.5 flex-row flex-wrap items-center gap-2">
              <Badge
                label={campaignStatusLabel(campaign.status)}
                tone={campaignStatusTone(campaign.status)}
              />
              {campaign.subject ? (
                <Text className="text-sm text-muted" numberOfLines={1}>
                  {campaign.subject}
                </Text>
              ) : null}
            </View>
          </View>
          <Button
            title="Edit design"
            icon="edit-3"
            onPress={() => router.push(`/campaign/${campaignId}/design` as never)}
          />
        </View>

        <CampaignMetaCard
          campaign={campaign}
          audiences={audiences}
          preview={preview}
          onSave={saveMeta}
        />

        <CampaignStatusCard
          campaign={campaign}
          audienceName={selectedAudience?.name ?? null}
          audience={selectedAudience}
          preview={preview}
          run={run}
        />

        <CampaignPollResults
          campaignId={campaignId}
          status={campaign.status}
          doc={campaign.doc}
        />

        <CampaignRepliesSection campaignId={campaignId} />
      </Narrow>
    </Screen>
  );
}
