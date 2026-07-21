/**
 * MentionTextInput — edit-mode drop-in replacement for `InlineText` on a
 * `notes` field, adding an `@`-trigger mention picker. Same value/onCommit
 * contract as `InlineText` (commits on blur), plus `people` and
 * `seatOptions` (this cell's own already-fetched suggestion sources) and
 * `seatHoldings` (used to show each seat suggestion's current holder, so a
 * chapter lead can tell "Music Director — Alex" from "Music Director —
 * Vacant" before picking).
 *
 * Selecting a suggestion commits IMMEDIATELY rather than waiting for blur:
 * on web, pressing a `Popover` row blurs the underlying `TextInput` first
 * (focus moves to the pressable), which would otherwise commit the
 * pre-selection text before the mention is spliced in. `justSelectedRef`
 * suppresses that stale blur-commit; `insertMention` is the sole committer
 * for the selection path.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { encodeMention, type MentionType } from "@events-os/shared";
import { Popover } from "../ui/Popover";
import { useAnchor } from "../ui/useAnchor";
import { detectMentionTrigger, type MentionTrigger } from "./mentionTrigger.logic";
import { colors } from "../../lib/theme";

const MAX_SUGGESTIONS = 8;

type Suggestion = {
  type: MentionType;
  id: string;
  label: string;
  detail: string;
};

export function MentionTextInput({
  value,
  onCommit,
  placeholder,
  people,
  seatHoldings,
  seatOptions,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  people: { _id: string; name: string }[];
  seatHoldings: { personId: string; seatDefId: string }[];
  seatOptions: { seatDefId: string; title: string }[];
}) {
  const [text, setText] = useState(value);
  const [trigger, setTrigger] = useState<MentionTrigger>(null);
  const cursorRef = useRef(value.length);
  const justSelectedRef = useRef(false);
  const { ref, anchor, visible, open, close } = useAnchor();

  // Keep the field in sync when the underlying value changes from elsewhere
  // (mirrors InlineText).
  useEffect(() => {
    setText(value);
    cursorRef.current = value.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const runTrigger = (nextText: string, cursor: number) => {
    const next = detectMentionTrigger(nextText, cursor);
    setTrigger(next);
    if (next) open();
    else close();
  };

  const suggestions: Suggestion[] = trigger
    ? buildSuggestions(trigger.query, people, seatOptions, seatHoldings)
    : [];

  const insertMention = (s: Suggestion) => {
    if (!trigger) return;
    const insertion = encodeMention(s.type, s.id, s.label) + " ";
    const nextText =
      text.slice(0, trigger.start) + insertion + text.slice(cursorRef.current);
    setText(nextText);
    cursorRef.current = trigger.start + insertion.length;
    setTrigger(null);
    close();
    onCommit(nextText);
  };

  return (
    <>
      <View ref={ref} className="flex-1">
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            runTrigger(t, cursorRef.current);
          }}
          onSelectionChange={(e) => {
            const sel = e.nativeEvent.selection.end;
            cursorRef.current = sel;
            runTrigger(text, sel);
          }}
          onBlur={() => {
            close();
            setTrigger(null);
            if (justSelectedRef.current) {
              justSelectedRef.current = false;
              return;
            }
            onCommit(text);
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          className="flex-1 px-2 py-1.5 text-sm leading-snug text-ink"
          style={{ minWidth: 40 }}
        />
      </View>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {suggestions.length === 0 ? (
            <Text className="px-3 py-2 text-sm text-faint">No matches</Text>
          ) : (
            suggestions.map((s) => (
              <Pressable
                key={`${s.type}:${s.id}`}
                onPressIn={() => {
                  justSelectedRef.current = true;
                }}
                onPress={() => insertMention(s)}
                className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                <Text className="text-sm text-ink" numberOfLines={1}>
                  {s.label}
                </Text>
                <Text className="text-xs text-faint" numberOfLines={1}>
                  {s.detail}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      </Popover>
    </>
  );
}

/** Filters people-by-name and seats-by-title (mirrors `PersonPicker`'s
 *  substring match), each seat annotated with its current holder's name
 *  (or "Vacant"), capped to `MAX_SUGGESTIONS` combined. */
function buildSuggestions(
  query: string,
  people: { _id: string; name: string }[],
  seatOptions: { seatDefId: string; title: string }[],
  seatHoldings: { personId: string; seatDefId: string }[],
): Suggestion[] {
  const q = query.toLowerCase();
  const nameByPersonId = new Map(people.map((p) => [p._id, p.name]));

  const personSuggestions: Suggestion[] = people
    .filter((p) => p.name.toLowerCase().includes(q))
    .map((p) => ({ type: "person", id: p._id, label: p.name, detail: "" }));

  const seatSuggestions: Suggestion[] = seatOptions
    .filter((s) => s.title.toLowerCase().includes(q))
    .map((s) => {
      const holderId = seatHoldings.find(
        (h) => h.seatDefId === s.seatDefId,
      )?.personId;
      const holderName = holderId ? nameByPersonId.get(holderId) : undefined;
      return {
        type: "seat",
        id: s.seatDefId,
        label: s.title,
        detail: holderName ?? "Vacant",
      };
    });

  return [...personSuggestions, ...seatSuggestions].slice(0, MAX_SUGGESTIONS);
}
