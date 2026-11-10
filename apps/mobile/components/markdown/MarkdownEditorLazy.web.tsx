/**
 * The web markdown editor, loaded only when one actually renders.
 *
 * `MarkdownEditor.web.tsx` is CodeMirror — ~0.5 MB of script. It is reached
 * from several routes (docs, share pages, crew briefings, the blog editor,
 * the campaign canvas), and anything two routes share lands in the web
 * build's `__common` chunk, which EVERY page downloads at startup. Behind this
 * one `import()` it becomes its own chunk, fetched the first time a markdown
 * field appears. (Dev2, 2026-11-10: /os/code never finished loading on weak
 * cellular — it has no markdown at all and was paying for CodeMirror.)
 *
 * While the chunk loads, read-only content shows as plain text (so a shared
 * doc is readable at once on a slow connection) and an editor shows a small
 * placeholder. Native imports the editor directly (`MarkdownEditorLazy.tsx`).
 */
import { lazy, Suspense } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { colors } from "../../lib/theme";
import type { MarkdownEditorProps } from "./types";

const Impl = lazy(() =>
  import("./MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);

function Fallback({ value, editable, minHeight }: MarkdownEditorProps) {
  if (editable === false) {
    return (
      <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>
        {value}
      </Text>
    );
  }
  return (
    <View style={{ minHeight: minHeight ?? 120, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="small" color={colors.accent} />
    </View>
  );
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <Suspense fallback={<Fallback {...props} />}>
      <Impl {...props} />
    </Suspense>
  );
}

export default MarkdownEditor;
