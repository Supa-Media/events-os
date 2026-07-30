/**
 * Shared prop shape for the platform-split "Paste HTML" host
 * (`HtmlPasteComposer.web.tsx` / `HtmlPasteComposer.native.tsx`) — same
 * bridge-file pattern `MailyDocumentHost.types.ts` established for the
 * tiptap host, reused here for the `docFormat: "html"` twin (PR 2 of the
 * founder's editor feedback, "Paste HTML", 2026-07-30).
 */
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { ActionRunner } from "../../../lib/useActionToast";
import type { ComposerFormatSwitch, MailyMetaFieldsProps } from "./MailyDocumentHost.types";

/** The stored `docFormat: "html"` document shape — mirrors
 *  `@events-os/shared`'s `EmailHtmlDocument`, kept as a local structural
 *  type so this composer (and its native/web split) has no cross-package
 *  import of its own beyond what `campaigns.ts` already validates against. */
export type HtmlPasteDoc = { html: string };

export type HtmlPasteComposerProps = {
  /** Needed for the server-rendered preview action
   *  (`api.emailPreview.renderCampaignPreview({ campaignId })`) — the host
   *  never reads/writes the row directly beyond `onSave`. */
  campaignId: Id<"campaigns">;
  /** The stored html doc. `undefined` while the campaign is still loading. */
  doc: HtmlPasteDoc | undefined;
  /** False renders a static, non-editable preview — same contract as
   *  `MailyDocumentHostProps.editable`. */
  editable: boolean;
  /** Why it's locked, in the caller's own words. Only shown when `!editable`. */
  lockedNotice?: string;
  /** Persist the imported/sanitized doc via `campaigns.updateCampaignDoc`
   *  (which dispatches on the row's own `docFormat`). MUST reject on
   *  failure, mirroring every other composer's `onSave`. */
  onSave: (doc: HtmlPasteDoc) => Promise<unknown>;
  /** Surfaces failures (import errors, image re-host failures) — the screen
   *  owns the toast/Alert. */
  run: ActionRunner["run"];
  /** Present only for a campaign (see `MailyMetaFieldsProps`'s own doc). */
  meta?: MailyMetaFieldsProps;
  /** Present only when the screen has decided this row is eligible to
   *  switch format — see `ComposerFormatSwitch`'s own doc
   *  (`MailyDocumentHost.types.ts`). */
  formatSwitch?: ComposerFormatSwitch;
};
