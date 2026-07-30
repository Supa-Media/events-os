/**
 * EMAILS — the email list + inline "new email" creator.
 *
 * On screen this desk says EMAIL: one email, written once, sent once. The
 * table, the API (`api.campaigns.*`) and the `/campaign/[id]` route keep the
 * older "campaign" name, which is reserved for a future series container —
 * see `docs/guides/email-terminology.md`.
 *
 * ── What the creator asks for, and what it doesn't ─────────────────────────
 * TWO answers: the subject line and the segment. `campaigns.ts` refuses a
 * draft without either, so both are genuinely required up front.
 *
 * It does NOT ask for a campaign name. It used to, and then the record screen
 * immediately re-presented name AND subject as editable fields with different
 * save semantics (a Create button here, save-on-blur there) — the same two
 * questions asked twice, thirty seconds apart, the second time in a different
 * idiom. The internal name is the one of the two nobody outside the org ever
 * sees, so it starts as a copy of the subject and is renamed on the record if
 * it's ever worth renaming. Preview text, sender and the design itself are
 * likewise filled in there, via eager autosave.
 *
 * ── Starting from a template ───────────────────────────────────────────────
 * The creator offers "Start from" as its FIRST field, because it decides
 * which mutation runs and what the designer opens into: a blank document
 * (`campaigns.createCampaign`) or a copy of a saved one
 * (`campaignTemplates.createCampaignFromTemplate`). Built-ins — today the
 * Public Worship monthly newsletter, rebuilt block-for-block — are listed
 * first under their own heading, since "start from the newsletter" is the
 * common case and a blank canvas is the exception.
 *
 * Every campaign here is scoped `"central"` (the org-wide sentinel
 * `schema/campaigns.ts`'s `campaignsScope` union also allows a specific
 * chapter) — this surface is CENTRAL-only to begin with, and per-chapter
 * scoping isn't part of this build's design brief, so there's no scope
 * picker yet; every campaign/audience this UI creates is org-wide.
 *
 * ── Who gets the creator ───────────────────────────────────────────────────
 * Both of its buttons are COMPOSE actions (`campaigns.createCampaign` /
 * `campaignTemplates.createCampaignFromTemplate`, each behind
 * `requireCampaignCompose`), so the whole card is hidden unless
 * `myCampaignsAccess.canCompose`. A design-only holder — the Graphic
 * Designer, who opens this desk for the themes/templates/image library, not
 * for the send — gets the campaign LIST plus a line saying where her own
 * tools are, rather than a form whose Create button throws `FORBIDDEN`.
 */
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, Badge, SectionHeader, TextField, Select, Field, EmptyState, ToastView } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { newTiptapDocSeed } from "./designer/mailyDoc";
import { formatDateTime } from "../../lib/format";
import { campaignStatusLabel, campaignStatusTone, pluralCount, pluralReply } from "./helpers";

/** Sentinel for "don't start from a template" — not a real template id. */
const BLANK_TEMPLATE = "blank" as const;

/**
 * "Design in editor" vs "Paste HTML" (PR 2 of the founder's editor
 * feedback, verbatim: "there should be an option to forgo the email editor
 * entirely and just use a html paste from things like canva to send the
 * email", 2026-07-30) — the creator's FIRST decision, same footing as
 * "Start from". Picking "Paste HTML" skips the template picker (a
 * pasted-HTML doc starts from nothing — see `HtmlPasteComposer.web.tsx`'s
 * own textarea) and creates a `docFormat: "html"` row instead of
 * `"tiptap"`; the actual paste happens on the design screen right after,
 * same as every other format opens straight into its composer.
 */
type CreateMode = "editor" | "paste";

/** A single campaign row from `api.campaigns.listCampaigns`. */
type Campaign = FunctionReturnType<typeof api.campaigns.listCampaigns>[number];
/** A single SEGMENT row from `api.audiences.listAudiences` — used both to
 *  resolve a campaign's segment name for display and to populate the
 *  creator's segment picker. (The table and its API keep the older
 *  "audience" name; the label on screen is "Segment".) */
type Audience = FunctionReturnType<typeof api.audiences.listAudiences>[number];

export function CampaignsListView() {
  const router = useRouter();
  const campaigns = useQuery(api.campaigns.listCampaigns, {});
  const audiences = useQuery(api.audiences.listAudiences, {});
  const templates = useQuery(api.campaignTemplates.listTemplates, { scope: "central" });
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  const create = useMutation(api.campaigns.createCampaign);
  const createFromTemplate = useMutation(api.campaignTemplates.createCampaignFromTemplate);
  const { run, toast, dismiss } = useActionRunner();

  const [subject, setSubject] = useState("");
  const [audienceId, setAudienceId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>(BLANK_TEMPLATE);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<CreateMode>("editor");

  if (campaigns === undefined || audiences === undefined || access === undefined) {
    return (
      <View style={{ paddingVertical: spacing.lg }}>
        <Text className="text-sm text-faint">Loading emails…</Text>
      </View>
    );
  }

  const canCompose = access.canCompose;

  const audienceName = (id: string | null | undefined): string | null =>
    (id && audiences.find((a) => a._id === id)?.name) || null;

  const canCreate = subject.trim() !== "" && audienceId !== null;

  async function handleCreate() {
    if (!canCreate || !audienceId) return;
    setCreating(true);
    try {
      // The internal name starts as the subject — `createCampaign` requires a
      // non-empty one, and asking for a second string that only the org ever
      // sees is a question better answered later (or never). It's editable on
      // the record, which is also the only place it's ever shown.
      const trimmedSubject = subject.trim();
      const id = await run(
        () =>
          mode === "paste"
            ? create({
                scope: "central",
                name: trimmedSubject,
                subject: trimmedSubject,
                audienceId: audienceId as Id<"audiences">,
                // Starts empty — the paste itself happens on the design
                // screen, right after, via `HtmlPasteComposer`'s textarea +
                // import action.
                doc: { html: "" },
                docFormat: "html",
              })
            : templateId === BLANK_TEMPLATE
              ? create({
                  scope: "central",
                  name: trimmedSubject,
                  subject: trimmedSubject,
                  audienceId: audienceId as Id<"audiences">,
                  // "New documents are maily-format from now on"
                  // (docs/plans/maily-editor-overhaul.md, "New template flow").
                  doc: newTiptapDocSeed(),
                  docFormat: "tiptap",
                })
              : createFromTemplate({
                  templateId: templateId as Id<"campaigns">,
                  name: trimmedSubject,
                  subject: trimmedSubject,
                  audienceId: audienceId as Id<"audiences">,
                }),
        { errorTitle: "Couldn't create email" },
      );
      if (id) {
        setSubject("");
        setAudienceId(null);
        setTemplateId(BLANK_TEMPLATE);
        setMode("editor");
        router.push(`/campaign/${id}` as never);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <ToastView toast={toast} onDismiss={dismiss} />

      <PendingApprovalsStrip />

      {!canCompose ? (
        <DesignerDeskCard />
      ) : audiences.length === 0 ? (
        <Card style={styles.creator}>
          <Text className="text-sm text-muted">
            Every email needs a segment to send to, and there aren&apos;t any yet.
          </Text>
          {/* A link, not an instruction. "Create one first (Segments tab
              above)" leaves the reader to find the tab and come back; the
              button is the same sentence with the walk done for her. */}
          <Button
            title="Create a segment"
            icon="users"
            onPress={() => router.push("/campaigns/audiences" as never)}
          />
        </Card>
      ) : (
        <Card style={styles.creator}>
          <Field
            label="Format"
            hint={
              mode === "paste"
                ? "Starts blank — you'll paste the HTML on the next screen."
                : "The maily editor's block canvas — themes, images, buttons, the works."
            }
          >
            <View style={styles.formatToggle}>
              {(
                [
                  { value: "editor" as const, label: "Design in editor" },
                  { value: "paste" as const, label: "Paste HTML" },
                ]
              ).map((option) => {
                const active = mode === option.value;
                return (
                  <Text
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setMode(option.value)}
                    style={[styles.formatToggleOption, active && styles.formatToggleOptionActive]}
                  >
                    {option.label}
                  </Text>
                );
              })}
            </View>
          </Field>
          {mode === "paste" ? null : (
            <Select
              label="Start from"
              value={templateId}
              options={templateOptions(templates)}
              onChange={setTemplateId}
              hint="A template copies its blocks and theme into the new draft. Editing the template later never touches an email already made from it."
            />
          )}
          <TextField
            label="Subject line"
            placeholder="What shows in the inbox"
            value={subject}
            onChangeText={setSubject}
            hint="Names the email too — rename it on the email itself if the internal name should differ."
          />
          <Select
            label="Segment"
            value={audienceId}
            placeholder="Pick a segment…"
            options={audiences.map((a) => ({ value: a._id, label: a.name }))}
            onChange={setAudienceId}
          />
          <Button
            title="+ Create email"
            onPress={handleCreate}
            loading={creating}
            disabled={!canCreate}
          />
        </Card>
      )}

      {campaigns.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No emails yet"
          message={
            canCompose
              ? "Write your first one above — you'll design it next."
              : "Nobody has written an email yet. When someone does, it shows up here and uses the themes and templates you keep."
          }
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
                  {audienceName(c.audienceId) ?? "Segment deleted"}
                  {c.status === "sending" || c.status === "sent" || c.status === "failed"
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

/**
 * What stands in for the creator when the caller holds `campaigns.design` but
 * not `campaigns.compose` (the Graphic Designer / Social Media Manager).
 *
 * A hidden button with nothing in its place reads as a broken screen. This
 * says, in one line, which half of the desk is theirs — and walks them there,
 * the same "a link, not an instruction" move the no-segments card makes.
 */
function DesignerDeskCard() {
  const router = useRouter();
  return (
    <Card style={styles.creator}>
      <Text className="text-sm text-muted">
        The emails themselves are written by whoever holds compose power. Yours
        is what they&apos;re built from — the saved templates and the image
        library.
      </Text>
      <View style={styles.designerActions}>
        <Button
          title="Templates"
          icon="bookmark"
          variant="secondary"
          onPress={() => router.push("/campaigns/templates" as never)}
        />
      </View>
    </Card>
  );
}

/**
 * Options for the "Start from" picker: the blank canvas, then the built-ins,
 * then the org's own saved templates — each group under its own heading.
 *
 * Built-ins lead because "start from the newsletter" is the reason this
 * picker exists. `undefined` (templates still loading) yields just the blank
 * option, so the creator is usable before the query resolves rather than
 * flashing an empty select.
 */
function templateOptions(
  templates: FunctionReturnType<typeof api.campaignTemplates.listTemplates> | undefined,
): { value: string; label: string; header?: boolean }[] {
  const options: { value: string; label: string; header?: boolean }[] = [
    { value: BLANK_TEMPLATE, label: "Blank email" },
  ];
  if (!templates) return options;
  const builtIn = templates.filter((t) => t.isBuiltIn === true);
  const saved = templates.filter((t) => t.isBuiltIn !== true);
  if (builtIn.length > 0) {
    options.push({ value: "", label: "Built-in", header: true });
    for (const t of builtIn) options.push({ value: t._id, label: t.name });
  }
  if (saved.length > 0) {
    options.push({ value: "", label: "Your templates", header: true });
    for (const t of saved) options.push({ value: t._id, label: t.name });
  }
  return options;
}

/**
 * "Awaiting your approval (N)" strip — mirrors
 * `orgchart/ProposalsInbox.tsx`'s shape (visible only when there's something
 * to act on). `campaigns.listPendingApprovals` already returns exactly
 * "every pending_approval campaign where the caller is the CHOSEN reviewer"
 * — no further filtering needed here.
 *
 * TWO INDEPENDENT guards keep this safe for a compose-only caller (this PR's
 * own lower access tier) — found missing in adversarial review, 2026-07-24:
 * `listPendingApprovals` itself now SOFT-gates (returns `[]` rather than
 * throwing `FORBIDDEN` for a caller without approval power — mirrors
 * `myCampaignsAccess`'s non-throwing shape), AND this component skips firing
 * the query at all unless `myCampaignsAccess.canApprove` is already known
 * true — no reason to round-trip a query we know will come back empty, and
 * belt-and-suspenders against the backend gate ever regressing.
 */
function PendingApprovalsStrip() {
  const router = useRouter();
  const access = useQuery(api.audiences.myCampaignsAccess, {});
  const pending = useQuery(
    api.campaigns.listPendingApprovals,
    access?.canApprove ? {} : "skip",
  );
  if (!pending || pending.length === 0) return null;

  return (
    <View style={{ marginBottom: spacing.md }}>
      <SectionHeader title="Awaiting your approval" count={pending.length} />
      <View style={{ gap: spacing.sm }}>
        {pending.map((c) => (
          <Card key={c._id} onPress={() => router.push(`/campaign/${c._id}` as never)}>
            <Text style={styles.name} numberOfLines={1}>
              {c.name}
            </Text>
            {c.purpose ? (
              <Text style={styles.desc} numberOfLines={2}>
                {c.purpose}
              </Text>
            ) : null}
          </Card>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  creator: { gap: spacing.sm },
  designerActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
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
  // The creator's "Design in editor" / "Paste HTML" toggle — same segmented-
  // pill visual language as the designer's own preview Light/Dark and
  // Mobile/Tablet/Desktop pills (`MailyDocumentHost.web.tsx`), just sized up
  // since this is a first-class DECISION here, not a secondary view control.
  formatToggle: {
    flexDirection: "row",
    alignSelf: "flex-start",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: "hidden",
  },
  formatToggleOption: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    fontSize: 13,
    fontWeight: "600",
    color: colors.muted,
    backgroundColor: colors.raised,
  },
  formatToggleOptionActive: {
    backgroundColor: colors.accent,
    color: colors.accentText,
  },
});
