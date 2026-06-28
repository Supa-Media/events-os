import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Platform,
} from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  TextField,
  EmptyState,
  Icon,
  Pill,
  InlineText,
  GridHeaderCell,
} from "../../components/ui";
import { TagChips } from "../../components/songs/SongTags";
import { colors, spacing } from "../../lib/theme";
import { songTagLabel, normalizeSongTag } from "@events-os/shared";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";

type Song = Doc<"songs">;

// Fixed column widths (px) — mirrors the People grid so columns stay put while
// the table scrolls horizontally on web.
const COLS = {
  title: 240,
  author: 180,
  tags: 260,
  lyrics: 360,
} as const;
const DELETE_W = 38;
const TABLE_WIDTH =
  Object.values(COLS).reduce((sum, w) => sum + w, 0) + DELETE_W;

/** Split a comma list into normalized, de-duped tags. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const t = normalizeSongTag(part);
    if (t) seen.add(t);
  }
  return Array.from(seen);
}

/** Confirm a destructive delete — window.confirm on web, no prompt on native. */
function confirmRemove(title: string): boolean {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.confirm(
      `Delete “${title || "this song"}”? It'll be removed from any setlists too.`,
    );
  }
  return true;
}

/**
 * SONG LIBRARY — the chapter song database, as a spreadsheet-style editable grid
 * (the same inline-editing UI as the People roster). Edit any cell in place; add
 * a song with the bottom row; tagging a song `doxology` or `well_known` also
 * surfaces it as a default suggestion on the public request page. Renders inside
 * the AppShell, so it works on web and mobile.
 */
export default function SongLibraryScreen() {
  const songs = useQuery(api.songs.list, { search: "" }) as Song[] | undefined;
  const create = useMutation(api.songs.create);

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // Every tag in use across the library, for the filter bar.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of songs ?? []) for (const t of s.tags ?? []) set.add(t);
    return Array.from(set).sort();
  }, [songs]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (songs ?? []).filter((s) => {
      if (tagFilter && !(s.tags ?? []).includes(tagFilter)) return false;
      if (
        query &&
        !s.title.toLowerCase().includes(query) &&
        !(s.author ?? "").toLowerCase().includes(query)
      )
        return false;
      return true;
    });
  }, [songs, tagFilter, search]);

  if (songs === undefined) return <Screen loading />;

  async function handleAddRow() {
    await create({ title: "New song" });
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
          <Text className="font-display text-2xl text-ink">Songs</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Library ({songs.length})
          </Text>
        </View>
        <Text className="mb-3 text-sm text-muted">
          Your reusable songs and lyrics — edit any cell inline. Add a song to an
          event from its Songs tab.
        </Text>

        <TextField
          placeholder="Search by title or author…"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />

        {allTags.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: spacing.xs,
              marginTop: spacing.sm,
            }}
          >
            <Pill
              label="All"
              selected={tagFilter === null}
              onPress={() => setTagFilter(null)}
            />
            {allTags.map((t) => (
              <Pill
                key={t}
                label={songTagLabel(t)}
                selected={tagFilter === t}
                onPress={() => setTagFilter((cur) => (cur === t ? null : t))}
              />
            ))}
          </View>
        ) : null}
      </Narrow>

      {/* The grid */}
      <View className="mt-3 overflow-hidden rounded-lg border border-border bg-raised">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
            {/* Column header */}
            <View className="flex-row items-center border-b border-border bg-sunken">
              <GridHeaderCell label="Title" width={COLS.title} />
              <GridHeaderCell label="Author" width={COLS.author} />
              <GridHeaderCell label="Tags" width={COLS.tags} />
              <GridHeaderCell label="Lyrics" width={COLS.lyrics} />
              <View style={{ width: DELETE_W }} />
            </View>

            {/* Body */}
            {songs.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No songs yet — add your first below.
                </Text>
              </View>
            ) : filtered.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No songs match your filters.
                </Text>
              </View>
            ) : (
              filtered.map((s, i) => (
                <SongRow key={s._id} song={s} isLast={i === filtered.length - 1} />
              ))
            )}
          </View>
        </ScrollView>

        {/* Add row */}
        <Pressable
          onPress={handleAddRow}
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Add song</Text>
        </Pressable>
      </View>

      {songs.length === 0 ? (
        <Narrow>
          <View style={{ marginTop: spacing.md }}>
            <EmptyState
              title="No songs yet"
              message="Use the “Add song” row to start your library, then edit each cell inline."
            />
          </View>
        </Narrow>
      ) : null}
    </Screen>
  );
}

/** One song row of fixed-width inline-editable cells + a delete gutter. */
function SongRow({ song, isLast }: { song: Song; isLast: boolean }) {
  const update = useMutation(api.songs.update);
  const remove = useMutation(api.songs.remove);
  const id = song._id as Id<"songs">;

  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      {/* Title */}
      <Cell width={COLS.title}>
        <InlineText
          value={song.title}
          placeholder="Song title"
          weight="medium"
          onCommit={(t) => update({ songId: id, title: t })}
        />
      </Cell>

      {/* Author */}
      <Cell width={COLS.author}>
        <InlineText
          value={song.author ?? ""}
          placeholder="—"
          onCommit={(t) => update({ songId: id, author: t.trim() || null })}
        />
      </Cell>

      {/* Tags: chips + inline comma editor (doxology / well_known highlight) */}
      <Cell width={COLS.tags}>
        <TagsCell
          tags={song.tags ?? []}
          onCommit={(next) => update({ songId: id, tags: next })}
        />
      </Cell>

      {/* Lyrics — multi-line inline editor so line breaks are preserved */}
      <Cell width={COLS.lyrics}>
        <LyricsCell
          value={song.lyrics ?? ""}
          onCommit={(t) => update({ songId: id, lyrics: t || null })}
        />
      </Cell>

      {/* Right gutter: delete */}
      <View style={{ width: DELETE_W }} className="items-center justify-center">
        <Pressable
          onPress={() => {
            if (confirmRemove(song.title)) remove({ songId: id });
          }}
          hitSlop={4}
          accessibilityLabel="Delete song"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="trash-2" size={14} color={colors.danger} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Lyrics cell: a 3-line preview that expands to a multi-line editor on tap and
 * commits on blur — keeps the inline-grid feel while preserving line breaks.
 */
function LyricsCell({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  // Stay in sync if the value changes from elsewhere while not editing.
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  if (editing) {
    return (
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        placeholder="Lyrics…"
        placeholderTextColor={colors.faint}
        onBlur={() => {
          onCommit(text.trim() || null);
          setEditing(false);
        }}
        className="flex-1 px-2 py-1.5 text-sm leading-snug text-ink"
        style={{ minHeight: 64, textAlignVertical: "top" }}
      />
    );
  }

  return (
    <Pressable
      onPress={() => setEditing(true)}
      accessibilityLabel="Edit lyrics"
      className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {value ? (
        <Text className="text-sm leading-snug text-ink" numberOfLines={3}>
          {value}
        </Text>
      ) : (
        <Text className="text-sm text-faint">—</Text>
      )}
    </Pressable>
  );
}

/** A fixed-width grid cell with a right hairline (mirrors the People grid). */
function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View
      style={{ width }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
  );
}

/**
 * Tags cell: shows the tag chips; tap to edit them as a normalized comma list.
 * Typing "well known" canonicalizes to `well_known`, so the first-class tags are
 * reachable by name and any custom tag can be created on the fly.
 */
function TagsCell({
  tags,
  onCommit,
}: {
  tags: string[];
  onCommit: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineText
        value={tags.join(", ")}
        placeholder="doxology, well known, hymn…"
        onCommit={(t) => {
          onCommit(parseTags(t));
          setEditing(false);
        }}
      />
    );
  }

  return (
    <Pressable
      onPress={() => setEditing(true)}
      accessibilityLabel="Edit tags"
      className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {tags.length === 0 ? (
        <Text className="text-sm text-faint">—</Text>
      ) : (
        <TagChips tags={tags} />
      )}
    </Pressable>
  );
}
