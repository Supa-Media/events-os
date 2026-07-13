import "../global.css";

import { useEffect, useState } from "react";
import Constants from "expo-constants";
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
 * Root layout for Chapter OS.
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
  const [fontsLoaded, fontError] = useFonts({
    Corben_400Regular,
    Corben_700Bold,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
  });

  // Never let fonts hold the app hostage. expo-font's web loader
  // (fontfaceobserver) can reject after 6s — or stall forever without
  // resolving OR erroring — which used to leave a permanently blank page.
  // After a short grace period we render with fallback fonts; the @font-face
  // rules are already registered, so the brand type still swaps in whenever
  // the files finish loading.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), 2000);
    return () => clearTimeout(t);
  }, []);
  const showApp = fontsLoaded || fontError != null || graceOver;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          {/* extra.convexUrl is the env URL with loopback rewritten to the
              machine's LAN IP at dev-server start (see app.config.js) —
              Chrome blocks cross-origin loopback and devices can't reach it. */}
          <SupaConvexProvider
            url={
              Constants.expoConfig?.extra?.convexUrl ??
              process.env.EXPO_PUBLIC_CONVEX_URL
            }
          >
            <NotificationProvider>
              <StatusBar style="dark" />
              {/* Catches render errors in any screen so a thrown exception shows
                  a recovery UI instead of a blank tree. Kept below the Convex/
                  auth + notification providers so its recovery Screen still has
                  context, but above the route Slot so it wraps every screen. */}
              <ErrorBoundary>{showApp ? <Slot /> : null}</ErrorBoundary>
            </NotificationProvider>
          </SupaConvexProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
