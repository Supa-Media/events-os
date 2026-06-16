/**
 * Surfacing mutation / action FAILURES to the user.
 *
 * Today most call sites `void myMutation(args)` and silently swallow rejections,
 * so a failed save just looks like nothing happened. This hook wraps a call,
 * catches the rejection, extracts a human-readable message via `lib/errors`'
 * {@link errorMessage}, and shows it — cross-platform and dependency-free:
 *
 *  - native: `Alert.alert(title, message)` (mirrors event/[id].tsx),
 *  - web: a non-blocking inline toast exposed via `toast` (render `<ToastView>`),
 *    falling back to `window.alert` if the consumer doesn't render it.
 *
 * Usage:
 *   const { run, toast, dismiss } = useActionRunner();
 *   run(() => save(args), { errorTitle: "Couldn't save" });
 *   // …and render <ToastView toast={toast} onDismiss={dismiss} /> somewhere.
 */
import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";
import { errorMessage } from "./errors";

/** A surfaced failure — `title` is the action context, `message` the reason. */
export type ActionToast = { title: string; message: string };

export type RunOptions = {
  /** Heading shown with the error (e.g. "Couldn't save"). */
  errorTitle?: string;
  /** Called after a SUCCESSFUL run, with the resolved value. */
  onSuccess?: (value: unknown) => void;
};

const DEFAULT_TITLE = "Something went wrong";

export type ActionRunner = {
  /**
   * Run an async action; on rejection, extract + surface a message. Returns the
   * resolved value on success, or `undefined` if it threw (already surfaced).
   */
  run: <T>(action: () => Promise<T>, options?: RunOptions) => Promise<T | undefined>;
  /** The current web toast (null when none). Native shows an Alert instead. */
  toast: ActionToast | null;
  /** Dismiss the current web toast. */
  dismiss: () => void;
};

/**
 * Hook returning a `run` wrapper plus web toast state. On native it routes
 * failures to `Alert.alert`; on web it sets `toast` state for an inline banner.
 */
export function useActionRunner(): ActionRunner {
  const [toast, setToast] = useState<ActionToast | null>(null);
  // Keep `run` stable across renders.
  const showRef = useRef<(t: ActionToast) => void>(() => {});
  showRef.current = (t: ActionToast) => {
    if (Platform.OS === "web") {
      setToast(t);
    } else {
      // Lazy require so web bundles don't carry the native Alert path eagerly.
      const { Alert } = require("react-native") as typeof import("react-native");
      Alert.alert(t.title, t.message);
    }
  };

  const run = useCallback(
    async <T,>(
      action: () => Promise<T>,
      options?: RunOptions,
    ): Promise<T | undefined> => {
      try {
        const value = await action();
        options?.onSuccess?.(value);
        return value;
      } catch (err) {
        showRef.current({
          title: options?.errorTitle ?? DEFAULT_TITLE,
          message: errorMessage(err),
        });
        return undefined;
      }
    },
    [],
  );

  const dismiss = useCallback(() => setToast(null), []);

  return { run, toast, dismiss };
}
