/**
 * Campaign status card — the send workflow. Renders differently per
 * `campaign.status`:
 *   draft / changes_requested → "Request approval" (opens a modal collecting
 *             a required purpose + a reviewer picked from
 *             `listCampaignApprovers`) + a test-send row. `changes_requested`
 *             also shows the reviewer's note prominently above the request
 *             row (the design itself is editable again — see `design.tsx`).
 *   pending_approval → THREE possible views, mutually exclusive, driven by
 *             `getCampaignApproval`: the chosen REVIEWER sees the review card
 *             (audience, purpose, live recipient count, Approve/Request
 *             changes/Deny); the SUBMITTER sees a "submitted, awaiting
 *             so-and-so" line + Cancel; anyone else sees a plain status line.
 *   approved → "Approved by so-and-so" + the real Send button.
 *   denied   → the reviewer's note + "Move back to draft".
 *   sending  → live progress from the campaign's own counts.
 *   sent     → results (sent / failed / suppressed) + reply count.
 *   failed   → results + whatever error the send action left behind, +
 *             a retry Send row (the backend still allows `approved|failed →
 *             sending`, so a transport-failure retry doesn't need a fresh
 *             review — only a genuine content/audience drift would, and
 *             `send` itself catches that and re-records a failure explaining
 *             so).
 *
 * `campaign.audienceTruncated` (set at materialize time — see
 * `lib/audienceResolve.ts`) is a durable, boolean-only record of whether the
 * audience hit the 5,000 cap when this was actually sent; live views instead
 * use the fresh `preview.truncated`/`truncatedCount` (exact, since it's a
 * fresh query) to name how many would be left out.
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Card, Field, Icon, ProgressBar, Select, TextField } from "../ui";
import { colors } from "../../lib/theme";
import {
  campaignStatusLabel,
  campaignStatusTone,
  confirmAction,
  describeAudience,
  formatSenderDisplay,
  pluralCount,
  pluralReply,
} from "./helpers";
import type { ActionRunner } from "../../lib/useActionToast";

type Campaign = NonNullable<FunctionReturnType<typeof api.campaigns.getCampaign>>;
type PreviewResult = FunctionReturnType<typeof api.audiences.previewAudience>;
type Approval = FunctionReturnType<typeof api.campaigns.getCampaignApproval>;
type AudienceRow = FunctionReturnType<typeof api.audiences.listAudiences>[number];

/** "Audience hit the 5,000 cap when this was sent — some contacts were left
 *  out." — shown wherever a campaign's PERSISTED `audienceTruncated` is true
 *  (sending/sent/failed views); the exact count isn't stored (only the
 *  boolean — see `schema/campaigns.ts`), unlike the pre-send confirm, which
 *  reads the live, exact `preview.truncatedCount`. */
function AudienceCapWarning({ truncated }: { truncated: boolean | undefined }) {
  if (!truncated) return null;
  return (
    <Text className="mt-1 text-xs text-warn">
      Audience hit the 5,000 cap when this was sent — some contacts were left out. Raise the
      cap deliberately if this audience needs to reach everyone.
    </Text>
  );
}

export function CampaignStatusCard({
  campaign,
  audienceName,
  audience,
  preview,
  run,
}: {
  campaign: Campaign;
  audienceName: string | null;
  /** The campaign's own selected audience row (source/scope/filters) — used
   *  by the reviewer's review card to describe WHO is targeted. `null` while
   *  `audiences` is still loading or the audience was deleted. */
  audience: AudienceRow | null;
  preview: PreviewResult | undefined;
  run: ActionRunner["run"];
}) {
  const approval = useQuery(api.campaigns.getCampaignApproval, { campaignId: campaign._id });

  if (campaign.status === "sending") {
    const sentCount = campaign.sentCount ?? 0;
    const recipientCount = campaign.recipientCount ?? 0;
    const fraction = recipientCount > 0 ? sentCount / recipientCount : 0;
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        <View className="mt-2">
          <ProgressBar fraction={fraction} />
          <Text className="mt-2 text-sm text-muted">
            {pluralCount(sentCount, "sent")} of {pluralCount(recipientCount, "recipient")}
          </Text>
          <AudienceCapWarning truncated={campaign.audienceTruncated} />
        </View>
      </Card>
    );
  }

  if (campaign.status === "sent" || campaign.status === "failed") {
    const sentCount = campaign.sentCount ?? 0;
    const failedCount = campaign.failedCount ?? 0;
    const suppressedCount = campaign.suppressedCount ?? 0;
    const replyCount = campaign.replyCount ?? 0;
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        <View className="mt-2 gap-1">
          <Text className="text-sm text-ink">
            {pluralCount(sentCount, "sent")}
            {failedCount > 0 ? ` · ${pluralCount(failedCount, "failed")}` : ""}
            {suppressedCount > 0 ? ` · ${pluralCount(suppressedCount, "suppressed")}` : ""}
          </Text>
          {replyCount > 0 ? (
            <Text className="text-sm text-muted">{pluralReply(replyCount)} so far</Text>
          ) : null}
          <AudienceCapWarning truncated={campaign.audienceTruncated} />
          {campaign.status === "failed" ? (
            <Text className="mt-1 text-sm text-danger">
              {campaign.error ?? "The send didn't complete. Check the campaign's audience and design, then try again."}
            </Text>
          ) : null}
        </View>
        {campaign.status === "failed" ? (
          // The backend allows an `approved|failed → sending` retry
          // (`campaigns.ts#send`) — a transport failure isn't a content
          // change, so this reuses the exact same confirm/send flow the
          // "approved" state uses, just relabeled so it reads as a retry.
          <View className="mt-3 border-t border-border pt-3">
            <DraftSendRow campaign={campaign} audienceName={audienceName} preview={preview} run={run} retry />
          </View>
        ) : null}
      </Card>
    );
  }

  if (campaign.status === "draft" || campaign.status === "changes_requested") {
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        {campaign.status === "changes_requested" ? (
          <ReviewNoteBlock
            label={
              approval?.reviewerName ? `${approval.reviewerName} requested changes` : "Changes requested"
            }
            note={campaign.reviewNote}
          />
        ) : null}
        <RequestApprovalRow campaign={campaign} preview={preview} run={run} />
        <TestSendRow campaign={campaign} run={run} />
      </Card>
    );
  }

  if (campaign.status === "pending_approval") {
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        {approval === undefined ? null : approval.canDecide ? (
          <ReviewCard campaign={campaign} audience={audience} preview={preview} approval={approval} run={run} />
        ) : approval.isSubmitter ? (
          <PendingSubmitterView campaign={campaign} approval={approval} run={run} />
        ) : (
          <Text className="mt-2 text-sm text-muted">
            Awaiting {approval.reviewerName ?? "the reviewer"}'s decision.
          </Text>
        )}
      </Card>
    );
  }

  if (campaign.status === "approved") {
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        <Text className="mt-1 text-sm text-muted">
          Approved by {approval?.reviewerName ?? "a reviewer"}
          {campaign.reviewNote ? ` — "${campaign.reviewNote}"` : ""}
        </Text>
        <DraftSendRow campaign={campaign} audienceName={audienceName} preview={preview} run={run} />
      </Card>
    );
  }

  if (campaign.status === "denied") {
    return (
      <Card className="mb-4">
        <StatusHeader status={campaign.status} />
        <ReviewNoteBlock
          label={approval?.reviewerName ? `${approval.reviewerName}'s note` : "Reviewer's note"}
          note={campaign.reviewNote}
        />
        <DeniedActions campaign={campaign} run={run} />
      </Card>
    );
  }

  return null;
}

function StatusHeader({ status }: { status: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-xs font-bold uppercase tracking-wider text-faint">Status</Text>
      <Badge label={campaignStatusLabel(status)} tone={campaignStatusTone(status)} />
    </View>
  );
}

function ReviewNoteBlock({ label, note }: { label: string; note: string | undefined }) {
  if (!note) return null;
  return (
    <View className="mt-2 rounded-md border border-dashed border-border bg-raised px-3 py-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-faint">{label}</Text>
      <Text className="mt-1 text-sm text-ink">{note}</Text>
    </View>
  );
}

// ── draft / changes_requested → request approval ────────────────────────────

function RequestApprovalRow({
  campaign,
  preview,
  run,
}: {
  campaign: Campaign;
  preview: PreviewResult | undefined;
  run: ActionRunner["run"];
}) {
  const submit = useMutation(api.campaigns.submitForApproval);
  const [showModal, setShowModal] = useState(false);
  const hasAudience = campaign.audienceId != null;
  const hasContent = campaign.doc.blocks.length > 0;
  const hasSubject = (campaign.subject ?? "").trim().length > 0;
  const canSubmit = hasAudience && hasContent && hasSubject;

  return (
    <View className="mt-3 gap-2">
      <Text className="text-sm text-muted">
        {hasAudience ? "Ready to submit for review." : "Pick an audience above before submitting."}
      </Text>
      {!hasSubject ? (
        <Text className="text-xs text-warn">Add a subject line before requesting approval.</Text>
      ) : null}
      {!hasContent ? (
        <Text className="text-xs text-warn">The design is empty — add at least one block.</Text>
      ) : null}
      <View className="flex-row justify-end">
        <Button
          title="Request approval"
          icon="send"
          onPress={() => setShowModal(true)}
          disabled={!canSubmit}
        />
      </View>
      {showModal ? (
        <RequestApprovalModal
          preview={preview}
          onCancel={() => setShowModal(false)}
          onSubmit={async (purpose, reviewerPersonId) => {
            const result = await run(
              () => submit({ campaignId: campaign._id, purpose, reviewerPersonId }),
              { errorTitle: "Couldn't submit for approval" },
            );
            if (result !== undefined) setShowModal(false);
          }}
        />
      ) : null}
    </View>
  );
}

function RequestApprovalModal({
  preview,
  onCancel,
  onSubmit,
}: {
  preview: PreviewResult | undefined;
  onCancel: () => void;
  onSubmit: (purpose: string, reviewerPersonId: Id<"people">) => Promise<void>;
}) {
  const approvers = useQuery(api.campaigns.listCampaignApprovers, {});
  const [purpose, setPurpose] = useState("");
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canSubmit = purpose.trim().length > 0 && reviewerId != null;

  async function submit() {
    if (!canSubmit || !reviewerId) return;
    setSaving(true);
    try {
      await onSubmit(purpose.trim(), reviewerId as Id<"people">);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable onPress={onCancel} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Request approval</Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-3 px-5 py-4">
            <Text className="text-xs text-muted">
              A test copy goes to you and the reviewer — the reviewer's copy links back here to
              decide.
            </Text>
            <TextField
              label="Purpose"
              value={purpose}
              onChangeText={setPurpose}
              placeholder="Why is this campaign going out?"
              multiline
              numberOfLines={3}
              autoFocus
            />
            <Select
              label="Reviewer"
              value={reviewerId}
              placeholder={
                approvers === undefined
                  ? "Loading…"
                  : approvers.length === 0
                    ? "No eligible reviewers on the org chart"
                    : "Pick a reviewer…"
              }
              options={(approvers ?? []).map((a) => ({ value: a.personId, label: a.name }))}
              onChange={setReviewerId}
            />
            {preview ? (
              <Text className="text-xs text-muted">
                Sends to {pluralCount(preview.count, "person")} once approved.
              </Text>
            ) : null}
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Submit for approval"
              onPress={submit}
              loading={saving}
              disabled={!canSubmit}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── pending_approval — submitter's view ─────────────────────────────────────

function PendingSubmitterView({
  campaign,
  approval,
  run,
}: {
  campaign: Campaign;
  approval: Approval;
  run: ActionRunner["run"];
}) {
  const cancel = useMutation(api.campaigns.cancelApprovalRequest);
  const [busy, setBusy] = useState(false);

  return (
    <View className="mt-2 gap-2">
      <Text className="text-sm text-ink">
        Submitted — awaiting {approval?.reviewerName ?? "the reviewer"}.
      </Text>
      {campaign.purpose ? (
        <Text className="text-sm text-muted">Purpose: {campaign.purpose}</Text>
      ) : null}
      <View className="flex-row justify-end">
        <Button
          title="Cancel request"
          variant="secondary"
          size="sm"
          loading={busy}
          onPress={() =>
            confirmAction({
              title: "Cancel this approval request?",
              message: "The campaign goes back to draft — you can resubmit later.",
              confirmLabel: "Cancel request",
              destructive: true,
              onConfirm: () => {
                setBusy(true);
                void run(() => cancel({ campaignId: campaign._id }), {
                  errorTitle: "Couldn't cancel the request",
                }).finally(() => setBusy(false));
              },
            })
          }
        />
      </View>
    </View>
  );
}

// ── pending_approval — reviewer's view ──────────────────────────────────────

function ReviewCard({
  campaign,
  audience,
  preview,
  approval,
  run,
}: {
  campaign: Campaign;
  audience: AudienceRow | null;
  preview: PreviewResult | undefined;
  approval: Approval;
  run: ActionRunner["run"];
}) {
  const approve = useMutation(api.campaigns.approveCampaign);
  const requestChanges = useMutation(api.campaigns.requestCampaignChanges);
  const deny = useMutation(api.campaigns.denyCampaign);
  const [busy, setBusy] = useState<"approve" | "changes" | "deny" | null>(null);
  const [modal, setModal] = useState<"changes" | "deny" | null>(null);

  async function decide(kind: "approve" | "changes" | "deny", fn: () => Promise<unknown>) {
    setBusy(kind);
    try {
      await run(fn, {
        errorTitle:
          kind === "approve" ? "Couldn't approve" : kind === "deny" ? "Couldn't deny" : "Couldn't request changes",
      });
    } finally {
      setBusy(null);
    }
  }

  const excludedBits: string[] = [];
  if (preview && preview.excludedSuppressed > 0) excludedBits.push(`${preview.excludedSuppressed} suppressed`);
  if (preview && preview.excludedUnverified > 0) excludedBits.push(`${preview.excludedUnverified} unverified`);
  // Person-centric audiences Phase 3 — `excludedOptOut`/`unlinkedCentralDonors`
  // are always 0 for legacy sources, so this is additive-only for existing
  // campaigns' review cards.
  if (preview && preview.excludedOptOut > 0) excludedBits.push(`${preview.excludedOptOut} opted out`);

  return (
    <View className="mt-2 gap-3">
      <View className="gap-1">
        <Text className="text-2xs font-bold uppercase tracking-wider text-faint">Audience</Text>
        <Text className="text-sm text-ink">
          {audience
            ? describeAudience(audience.source, audience.filters, {
                includeCount: audience.includePersonIds?.length,
                excludeCount: audience.excludePersonIds?.length,
              })
            : "Audience deleted"}
        </Text>
        <Text className="text-sm text-muted">
          {preview === undefined
            ? "Resolving recipients…"
            : `${pluralCount(preview.count, "recipient")}${excludedBits.length > 0 ? ` (${excludedBits.join(", ")} excluded)` : ""}`}
        </Text>
        {preview && preview.unlinkedCentralDonors > 0 ? (
          <Text className="text-xs text-muted">
            Includes {pluralCount(preview.unlinkedCentralDonors, "central donor")} (unlinked)
          </Text>
        ) : null}
      </View>
      <View className="gap-1">
        <Text className="text-2xs font-bold uppercase tracking-wider text-faint">Purpose</Text>
        <Text className="text-sm text-ink">{campaign.purpose ?? "—"}</Text>
      </View>
      <View className="gap-1">
        <Text className="text-2xs font-bold uppercase tracking-wider text-faint">Subject</Text>
        <Text className="text-sm text-ink">{campaign.subject}</Text>
      </View>
      {approval?.submitterName ? (
        <Text className="text-xs text-muted">Submitted by {approval.submitterName}</Text>
      ) : null}

      <View className="flex-row flex-wrap justify-end gap-2">
        <Button
          title="Deny"
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          onPress={() => setModal("deny")}
        />
        <Button
          title="Request changes"
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          onPress={() => setModal("changes")}
        />
        <Button
          title="Approve"
          size="sm"
          loading={busy === "approve"}
          disabled={busy !== null && busy !== "approve"}
          onPress={() => void decide("approve", () => approve({ campaignId: campaign._id }))}
        />
      </View>

      {modal === "changes" ? (
        <NoteModal
          title="Request changes"
          prompt="What needs to change before this can be approved?"
          submitLabel="Send"
          onCancel={() => setModal(null)}
          onSubmit={async (note) => {
            await decide("changes", () => requestChanges({ campaignId: campaign._id, note }));
            setModal(null);
          }}
        />
      ) : null}
      {modal === "deny" ? (
        <NoteModal
          title="Deny this campaign"
          prompt="Why is this campaign being denied? The submitter will see this note."
          submitLabel="Deny"
          destructive
          onCancel={() => setModal(null)}
          onSubmit={async (note) => {
            await decide("deny", () => deny({ campaignId: campaign._id, note }));
            setModal(null);
          }}
        />
      ) : null}
    </View>
  );
}

/** Shared note-required modal for "Request changes" and "Deny" — mirrors
 *  `BudgetApprovalActions.tsx#RequestChangesModal`'s pattern (the app has no
 *  cross-platform `Alert.prompt`). */
function NoteModal({
  title,
  prompt,
  submitLabel,
  destructive = false,
  onCancel,
  onSubmit,
}: {
  title: string;
  prompt: string;
  submitLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await onSubmit(note.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable onPress={onCancel} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">{title}</Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="px-5 py-4">
            <Text className="mb-3 text-xs text-muted">{prompt}</Text>
            <TextField
              value={note}
              onChangeText={setNote}
              placeholder="Explain in a sentence or two"
              multiline
              numberOfLines={4}
              autoFocus
            />
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={submitLabel}
              variant={destructive ? "danger" : "primary"}
              onPress={submit}
              loading={saving}
              disabled={!note.trim()}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── denied ────────────────────────────────────────────────────────────────

function DeniedActions({ campaign, run }: { campaign: Campaign; run: ActionRunner["run"] }) {
  const revert = useMutation(api.campaigns.revertToDraft);
  const [busy, setBusy] = useState(false);

  return (
    <View className="mt-2 flex-row justify-end">
      <Button
        title="Move back to draft"
        variant="secondary"
        loading={busy}
        onPress={() => {
          setBusy(true);
          void run(() => revert({ campaignId: campaign._id }), {
            errorTitle: "Couldn't move this campaign back to draft",
          }).finally(() => setBusy(false));
        }}
      />
    </View>
  );
}

// ── approved / failed-retry — the real send ─────────────────────────────────

function DraftSendRow({
  campaign,
  audienceName,
  preview,
  run,
  retry = false,
}: {
  campaign: Campaign;
  audienceName: string | null;
  preview: PreviewResult | undefined;
  run: ActionRunner["run"];
  /** Rendered for a "failed" campaign instead of an "approved" one — same
   *  underlying `send()` call (the backend allows both statuses), just
   *  relabeled so it reads as a retry rather than a first send. */
  retry?: boolean;
}) {
  const send = useMutation(api.campaigns.send);
  const senderDefaults = useQuery(api.campaigns.getSenderDefaults, {});
  const [sending, setSending] = useState(false);
  const hasAudience = campaign.audienceId != null;
  const hasContent = campaign.doc.blocks.length > 0;
  const hasSubject = (campaign.subject ?? "").trim().length > 0;
  const canSend = hasAudience && hasContent && hasSubject && preview !== undefined;

  function handleSend() {
    if (!canSend || !preview) return;
    const excludedBits: string[] = [];
    if (preview.excludedSuppressed > 0) {
      excludedBits.push(`${preview.excludedSuppressed} suppressed`);
    }
    if (preview.excludedUnverified > 0) {
      excludedBits.push(`${preview.excludedUnverified} unverified`);
    }
    const excludedNote = excludedBits.length > 0 ? ` (${excludedBits.join(", ")} excluded)` : "";
    const senderDisplay = campaign.fromEmail
      ? formatSenderDisplay(campaign.fromName, campaign.fromEmail)
      : (senderDefaults?.orgFromAddress ?? "the org default sender");
    const capNote = preview.truncated
      ? ` Audience hit the 5,000 cap — ${pluralCount(preview.truncatedCount, "person")} left out; raise the cap deliberately.`
      : "";
    confirmAction({
      title: retry ? "Retry sending this campaign?" : "Send campaign?",
      message: `Sends to ${preview.count} ${preview.count === 1 ? "person" : "people"}${excludedNote} as ${senderDisplay}.${capNote} This can't be undone.`,
      confirmLabel: retry ? "Retry send" : "Send",
      onConfirm: () => {
        setSending(true);
        void run(() => send({ campaignId: campaign._id }), {
          errorTitle: retry ? "Couldn't retry the send" : "Couldn't send campaign",
        }).finally(() => setSending(false));
      },
    });
  }

  return (
    <View className={retry ? "gap-2" : "mt-3 gap-2"}>
      <Text className="text-sm text-muted">
        {audienceName ? `Audience: ${audienceName}` : "Pick an audience above before sending."}
      </Text>
      {!hasSubject ? (
        <Text className="text-xs text-warn">Add a subject line before sending.</Text>
      ) : null}
      {!hasContent ? (
        <Text className="text-xs text-warn">The design is empty — add at least one block.</Text>
      ) : null}
      <View className="flex-row justify-end">
        <Button
          title={retry ? "Retry send" : "Send campaign"}
          icon="send"
          onPress={handleSend}
          loading={sending}
          disabled={!canSend}
        />
      </View>
    </View>
  );
}

function TestSendRow({ campaign, run }: { campaign: Campaign; run: ActionRunner["run"] }) {
  // `sendTest` is a Convex `action` (it calls out to Resend), not a mutation —
  // `useAction`, not `useMutation`.
  const sendTest = useAction(api.campaigns.sendTest);
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSendTest() {
    const trimmed = to.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const result = await run(() => sendTest({ campaignId: campaign._id, to: trimmed }), {
        errorTitle: "Couldn't send test",
      });
      if (result !== undefined) setTo("");
    } finally {
      setSending(false);
    }
  }

  return (
    <View className="mt-4 border-t border-border pt-3">
      <Field label="Send a test" hint="Preview the current design in your own inbox before sending for real.">
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <TextField
              value={to}
              onChangeText={setTo}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              onSubmitEditing={handleSendTest}
            />
          </View>
          <Button title="Send test" variant="secondary" onPress={handleSendTest} loading={sending} disabled={!to.trim()} />
        </View>
      </Field>
    </View>
  );
}
