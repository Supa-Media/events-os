/**
 * Campaign metadata — name / subject / preview text / audience. Eager
 * autosave: text fields save on blur (mirrors `template/NameEditor` +
 * `DescriptionEditor`), the audience Select saves immediately on change. The
 * audience picker shows a live recipient count next to it, so switching
 * audiences shows its impact before the caller ever hits Send.
 *
 * `preview` (the current audience's live `previewAudience` result) is lifted
 * to the parent screen and passed in — `CampaignStatusCard`'s send-confirm
 * summary needs the exact same numbers, so there's one query, not two.
 *
 * Read-only once `status !== "draft"`: `updateCampaignMeta`/`updateCampaignDoc`
 * both throw `NOT_DRAFT` server-side once a send has started or finished
 * (`campaigns.ts#assertDraft`) — a sent campaign's record should stay a
 * faithful account of what actually went out, so the fields render as plain
 * text instead of editable controls rather than letting an edit silently fail.
 */
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, TextField, Select, Field } from "../ui";
import { pluralCount } from "./helpers";

type Campaign = NonNullable<FunctionReturnType<typeof api.campaigns.getCampaign>>;
type Audience = FunctionReturnType<typeof api.audiences.listAudiences>[number];
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;

export function CampaignMetaCard({
  campaign,
  audiences,
  preview,
  onSave,
}: {
  campaign: Campaign;
  audiences: Audience[];
  preview: PreviewResult | undefined;
  onSave: (patch: {
    name?: string;
    subject?: string;
    previewText?: string;
    audienceId?: Id<"audiences">;
  }) => Promise<unknown>;
}) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject ?? "");
  const [previewText, setPreviewText] = useState(campaign.previewText ?? "");
  useEffect(() => setName(campaign.name), [campaign.name]);
  useEffect(() => setSubject(campaign.subject ?? ""), [campaign.subject]);
  useEffect(() => setPreviewText(campaign.previewText ?? ""), [campaign.previewText]);

  const editable = campaign.status === "draft";
  const selectedAudience = audiences.find((a) => a._id === campaign.audienceId) ?? null;

  function saveName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== campaign.name) void onSave({ name: trimmed });
    else if (!trimmed) setName(campaign.name);
  }

  function saveSubject() {
    if (subject !== (campaign.subject ?? "")) void onSave({ subject });
  }

  function savePreviewText() {
    if (previewText !== (campaign.previewText ?? "")) void onSave({ previewText });
  }

  return (
    <Card className="mb-4">
      {!editable ? (
        <Text className="mb-3 text-xs text-muted">
          This campaign has been sent — its details are locked.
        </Text>
      ) : null}
      <TextField
        label="Campaign name"
        placeholder="Internal name — recipients never see this"
        value={name}
        onChangeText={setName}
        onBlur={saveName}
        editable={editable}
      />
      <TextField
        label="Subject line"
        placeholder="What shows in the inbox"
        value={subject}
        onChangeText={setSubject}
        onBlur={saveSubject}
        editable={editable}
      />
      <TextField
        label="Preview text"
        placeholder="The snippet after the subject in most inboxes (optional)"
        value={previewText}
        onChangeText={setPreviewText}
        onBlur={savePreviewText}
        editable={editable}
      />
      {editable ? (
        <Select
          label="Audience"
          value={campaign.audienceId ?? null}
          placeholder="Pick an audience…"
          options={audiences.map((a) => ({ value: a._id, label: a.name }))}
          onChange={(v) => void onSave({ audienceId: v as Id<"audiences"> })}
        />
      ) : (
        <Field label="Audience">
          <Text className="text-base text-ink">{selectedAudience?.name ?? "Audience deleted"}</Text>
        </Field>
      )}
      <Field label="Recipients">
        {!selectedAudience ? (
          <Text className="text-sm text-faint">Pick an audience to see who this reaches.</Text>
        ) : preview === undefined ? (
          <Text className="text-sm text-faint">Calculating…</Text>
        ) : (
          <View>
            <Text className="text-sm font-semibold text-ink">
              {pluralCount(preview.count, "recipient")}
            </Text>
            {preview.excludedSuppressed > 0 || preview.excludedUnverified > 0 ? (
              <Text className="mt-0.5 text-xs text-muted">
                {preview.excludedSuppressed > 0
                  ? `${pluralCount(preview.excludedSuppressed, "suppressed contact")} excluded`
                  : ""}
                {preview.excludedSuppressed > 0 && preview.excludedUnverified > 0 ? " · " : ""}
                {preview.excludedUnverified > 0
                  ? `${pluralCount(preview.excludedUnverified, "unverified contact")} excluded`
                  : ""}
              </Text>
            ) : null}
          </View>
        )}
      </Field>
    </Card>
  );
}
