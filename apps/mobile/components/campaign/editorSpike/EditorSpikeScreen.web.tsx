/**
 * EditorSpikeScreen (web) — WS0 spike for `docs/plans/maily-editor-overhaul.md`
 * Bet 1: does `@maily-to/core@0.3.7`'s `<Editor>` mount under react-native-web
 * + Metro, and does the `extensions` prop really accept a hand-rolled Tiptap
 * node (`pwProbe`, see ./pwProbeNode.ts)?
 *
 * react-native-web is React DOM under the hood (same trick `MarkdownEditor.web`
 * uses for CodeMirror), so a plain DOM-mounted `<Editor>` renders inside an RN
 * screen with no wrapper needed.
 *
 * CSS: `@maily-to/core` ships its stylesheet as `dist/index.css` (also
 * reachable via the package's `./style.css` export condition). Imported here
 * as a bare side-effecting import — Expo's Metro web config enables `.css` as
 * a first-class bundlable extension by default (`isCSSEnabled: true` in
 * `@expo/metro-config`, confirmed by reading
 * `node_modules/@expo/metro-config/build/ExpoMetroConfig.js`), independent of
 * NativeWind's own CSS pipeline (NativeWind only owns `global.css`'s Tailwind
 * directives). No Metro config change was needed for this import to resolve
 * at the bundler-graph level; Metro itself could not be run in this sandbox
 * (no `pnpm dev`/`expo start` here) so this is unverified at the ACTUAL
 * bundle-and-serve level — CI's deploy build is the real gate, which is why
 * this screen stays behind the same access gate every other Emails-desk
 * screen uses rather than shipping into a nav tab.
 *
 * SPIKE ONLY: no autosave, no `campaigns.doc` wiring, no save button. Do not
 * build on top of this file — it is deleted (or replaced by WS3's real host
 * screen) once the spike's verdict lands in the plan doc.
 */
import "@maily-to/core/dist/index.css";

import { useState } from "react";
import { View, Text } from "react-native";
import { Editor } from "@maily-to/core";

import { pwProbeNode } from "./pwProbeNode";

const SPIKE_EXTENSIONS = [pwProbeNode];

export function EditorSpikeScreen() {
  // No persistence — this only proves the editor mounts and is interactive.
  const [mounted, setMounted] = useState(false);

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 13, opacity: 0.7 }}>
        WS0 spike — maily.to `&lt;Editor&gt;` mounted directly (react-native-web is React
        DOM). Not wired to campaigns.doc. See docs/plans/maily-editor-overhaul.md.
      </Text>
      <View
        style={{
          flex: 1,
          minHeight: 320,
          borderWidth: 1,
          borderColor: "#EFE0DC",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <Editor
          contentHtml="<p>WS0 spike — type here to prove the editor is live.</p>"
          extensions={SPIKE_EXTENSIONS}
          onCreate={() => setMounted(true)}
        />
      </View>
      <Text style={{ fontSize: 12, opacity: 0.5 }}>
        {mounted ? "Editor onCreate fired — mounted." : "Waiting for onCreate…"}
      </Text>
    </View>
  );
}

export default EditorSpikeScreen;
