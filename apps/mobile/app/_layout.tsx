import "../global.css";

import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SupaConvexProvider } from "@supa-media/core/providers";
import { NotificationProvider } from "@supa-media/notifications";
import { ErrorBoundary } from "../components/ErrorBoundary";
import {
  useFonts,
  Corben_400Regular,
  Corben_700Bold,
} from "@expo-google-fonts/corben";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";

/**
 * Root layout for Events OS.
 *
 * Loads the brand type pairing (Corben serif display + DM Sans body) and the
 * NativeWind global stylesheet, then mounts the Convex/auth + notification
 * providers. Route groups under `(app)` and `(auth)` handle gating.
 *
 * `SupaConvexProvider` provides both the Convex client and auth context
 * (it wraps @convex-dev/auth's ConvexAuthProvider with platform-aware secure
 * token storage).
 */
export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Corben_400Regular,
    Corben_700Bold,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <SupaConvexProvider url={process.env.EXPO_PUBLIC_CONVEX_URL}>
            <NotificationProvider>
              <StatusBar style="dark" />
              {/* Catches render errors in any screen so a thrown exception shows
                  a recovery UI instead of a blank tree. Kept below the Convex/
                  auth + notification providers so its recovery Screen still has
                  context, but above the route Slot so it wraps every screen. */}
              <ErrorBoundary>{fontsLoaded ? <Slot /> : null}</ErrorBoundary>
            </NotificationProvider>
          </SupaConvexProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
