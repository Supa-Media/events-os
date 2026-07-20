import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Screen, Narrow, Button, ToastView } from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { CampaignMetaCard } from "../../../components/campaign/CampaignMetaCard";
import { CampaignStatusCard } from "../../../components/campaign/CampaignStatusCard";
import { CampaignRepliesSection } from "../../../components/campaign/CampaignRepliesSection";

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
 */
export default function CampaignDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const campaignId = id as Id<"campaigns">;

  const campaign = useQuery(api.campaigns.getCampaign, { campaignId });
  const audiences = useQuery(api.audiences.listAudiences, {});
  const updateMeta = useMutation(api.campaigns.updateCampaignMeta);
  const { run, toast, dismiss } = useActionRunner();

  // Every hook above (and the preview query below) runs unconditionally, on
  // every render — the loading guard comes AFTER, same rule `EditableGrid`
  // calls out: an early return ahead of a hook call flips hook order between
  // renders and React throws.
  const selectedAudience = audiences?.find((a) => a._id === campaign?.audienceId) ?? null;
  const preview = useQuery(
    api.audiences.previewAudience,
    selectedAudience
      ? { scope: selectedAudience.scope, source: selectedAudience.source, filters: selectedAudience.filters }
      : "skip",
  );

  if (campaign === undefined || audiences === undefined) return <Screen loading />;

  function saveMeta(patch: {
    name?: string;
    subject?: string;
    previewText?: string;
    audienceId?: Id<"audiences">;
  }) {
    return run(() => updateMeta({ campaignId, ...patch }), {
      errorTitle: "Couldn't save campaign",
    });
  }

  return (
    <Screen>
      <Narrow>
        <ToastView toast={toast} onDismiss={dismiss} />

        <View className="mb-4 flex-row items-center justify-between gap-3">
          <View className="flex-1" />
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
          preview={preview}
          run={run}
        />

        <CampaignRepliesSection campaignId={campaignId} />
      </Narrow>
    </Screen>
  );
}
