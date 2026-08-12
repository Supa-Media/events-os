/**
 * Cross-platform confirm: `window.confirm` on web, `Alert.alert` on native.
 *
 * A handful of finance surfaces (`components/event/ticketing/helpers.ts`,
 * `components/campaign/helpers.ts`) each carry their own copy of this exact
 * shape already — this is the shared version for anything new, so a THIRD
 * copy doesn't appear. See `FinishChargeSheet.tsx`'s "Done" button (Finding
 * 10, UX audit 2026-08-12) for the first caller.
 */
import { Alert, Platform } from "react-native";

export function confirmAction({
  title,
  message,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}): void {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm(`${title}\n\n${message}`)
    ) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmLabel,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}
