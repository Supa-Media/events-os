import { Platform } from "react-native";

/**
 * Copy text to the system clipboard, returning whether it succeeded.
 *
 * Web uses the async Clipboard API (available on the localhost/https origins the
 * app runs on). Native isn't wired yet — `expo-clipboard` isn't reachable from
 * this workspace's registry — so it reports failure rather than pretending to
 * succeed, letting the caller skip its "Copied" confirmation.
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
    return false;
  } catch {
    return false;
  }
}
