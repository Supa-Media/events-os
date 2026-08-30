import "../global.css";

import { Fragment, useEffect, useState } from "react";
import Constants from "expo-constants";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SupaConvexProvider } from "@supa-media/core/providers";
import { loadNotificationProvider } from "../lib/notificationProvider";
import { loadKeyboardController } from "../lib/keyboardController";
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

  // Push is gated on the native module being in THIS build (see
  // `lib/notificationProvider.ts`). On a build without it we render a
  // pass-through instead, so a missing feature module can never stop the app
  // from starting.
  const Notifications = loadNotificationProvider() ?? Fragment;
  // Keyboard avoidance is an enhancement, gated the same way: without the
  // native module a form still renders and scrolls.
  const Keyboard = loadKeyboardController()?.KeyboardProvider ?? Fragment;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Keyboard>
        <SafeAreaProvider>
          {/* OUTER boundary — wraps the providers themselves.
              
              Without it, a throw from `SupaConvexProvider` or
              `NotificationProvider` while they mount has nothing above it to
              catch it: React unmounts the whole tree, RN reports a fatal JS
              error, and on a release build expo-updates' ErrorRecovery
              escalates that to a native abort. What reaches you then is a
              SIGABRT crash log whose only frames are `ErrorRecovery.crash()`
              — the JS error that actually caused it is nowhere in the report,
              which is exactly how a startup crash becomes undiagnosable.
              
              This boundary is deliberately OUTSIDE both providers and uses
              only `View`/`Text`/`Screen`, none of which need Convex or
              notification context. The inner boundary below stays where it is:
              it wraps the route tree, where the recovery UI SHOULD have those
              contexts available. */}
          <ErrorBoundary>
            {/* extra.convexUrl is the env URL with loopback rewritten to the
                machine's LAN IP at dev-server start (see app.config.js) —
                Chrome blocks cross-origin loopback and devices can't reach it. */}
            <SupaConvexProvider
              url={
                Constants.expoConfig?.extra?.convexUrl ??
                process.env.EXPO_PUBLIC_CONVEX_URL
              }
            >
              <Notifications>
                <StatusBar style="dark" />
                {/* Catches render errors in any screen so a thrown exception
                    shows a recovery UI instead of a blank tree. Kept below the
                    Convex/auth + notification providers so its recovery Screen
                    still has context, but above the route Slot so it wraps
                    every screen. */}
                <ErrorBoundary>{showApp ? <Slot /> : null}</ErrorBoundary>
              </Notifications>
            </SupaConvexProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </Keyboard>
    </GestureHandlerRootView>
  );
}
