/**
 * One reply row's shared chrome — the unread dot, from name-or-email,
 * `formatDateTime` timestamp, and mark-read-on-press wiring. Factored out of
 * `RepliesView` (the org-wide inbox) and `CampaignRepliesSection` (one
 * campaign's replies scoped section), which duplicated this exactly.
 *
 * Each surface keeps its OWN wrapper layout: the outer border/spacing via
 * `className` (a rounded card for `RepliesView`, a bottom-divider list item
 * for `CampaignRepliesSection`), and its own body content below the header
 * row — a subject line + snippet + matched-campaign line for `RepliesView`,
 * just a merged snippet line for `CampaignRepliesSection` — via `children`.
 * `onPress` is supplied by the caller too, since what happens on press
 * differs (`RepliesView` also navigates to the matched campaign).
 */
import type { ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { colors } from "../../lib/theme";
import { formatDateTime } from "../../lib/format";
import type { EmailReply } from "./replyTypes";

export function ReplyRow({
  reply,
  unread,
  onPress,
  className,
  children,
}: {
  reply: EmailReply;
  unread: boolean;
  onPress: () => void;
  className?: string;
  /** The surface-specific body rendered below the header row. */
  children: ReactNode;
}) {
  return (
    <Pressable onPress={onPress} className={className}>
      <View className="flex-row items-center gap-2">
        {unread ? (
          <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.accent }} />
        ) : (
          <View className="h-2 w-2" />
        )}
        <Text
          className={`flex-1 text-sm text-ink ${unread ? "font-bold" : "font-semibold"}`}
          numberOfLines={1}
        >
          {reply.fromName || reply.fromEmail}
        </Text>
        <Text className="text-xs text-muted">{formatDateTime(reply.receivedAt)}</Text>
      </View>
      {children}
    </Pressable>
  );
}
