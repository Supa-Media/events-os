/**
 * The Maily email designer, loaded only when a tiptap-format document opens.
 *
 * `MailyDocumentHost.web.tsx` pulls Maily, TipTap, ProseMirror, Yjs, lowlight
 * and the whole Lucide icon set — well over 1 MB of script. Two routes reach it
 * (campaign design, campaign templates), which put all of it in the web
 * build's shared `__common` chunk that every page downloads at startup
 * (Dev2, 2026-11-10: /os/code stuck loading on weak cellular). Behind this one
 * `import()` it is its own chunk instead. Native imports it directly
 * (`MailyDocumentHostLazy.tsx`).
 */
import { lazy, Suspense } from "react";
import { ActivityIndicator, View } from "react-native";
import { colors } from "../../../lib/theme";
import type { MailyDocumentHostProps } from "./MailyDocumentHost.types";

const Impl = lazy(() =>
  import("./MailyDocumentHost").then((m) => ({ default: m.MailyDocumentHost })),
);

export function MailyDocumentHost(props: MailyDocumentHostProps) {
  return (
    <Suspense
      fallback={
        <View style={{ flex: 1, minHeight: 240, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}

export default MailyDocumentHost;
