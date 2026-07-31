/**
 * The comms card's Send affordance — next to the Copy button (`ItemCardText`'s
 * `CopyEditor`), one tap sends the row's ALREADY-SAVED copy to a picked
 * Google Chat channel via `commsSend.sendCommsToGoogleChat`. On success the
 * row's status flips to "Sent" server-side; this button just reflects the
 * outcome (`item.fields?.lastGoogleChatSend`), it never sets status itself.
 */
import { useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "../../ui/Icon";
import { Popover } from "../../ui/Popover";
import type { AnchorRect } from "../../ui/useAnchor";
import { measureAnchor } from "../../ui/ContextMenu";
import { colors } from "../../../lib/theme";
import { errorMessage } from "../../../lib/errors";
import type { ScheduleItem } from "./config";

export function SendToGoogleChatButton({
  item,
  message,
}: {
  item: ScheduleItem;
  message: string;
}) {
  const ref = useRef<any>(null);
  const [anchor, setAnchor] = useState<AnchorRect | undefined>();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channels = useQuery(api.googleChatChannels.listGoogleChatChannels, {});
  const send = useMutation(api.commsSend.sendCommsToGoogleChat);

  if (!message.trim()) return null;

  const lastSend = (item.fields as Record<string, any> | undefined)
    ?.lastGoogleChatSend as
    | { channelName: string; status: "sent" | "failed"; error?: string }
    | undefined;

  async function handlePick(channelId: Id<"googleChatChannels">) {
    setOpen(false);
    setError(null);
    setSending(true);
    try {
      await send({ itemId: item._id, channelId, message });
    } catch (e) {
      setError(errorMessage(e, "Couldn't send to Google Chat."));
    } finally {
      setSending(false);
    }
  }

  return (
    <View>
      <Pressable
        ref={ref}
        onPress={() => {
          setError(null);
          measureAnchor(ref.current, (a) => {
            setAnchor(a);
            setOpen(true);
          });
        }}
        disabled={sending}
        hitSlop={6}
        className="ml-1.5 flex-row items-center gap-1 active:opacity-70"
      >
        <Icon
          name="send"
          size={11}
          color={sending ? colors.faint : colors.accent}
        />
        <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
          {sending ? "Sending…" : "Send"}
        </Text>
      </Pressable>

      {error ? (
        <Text className="mt-1 text-2xs text-danger">{error}</Text>
      ) : lastSend ? (
        <Text
          className={`mt-1 text-2xs ${lastSend.status === "sent" ? "text-success" : "text-danger"}`}
        >
          {lastSend.status === "sent"
            ? `Sent to ${lastSend.channelName}`
            : `Couldn't send to ${lastSend.channelName}${lastSend.error ? `: ${lastSend.error}` : ""}`}
        </Text>
      ) : null}

      <Popover visible={open} onClose={() => setOpen(false)} anchor={anchor} width={220}>
        <View className="py-1">
          {channels === undefined ? (
            <Text className="px-3 py-2 text-xs text-muted">Loading…</Text>
          ) : channels.length === 0 ? (
            <Text className="px-3 py-2 text-xs text-muted">
              No Google Chat channels configured — a superuser can add one in
              Profile → Integrations.
            </Text>
          ) : (
            channels.map((c) => (
              <Pressable
                key={c._id}
                onPress={() => void handlePick(c._id)}
                className="flex-row items-center gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name="message-circle" size={13} color={colors.muted} />
                <Text className="text-sm text-ink">{c.name}</Text>
              </Pressable>
            ))
          )}
        </View>
      </Popover>
    </View>
  );
}
