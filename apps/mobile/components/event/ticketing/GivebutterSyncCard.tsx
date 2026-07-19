/**
 * Givebutter sync — pull tickets sold on a Givebutter campaign into the native
 * guest list / door scanner / rollups (PR B, poll-only). The operator pastes the
 * campaign id (saved via `updatePage`), then "Sync now" schedules a pull; the
 * 15-min cron keeps it fresh while the event is live. Shows last-synced / last
 * error, and a hint that refunds aren't reflected (a documented v1 limit).
 *
 * Money note: synced tickets are DISPLAY ATTRIBUTION only — they never touch the
 * finance ledger (Givebutter stays the system of record for that money).
 */
import { useState } from "react";
import { View, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import { Button, TextField } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { formatDateTime } from "../../../lib/format";

type Props = {
  eventId: Id<"events">;
  page: Doc<"eventPages">;
  run: ActionRunner["run"];
};

export function GivebutterSyncCard({ eventId, page, run }: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const requestSync = useMutation(api.givebutterSync.requestGivebutterSync);

  const [campaignId, setCampaignId] = useState(page.givebutterCampaignId ?? "");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const saved = page.givebutterCampaignId ?? "";
  const dirty = campaignId.trim() !== saved;

  async function handleSave() {
    const next = campaignId.trim();
    setSaving(true);
    await run(
      () =>
        updatePage({
          pageId: page._id,
          // Empty input clears the campaign id (null-sentinel → stops the cron).
          patch: { givebutterCampaignId: next === "" ? null : next },
        }),
      { errorTitle: "Couldn't save campaign id" },
    );
    setSaving(false);
  }

  async function handleSync() {
    setSyncing(true);
    await run(() => requestSync({ eventId }), {
      errorTitle: "Couldn't start sync",
    });
    setSyncing(false);
  }

  return (
    <View className="mt-3 gap-2.5">
      <View>
        <Text className="text-sm font-semibold text-ink">
          Givebutter ticket sync
        </Text>
        <Text className="mt-1 text-xs text-muted">
          Pull tickets sold on a Givebutter campaign into this event's guest
          list, door scanner, and totals.
        </Text>
      </View>

      <TextField
        label="Campaign ID, code, or slug"
        value={campaignId}
        onChangeText={setCampaignId}
        placeholder="e.g. 686283, UM8HE0, or the URL slug"
        autoCapitalize="none"
        hint="Campaign ID, code, or slug (e.g. 686283, UM8HE0, or the URL slug). Leave blank to disable."
      />

      <View className="flex-row gap-2">
        <Button
          title={dirty ? "Save" : "Saved"}
          icon="check"
          variant="secondary"
          size="sm"
          loading={saving}
          disabled={!dirty}
          onPress={() => void handleSave()}
        />
        <Button
          title="Sync now"
          icon="refresh-cw"
          size="sm"
          loading={syncing}
          disabled={dirty || saved === ""}
          onPress={() => void handleSync()}
        />
      </View>

      {saved !== "" ? (
        <View className="gap-0.5">
          {page.givebutterLastSyncedAt ? (
            <Text className="text-xs text-muted">
              Last synced {formatDateTime(page.givebutterLastSyncedAt)}
            </Text>
          ) : (
            <Text className="text-xs text-muted">Not synced yet.</Text>
          )}
          {page.givebutterLastSyncError ? (
            <Text className="text-xs text-danger">
              Last sync error: {page.givebutterLastSyncError}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Text className="text-xs text-faint">
        Refunds made in Givebutter aren't reflected here yet — a refunded ticket
        stays counted until you adjust it manually.
      </Text>
    </View>
  );
}
