/**
 * What the app shows while it is still starting up: fonts loading, the
 * sign-in being confirmed with the server, the viewer's profile on its way.
 *
 * Each of those phases used to render `null`. On a slow or flaky connection
 * that was a blank white page (Dev2, 2026-11-08: "slow in low data or slow
 * wifi situations, white screen" — and one link from Gmail sat white for over
 * five minutes). Sign-in and the profile both wait on the Convex WebSocket,
 * and a socket that never connects waits forever with nothing on screen to
 * say so.
 *
 * So this is the HTML splash (`public/index.html`) drawn in React, so the
 * hand-off is seamless, plus two things the blank page never had:
 *  - WHICH step it is on, so a screenshot of a stuck load says where it stuck;
 *  - after a while, an honest "can't reach the server" (read from the Convex
 *    client's own connection state) and a Reload button on web.
 *
 * Built from `react-native`, `convex/react` and `lib/theme` only — it renders
 * before fonts and the Tailwind stylesheet can be relied on, and it sits on
 * the startup graph of every route (see `__tests__/startupNativeImports.test.js`).
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useConvex } from "convex/react";
import { colors } from "../lib/theme";

export type BootStage = "app" | "sign-in" | "profile";

const STAGE_LABEL: Record<BootStage, string> = {
  app: "Loading Chapter OS…",
  "sign-in": "Checking your sign-in…",
  profile: "Loading your account…",
};

/** How long a stage may take before we stop pretending it's fine. */
const SLOW_AFTER_MS = 12_000;

type Connection = { connected: boolean; everConnected: boolean; retries: number };

function useConnection(): Connection | null {
  // `undefined` outside a ConvexProvider — `useConvex` doesn't throw there.
  const client = useConvex() as ReturnType<typeof useConvex> | undefined;
  const [state, setState] = useState<Connection | null>(null);
  useEffect(() => {
    if (!client) return;
    const read = () => {
      try {
        const s = client.connectionState();
        setState({
          connected: s.isWebSocketConnected,
          everConnected: s.hasEverConnected,
          retries: s.connectionRetries,
        });
      } catch {
        // A diagnostic only — never let it take the splash down.
      }
    };
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [client]);
  return state;
}

export function BootSplash({ stage = "app" }: { stage?: BootStage }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [stage]);
  const connection = useConnection();
  const offline = connection != null && !connection.connected;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={STAGE_LABEL[stage]}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        backgroundColor: colors.surface,
      }}
    >
      <ActivityIndicator size="small" color={colors.accent} />
      <Text style={{ fontSize: 14, color: colors.ink, opacity: 0.7 }}>
        {STAGE_LABEL[stage]}
      </Text>
      {slow ? (
        <View style={{ alignItems: "center", gap: 12, maxWidth: 320 }}>
          <Text
            style={{
              fontSize: 13,
              color: colors.ink,
              opacity: 0.7,
              textAlign: "center",
            }}
          >
            {offline
              ? "Can't reach the server yet. Your connection may be weak or blocking it — we'll keep trying."
              : "This is taking longer than usual."}
          </Text>
          {Platform.OS === "web" && typeof window !== "undefined" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => window.location.reload()}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: colors.accent,
              }}
            >
              <Text style={{ color: "#ffffff", fontSize: 14, fontWeight: "600" }}>
                Reload
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
