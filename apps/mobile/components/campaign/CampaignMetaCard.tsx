/**
 * Campaign metadata — name / subject / preview text / audience / sender.
 * Eager autosave: text fields save on blur (mirrors `template/NameEditor` +
 * `DescriptionEditor`), the audience Select saves immediately on change. The
 * audience picker shows a live recipient count next to it, so switching
 * audiences shows its impact before the caller ever hits Send.
 *
 * `preview` (the current audience's live `previewAudience` result) is lifted
 * to the parent screen and passed in — `CampaignStatusCard`'s send-confirm
 * summary needs the exact same numbers, so there's one query, not two.
 *
 * "Send as" (`fromName`/`fromEmail`) is the per-campaign sender override —
 * blank means "use the org's default Resend sender". `getSenderDefaults`
 * supplies the org domain (for the hint text) and default address (for the
 * "leave blank to send as…" copy); the domain match itself is enforced
 * server-side (`campaigns.ts#validateSenderFields`) and surfaced here as a
 * plain save error.
 *
 * Read-only outside `draft`/`changes_requested`: `updateCampaignMeta`/
 * `updateCampaignDoc` both throw `NOT_EDITABLE` server-side once a campaign
 * is submitted for approval (or a send has started/finished) —
 * (`campaigns.ts#assertEditable`) — so the fields render as plain text
 * instead of editable controls rather than letting an edit silently fail.
 */
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useQuery } from "convex/react";
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
    fromName?: string | null;
    fromEmail?: string | null;
  }) => Promise<unknown>;
}) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject ?? "");
  const [previewText, setPreviewText] = useState(campaign.previewText ?? "");
  const [fromName, setFromName] = useState(campaign.fromName ?? "");
  const [fromEmail, setFromEmail] = useState(campaign.fromEmail ?? "");
  useEffect(() => setName(campaign.name), [campaign.name]);
  useEffect(() => setSubject(campaign.subject ?? ""), [campaign.subject]);
  useEffect(() => setPreviewText(campaign.previewText ?? ""), [campaign.previewText]);
  useEffect(() => setFromName(campaign.fromName ?? ""), [campaign.fromName]);
  useEffect(() => setFromEmail(campaign.fromEmail ?? ""), [campaign.fromEmail]);

  const senderDefaults = useQuery(api.campaigns.getSenderDefaults, {});

  const editable = campaign.status === "draft" || campaign.status === "changes_requested";
  const selectedAudience = audiences.find((a) => a._id === campaign.audienceId) ?? null;

  function saveName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== campaign.name) void onSave({ name: trimmed });
    else if (!trimmed) setName(campaign.name);
  }

  function saveSubject() {
    // Mirrors `saveName`: an empty (trimmed) subject resets the field to the
    // saved value rather than calling `onSave` — `updateCampaignMeta` throws
    // `EMPTY` on a blank subject, which without this guard left the local
    // field desynced from what's actually saved (the blur handler would
    // have already fired, the throw is unhandled here, and the empty text
    // stays on screen looking saved).
    const trimmed = subject.trim();
    if (trimmed && trimmed !== (campaign.subject ?? "")) void onSave({ subject: trimmed });
    else if (!trimmed) setSubject(campaign.subject ?? "");
  }

  function savePreviewText() {
    if (previewText !== (campaign.previewText ?? "")) void onSave({ previewText });
  }

  // Blank clears back to the org default (`fromName`/`fromEmail: null`) — a
  // server-rejected value (e.g. a mismatched domain) throws through `onSave`
  // (the parent's `run()` surfaces it as a toast); the local field is left
  // as typed so the caller can see and fix what they entered.
  function saveFromName() {
    const trimmed = fromName.trim();
    if (trimmed !== (campaign.fromName ?? "")) void onSave({ fromName: trimmed || null });
  }

  function saveFromEmail() {
    const trimmed = fromEmail.trim();
    if (trimmed !== (campaign.fromEmail ?? "")) void onSave({ fromEmail: trimmed || null });
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
            {preview.excludedSuppressed > 0 || preview.excludedUnverified > 0 || preview.excludedOptOut > 0 ? (
              <Text className="mt-0.5 text-xs text-muted">
                {[
                  preview.excludedSuppressed > 0
                    ? `${pluralCount(preview.excludedSuppressed, "suppressed contact")} excluded`
                    : null,
                  preview.excludedUnverified > 0
                    ? `${pluralCount(preview.excludedUnverified, "unverified contact")} excluded`
                    : null,
                  // Person-centric audiences Phase 3 — always 0 for legacy
                  // sources (guests/donors/people), so this is additive-only.
                  preview.excludedOptOut > 0
                    ? `${pluralCount(preview.excludedOptOut, "person")} opted out`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
            {preview.unlinkedCentralDonors > 0 ? (
              <Text className="mt-0.5 text-xs text-muted">
                Includes {pluralCount(preview.unlinkedCentralDonors, "central donor")} (unlinked)
              </Text>
            ) : null}
            {preview.truncated ? (
              <Text className="mt-0.5 text-xs text-warn">
                Showing the first 5,000 — this audience matches more than the cap.
              </Text>
            ) : null}
          </View>
        )}
      </Field>
      <Field
        label="Send as"
        hint={
          senderDefaults
            ? `Must be @${senderDefaults.orgDomain ?? "your organization's domain"}. Leave blank to send as ${senderDefaults.orgFromAddress ?? "the org default"}.`
            : undefined
        }
      >
        <View className="gap-2">
          <TextField
            placeholder="Sender name (optional) — e.g. AJ"
            value={fromName}
            onChangeText={setFromName}
            onBlur={saveFromName}
            editable={editable}
          />
          <TextField
            placeholder="Sender email (optional) — e.g. aj@yourdomain.org"
            value={fromEmail}
            onChangeText={setFromEmail}
            onBlur={saveFromEmail}
            editable={editable}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>
      </Field>
    </Card>
  );
}
