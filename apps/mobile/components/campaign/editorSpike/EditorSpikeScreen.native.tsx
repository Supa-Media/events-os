/**
 * EditorSpikeScreen (native) — WS0 spike, native side.
 *
 * maily's `<Editor>` is a contenteditable DOM component (Tiptap/ProseMirror);
 * it must NEVER be imported into a native bundle — this repo has already
 * shipped a crash from a DOM-only component reaching native (see
 * `MarkdownEditor.native.tsx`'s WebView-hosting workaround, adopted for
 * exactly this reason). This file is the `.native.tsx` sibling Metro/Webpack
 * resolve on iOS/Android instead of `EditorSpikeScreen.web.tsx`, so `@maily-to/
 * core` is never even imported on native — no bundle-time or runtime risk.
 *
 * The plan (`docs/plans/maily-editor-overhaul.md`, "Platform") already scopes
 * v1 editing to web; a WebView-hosted editor with a bundled (not CDN) asset is
 * a follow-up stage, not part of this spike.
 */
import { View, Text } from "react-native";

export function EditorSpikeScreen() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ fontSize: 15, fontWeight: "600", textAlign: "center" }}>
        WS0 editor spike is web only
      </Text>
      <Text style={{ fontSize: 13, opacity: 0.7, textAlign: "center", marginTop: 8 }}>
        maily.to&apos;s editor is a contenteditable DOM component. Open this screen in a
        browser to try it.
      </Text>
    </View>
  );
}

export default EditorSpikeScreen;
