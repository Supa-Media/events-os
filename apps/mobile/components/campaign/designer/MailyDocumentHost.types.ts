/**
 * Shared prop shape for the platform-split maily host
 * (`MailyDocumentHost.web.tsx` / `MailyDocumentHost.native.tsx`) — the
 * `MarkdownEditor`/`EmailHtmlPreview` bridge-file pattern: one types module
 * both platform files and the bare `.tsx` bridge import from, so they can
 * never quietly diverge on what a caller hands them.
 */
import type { JSONContent } from "@tiptap/core";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { UploadImage } from "./DesignerControls";
import type { ActionRunner } from "../../../lib/useActionToast";

/**
 * The inline meta strip above the document (Subject / Preview text / From) —
 * the founder's screenshot's "meta fields inline at the top". Present only
 * for a CAMPAIGN (email-kind row); templates have no subject/audience/sender
 * of their own, so `DocumentComposer` simply doesn't build one for the
 * template screen and the host renders the document alone.
 */
export type MailyMetaFieldsProps = {
  subject: string;
  previewText: string;
  /** Precomputed read-only display text (`mailyMetaText.ts#fromLineText`) —
   *  the host never edits sender fields itself; that stays on the record
   *  (`CampaignMetaCard.tsx`). */
  fromLine: string;
  /** `campaigns.updateCampaignMeta({ subject })` — same mutation the meta
   *  card autosaves on blur. */
  onSaveSubject: (subject: string) => Promise<unknown>;
  /** `campaigns.updateCampaignMeta({ previewText })`, same mutation. */
  onSavePreviewText: (previewText: string) => Promise<unknown>;
};

/**
 * The in-editor format switch (founder's PRIMARY fix for "Paste HTML is
 * unreachable," 2026-07-30 — see `apps/convex/campaigns.ts#setDocFormat`'s own
 * doc for the guard this button's success depends on). Built by the SCREEN
 * (`app/(app)/campaign/[id]/design.tsx`), not the host, because deciding
 * eligibility needs the campaign row's `status` and approval history, which
 * the host never reads directly — the host only ever renders whatever this
 * object says. Shared between `MailyDocumentHostProps` and
 * `HtmlPasteComposerProps` so the tiptap host's "Paste HTML instead" and the
 * html host's "Use the editor instead" are the exact same affordance, wired
 * to the same mutation, just pointed at each other's target format.
 */
export type ComposerFormatSwitch = {
  /** "Paste HTML instead" / "Use the editor instead". */
  label: string;
  /** Calls `campaigns.setDocFormat` — the composer re-renders in the new
   *  format on its own once the campaign query refreshes (`docFormat` drives
   *  `DocumentComposer`'s three-way switch); this callback doesn't need to
   *  do anything else. MUST reject on failure (mirrors every other
   *  composer callback's contract) so the screen's `run()` can surface it. */
  onSwitch: () => Promise<unknown>;
  /** True while `onSwitch` is in flight — disables the control so a second
   *  click can't fire a second switch mid-flight. */
  switching: boolean;
  /** Set when the current doc has real content: `setDocFormat` would reject
   *  it (a format switch resets the doc, so a non-empty one is never a safe
   *  switch) — render the affordance disabled with this as the explanation
   *  instead of a working button, rather than making it vanish with no
   *  trace once a designer starts typing. */
  disabledReason?: string;
};

export type MailyDocumentHostProps = {
  /** Needed for the server-rendered preview action
   *  (`api.emailPreview.renderCampaignPreview({ campaignId })` — see
   *  `lib/emailPreview.ts`) and nothing else; the host never reads/writes
   *  the row directly. */
  campaignId: Id<"campaigns">;
  /** The stored tiptap document. `undefined` while `campaign`/`template` is
   *  still loading — mirrors `BlocksDocumentComposer`'s `doc` prop. */
  doc: JSONContent | undefined;
  /** False renders a static, non-editable document — see the module doc on
   *  `MailyDocumentHost.web.tsx` for exactly what that disables. */
  editable: boolean;
  /** Why it's locked, in the caller's own words. Only shown when `!editable`. */
  lockedNotice?: string;
  /** Persist the document via the existing doc-save path
   *  (`campaigns.updateCampaignDoc` / `campaignTemplates.updateTemplate`,
   *  which dispatch on the row's own `docFormat` — WS2b). MUST reject on
   *  failure (mirrors `BlocksDocumentComposer`'s `onSave`). */
  onSave: (doc: JSONContent) => Promise<unknown>;
  /** Surfaces failures (uploads) — the screen owns the toast/Alert. */
  run: ActionRunner["run"];
  /** `undefined` on a locked document — every upload affordance disappears
   *  rather than failing on tap, mirroring `useDesignerImageUploader`'s
   *  existing `enabled` contract. */
  uploadImage: UploadImage | undefined;
  /** Present only for a campaign (see the type's own doc). */
  meta?: MailyMetaFieldsProps;
  /** Present only when the screen has decided this row is eligible to
   *  switch format at all (`campaigns.compose` + `status === "draft"`) —
   *  absent means don't render the affordance, full stop (a submitted/
   *  approved/sent row, or a caller without compose power, never sees it).
   *  See `ComposerFormatSwitch`'s own doc. */
  formatSwitch?: ComposerFormatSwitch;
};
