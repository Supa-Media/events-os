/**
 * What the app shows while it is still starting up: fonts loading, the
 * sign-in token being checked, the viewer's profile on its way.
 *
 * Each of those phases used to render `null`, so on a slow connection the
 * page went from the HTML splash (`public/index.html`) to a blank page for
 * several more seconds (Dev2, 2026-11-08: "slow in low data or slow wifi
 * situations, white screen"). This is the same splash drawn in React, so the
 * hand-off from HTML to app is seamless: the spinner stays put until a screen
 * is ready.
 *
 * Deliberately built from `react-native` and `lib/theme` only — it renders
 * before fonts, providers and the Tailwind stylesheet can be relied on, and it
 * sits on the startup graph of every route (see
 * `__tests__/startupNativeImports.test.js`).
 */
import { ActivityIndicator, Text, View } from "react-native";
import { colors } from "../lib/theme";

export function BootSplash() {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Chapter OS"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        backgroundColor: colors.surface,
      }}
    >
      <ActivityIndicator size="small" color={colors.accent} />
      <Text style={{ fontSize: 14, color: colors.ink, opacity: 0.7 }}>
        Loading Chapter OS…
      </Text>
    </View>
  );
}
