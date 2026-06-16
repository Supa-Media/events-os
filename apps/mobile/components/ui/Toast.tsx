/**
 * Inline failure banner for the web path of {@link useActionRunner}. Native
 * surfaces failures via `Alert.alert`, so this only renders when there's a web
 * `toast`. Render it once near a screen root and pass the hook's `toast` +
 * `dismiss`:
 *
 *   const { run, toast, dismiss } = useActionRunner();
 *   <ToastView toast={toast} onDismiss={dismiss} />
 */
import { View, Text, Pressable } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";
import type { ActionToast } from "../../lib/useActionToast";

export function ToastView({
  toast,
  onDismiss,
}: {
  toast: ActionToast | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  return (
    <View className="flex-row items-start gap-2 rounded-md border border-danger bg-danger-bg px-3 py-2.5">
      <Icon name="alert-circle" size={16} color={colors.danger} />
      <View className="flex-1">
        <Text className="text-sm font-semibold text-danger">{toast.title}</Text>
        <Text className="text-sm text-ink">{toast.message}</Text>
      </View>
      <Pressable
        onPress={onDismiss}
        hitSlop={6}
        accessibilityLabel="Dismiss"
        className="rounded p-0.5 active:opacity-70"
      >
        <Icon name="x" size={15} color={colors.muted} />
      </Pressable>
    </View>
  );
}
