import { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Badge, Icon, type IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import type { SaveState } from "./useCourseDraft";

/** A square icon-only button (move up/down, delete) with a 36pt target. */
export function EditorIconButton({
  icon,
  label,
  onPress,
  disabled = false,
  tone = "muted",
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "muted" | "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      className={`h-9 w-9 items-center justify-center rounded-md border border-border bg-raised active:bg-sunken web:hover:bg-sunken ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <Icon
        name={icon}
        size={15}
        color={tone === "danger" ? colors.danger : colors.muted}
      />
    </Pressable>
  );
}

/** Up / down / remove for one item in an ordered list. */
export function MoveControls({
  index,
  count,
  noun,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  noun: string;
  onMove: (to: number) => void;
  onRemove?: () => void;
}) {
  return (
    <View className="flex-row gap-1">
      <EditorIconButton
        icon="arrow-up"
        label={`Move ${noun} up`}
        disabled={index === 0}
        onPress={() => onMove(index - 1)}
      />
      <EditorIconButton
        icon="arrow-down"
        label={`Move ${noun} down`}
        disabled={index === count - 1}
        onPress={() => onMove(index + 1)}
      />
      {onRemove ? (
        <EditorIconButton
          icon="trash-2"
          label={`Remove ${noun}`}
          tone="danger"
          onPress={onRemove}
        />
      ) : null}
    </View>
  );
}

/** Where the draft is: unchanged, waiting to save, saving, saved, failed. */
export function SaveStatus({
  saveState,
  hasDraft,
  isReset,
}: {
  saveState: SaveState;
  hasDraft: boolean;
  isReset: boolean;
}) {
  if (saveState === "error") {
    return <Badge label="Not saved" tone="danger" icon="alert-triangle" />;
  }
  if (saveState === "pending" || saveState === "saving") {
    return <Badge label="Saving…" tone="neutral" />;
  }
  if (isReset) return <Badge label="Draft · back to built-in" tone="warn" />;
  if (hasDraft) return <Badge label="Draft saved" tone="warn" icon="check" />;
  return <Badge label="No changes" tone="neutral" />;
}

/** A small uppercase label over a group of fields. */
export function EditorLabel({ children }: { children: ReactNode }) {
  return (
    <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
      {children}
    </Text>
  );
}

/** The visible circle inside a `Radio` (which is only a pressable wrapper). */
export function RadioDot({ checked }: { checked: boolean }) {
  return (
    <View
      className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
        checked ? "border-success" : "border-border-strong"
      }`}
    >
      {checked ? <View className="h-2.5 w-2.5 rounded-full bg-success" /> : null}
    </View>
  );
}

/** A full-width notice above the editor's content. */
export function EditorBanner({
  text,
  tone = "warn",
  children,
}: {
  text: string;
  tone?: "warn" | "danger" | "success";
  children?: ReactNode;
}) {
  const box = {
    warn: "border-warn-soft bg-warn-bg",
    danger: "border-danger bg-danger-bg",
    success: "border-success-soft bg-success-bg",
  }[tone];
  return (
    <View className={`mb-3 gap-2 rounded-lg border p-3 ${box}`}>
      <Text className="text-sm text-ink">{text}</Text>
      {children ? <View className="flex-row flex-wrap gap-2">{children}</View> : null}
    </View>
  );
}
