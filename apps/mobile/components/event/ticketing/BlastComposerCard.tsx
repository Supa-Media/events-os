/**
 * Blasts — compose an announcement to an audience segment and review past
 * sends. Email and SMS both deliver (Attendance F). The SMS channel enables
 * only when Twilio is connected (previewBlastAudience.smsConfigured); when it
 * isn't, the chip stays selectable but the composer shows a hint pointing at
 * Profile → Integrations. Each channel shows its own live recipient count.
 *
 * The SMS channel also previews a cost estimate (`estimatedSegments` ×
 * `estimatedCostUsdMicros`, from `@events-os/shared`'s segment estimator —
 * see `blasts.ts#previewBlastAudience` + docs/plans/sms-comms.md) and how
 * many numbers in the audience have opted out (`smsOptedOut`) and will be
 * silently skipped. The draft body is debounced before it drives the query
 * so fast typing doesn't fire a preview on every keystroke.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatUsdMicros } from "@events-os/shared";
import { Badge, Button, Card, Field, Pill, TextField, type BadgeTone } from "../../ui";
import { formatDateTime } from "../../../lib/format";
import type { ActionRunner } from "../../../lib/useActionToast";
import { confirmAction } from "./helpers";

/** How long to wait after the last keystroke before the draft body drives the
 *  cost preview query — keeps `previewBlastAudience` from re-running on
 *  every character. */
const BODY_DEBOUNCE_MS = 400;

type Audience = "everyone" | "going" | "maybe" | "ticket_holders";
type Channel = "email" | "sms";

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
  const [channel, setChannel] = useState<Channel>("email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  // Debounce the draft body before it drives the cost-preview query.
  const [debouncedBody, setDebouncedBody] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedBody(body), BODY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [body]);

  const preview = useQuery(api.blasts.previewBlastAudience, {
    eventId,
    audience,
    body: channel === "sms" && debouncedBody.trim() ? debouncedBody : undefined,
  });
  const smsConfigured = preview?.smsConfigured ?? false;
  const recipientCount =
    preview === undefined
      ? null
      : channel === "sms"
        ? preview.smsRecipients
        : preview.emailRecipients;
  const smsBlocked = channel === "sms" && !smsConfigured;

  function handleSend() {
    if (!body.trim() || smsBlocked) return;
    const verb = channel === "sms" ? "texts" : "emails";
    confirmAction({
      title: "Send blast?",
      message: `This ${verb} "${audienceLabelFor(audience)}" right away.`,
      confirmLabel: "Send",
      onConfirm: () => {
        setSending(true);
        void run(
          () =>
            sendBlast({
              eventId,
              channel,
              subject:
                channel === "email" ? subject.trim() || undefined : undefined,
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
          <Pill
            label="Email"
            selected={channel === "email"}
            onPress={() => setChannel("email")}
          />
          <Pill
            label="SMS"
            selected={channel === "sms"}
            onPress={() => setChannel("sms")}
          />
          {recipientCount !== null ? (
            <Text className="text-xs text-muted">
              {recipientCount} recipient{recipientCount === 1 ? "" : "s"}
            </Text>
          ) : null}
        </View>
      </Field>

      {smsBlocked ? (
        <Text className="mb-2 text-xs text-danger">
          Twilio isn’t connected — a super admin can set it up in Profile →
          Integrations.
        </Text>
      ) : null}

      {channel === "email" ? (
        <TextField
          label="Subject"
          value={subject}
          onChangeText={setSubject}
          placeholder="An update on the event (optional)"
        />
      ) : null}
      <TextField
        label="Message"
        value={body}
        onChangeText={setBody}
        placeholder="What do your guests need to know?"
        multiline
        numberOfLines={5}
        style={{ minHeight: 110, textAlignVertical: "top" }}
      />
      {channel === "sms" ? (
        <>
          <Text className="mb-1 text-xs text-muted">
            A “Reply STOP to opt out” line is appended automatically.
          </Text>
          {preview && preview.estimatedSegments > 0 ? (
            <Text className="mb-1 text-xs text-muted">
              {preview.smsRecipients} people · ~{preview.estimatedSegments}{" "}
              segment{preview.estimatedSegments === 1 ? "" : "s"} each · est.{" "}
              {formatUsdMicros(preview.estimatedCostUsdMicros)} org cost
            </Text>
          ) : null}
          {preview && preview.smsOptedOut > 0 ? (
            <Text className="mb-2 text-xs text-muted">
              {preview.smsOptedOut} opted out and will be skipped.
            </Text>
          ) : null}
        </>
      ) : null}
      <View className="flex-row justify-end">
        <Button
          title="Send blast"
          icon="send"
          loading={sending}
          disabled={body.trim() === "" || smsBlocked}
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
