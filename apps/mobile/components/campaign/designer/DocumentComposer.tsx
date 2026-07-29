/**
 * DOCUMENT COMPOSER — THE FORMAT SWITCH.
 *
 * `docs/plans/maily-editor-overhaul.md` (WS3): a "blocks"-format row (every
 * campaign/template written before 2026-07-29, and forever afterward — old
 * docs never convert in place, see `@events-os/shared`'s `emailDocFormat.ts`)
 * renders through `BlocksDocumentComposer`, COMPLETELY UNTOUCHED — same
 * canvas, same autosave, same undo/redo, byte-for-byte what used to live in
 * this file under the name `DocumentComposer`. A "tiptap"-format row renders
 * through `MailyDocumentHost` (web: the real maily.to editor; native:
 * read-only + meta fields, per the plan's "Platform" section) instead.
 *
 * The switch itself is one function (`composerHostForFormat`,
 * `composerFormat.ts`) so it's tested as plain data — see that module's tests
 * for "the format switch picks the right host".
 *
 * Both callers (`app/(app)/campaign/[id]/design.tsx`,
 * `app/(app)/campaign-template/[id].tsx`) flow through here exactly as they
 * did before this split — they compute `docFormat` once
 * (`emailDocFormatOf(campaign)` / `emailDocFormatOf(template)`) and build
 * whichever branch of `DocumentComposerProps` matches it.
 */
import { composerHostForFormat } from "./composerFormat";
import { BlocksDocumentComposer, type BlocksDocumentComposerProps } from "./BlocksDocumentComposer";
import { MailyDocumentHost } from "./MailyDocumentHost";
import type { MailyDocumentHostProps } from "./MailyDocumentHost.types";

export type { BlocksDocumentComposerProps } from "./BlocksDocumentComposer";
export type { MailyDocumentHostProps, MailyMetaFieldsProps } from "./MailyDocumentHost.types";
export type { SaveState } from "./BlocksDocumentComposer";

type BlocksBranchProps = { docFormat: "blocks" } & BlocksDocumentComposerProps;
type TiptapBranchProps = { docFormat: "tiptap" } & MailyDocumentHostProps;

/** Discriminated on `docFormat` — TypeScript enforces that a caller building
 *  the "tiptap" branch can't accidentally hand over blocks-only props (an
 *  `onApplyTheme`, an `EmailDocument`) and vice versa. */
export type DocumentComposerProps = BlocksBranchProps | TiptapBranchProps;

export function DocumentComposer(props: DocumentComposerProps) {
  const host = composerHostForFormat(props.docFormat);
  if (host === "tiptap") {
    const { docFormat: _docFormat, ...hostProps } = props as TiptapBranchProps;
    return <MailyDocumentHost {...hostProps} />;
  }
  const { docFormat: _docFormat, ...hostProps } = props as BlocksBranchProps;
  return <BlocksDocumentComposer {...hostProps} />;
}
