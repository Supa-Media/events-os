/**
 * CSV platform hookup — hands a serialized CSV string (`csv.ts#toCsv`) to the
 * platform: a file download on web, the OS share sheet elsewhere. Kept
 * separate from `csv.ts` because it imports `react-native` (that file must
 * stay dependency-free for jest to load it without the RN transform).
 *
 * Web downloads via a Blob + an anchor click — the same `document`-driven
 * pattern the receipt picker in `giving/gifts.tsx` already uses for its web
 * file input. Native has no expo-file-system/expo-sharing dependency in this
 * repo yet (checked `package.json` — neither is installed, and this PR isn't
 * adding a new one for it), so native hands the CSV to React Native's
 * built-in `Share` API instead: iOS gets a `data:` URI (Share's `url` field
 * renders a proper file preview there); Android's `Share.share` has no `url`
 * support, so it falls back to sharing the raw CSV text as the message body.
 */
import { Platform, Share } from "react-native";

/** `filename` should include the `.csv` extension. */
export async function exportCsv(filename: string, csv: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof document === "undefined") return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }
  if (Platform.OS === "ios") {
    const dataUri = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    await Share.share({ url: dataUri, title: filename });
    return;
  }
  // Android's Share has no `url` support — share the CSV text itself.
  await Share.share({ message: csv, title: filename });
}
