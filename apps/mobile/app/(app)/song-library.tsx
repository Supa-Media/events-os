import { useMemo, useState } from "react";
import { View, Text, Modal, Pressable, ScrollView, Platform, Alert } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  TextField,
  EmptyState,
  Icon,
} from "../../components/ui";
import { ToastView } from "../../components/ui/Toast";
import { TagChips, TagPicker } from "../../components/songs/SongTags";
import { useActionRunner } from "../../lib/useActionToast";
import { colors } from "../../lib/theme";
import { FIRST_CLASS_SONG_TAGS, songTagLabel } from "@events-os/shared";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";

type Song = Doc<"songs">;

/** Draft state for the create/edit modal. `song` is null when creating. */
type Editor = {
  song: Song | null;
  title: string;
  author: string;
  lyrics: string;
  tags: string[];
};

/**
 * SONG LIBRARY — the chapter-wide song database.
 *
 * Browse / search / tag / edit / delete every song. Songs created here are
 * reusable across events (added to a setlist from an event's Songs screen).
 * Tagging a song `doxology` also makes it a default suggestion on the public
 * request page. Renders inside the AppShell, so it works on web and mobile.
 */
export default function SongLibraryScreen() {
  const { run, toast, dismiss } = useActionRunner();
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  const songs = useQuery(api.songs.list, { search });
  const createSong = useMutation(api.songs.create);
  const updateSong = useMutation(api.songs.update);
  const removeSong = useMutation(api.songs.remove);

  // Every tag in use across the library (first-class first, then custom), for
  // the filter row and as suggestions in the editor's tag picker.
  const knownTags = useMemo(() => {
    const used = new Set<string>();
    for (const s of songs ?? []) for (const t of s.tags ?? []) used.add(t);
    const first = (FIRST_CLASS_SONG_TAGS as readonly string[]).filter((t) =>
      used.has(t),
    );
    const custom = [...used]
      .filter((t) => !(FIRST_CLASS_SONG_TAGS as readonly string[]).includes(t))
      .sort();
    return [...first, ...custom];
  }, [songs]);

  if (songs === undefined) return <Screen loading />;

  const filtered = tagFilter
    ? songs.filter((s) => (s.tags ?? []).includes(tagFilter))
    : songs;

  function openNew() {
    setEditor({ song: null, title: "", author: "", lyrics: "", tags: [] });
  }
  function openEdit(s: Song) {
    setEditor({
      song: s,
      title: s.title,
      author: s.author ?? "",
      lyrics: s.lyrics ?? "",
      tags: s.tags ?? [],
    });
  }

  async function save() {
    if (!editor) return;
    const title = editor.title.trim();
    if (!title) return;
    const payload = {
      title,
      author: editor.author.trim() || undefined,
      lyrics: editor.lyrics.trim() || undefined,
      tags: editor.tags,
    };
    const ok = editor.song
      ? await run(
          () =>
            updateSong({
              songId: editor.song!._id,
              title,
              author: editor.author.trim() || null,
              lyrics: editor.lyrics.trim() || null,
              tags: editor.tags,
            }),
          { errorTitle: "Couldn't save song" },
        )
      : await run(() => createSong(payload), { errorTitle: "Couldn't add song" });
    if (ok !== undefined) setEditor(null);
  }

  function confirmDelete(s: Song) {
    const msg = `Delete “${s.title}”? It'll be removed from any setlists too. This can't be undone.`;
    const doIt = () => {
      void run(() => removeSong({ songId: s._id }), {
        errorTitle: "Couldn't delete song",
      });
      setEditor(null);
    };
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(msg)) doIt();
      return;
    }
    Alert.alert("Delete song?", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doIt },
    ]);
  }

  return (
    <Screen>
      <ToastView toast={toast} onDismiss={dismiss} />

      <View className="mb-4 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-2xl text-ink">Song library</Text>
          <Text className="mt-0.5 text-sm text-muted">
            Your reusable songs and lyrics. Add them to an event's setlist from
            its Songs tab.
          </Text>
        </View>
        <Button title="New song" icon="plus" onPress={openNew} />
      </View>

      <TextField
        value={search}
        onChangeText={setSearch}
        placeholder="Search by title, author, or tag…"
        autoCapitalize="none"
      />

      {/* Tag filter row */}
      {knownTags.length > 0 ? (
        <View className="mb-3 mt-1 flex-row flex-wrap gap-2">
          <FilterChip
            label="All"
            active={tagFilter === null}
            onPress={() => setTagFilter(null)}
          />
          {knownTags.map((t) => (
            <FilterChip
              key={t}
              label={songTagLabel(t)}
              active={tagFilter === t}
              onPress={() => setTagFilter(tagFilter === t ? null : t)}
            />
          ))}
        </View>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          title={songs.length === 0 ? "No songs yet" : "No songs match"}
          message={
            songs.length === 0
              ? "Add your first song — title, author, lyrics, and tags."
              : "Try a different search or tag filter."
          }
        />
      ) : (
        <View className="mt-1 gap-2">
          {filtered.map((s) => (
            <Card key={s._id} onPress={() => openEdit(s)}>
              <View className="flex-row items-start gap-2">
                <View className="flex-1 gap-1">
                  <Text className="text-base font-bold text-ink">{s.title}</Text>
                  {s.author ? (
                    <Text className="text-sm text-muted">{s.author}</Text>
                  ) : null}
                  {s.tags && s.tags.length > 0 ? (
                    <View className="mt-0.5">
                      <TagChips tags={s.tags} />
                    </View>
                  ) : null}
                  {s.lyrics ? (
                    <Text className="mt-0.5 text-sm text-faint" numberOfLines={2}>
                      {s.lyrics}
                    </Text>
                  ) : null}
                </View>
                <Icon name="chevron-right" size={18} color={colors.faint} />
              </View>
            </Card>
          ))}
        </View>
      )}

      <SongEditorModal
        editor={editor}
        suggestions={knownTags}
        onChange={setEditor}
        onSave={save}
        onDelete={confirmDelete}
        onClose={() => setEditor(null)}
      />
    </Screen>
  );
}

/** A pill-shaped filter toggle for the tag row. */
function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className="rounded-pill border px-3 py-1.5 active:opacity-80 web:hover:opacity-90"
      style={{
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accentBg : "transparent",
      }}
    >
      <Text
        className="text-sm font-semibold"
        style={{ color: active ? colors.accent : colors.muted }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The create/edit modal — centered card on web, full sheet on mobile. */
function SongEditorModal({
  editor,
  suggestions,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  editor: Editor | null;
  suggestions: string[];
  onChange: (e: Editor) => void;
  onSave: () => void;
  onDelete: (s: Song) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={editor !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View
        className="flex-1 items-center justify-center p-4"
        style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      >
        <View
          className="w-full overflow-hidden rounded-xl border border-border bg-surface"
          style={{ maxWidth: 560, maxHeight: "90%" }}
        >
          {editor ? (
            <>
              <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
                <Text className="text-lg font-bold text-ink">
                  {editor.song ? "Edit song" : "New song"}
                </Text>
                <Pressable
                  onPress={onClose}
                  accessibilityLabel="Close"
                  hitSlop={8}
                  className="active:opacity-60"
                >
                  <Icon name="x" size={20} color={colors.muted} />
                </Pressable>
              </View>

              <ScrollView contentContainerStyle={{ padding: 20 }}>
                <TextField
                  label="Title"
                  value={editor.title}
                  onChangeText={(title) => onChange({ ...editor, title })}
                  placeholder="Song title"
                />
                <TextField
                  label="Author / artist"
                  value={editor.author}
                  onChangeText={(author) => onChange({ ...editor, author })}
                  placeholder="Optional"
                />
                <TextField
                  label="Lyrics"
                  value={editor.lyrics}
                  onChangeText={(lyrics) => onChange({ ...editor, lyrics })}
                  placeholder="Optional — shown on the public page when this song is current"
                  multiline
                  numberOfLines={6}
                  style={{ minHeight: 130, textAlignVertical: "top" }}
                />
                <Text className="mb-1.5 mt-1 text-sm font-semibold text-ink">
                  Tags
                </Text>
                <TagPicker
                  value={editor.tags}
                  suggestions={suggestions}
                  onChange={(tags) => onChange({ ...editor, tags })}
                />
              </ScrollView>

              <View className="flex-row items-center justify-between gap-2 border-t border-border px-5 py-3">
                {editor.song ? (
                  <Button
                    title="Delete"
                    icon="trash-2"
                    variant="danger"
                    onPress={() => onDelete(editor.song!)}
                  />
                ) : (
                  <View />
                )}
                <View className="flex-row gap-2">
                  <Button title="Cancel" variant="secondary" onPress={onClose} />
                  <Button
                    title="Save"
                    icon="check"
                    onPress={onSave}
                    disabled={!editor.title.trim()}
                  />
                </View>
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
