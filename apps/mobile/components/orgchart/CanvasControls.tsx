import { Pressable, Text, View } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

/**
 * The small, unobtrusive zoom controls in the canvas's bottom-right corner —
 * the mouse-only fallback for a caller with no trackpad (owner: "some type of
 * default if there isn't a trackpad"). Trackpad pinch / two-finger scroll (web)
 * and pinch/pan gestures (native) are the PRIMARY way to navigate; this is
 * deliberately small and out of the way, never a plus/minus-first UX.
 */
export function CanvasControls({
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  /** Current scale, shown as a percentage (e.g. "100%"). */
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <View
      pointerEvents="box-none"
      className="absolute bottom-4 right-4 z-40 flex-row items-center gap-1 rounded-md border border-border bg-raised px-1 py-1 shadow-card"
    >
      <ControlButton icon="zoom-out" label="Zoom out" onPress={onZoomOut} />
      <Text className="min-w-[38px] text-center text-xs font-semibold text-muted">
        {Math.round(scale * 100)}%
      </Text>
      <ControlButton icon="zoom-in" label="Zoom in" onPress={onZoomIn} />
      <View className="mx-0.5 h-5 w-px bg-border" />
      <ControlButton icon="maximize" label="Fit to screen" onPress={onFit} />
    </View>
  );
}

function ControlButton({
  icon,
  label,
  onPress,
}: {
  icon: "zoom-in" | "zoom-out" | "maximize";
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      className="h-7 w-7 items-center justify-center rounded-sm active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name={icon} size={15} color={colors.muted} />
    </Pressable>
  );
}
