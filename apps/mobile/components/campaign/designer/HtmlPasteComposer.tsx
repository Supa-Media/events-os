/**
 * Shared type + default export for the platform-split "Paste HTML" host.
 *
 * The real implementations live in:
 *   - HtmlPasteComposer.web.tsx     (the textarea + Import/Preview action +
 *     the reused preview pane — see that file's module doc)
 *   - HtmlPasteComposer.native.tsx  (read-only: meta fields + server preview
 *     + a "pasting happens on the web app" notice — "Paste HTML" is a
 *     web-only composing surface per the task brief, same "editing happens
 *     on the web app" posture `MailyDocumentHost.native.tsx` already
 *     established for the tiptap editor)
 *
 * Metro/Webpack resolve `.web.tsx` / `.native.tsx` by platform automatically;
 * this bare `.tsx` is what TypeScript/Jest resolve for an extensionless
 * import — mirrors `MailyDocumentHost.tsx`'s identical bridge file exactly.
 * Points at the native (conservative, no-DOM) variant; the bundler swaps in
 * the web build at runtime on web.
 */
export type { HtmlPasteComposerProps, HtmlPasteDoc } from "./HtmlPasteComposer.types";
export {
  HtmlPasteComposer as default,
  HtmlPasteComposer,
} from "./HtmlPasteComposer.native";
