import * as Clipboard from "expo-clipboard";
import { Platform } from "react-native";

/**
 * Copy text to the system clipboard, returning whether it succeeded.
 *
 * Web keeps using the browser Clipboard API on secure origins. Native delegates
 * to Expo's clipboard module. Either path reports failure rather than showing a
 * confirmation for text that was not actually copied.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      Platform.OS === "web" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard?.writeText
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    if (Platform.OS !== "web") {
      await Clipboard.setStringAsync(text);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
