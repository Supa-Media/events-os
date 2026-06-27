import { useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, Button, SectionHeader, TextField, Icon } from "../../../../components/ui";
import { ToastView } from "../../../../components/ui/Toast";
import { useActionRunner } from "../../../../lib/useActionToast";
import { colors } from "../../../../lib/theme";
import {
  SONG_REQUEST_STATUS_LABELS,
  type SongRequestStatus,
} from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * SONGS — the worship-leader/music-director surface for an event.
 *
 * Build the setlist from the chapter library, scroll it day-of and tap the song
 * you're currently on (its lyrics then show here AND on the public page), share
 * the QR/request link, and work the incoming request queue. Reads
 * `api.setlists.forEvent` + `api.setlists.requests`.
 */
export default function EventSongsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const { run, toast, dismiss } = useActionRunner();

  const board = useQuery(api.setlists.forEvent, { eventId });
  const reqs = useQuery(api.setlists.requests, { eventId });

  const addSong = useMutation(api.setlists.addSong);
  const removeEntry = useMutation(api.setlists.removeEntry);
  const move = useMutation(api.setlists.move);
  const setCurrent = useMutation(api.setlists.setCurrent);
  const setRequestsOpen = useMutation(api.setlists.setRequestsOpen);
  const setRequestStatus = useMutation(api.setlists.setRequestStatus);

  const [adding, setAdding] = useState(false);

  if (board === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Songs" }} />
        <Screen loading />
      </>
    );
  }
  if (board === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Songs" }} />
        <Screen>
          <Text className="text-base text-muted">This event no longer exists.</Text>
        </Screen>
      </>
    );
  }

  const { songs, requestsOpen } = board;
  const current = songs.find((s) => s.isCurrent) ?? null;
  const newCount = (reqs ?? []).filter((r) => r.status === "new").length;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Songs" }} />
      <Screen>
        <ToastView toast={toast} onDismiss={dismiss} />

        {/* Share + open/close controls */}
        <Card className="mb-4">
          <View className="flex-row flex-wrap items-center justify-between gap-3">
            <View className="flex-1" style={{ minWidth: 220 }}>
              <Text className="text-base font-semibold text-ink">
                Congregation requests
              </Text>
              <Text className="mt-0.5 text-sm text-muted">
                Share the link or its QR code. People request songs and follow
                the current lyrics — no app needed.
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <CopyLinkButton eventId={eventId} />
              <Button
                title={requestsOpen ? "Requests open" : "Requests closed"}
                icon={requestsOpen ? "unlock" : "lock"}
                size="sm"
                variant={requestsOpen ? "primary" : "secondary"}
                onPress={() =>
                  run(() => setRequestsOpen({ eventId, open: !requestsOpen }), {
                    errorTitle: "Couldn't change requests",
                  })
                }
              />
            </View>
          </View>
        </Card>

        {/* Now playing — current song + lyrics */}
        <SectionHeader title="Now" />
        <Card
          className="mb-4"
          style={current ? { borderColor: colors.accent, borderWidth: 2 } : undefined}
        >
          {current ? (
            <>
              <View className="flex-row items-center gap-2">
                <Icon name="music" size={16} color={colors.accent} />
                <Text className="flex-1 text-lg font-bold text-ink">
                  {current.title}
                </Text>
                <Pressable
                  onPress={() =>
                    run(() => setCurrent({ eventId, entryId: null }), {
                      errorTitle: "Couldn't clear current song",
                    })
                  }
                  accessibilityLabel="Clear current song"
                  hitSlop={8}
                  className="active:opacity-60"
                >
                  <Icon name="x" size={18} color={colors.muted} />
                </Pressable>
              </View>
              {current.author ? (
                <Text className="mt-0.5 text-sm text-muted">{current.author}</Text>
              ) : null}
              {current.lyrics ? (
                <Text className="mt-3 text-base leading-6 text-ink">
                  {current.lyrics}
                </Text>
              ) : (
                <Text className="mt-3 text-sm italic text-faint">
                  No lyrics saved for this song yet.
                </Text>
              )}
            </>
          ) : (
            <Text className="text-sm text-muted">
              Tap a song below to mark it as the one you're on now.
            </Text>
          )}
        </Card>

        {/* Setlist */}
        <SectionHeader title="Setlist" count={songs.length} />
        {songs.length === 0 ? (
          <Card className="mb-3">
            <Text className="text-sm text-muted">
              No songs yet. Add some from your library below.
            </Text>
          </Card>
        ) : (
          <View className="mb-3 gap-2">
            {songs.map((s, i) => (
              <SetlistRow
                key={s.entryId}
                title={s.title}
                author={s.author}
                isCurrent={s.isCurrent}
                requestCount={s.requestCount}
                isFirst={i === 0}
                isLast={i === songs.length - 1}
                onSetCurrent={() =>
                  run(
                    () =>
                      setCurrent({
                        eventId,
                        entryId: s.isCurrent ? null : (s.entryId as Id<"setlistEntries">),
                      }),
                    { errorTitle: "Couldn't set current song" },
                  )
                }
                onUp={() =>
                  run(
                    () => move({ entryId: s.entryId as Id<"setlistEntries">, direction: "up" }),
                    { errorTitle: "Couldn't reorder" },
                  )
                }
                onDown={() =>
                  run(
                    () => move({ entryId: s.entryId as Id<"setlistEntries">, direction: "down" }),
                    { errorTitle: "Couldn't reorder" },
                  )
                }
                onRemove={() =>
                  run(
                    () => removeEntry({ entryId: s.entryId as Id<"setlistEntries"> }),
                    { errorTitle: "Couldn't remove song" },
                  )
                }
              />
            ))}
          </View>
        )}

        {adding ? (
          <AddSongPanel
            eventId={eventId}
            onClose={() => setAdding(false)}
            onAdd={(songId) =>
              run(() => addSong({ eventId, songId }), {
                errorTitle: "Couldn't add song",
              })
            }
          />
        ) : (
          <Button
            title="Add song"
            icon="plus"
            variant="secondary"
            onPress={() => setAdding(true)}
          />
        )}

        {/* Requests */}
        <View className="mt-6">
          <SectionHeader title="Requests" count={newCount} />
        </View>
        {reqs === undefined ? (
          <Text className="text-sm text-muted">Loading requests…</Text>
        ) : reqs.length === 0 ? (
          <Card>
            <Text className="text-sm text-muted">
              No requests yet. They'll appear here as people submit them.
            </Text>
          </Card>
        ) : (
          <View className="gap-2">
            {reqs.map((r) => (
              <RequestRow
                key={r._id}
                songTitle={r.songTitle}
                requesterName={r.requesterName}
                note={r.note}
                willSing={r.willSing}
                status={r.status as SongRequestStatus}
                onStatus={(status) =>
                  run(
                    () =>
                      setRequestStatus({
                        requestId: r._id as Id<"songRequests">,
                        status,
                      }),
                    { errorTitle: "Couldn't update request" },
                  )
                }
              />
            ))}
          </View>
        )}
      </Screen>
    </>
  );
}

/** A single setlist row: tap to set current; reorder + remove + request count. */
function SetlistRow({
  title,
  author,
  isCurrent,
  requestCount,
  isFirst,
  isLast,
  onSetCurrent,
  onUp,
  onDown,
  onRemove,
}: {
  title: string;
  author: string | null;
  isCurrent: boolean;
  requestCount: number;
  isFirst: boolean;
  isLast: boolean;
  onSetCurrent: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  return (
    <Card
      padding="sm"
      style={isCurrent ? { borderColor: colors.accent, borderWidth: 2 } : undefined}
    >
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={onSetCurrent}
          accessibilityRole="button"
          accessibilityLabel={
            isCurrent ? `${title} is current. Tap to clear.` : `Set ${title} as current song`
          }
          className="flex-1 flex-row items-center gap-2.5 active:opacity-70"
          hitSlop={6}
        >
          <Icon
            name={isCurrent ? "play" : "music"}
            size={16}
            color={isCurrent ? colors.accent : colors.muted}
          />
          <View className="flex-1">
            <Text className="text-base font-semibold text-ink">{title}</Text>
            {author ? (
              <Text className="text-xs text-muted">{author}</Text>
            ) : null}
          </View>
        </Pressable>

        {requestCount > 0 ? (
          <View
            className="flex-row items-center gap-1 rounded-pill bg-sunken px-2 py-0.5"
            accessibilityLabel={`${requestCount} requests`}
          >
            <Icon name="heart" size={12} color={colors.accent} />
            <Text className="text-xs font-bold text-muted">{requestCount}</Text>
          </View>
        ) : null}

        <View className="flex-row items-center">
          <IconButton name="chevron-up" label="Move up" disabled={isFirst} onPress={onUp} />
          <IconButton name="chevron-down" label="Move down" disabled={isLast} onPress={onDown} />
          <IconButton name="trash-2" label="Remove song" onPress={onRemove} />
        </View>
      </View>
    </Card>
  );
}

/** A small icon-only tap target used for row affordances. */
function IconButton({
  name,
  label,
  onPress,
  disabled,
}: {
  name: any;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      className={`h-9 w-9 items-center justify-center rounded-md ${
        disabled ? "opacity-30" : "active:bg-sunken"
      }`}
    >
      <Icon name={name} size={16} color={colors.muted} />
    </Pressable>
  );
}

/** One request: song + who + note + a tiny status control set. */
function RequestRow({
  songTitle,
  requesterName,
  note,
  willSing,
  status,
  onStatus,
}: {
  songTitle: string;
  requesterName: string | null;
  note: string | null;
  willSing: boolean;
  status: SongRequestStatus;
  onStatus: (status: SongRequestStatus) => void;
}) {
  const dimmed = status === "done" || status === "dismissed";
  return (
    <Card padding="sm" style={dimmed ? { opacity: 0.6 } : undefined}>
      <View className="flex-row items-start gap-2">
        <View className="flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-base font-semibold text-ink">{songTitle}</Text>
            {willSing ? (
              <View
                className="flex-row items-center gap-1 rounded-pill px-2 py-0.5"
                style={{ backgroundColor: colors.accentBg }}
                accessibilityLabel={`${requesterName ?? "Someone"} offered to help sing this`}
              >
                <Icon name="mic" size={11} color={colors.accent} />
                <Text className="text-xs font-bold text-accent">Will sing</Text>
              </View>
            ) : null}
          </View>
          <Text className="text-xs text-muted">
            {requesterName ? `From ${requesterName}` : "Anonymous"}
            {status !== "new" ? ` · ${SONG_REQUEST_STATUS_LABELS[status]}` : ""}
          </Text>
          {note ? <Text className="mt-1 text-sm text-ink">{note}</Text> : null}
        </View>
        <View className="flex-row items-center">
          <IconButton
            name="clock"
            label="Queue this request"
            onPress={() => onStatus("queued")}
          />
          <IconButton
            name="check"
            label="Mark played"
            onPress={() => onStatus("done")}
          />
          <IconButton
            name="x"
            label="Dismiss request"
            onPress={() => onStatus("dismissed")}
          />
        </View>
      </View>
    </Card>
  );
}

/**
 * Inline panel to add a song to the setlist: search the library and tap to add,
 * or create a brand-new song (title + author + lyrics) on the spot.
 */
function AddSongPanel({
  eventId,
  onClose,
  onAdd,
}: {
  eventId: Id<"events">;
  onClose: () => void;
  onAdd: (songId: Id<"songs">) => void;
}) {
  const { run, toast, dismiss } = useActionRunner();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [lyrics, setLyrics] = useState("");

  const library = useQuery(api.songs.list, { search });
  const createSong = useMutation(api.songs.create);

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) return;
    const newId = await run(
      () =>
        createSong({
          title: trimmed,
          author: author.trim() || undefined,
          lyrics: lyrics.trim() || undefined,
        }),
      { errorTitle: "Couldn't save song" },
    );
    if (newId) {
      onAdd(newId as Id<"songs">);
      setTitle("");
      setAuthor("");
      setLyrics("");
      setCreating(false);
    }
  }

  return (
    <Card className="mb-3">
      <ToastView toast={toast} onDismiss={dismiss} />
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="text-base font-semibold text-ink">
          {creating ? "New song" : "Add from library"}
        </Text>
        <Pressable onPress={onClose} accessibilityLabel="Close" hitSlop={8} className="active:opacity-60">
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {creating ? (
        <View className="gap-1">
          <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Song title" />
          <TextField
            label="Author / artist"
            value={author}
            onChangeText={setAuthor}
            placeholder="Optional"
          />
          <TextField
            label="Lyrics"
            value={lyrics}
            onChangeText={setLyrics}
            placeholder="Optional — shown on the public page when this song is current"
            multiline
            numberOfLines={5}
            style={{ minHeight: 110, textAlignVertical: "top" }}
          />
          <View className="mt-1 flex-row gap-2">
            <Button title="Add to setlist" icon="plus" onPress={handleCreate} disabled={!title.trim()} />
            <Button title="Back" variant="secondary" onPress={() => setCreating(false)} />
          </View>
        </View>
      ) : (
        <>
          <TextField
            value={search}
            onChangeText={setSearch}
            placeholder="Search your songs…"
            autoCapitalize="none"
          />
          <View className="mt-1 max-h-72">
            <ScrollView>
              {library === undefined ? (
                <Text className="py-3 text-sm text-muted">Loading…</Text>
              ) : library.length === 0 ? (
                <Text className="py-3 text-sm text-muted">
                  No songs in your library yet.
                </Text>
              ) : (
                library.map((song) => (
                  <Pressable
                    key={song._id}
                    onPress={() => onAdd(song._id as Id<"songs">)}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${song.title} to setlist`}
                    className="flex-row items-center gap-2 border-b border-border py-2.5 active:bg-sunken"
                  >
                    <Icon name="plus" size={15} color={colors.accent} />
                    <View className="flex-1">
                      <Text className="text-base text-ink">{song.title}</Text>
                      {song.author ? (
                        <Text className="text-xs text-muted">{song.author}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
          <View className="mt-2">
            <Button
              title="New song"
              icon="edit-2"
              variant="secondary"
              onPress={() => setCreating(true)}
            />
          </View>
        </>
      )}
    </Card>
  );
}

/**
 * Copies the public request link (`/songs/<eventId>`) — the URL a printed QR
 * code points at. Mirrors EventHeader's ShareCrewButton.
 */
function CopyLinkButton({ eventId }: { eventId: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    const url =
      (typeof window !== "undefined" ? window.location.origin : "") +
      `/songs/${eventId}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } else if (typeof window !== "undefined") {
      window.prompt("Public song-request link:", url);
    }
  }
  return (
    <Button
      title={copied ? "Link copied!" : "Copy link"}
      icon={copied ? "check" : "share-2"}
      size="sm"
      variant="secondary"
      onPress={copy}
    />
  );
}
