/**
 * REPLIES — org-wide inbox of replies to sent campaigns (`api.campaigns.getReplies`
 * with no `campaignId`, i.e. every campaign). Tapping a reply marks it read
 * (`api.campaigns.markReplyRead`) and jumps to the campaign it replied to
 * (when it matched one — `emailReplies.campaignId` is optional; a stray
 * inbound message that didn't match any campaign's reply-to address still
 * gets a row, per the schema doc, so it stays on this screen instead).
 *
 * Replying only works once inbound email is wired to a domain the org
 * controls — until then this stays an honest empty state rather than a
 * confusing always-empty inbox.
 *
 */
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { EmptyState } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { ReplyRow } from "./ReplyRow";
import type { EmailReply } from "./replyTypes";

type Campaign = FunctionReturnType<typeof api.campaigns.listCampaigns>[number];

export function RepliesView() {
  const replies: EmailReply[] | undefined = useQuery(api.campaigns.getReplies, {});
  const campaigns = useQuery(api.campaigns.listCampaigns, {});
  const markRead = useMutation(api.campaigns.markReplyRead);
  const router = useRouter();
  const [openedId, setOpenedId] = useState<string | null>(null);

  if (replies === undefined) {
    return (
      <View style={{ paddingVertical: spacing.lg }}>
        <Text className="text-sm text-faint">Loading replies…</Text>
      </View>
    );
  }

  if (replies.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="No replies yet"
        message="Replies show up here once a recipient responds to a sent campaign. This needs an inbound email domain connected for the org — ask a super admin to set that up in Profile → Integrations if replies aren't arriving."
      />
    );
  }

  function campaignName(campaignId: string | undefined): string | null {
    if (!campaignId) return null;
    return (campaigns as Campaign[] | undefined)?.find((c) => c._id === campaignId)?.name ?? null;
  }

  function open(reply: EmailReply) {
    setOpenedId(reply._id);
    if (!reply.read) void markRead({ replyId: reply._id });
    if (reply.campaignId) router.push(`/campaign/${reply.campaignId}` as never);
  }

  return (
    <View style={styles.list}>
      {replies.map((r) => {
        const unread = !r.read && openedId !== r._id;
        const matchedCampaign = campaignName(r.campaignId);
        return (
          <ReplyRow
            key={r._id}
            reply={r}
            unread={unread}
            onPress={() => open(r)}
            className="rounded-lg border border-border bg-raised px-4 py-3 active:bg-sunken web:hover:bg-sunken"
          >
            <Text style={[styles.subject, unread ? styles.unreadText : null]} numberOfLines={1}>
              {r.subject || "(no subject)"}
            </Text>
            <Text style={styles.snippet} numberOfLines={2}>
              {r.textBody || ""}
            </Text>
            <Text style={styles.campaign} numberOfLines={1}>
              {matchedCampaign ? `Re: ${matchedCampaign}` : "Didn't match a campaign"}
            </Text>
          </ReplyRow>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  unreadText: { fontWeight: "700", color: colors.ink },
  subject: { fontSize: 14, color: colors.text, marginTop: 2 },
  snippet: { fontSize: 13, color: colors.muted, marginTop: 2 },
  campaign: { fontSize: 12, color: colors.faint, marginTop: spacing.xs },
});
