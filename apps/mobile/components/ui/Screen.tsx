import { ReactNode } from "react";
import { View, ActivityIndicator } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { colors } from "../../lib/theme";

type Props = {
  children?: ReactNode;
  /** Show a centered spinner instead of children. */
  loading?: boolean;
  /** Constrain the content to a centered work-app column. */
  maxWidth?: number;
};

/**
 * Width a page passes to <Screen> when it wants its database/grid tables to fill
 * the window (Notion-style — the table starts at the content's left edge and can
 * scroll into the empty space). The page wraps its reading sections in <Narrow>
 * so only the grids span the full width.
 */
export const FULL_WIDTH = 4000;

/** Comfortable reading column width used by <Narrow>. */
export const NARROW_WIDTH = 1180;

/** Caps its children at a comfortable reading width, left-aligned. */
export function Narrow({
  children,
  width = NARROW_WIDTH,
}: {
  children: ReactNode;
  width?: number;
}) {
  return <View style={{ width: "100%", maxWidth: width }}>{children}</View>;
}

/**
 * Page content wrapper used inside the app shell. Scrolls vertically and centers
 * a comfortable max-width column on wide screens (the shell already owns the
 * cream background + sidebar). Padding is generous and consistent.
 */
export function Screen({ children, loading = false, maxWidth = 1080 }: Props) {
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-surface">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <KeyboardAwareScrollView
        contentContainerStyle={{ flexGrow: 1, alignItems: "center" }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ width: "100%", maxWidth }} className="px-6 py-7 sm:px-8 sm:py-8">
          {children}
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}
