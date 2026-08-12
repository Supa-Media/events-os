/**
 * Web variant — unreachable in practice (`FileViewer.tsx` only renders
 * `NativePdfPane` when `!supportsInlinePdf`, which is always `true` on web;
 * see `lib/pdfPages.web.ts`). Kept as a defensive fallback, not a dead
 * assumption: if that ever changes, this still says something sane instead
 * of crashing on an unbundled `react-native-webview`.
 */
import { Text, View } from "react-native";
import type { NativePdfPaneProps } from "./NativePdfPane";

export function NativePdfPane({ filename }: NativePdfPaneProps) {
  return (
    <View className="h-full w-full items-center justify-center px-8">
      <Text className="text-center text-sm text-raised">
        {filename ?? "This PDF"} couldn&apos;t be rendered inline here.
      </Text>
    </View>
  );
}
