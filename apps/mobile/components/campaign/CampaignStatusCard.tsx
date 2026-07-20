/**
 * Campaign status card — the send workflow. Renders differently per
 * `campaign.status`:
 *   draft   → Send button (confirm summarizes reach + exclusions) + a
 *             test-send row (send the current design to one address first).
 *   sending → live progress from the campaign's own counts.
 *   sent    → results (sent / failed / suppressed) + reply count.
 *   failed  → results + whatever error the send action left behind.
 */
import { useState } from "react";
import { View, Text } from "react-native";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { Card, Button, Badge, TextField, ProgressBar, Field } from "../ui";
import { campaignStatusLabel, campaignStatusTone, confirmAction, pluralCount, pluralReply } from "./helpers";
import type { ActionRunner } from "../../lib/useActionToast";

type Campaign = NonNullable<FunctionReturnType<typeof api.campaigns.getCampaign>>;
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;

export function CampaignStatusCard({
  campaign,
  audienceName,
  preview,
  run,
}: {
  campaign: Campaign;
  audienceName: string | null;
  preview: PreviewResult | undefined;
  run: ActionRunner["run"];
}) {
  if (campaign.status === "sending") {
    const sentCount = campaign.sentCount ?? 0;
    const recipientCount = campaign.recipientCount ?? 0;
    const fraction = recipientCount > 0 ? sentCount / recipientCount : 0;
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        <View className="mt-2">
          <ProgressBar fraction={fraction} />
          <Text className="mt-2 text-sm text-muted">
            {pluralCount(sentCount, "sent")} of {pluralCount(recipientCount, "recipient")}
          </Text>
        </View>
      </Card>
    );
  }

  if (campaign.status === "sent" || campaign.status === "failed") {
    const sentCount = campaign.sentCount ?? 0;
    const failedCount = campaign.failedCount ?? 0;
    const suppressedCount = campaign.suppressedCount ?? 0;
    const replyCount = campaign.replyCount ?? 0;
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        <View className="mt-2 gap-1">
          <Text className="text-sm text-ink">
            {pluralCount(sentCount, "sent")}
            {failedCount > 0 ? ` · ${pluralCount(failedCount, "failed")}` : ""}
            {suppressedCount > 0 ? ` · ${pluralCount(suppressedCount, "suppressed")}` : ""}
          </Text>
          {replyCount > 0 ? (
            <Text className="text-sm text-muted">{pluralReply(replyCount)} so far</Text>
          ) : null}
          {campaign.status === "failed" ? (
            <Text className="mt-1 text-sm text-danger">
              {campaign.error ?? "The send didn't complete. Check the campaign's audience and design, then try again."}
            </Text>
          ) : null}
        </View>
        {campaign.status === "failed" ? (
          // The backend explicitly allows `send()` for status "failed" (same
          // gate as "draft" — `campaigns.ts#send`), so retrying reuses the
          // exact same confirm/send flow `DraftSendRow` already has, just
          // relabeled so it reads as a retry rather than a first send.
          <View className="mt-3 border-t border-border pt-3">
            <DraftSendRow
              campaign={campaign}
              audienceName={audienceName}
              preview={preview}
              run={run}
              retry
            />
          </View>
        ) : null}
      </Card>
    );
  }

  // draft
  return (
    <Card className="mb-4">
      <StatusHeader status={campaign.status} />
      <DraftSendRow campaign={campaign} audienceName={audienceName} preview={preview} run={run} />
      <TestSendRow campaign={campaign} run={run} />
    </Card>
  );
}

function StatusHeader({ status }: { status: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-xs font-bold uppercase tracking-wider text-faint">Status</Text>
      <Badge label={campaignStatusLabel(status)} tone={campaignStatusTone(status)} />
    </View>
  );
}

function DraftSendRow({
  campaign,
  audienceName,
  preview,
  run,
  retry = false,
}: {
  campaign: Campaign;
  audienceName: string | null;
  preview: PreviewResult | undefined;
  run: ActionRunner["run"];
  /** Rendered for a "failed" campaign instead of a "draft" one — same
   *  underlying `send()` call (the backend allows both statuses), just
   *  relabeled so it reads as a retry rather than a first send. */
  retry?: boolean;
}) {
  const send = useMutation(api.campaigns.send);
  const [sending, setSending] = useState(false);
  const hasAudience = campaign.audienceId != null;
  const hasContent = campaign.doc.blocks.length > 0;
  const hasSubject = (campaign.subject ?? "").trim().length > 0;
  const canSend = hasAudience && hasContent && hasSubject && preview !== undefined;

  function handleSend() {
    if (!canSend || !preview) return;
    const excludedBits: string[] = [];
    if (preview.excludedSuppressed > 0) {
      excludedBits.push(`${preview.excludedSuppressed} suppressed`);
    }
    if (preview.excludedUnverified > 0) {
      excludedBits.push(`${preview.excludedUnverified} unverified`);
    }
    const excludedNote = excludedBits.length > 0 ? ` (${excludedBits.join(", ")} excluded)` : "";
    confirmAction({
      title: retry ? "Retry sending this campaign?" : "Send campaign?",
      message: `Sends to ${preview.count} ${preview.count === 1 ? "person" : "people"}${excludedNote}. This can't be undone.`,
      confirmLabel: retry ? "Retry send" : "Send",
      onConfirm: () => {
        setSending(true);
        void run(() => send({ campaignId: campaign._id }), {
          errorTitle: retry ? "Couldn't retry the send" : "Couldn't send campaign",
        }).finally(() => setSending(false));
      },
    });
  }

  return (
    <View className={retry ? "gap-2" : "mt-3 gap-2"}>
      <Text className="text-sm text-muted">
        {audienceName ? `Audience: ${audienceName}` : "Pick an audience above before sending."}
      </Text>
      {!hasSubject ? (
        <Text className="text-xs text-warn">Add a subject line before sending.</Text>
      ) : null}
      {!hasContent ? (
        <Text className="text-xs text-warn">The design is empty — add at least one block.</Text>
      ) : null}
      <View className="flex-row justify-end">
        <Button
          title={retry ? "Retry send" : "Send campaign"}
          icon="send"
          onPress={handleSend}
          loading={sending}
          disabled={!canSend}
        />
      </View>
    </View>
  );
}

function TestSendRow({ campaign, run }: { campaign: Campaign; run: ActionRunner["run"] }) {
  // `sendTest` is a Convex `action` (it calls out to Resend), not a mutation —
  // `useAction`, not `useMutation`.
  const sendTest = useAction(api.campaigns.sendTest);
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSendTest() {
    const trimmed = to.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const result = await run(() => sendTest({ campaignId: campaign._id, to: trimmed }), {
        errorTitle: "Couldn't send test",
      });
      if (result !== undefined) setTo("");
    } finally {
      setSending(false);
    }
  }

  return (
    <View className="mt-4 border-t border-border pt-3">
      <Field label="Send a test" hint="Preview the current design in your own inbox before sending for real.">
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <TextField
              value={to}
              onChangeText={setTo}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              onSubmitEditing={handleSendTest}
            />
          </View>
          <Button title="Send test" variant="secondary" onPress={handleSendTest} loading={sending} disabled={!to.trim()} />
        </View>
      </Field>
    </View>
  );
}
