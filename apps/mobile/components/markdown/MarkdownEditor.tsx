/**
 * Shared types + default export for the platform-split MarkdownEditor.
 *
 * The real implementations live in:
 *   - MarkdownEditor.web.tsx     (CodeMirror 6 mounted directly into the DOM)
 *   - MarkdownEditor.native.tsx  (the same CM6 setup hosted in a WebView)
 *
 * Metro/Webpack resolve `.web.tsx` / `.native.tsx` by platform automatically.
 * This bare `.tsx` is what TypeScript resolves when you `import` the component
 * without an extension, so it must export the same shape both variants do. We
 * point it at the native implementation (the most conservative default); the
 * bundler swaps in the web build at runtime on web.
 */
export type { MarkdownEditorProps } from "./types";
export { MarkdownEditor as default, MarkdownEditor } from "./MarkdownEditor.native";
