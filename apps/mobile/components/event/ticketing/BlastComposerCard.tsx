/**
 * Blasts — compose an announcement to an audience segment and review past
 * sends. Email delivers today; SMS is visible-but-disabled until Twilio is
 * connected (the backend refuses `channel: "sms"` with SMS_NOT_CONNECTED).
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Card, Field, Pill, TextField, type BadgeTone } from "../../ui";
import { formatDateTime } from "../../../lib/format";
import type { ActionRunner } from "../../../lib/useActionToast";
import { confirmAction } from "./helpers";

type Audience = "everyone" | "going" | "maybe" | "ticket_holders";

const AUDIENCES: Array<{ value: Audience; label: string }> = [
  { value: "everyone", label: "Everyone" },
  { value: "going", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "ticket_holders", label: "Ticket holders" },
];

const STATUS_TONE: Record<string, BadgeTone> = {
  sent: "success",
  sending: "warn",
  failed: "danger",
};

/** Display label for an audience value, falling back to the raw value. */
function audienceLabelFor(value: string): string {
  return AUDIENCES.find((a) => a.value === value)?.label ?? value;
}

export function BlastComposerCard({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const blasts = useQuery(api.blasts.listBlasts, { eventId });
  const sendBlast = useMutation(api.blasts.sendBlast);

  const [audience, setAudience] = useState<Audience>("everyone");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  function handleSend() {
    if (!body.trim()) return;
    confirmAction({
      title: "Send blast?",
      message: `This emails "${audienceLabelFor(audience)}" right away.`,
      confirmLabel: "Send",
      onConfirm: () => {
        setSending(true);
        void run(
          () =>
            sendBlast({
              eventId,
              channel: "email",
              subject: subject.trim() || undefined,
              body: body.trim(),
              audience,
            }),
          { errorTitle: "Couldn't send blast" },
        ).then((res) => {
          setSending(false);
          if (res !== undefined) {
            setSubject("");
            setBody("");
          }
        });
      },
    });
  }

  return (
    <Card>
      <Field label="Audience">
        <View className="flex-row flex-wrap gap-2">
          {AUDIENCES.map((a) => (
            <Pill
              key={a.value}
              label={a.label}
              selected={audience === a.value}
              onPress={() => setAudience(a.value)}
            />
          ))}
        </View>
      </Field>

      <Field label="Channel">
        <View className="flex-row items-center gap-2">
          <Pill label="Email" selected onPress={() => {}} />
          {/* SMS ships once Twilio is connected — static (disabled) chip. */}
          <Pill label="SMS" />
          <Text className="text-xs text-faint">Twilio soon</Text>
        </View>
      </Field>

      <TextField
        label="Subject"
        value={subject}
        onChangeText={setSubject}
        placeholder="An update on the event (optional)"
      />
      <TextField
        label="Message"
        value={body}
        onChangeText={setBody}
        placeholder="What do your guests need to know?"
        multiline
        numberOfLines={5}
        style={{ minHeight: 110, textAlignVertical: "top" }}
      />
      <View className="flex-row justify-end">
        <Button
          title="Send blast"
          icon="send"
          loading={sending}
          disabled={body.trim() === ""}
          onPress={handleSend}
        />
      </View>

      {/* History */}
      {blasts && blasts.length > 0 ? (
        <View className="mt-4 border-t border-border pt-3">
          <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-muted">
            Sent blasts
          </Text>
          {blasts.map((b) => (
            <View key={b._id} className="flex-row items-center gap-3 py-2.5">
              <View className="flex-1">
                <Text className="text-base font-medium text-ink" numberOfLines={1}>
                  {b.subject || b.body.split("\n")[0]}
                </Text>
                <Text className="text-xs text-muted">
                  {audienceLabelFor(b.audience)}
                  {b.recipientCount != null
                    ? ` · ${b.recipientCount} recipient${b.recipientCount === 1 ? "" : "s"}`
                    : ""}
                  {b.sentAt != null ? ` · ${formatDateTime(b.sentAt)}` : ""}
                </Text>
              </View>
              <Badge label={b.status} tone={STATUS_TONE[b.status] ?? "neutral"} />
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
