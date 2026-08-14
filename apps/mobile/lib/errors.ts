import { Alert, Platform } from "react-native";
import { ConvexError } from "convex/values";

/**
 * Surface a human-readable message from a thrown error. ConvexError payloads
 * (the app throws `{ code, message }`) are unwrapped so the user sees the real
 * reason; falls back to the provided default otherwise.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * The machine CODE from a ConvexError payload (`{ code, message }`), or `null`
 * for anything else that was thrown.
 *
 * The counterpart to `errorMessage` above, and it exists for exactly one
 * shape of caller: a bulk action that runs the per-row mutation N times and
 * has to GROUP the refusals ("3 still owe money back · 2 need a receipt
 * first") rather than showing whichever one rejected first. The message is
 * what a person reads; the code is what the failures are grouped by, and
 * grouping on the sentence would re-group the moment somebody rewords it.
 */
export function errorCode(err: unknown): string | null {
  if (err instanceof ConvexError) {
    const data = err.data as { code?: string } | undefined;
    if (typeof data?.code === "string") return data.code;
  }
  return null;
}

/**
 * Show a thrown error to the user — window.alert on web, Alert.alert on
 * native. For fire-and-forget mutations (commit-on-blur cells, tap actions)
 * where a server rejection would otherwise be a silent no-op.
 */
export function alertError(err: unknown): void {
  const message = errorMessage(err);
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.alert(message);
    return;
  }
  Alert.alert("Something went wrong", message);
}

/**
 * Cross-platform INFO confirmation — same web/native split as `alertError`,
 * for a non-error notice a fire-and-forget cell edit needs to surface (e.g.
 * "this row will disappear from the list now" after a $0 edit that
 * technically succeeded — a silent vanish reads as a bug even when it isn't).
 */
export function alertInfo(message: string, title = "Note"): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.alert(message);
    return;
  }
  Alert.alert(title, message);
}
