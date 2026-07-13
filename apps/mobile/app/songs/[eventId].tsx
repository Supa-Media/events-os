import { useState, type ReactNode } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon, TextField, Button } from "../../components/ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * PUBLIC, no-auth song-request page — reachable at `/songs/<eventId>` (the URL a
 * printed QR code points at).
 *
 * Lives under `app/` OUTSIDE the `(app)`/`(auth)` route groups, so it is NOT
 * behind the auth guard (the root layout renders `<Slot/>` inside the Convex
 * provider). It reads the no-auth `api.setlists.publicBoard` and writes via
 * `api.setlists.submitRequest`. The congregation can follow the current song's
 * lyrics, tap a suggested song to request it, or type any other song. No chapter
 * data, roster, or money is ever exposed.
 */
export default function PublicSongsScreen() {
  const { eventId: rawId } = useLocalSearchParams<{ eventId: string }>();
  const eventId = rawId as Id<"events">;
  const board = useQuery(api.setlists.publicBoard, { eventId });
  const submit = useMutation(api.setlists.submitRequest);

  const [name, setName] = useState("");
  const [willSing, setWillSing] = useState(false);
  const [songTitle, setSongTitle] = useState("");
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(args: { songId?: Id<"songs">; title: string }) {
    if (busy) return;
    const trimmedName = name.trim();
    // Offering to sing only makes sense with a name attached.
    if (willSing && !trimmedName) {
      setError("Add your name so the team knows who's singing.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submit({
        eventId,
        songId: args.songId,
        songTitle: args.title,
        requesterName: trimmedName || undefined,
        note: note.trim() || undefined,
        willSing: willSing || undefined,
      });
      setConfirmation(
        willSing && trimmedName
          ? `Thanks ${trimmedName}! The team knows you'd love to help sing “${args.title}”.`
          : `Thanks! We passed “${args.title}” to the worship team.`,
      );
      setSongTitle("");
      setNote("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (board === undefined) {
    return (
      <Centered>
        <Text className="text-base text-muted">Loading…</Text>
      </Centered>
    );
  }
  if (board === null) {
    return (
      <Centered>
        <Icon name="music" size={28} color={colors.faint} />
        <Text className="mt-3 text-center text-base text-muted">
          This song-request link isn't available.
        </Text>
      </Centered>
    );
  }

  const { eventName, requestsOpen, currentSong, suggestions } = board;

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
        <View style={{ width: "100%", maxWidth: 640 }} className="gap-6">
          {/* Header */}
          <View className="gap-1">
            <Text className="text-xs font-bold uppercase tracking-wider text-accent">
              {eventName}
            </Text>
            <Text className="font-display text-3xl text-ink">Request a song</Text>
            <Text className="text-sm text-faint">
              Tap a song below, or type any other you'd love to sing.
            </Text>
          </View>

          {/* Now singing — current lyrics to follow along */}
          {currentSong ? (
            <View
              className="gap-1 rounded-lg border-2 bg-raised p-4"
              style={{ borderColor: colors.accent }}
            >
              <View className="flex-row items-center gap-2">
                <Icon name="music" size={15} color={colors.accent} />
                <Text className="text-xs font-bold uppercase tracking-wide text-accent">
                  Now singing
                </Text>
              </View>
              <Text className="text-xl font-bold text-ink">{currentSong.title}</Text>
              {currentSong.author ? (
                <Text className="text-sm text-muted">{currentSong.author}</Text>
              ) : null}
              {currentSong.lyrics ? (
                <Text className="mt-2 text-base leading-7 text-ink">
                  {currentSong.lyrics}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Confirmation banner after a successful request */}
          {confirmation ? (
            <View
              className="flex-row items-start gap-2 rounded-lg border border-border bg-raised p-3"
              style={{ borderColor: colors.success }}
            >
              <Icon name="check-circle" size={18} color={colors.success} />
              <Text className="flex-1 text-base text-ink">{confirmation}</Text>
            </View>
          ) : null}

          {!requestsOpen ? (
            <View className="rounded-lg border border-border bg-sunken p-4">
              <Text className="text-base text-muted">
                Requests are closed right now — enjoy the worship! 🙏
              </Text>
            </View>
          ) : (
            <>
              {/* Your details — shared by suggestion taps AND the form below, so
                  a name / "I'll sing" offer rides along with whatever you pick. */}
              <View className="gap-1 rounded-lg border border-border bg-raised p-4">
                <TextField
                  label="Your name"
                  value={name}
                  onChangeText={setName}
                  placeholder="Optional"
                />
                <Pressable
                  onPress={() => setWillSing((v) => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: willSing }}
                  accessibilityLabel="I'll help sing this one"
                  className="flex-row items-center gap-2.5 py-1 active:opacity-70"
                >
                  <View
                    className="h-6 w-6 items-center justify-center rounded-md border-2"
                    style={{
                      borderColor: willSing ? colors.accent : colors.border,
                      backgroundColor: willSing ? colors.accent : "transparent",
                    }}
                  >
                    {willSing ? <Icon name="check" size={15} color="#fff" /> : null}
                  </View>
                  <Icon name="mic" size={15} color={colors.muted} />
                  <Text className="flex-1 text-base text-ink">
                    I'll help sing this one
                  </Text>
                </Pressable>
                {willSing ? (
                  <Text className="text-xs text-muted">
                    Add your name above so the worship leader knows who to find.
                  </Text>
                ) : null}
              </View>

              {/* Suggested songs */}
              {suggestions.length > 0 ? (
                <View className="gap-2">
                  <Text className="text-sm font-bold uppercase tracking-wide text-faint">
                    Suggestions
                  </Text>
                  <View className="gap-2">
                    {suggestions.map((s) => (
                      <Pressable
                        key={s.songId}
                        onPress={() => send({ songId: s.songId as Id<"songs">, title: s.title })}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Request ${s.title}`}
                        className="flex-row items-center gap-3 rounded-lg border border-border bg-raised px-4 py-3 active:bg-sunken web:hover:bg-sunken"
                      >
                        <Icon name="plus-circle" size={18} color={colors.accent} />
                        <View className="flex-1">
                          <Text className="text-base font-semibold text-ink">
                            {s.title}
                          </Text>
                          {s.author ? (
                            <Text className="text-xs text-muted">{s.author}</Text>
                          ) : null}
                        </View>
                        {s.count > 0 ? (
                          <View className="flex-row items-center gap-1 rounded-pill bg-sunken px-2 py-0.5">
                            <Icon name="heart" size={12} color={colors.accent} />
                            <Text className="text-xs font-bold text-muted">
                              {s.count}
                            </Text>
                          </View>
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}

              {/* Free-text request form */}
              <View className="gap-1 rounded-lg border border-border bg-raised p-4">
                <Text className="mb-1 text-sm font-bold uppercase tracking-wide text-faint">
                  Request another
                </Text>
                <TextField
                  label="Song"
                  value={songTitle}
                  onChangeText={setSongTitle}
                  placeholder="Song name"
                />
                <TextField
                  label="Note"
                  value={note}
                  onChangeText={setNote}
                  placeholder="Optional — anything you'd like the team to know"
                />
                {error ? (
                  <Text className="mb-1 text-sm text-danger">{error}</Text>
                ) : null}
                <Button
                  title={busy ? "Sending…" : "Send request"}
                  icon="send"
                  loading={busy}
                  disabled={busy || !songTitle.trim()}
                  onPress={() => send({ title: songTitle.trim() })}
                />
              </View>
            </>
          )}

          <Text className="text-center text-xs text-faint">
            Powered by Chapter OS
          </Text>
        </View>
      </ScrollView>
    </>
  );
}

/** Centered full-screen wrapper for the loading / unavailable states. */
function Centered({ children }: { children: ReactNode }) {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        className="flex-1 items-center justify-center px-6"
        style={{ backgroundColor: colors.surface }}
      >
        {children}
      </View>
    </>
  );
}
