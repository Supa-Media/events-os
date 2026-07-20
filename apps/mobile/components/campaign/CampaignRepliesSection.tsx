/**
 * Replies to THIS campaign — a compact version of `RepliesView`, scoped via
 * `api.campaigns.getReplies({ campaignId })`. Hidden entirely once there are
 * no replies (a campaign detail page is busy enough without an empty inbox
 * section — the org-wide Replies tab is where "no replies yet" gets
 * explained).
 *
 * Backed by `campaigns.getReplies({ campaignId })` and `campaigns.markReplyRead`.
 */
import { View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";
import { formatDateTime } from "../../lib/format";
import type { EmailReply } from "./replyTypes";

export function CampaignRepliesSection({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const replies: EmailReply[] | undefined = useQuery(
    api.campaigns.getReplies,
    { campaignId },
  );
  const markRead = useMutation(api.campaigns.markReplyRead);

  if (!replies || replies.length === 0) return null;

  return (
    <View className="mt-2">
      <SectionHeader title="Replies" />
      <Card>
        <View className="gap-3">
          {replies.map((r, i) => (
            <Pressable
              key={r._id}
              onPress={() => {
                if (!r.read) void markRead({ replyId: r._id });
              }}
              className={`pb-3 ${i === replies.length - 1 ? "" : "border-b border-border"}`}
            >
              <View className="flex-row items-center gap-2">
                {!r.read ? (
                  <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.accent }} />
                ) : null}
                <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
                  {r.fromName || r.fromEmail}
                </Text>
                <Text className="text-xs text-muted">{formatDateTime(r.receivedAt)}</Text>
              </View>
              <Text className="mt-1 text-sm text-muted" numberOfLines={2}>
                {r.textBody || r.subject || "(no content)"}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>
    </View>
  );
}
