/**
 * Extensionless stub for the platform-split EditorSpikeScreen — same purpose
 * as `MarkdownEditor.tsx`: TypeScript resolves this bare `.tsx` when the
 * import has no platform suffix; Metro/Webpack swap in `.web.tsx` or
 * `.native.tsx` at bundle time. Points at the native (conservative) variant.
 */
export { EditorSpikeScreen as default, EditorSpikeScreen } from "./EditorSpikeScreen.native";
