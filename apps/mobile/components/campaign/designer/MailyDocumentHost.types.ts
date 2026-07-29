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

export type MailyDocumentHostProps = {
  /** Needed for the server-rendered preview action
   *  (`api.emailPreview.renderCampaignPreview({ campaignId })` — see
   *  `lib/emailPreview.ts`'s TODO(WS2b)) and nothing else; the host never
   *  reads/writes the row directly. */
  campaignId: Id<"campaigns">;
  /** The stored tiptap document. `undefined` while `campaign`/`template` is
   *  still loading — mirrors `BlocksDocumentComposer`'s `doc` prop. */
  doc: JSONContent | undefined;
  /** False renders a static, non-editable document — see the module doc on
   *  `MailyDocumentHost.web.tsx` for exactly what that disables. */
  editable: boolean;
  /** Why it's locked, in the caller's own words. Only shown when `!editable`. */
  lockedNotice?: string;
  /** Persist the document with `docFormat: "tiptap"` via the existing
   *  doc-save path. MUST reject on failure (mirrors `BlocksDocumentComposer`'s
   *  `onSave`). TODO(WS2b): the underlying mutation
   *  (`campaigns.updateCampaignDoc` / `campaignTemplates.updateTemplate`)
   *  doesn't accept a tiptap-shaped `doc` yet — see this prop's caller in
   *  `DocumentComposer.tsx` for the exact gate. */
  onSave: (doc: JSONContent) => Promise<unknown>;
  /** Surfaces failures (uploads) — the screen owns the toast/Alert. */
  run: ActionRunner["run"];
  /** `undefined` on a locked document — every upload affordance disappears
   *  rather than failing on tap, mirroring `useDesignerImageUploader`'s
   *  existing `enabled` contract. */
  uploadImage: UploadImage | undefined;
  /** Present only for a campaign (see the type's own doc). */
  meta?: MailyMetaFieldsProps;
};
