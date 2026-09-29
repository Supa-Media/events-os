/**
 * The org chart's one modal shell — dimmed backdrop, a centered card, a
 * titled header with a close button, a scrolling body, and an optional
 * footer. The picker, the Powers directory, "Reports to", and Add seat all
 * use it, so they read as one family instead of four hand-built overlays.
 */
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

export function OrgModal({
  visible,
  title,
  subtitle,
  onClose,
  header,
  footer,
  children,
  wide = false,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Pinned under the title, above the scrolling body (search boxes, filters). */
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** The picker and directory want room for descriptions; forms don't. */
  wide?: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-4">
        <Pressable
          onPress={() => {}}
          className={`max-h-[90%] w-full overflow-hidden rounded-xl border border-border bg-raised shadow-pop ${
            wide ? "max-w-2xl" : "max-w-md"
          }`}
        >
          <View className="gap-3 border-b border-border px-5 py-4">
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1 gap-0.5">
                <Text className="font-display text-lg text-ink" numberOfLines={2}>
                  {title}
                </Text>
                {subtitle ? <Text className="text-xs text-muted">{subtitle}</Text> : null}
              </View>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                className="rounded-md p-1"
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            {header}
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          {footer ? (
            <View className="flex-row flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3">
              {footer}
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A search box in the house style, for the modal headers above. */
export function SearchBox({
  value,
  onChangeText,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-2 rounded-md border border-border-strong bg-surface px-3">
      <Icon name="search" size={15} color={colors.faint} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus={autoFocus}
        autoCorrect={false}
        accessibilityLabel={placeholder}
        className="flex-1 py-2.5 text-base text-ink"
      />
    </View>
  );
}
