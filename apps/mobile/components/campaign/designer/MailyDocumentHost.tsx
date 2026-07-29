/**
 * Shared type + default export for the platform-split maily host.
 *
 * The real implementations live in:
 *   - MailyDocumentHost.web.tsx     (the real `@maily-to/core` `<Editor>`,
 *     meta strip, image library, live-ish preview)
 *   - MailyDocumentHost.native.tsx  (read-only: meta fields + server preview
 *     + a "editing happens on the web app" notice)
 *
 * Metro/Webpack resolve `.web.tsx` / `.native.tsx` by platform automatically;
 * this bare `.tsx` is what TypeScript resolves for an extensionless import —
 * mirrors `markdown/MarkdownEditor.tsx` and `email/EmailHtmlPreview.tsx`'s
 * bridge files exactly. Points at the native (conservative, no-DOM) variant;
 * the bundler swaps in the web build at runtime on web.
 */
export type {
  MailyDocumentHostProps,
  MailyMetaFieldsProps,
} from "./MailyDocumentHost.types";
export {
  MailyDocumentHost as default,
  MailyDocumentHost,
} from "./MailyDocumentHost.native";
