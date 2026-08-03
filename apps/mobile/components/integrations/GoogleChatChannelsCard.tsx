/**
 * Google Chat channels — superuser-managed list of named spaces (each backed
 * by an Incoming Webhook URL) behind the Comms Schedule's in-app "Send"
 * button (`SendToGoogleChatButton.tsx`). Mounted in `integrations.tsx`
 * alongside the Twilio/Resend cards, but its own component file (unlike
 * those single-row settings cards) since it manages a LIST — mirrors
 * `TwilioUsageSummary.tsx`'s precedent for a standalone integrations
 * sub-component.
 *
 * The webhook URL is WRITE-ONLY, same discipline as every other secret on
 * this screen: `getGoogleChatChannelsStatus` never returns it, only a short
 * `urlSuffix` hint, and "Replace webhook" never prefills the field.
 */
import { useState } from "react";
import { View, Text } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, TextField, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";

type ChannelStatus = {
  _id: Id<"googleChatChannels">;
  name: string;
  urlSuffix: string;
  archived: boolean;
  updatedAt: number;
};

export function GoogleChatChannelsCard({ superuser }: { superuser: boolean }) {
  const status = useQuery(
    api.googleChatChannels.getGoogleChatChannelsStatus,
    superuser ? {} : "skip",
  );

  if (!superuser) return null;

  return (
    <Card padding="lg" className="mt-4">
      <View className="mb-3 flex-row items-center gap-2">
        <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
          <Icon name="message-circle" size={14} color="#1F5A41" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">Google Chat</Text>
          <Text className="text-xs text-muted">
            Named spaces the Comms Schedule can send to, one Incoming Webhook
            each.
          </Text>
        </View>
      </View>

      {status === undefined ? (
        <Text className="text-xs text-muted">Loading channels…</Text>
      ) : (
        <View className="gap-3">
          {status.map((channel) => (
            <ChannelRow key={channel._id} channel={channel} />
          ))}
          {status.length === 0 ? (
            <Text className="text-sm text-muted">No channels yet.</Text>
          ) : null}
        </View>
      )}

      <AddChannelForm />
    </Card>
  );
}

function ChannelRow({ channel }: { channel: ChannelStatus }) {
  const rename = useMutation(api.googleChatChannels.renameGoogleChatChannel);
  const updateWebhook = useMutation(
    api.googleChatChannels.updateGoogleChatChannelWebhook,
  );
  const archive = useMutation(api.googleChatChannels.archiveGoogleChatChannel);

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(channel.name);
  const [replacingWebhook, setReplacingWebhook] = useState(false);
  const [webhookDraft, setWebhookDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRename() {
    const next = nameDraft.trim();
    if (!next || next === channel.name) {
      setRenaming(false);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await rename({ channelId: channel._id, name: next });
      setRenaming(false);
    } catch (e) {
      setError(errorMessage(e, "Couldn't rename the channel."));
    } finally {
      setBusy(false);
    }
  }

  async function handleReplaceWebhook() {
    const next = webhookDraft.trim();
    if (!next) return;
    setError(null);
    setBusy(true);
    try {
      await updateWebhook({ channelId: channel._id, webhookUrl: next });
      setWebhookDraft("");
      setReplacingWebhook(false);
    } catch (e) {
      setError(errorMessage(e, "Couldn't replace the webhook."));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleArchive() {
    setError(null);
    setBusy(true);
    try {
      await archive({ channelId: channel._id, archived: !channel.archived });
    } catch (e) {
      setError(errorMessage(e, "Couldn't update the channel."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="rounded-md border border-border p-3">
      {renaming ? (
        <View className="mb-2 flex-row items-center gap-2">
          <View className="flex-1">
            <TextField
              value={nameDraft}
              onChangeText={setNameDraft}
              autoCapitalize="none"
              editable={!busy}
            />
          </View>
          <Button title="Save" size="sm" onPress={() => void handleRename()} loading={busy} />
          <Button
            title="Cancel"
            size="sm"
            variant="secondary"
            onPress={() => {
              setNameDraft(channel.name);
              setRenaming(false);
            }}
            disabled={busy}
          />
        </View>
      ) : (
        <View className="mb-2 flex-row items-center gap-2">
          <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
            {channel.name}
          </Text>
          {channel.archived ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              Archived
            </Text>
          ) : null}
        </View>
      )}

      <Text className="mb-2 text-xs text-muted">
        Webhook •••• {channel.urlSuffix} · updated {formatDate(channel.updatedAt)}
      </Text>

      {replacingWebhook ? (
        <View className="mb-2">
          <TextField
            label="New webhook URL"
            value={webhookDraft}
            onChangeText={setWebhookDraft}
            placeholder="https://chat.googleapis.com/v1/spaces/…"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <View className="mt-1 flex-row gap-2">
            <Button
              title="Save"
              size="sm"
              onPress={() => void handleReplaceWebhook()}
              loading={busy}
              disabled={!webhookDraft.trim()}
            />
            <Button
              title="Cancel"
              size="sm"
              variant="secondary"
              onPress={() => {
                setWebhookDraft("");
                setReplacingWebhook(false);
              }}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}

      {error ? (
        <View className="mb-2 flex-row items-center gap-1.5">
          <Icon name="alert-circle" size={14} color={colors.danger} />
          <Text className="flex-1 text-sm text-danger">{error}</Text>
        </View>
      ) : null}

      {!renaming && !replacingWebhook ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            title="Rename"
            size="sm"
            variant="secondary"
            onPress={() => setRenaming(true)}
            disabled={busy}
          />
          <Button
            title="Replace webhook"
            size="sm"
            variant="secondary"
            onPress={() => setReplacingWebhook(true)}
            disabled={busy}
          />
          <Button
            title={channel.archived ? "Restore" : "Archive"}
            size="sm"
            variant={channel.archived ? "secondary" : "danger"}
            onPress={() => void handleToggleArchive()}
            loading={busy}
          />
        </View>
      ) : null}
    </View>
  );
}

function AddChannelForm() {
  const addChannel = useMutation(api.googleChatChannels.addGoogleChatChannel);
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && webhookUrl.trim() !== "";

  async function handleAdd() {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      await addChannel({ name: name.trim(), webhookUrl: webhookUrl.trim() });
      setName("");
      setWebhookUrl("");
    } catch (e) {
      setError(errorMessage(e, "Couldn't add the channel."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mt-3 border-t border-border pt-3">
      <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">
        Add a channel
      </Text>
      <TextField
        label="Name"
        value={name}
        onChangeText={(t) => {
          setName(t);
          if (error) setError(null);
        }}
        placeholder="Leaders"
        editable={!saving}
      />
      <TextField
        label="Webhook URL"
        value={webhookUrl}
        onChangeText={(t) => {
          setWebhookUrl(t);
          if (error) setError(null);
        }}
        placeholder="https://chat.googleapis.com/v1/spaces/…"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving}
        hint="From the space's Apps & integrations → Webhooks → Add webhook."
      />

      {error ? (
        <View className="mb-3 flex-row items-center gap-1.5">
          <Icon name="alert-circle" size={14} color={colors.danger} />
          <Text className="flex-1 text-sm text-danger">{error}</Text>
        </View>
      ) : null}

      <Button
        title="Add channel"
        icon="plus"
        onPress={() => void handleAdd()}
        loading={saving}
        disabled={!canSave}
      />
    </View>
  );
}
