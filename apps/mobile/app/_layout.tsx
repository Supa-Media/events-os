import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SupaConvexProvider } from "@supa/core/providers";
import { NotificationProvider } from "@supa/notifications";

/**
 * Root layout for Events OS.
 *
 * `SupaConvexProvider` provides both the Convex client and auth context
 * (it wraps @convex-dev/auth's ConvexAuthProvider with platform-aware secure
 * token storage). Route groups under `(app)` and `(auth)` handle gating.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SupaConvexProvider url={process.env.EXPO_PUBLIC_CONVEX_URL}>
        <NotificationProvider>
        <StatusBar style="auto" />
        <Slot />
        </NotificationProvider>
      </SupaConvexProvider>
    </SafeAreaProvider>
  );
}
