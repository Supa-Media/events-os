import { View, Text, ScrollView, Pressable, Linking } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../../components/ui";
import { MarkdownView } from "../../components/markdown";
import { colors } from "../../lib/theme";

/**
 * PUBLIC, read-only How-To doc — reachable at `/doc/<shareId>` (and via the
 * `eventsos://doc/<shareId>` deep link).
 *
 * Lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups, so it is NOT
 * behind the auth guard — the root layout renders `<Slot/>` inside the Convex
 * provider. It reads the no-auth `api.docs.getPublic` query (by share slug) and
 * renders the doc by kind: markdown/note → read-only render; link/video → a
 * button out to the URL. No chapter data is ever exposed.
 */
export default function DocShareScreen() {
  const { shareId } = useLocalSearchParams<{ shareId: string }>();
  const doc = useQuery(api.docs.getPublic, { shareId: shareId as string });

  if (doc === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: colors.surface }}
        >
          <Text className="text-base text-muted">Loading…</Text>
        </View>
      </>
    );
  }

  if (doc === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: colors.surface }}
        >
          <Icon name="file-text" size={28} color={colors.faint} />
          <Text className="mt-3 text-center text-base text-muted">
            This document link isn't available.
          </Text>
        </View>
      </>
    );
  }

  const isLinkLike = doc.kind === "link" || doc.kind === "video";

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.surface }}
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          paddingVertical: 32,
          paddingHorizontal: 20,
        }}
      >
        <View style={{ width: "100%", maxWidth: 760 }} className="gap-5">
          <Text className="font-display text-3xl text-ink">
            {doc.title || "Untitled"}
          </Text>

          {isLinkLike ? (
            doc.url ? (
              <Pressable
                onPress={() => Linking.openURL(doc.url as string)}
                className="flex-row items-center gap-2 self-start rounded-lg bg-accent px-4 py-2.5 active:opacity-80"
              >
                <Icon
                  name={doc.kind === "video" ? "video" : "external-link"}
                  size={16}
                  color="#fff"
                />
                <Text className="text-sm font-semibold text-white">
                  {doc.kind === "video" ? "Watch video" : "Open link"}
                </Text>
              </Pressable>
            ) : (
              <Text className="text-sm italic text-faint">No link provided.</Text>
            )
          ) : doc.body ? (
            <MarkdownView value={doc.body} />
          ) : (
            <Text className="text-sm italic text-faint">This document is empty.</Text>
          )}
        </View>
      </ScrollView>
    </>
  );
}
