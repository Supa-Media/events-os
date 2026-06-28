import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import {
  FIRST_CLASS_SONG_TAGS,
  songTagLabel,
  normalizeSongTag,
} from "@events-os/shared";
import { TextField, Icon } from "../ui";
import { colors } from "../../lib/theme";

/** Unique, order-preserving merge of tag lists. */
function uniq(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const t of list ?? []) {
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

/** Read-only tag chips for display on a song card. */
export function TagChips({ tags }: { tags?: string[] | null }) {
  if (!tags || tags.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {tags.map((t) => {
        const first = (FIRST_CLASS_SONG_TAGS as readonly string[]).includes(t);
        return (
          <View
            key={t}
            className="rounded-pill px-2 py-0.5"
            style={{ backgroundColor: first ? colors.accentBg : colors.sunken }}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: first ? colors.accent : colors.muted }}
            >
              {songTagLabel(t)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Editable tag selector. Always shows the first-class tags (Doxology,
 * Well-known), plus any `suggestions` (other tags already used in the chapter)
 * and the song's current tags, as toggle chips — and a field to create a new
 * custom tag. Works identically on web and native (NativeWind + RN primitives).
 */
export function TagPicker({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");

  const chips = uniq(FIRST_CLASS_SONG_TAGS, suggestions, value);

  function toggle(tag: string) {
    onChange(
      value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag],
    );
  }

  function addCustom() {
    const tag = normalizeSongTag(draft);
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  }

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        {chips.map((tag) => {
          const on = value.includes(tag);
          return (
            <Pressable
              key={tag}
              onPress={() => toggle(tag)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={songTagLabel(tag)}
              className="flex-row items-center gap-1 rounded-pill border px-3 py-1.5 active:opacity-80 web:hover:opacity-90"
              style={{
                borderColor: on ? colors.accent : colors.border,
                backgroundColor: on ? colors.accentBg : "transparent",
              }}
            >
              {on ? <Icon name="check" size={13} color={colors.accent} /> : null}
              <Text
                className="text-sm font-semibold"
                style={{ color: on ? colors.accent : colors.muted }}
              >
                {songTagLabel(tag)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Create a custom tag */}
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextField
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addCustom}
            returnKeyType="done"
            placeholder="Add a custom tag…"
            autoCapitalize="none"
          />
        </View>
        <Pressable
          onPress={addCustom}
          disabled={!normalizeSongTag(draft)}
          accessibilityRole="button"
          accessibilityLabel="Add tag"
          className={`mb-3 h-11 w-11 items-center justify-center rounded-md border border-border ${
            normalizeSongTag(draft) ? "active:bg-sunken" : "opacity-40"
          }`}
        >
          <Icon name="plus" size={18} color={colors.accent} />
        </Pressable>
      </View>
    </View>
  );
}
