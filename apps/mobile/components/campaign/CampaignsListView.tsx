/**
 * CAMPAIGNS — the campaign list + inline "new campaign" creator.
 *
 * Unlike `TemplatesView`'s "create with just a name" flow, `createCampaign`
 * requires a subject line and an audience up front (`campaigns.ts` validates
 * both before a draft can even be saved), so the creator collects all three
 * before pushing into the detail screen (`/campaign/[id]`) — previewText and
 * the actual design are filled in there via eager autosave.
 *
 * Every campaign here is scoped `"central"` (the org-wide sentinel
 * `schema/campaigns.ts`'s `campaignsScope` union also allows a specific
 * chapter) — this surface is CENTRAL-only to begin with, and per-chapter
 * scoping isn't part of this build's design brief, so there's no scope
 * picker yet; every campaign/audience this UI creates is org-wide.
 */
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, Badge, TextField, Select, EmptyState, ToastView } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { formatDateTime } from "../../lib/format";
import { campaignStatusLabel, campaignStatusTone, pluralCount, pluralReply } from "./helpers";

/** A single campaign row from `api.campaigns.listCampaigns`. */
type Campaign = FunctionReturnType<typeof api.campaigns.listCampaigns>[number];
/** A single audience row from `api.audiences.listAudiences` — used both to
 *  resolve a campaign's audience name for display and to populate the
 *  creator's audience picker. */
type Audience = FunctionReturnType<typeof api.audiences.listAudiences>[number];

export function CampaignsListView() {
  const router = useRouter();
  const campaigns = useQuery(api.campaigns.listCampaigns, {});
  const audiences = useQuery(api.audiences.listAudiences, {});
  const create = useMutation(api.campaigns.createCampaign);
  const { run, toast, dismiss } = useActionRunner();

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [audienceId, setAudienceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (campaigns === undefined || audiences === undefined) {
    return (
      <View style={{ paddingVertical: spacing.lg }}>
        <Text className="text-sm text-faint">Loading campaigns…</Text>
      </View>
    );
  }

  const audienceName = (id: string | null | undefined): string | null =>
    (id && audiences.find((a) => a._id === id)?.name) || null;

  const canCreate = name.trim() !== "" && subject.trim() !== "" && audienceId !== null;

  async function handleCreate() {
    if (!canCreate || !audienceId) return;
    setCreating(true);
    try {
      const id = await run(
        () =>
          create({
            scope: "central",
            name: name.trim(),
            subject: subject.trim(),
            audienceId: audienceId as Id<"audiences">,
            doc: { blocks: [] },
          }),
        { errorTitle: "Couldn't create campaign" },
      );
      if (id) {
        setName("");
        setSubject("");
        setAudienceId(null);
        router.push(`/campaign/${id}` as never);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <ToastView toast={toast} onDismiss={dismiss} />

      {audiences.length === 0 ? (
        <Card style={styles.creator}>
          <Text className="text-sm text-muted">
            Create an audience first (Audiences tab above) — every campaign needs one to send to.
          </Text>
        </Card>
      ) : (
        <Card style={styles.creator}>
          <TextField
            label="New campaign"
            placeholder="e.g. Fall Fundraiser Kickoff"
            value={name}
            onChangeText={setName}
          />
          <TextField
            label="Subject line"
            placeholder="What shows in the inbox"
            value={subject}
            onChangeText={setSubject}
          />
          <Select
            label="Audience"
            value={audienceId}
            placeholder="Pick an audience…"
            options={audiences.map((a) => ({ value: a._id, label: a.name }))}
            onChange={setAudienceId}
          />
          <Button
            title="+ Create campaign"
            onPress={handleCreate}
            loading={creating}
            disabled={!canCreate}
          />
        </Card>
      )}

      {campaigns.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No campaigns yet"
          message="Create your first email campaign above — you'll design the email next."
        />
      ) : (
        <View style={styles.list}>
          {campaigns.map((c) => {
            const sentCount = c.sentCount ?? 0;
            const recipientCount = c.recipientCount ?? 0;
            const replyCount = c.replyCount ?? 0;
            return (
              <Card key={c._id} onPress={() => router.push(`/campaign/${c._id}` as never)}>
                <View style={styles.cardTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Badge label={campaignStatusLabel(c.status)} tone={campaignStatusTone(c.status)} />
                </View>
                {c.subject ? (
                  <Text style={styles.desc} numberOfLines={1}>
                    {c.subject}
                  </Text>
                ) : null}
                <Text style={styles.meta}>
                  {audienceName(c.audienceId) ?? "Audience deleted"}
                  {c.status !== "draft"
                    ? ` · ${pluralCount(sentCount, "sent")} / ${pluralCount(recipientCount, "recipient")}`
                    : ""}
                  {replyCount > 0 ? ` · ${pluralReply(replyCount)}` : ""}
                  {c.sentAt != null ? ` · ${formatDateTime(c.sentAt)}` : ""}
                </Text>
              </Card>
            );
          })}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  creator: { gap: spacing.sm },
  list: { marginTop: spacing.md, gap: spacing.md },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  name: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  desc: { fontSize: 13, color: colors.muted, marginTop: spacing.xs },
  meta: { fontSize: 13, color: colors.muted, marginTop: spacing.sm },
});
