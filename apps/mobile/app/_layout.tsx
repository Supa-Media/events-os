import "../global.css";

import { useEffect, useState } from "react";
import Constants from "expo-constants";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Text, View } from "react-native";
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

  // extra.convexUrl is the env URL with loopback rewritten to the machine's
  // LAN IP at dev-server start (see app.config.js) — Chrome blocks
  // cross-origin loopback and devices can't reach it.
  const convexUrl =
    Constants.expoConfig?.extra?.convexUrl ??
    process.env.EXPO_PUBLIC_CONVEX_URL;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          {/* OUTER boundary — it exists specifically to catch a throw from the
              providers below it, which the inner one cannot: a boundary only
              catches its own subtree. `SupaConvexProvider` constructs a
              ConvexReactClient during render, and that throws outright on a
              missing address. Unhandled at startup, expo-updates treats it as
              a failed bundle, exhausts its recovery tasks and ABORTS the
              process — TestFlight build 8 died 0.4s after launch that way,
              leaving only a native SIGABRT stack. A caught error shows a
              recovery screen instead. Placed inside SafeAreaProvider so the
              recovery UI still has insets; it needs no Convex/auth context. */}
          <ErrorBoundary>
            {convexUrl ? (
              <SupaConvexProvider url={convexUrl}>
                <NotificationProvider>
                  <StatusBar style="dark" />
                  {/* Inner boundary: render errors in any SCREEN. Kept below
                      the providers so its recovery UI still has their
                      context, and above the Slot so it wraps every route. */}
                  <ErrorBoundary>{showApp ? <Slot /> : null}</ErrorBoundary>
                </NotificationProvider>
              </SupaConvexProvider>
            ) : (
              /* Never reachable from a correctly built binary — app.config.js
                 refuses to build one without EXPO_PUBLIC_CONVEX_URL. It's here
                 so that if one ever escapes anyway, it says what is wrong
                 instead of aborting on launch with a stack that names none of
                 this. */
              <MissingBackendNotice />
            )}
          </ErrorBoundary>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/** Shown only when the app was built without a Convex URL. Deliberately plain:
 *  no Convex, no auth, no data — the point is that it can always render. */
function MissingBackendNotice() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ fontSize: 17, fontWeight: "600", marginBottom: 8, textAlign: "center" }}>
        This build can't reach its server
      </Text>
      <Text style={{ fontSize: 14, opacity: 0.7, textAlign: "center" }}>
        It was built without a backend URL, so there's nothing to sign in to.
        Please report this build — a new one is needed.
      </Text>
    </View>
  );
}
