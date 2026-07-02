import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  TextInputProps,
} from "react-native";
import { useAction } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "./Icon";
import { Field } from "./Field";
import { colors } from "../../lib/theme";

type Suggestion = {
  description: string;
  mainText: string;
  secondaryText: string;
  placeId: string;
};

/** Wait this long after the last keystroke before asking Google. */
const DEBOUNCE_MS = 250;
/** Match the server floor so we don't fire obviously-empty queries. */
const MIN_QUERY_LENGTH = 3;

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  /**
   * Called when the user picks a suggestion, with its full description. The
   * component also calls `onChangeText` with the same value, so parents that
   * only keep local state can ignore this. Use it to persist immediately
   * (e.g. an inline blur-save field that needs the explicit chosen value).
   */
  onSelect?: (description: string) => void;
  /** Fired on blur when the user did NOT pick a suggestion (free-text commit). */
  onBlur?: () => void;
  placeholder?: string;
  /** "field" = labelled form row (TextField look); "inline" = compact chip-strip input. */
  variant?: "field" | "inline";
  label?: string;
  hint?: string;
  /** Fixed width for the inline variant. */
  width?: number;
  autoCapitalize?: TextInputProps["autoCapitalize"];
};

/**
 * A location text input with Google-Maps-style autocomplete. As the user types
 * we debounce-query the `places.autocomplete` Convex action (which proxies
 * Google so the API key stays server-side) and drop a list of matching venues
 * beneath the field. Picking one fills the text; typing freely still works and
 * commits on blur. Degrades to a plain text input when no suggestions come back
 * (e.g. the API key isn't configured).
 */
export function LocationAutocomplete({
  value,
  onChangeText,
  onSelect,
  onBlur,
  placeholder = "Where is it?",
  variant = "field",
  label,
  hint,
  width,
  autoCapitalize,
}: Props) {
  const runAutocomplete = useAction(api.places.autocomplete);
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [inputHeight, setInputHeight] = useState(40);
  const inputRef = useRef<TextInput>(null);
  // True between picking a suggestion and the resulting blur, so we can skip the
  // free-text blur-save (the pick already committed the right value) and skip
  // re-querying for the text we just filled in.
  const justSelectedRef = useRef(false);

  // Debounced suggestion fetch. Only runs while focused so the dropdown doesn't
  // reappear after the field is committed.
  useEffect(() => {
    if (!focused || justSelectedRef.current) return;
    const q = value.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { suggestions } = await runAutocomplete({ query: q });
        if (!cancelled) setResults(suggestions);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, focused, runAutocomplete]);

  function handleSelect(s: Suggestion) {
    justSelectedRef.current = true;
    onChangeText(s.description);
    onSelect?.(s.description);
    setResults([]);
    setFocused(false);
    inputRef.current?.blur();
  }

  function handleBlur() {
    setFocused(false);
    // Let a suggestion press (onPressIn) flip the ref before we decide whether
    // this blur is a free-text commit.
    setTimeout(() => {
      if (justSelectedRef.current) {
        justSelectedRef.current = false;
      } else {
        onBlur?.();
      }
    }, 120);
  }

  const showDropdown = focused && results.length > 0;
  const borderClass = focused ? "border-accent" : "border-border-strong";

  const inputClass =
    variant === "inline"
      ? `rounded-md border ${borderClass} bg-raised px-2.5 py-1.5 text-sm text-ink`
      : `rounded-md border ${borderClass} bg-raised px-3 py-2.5 text-base text-ink`;

  const input = (
    // Relative wrapper so the dropdown can anchor right under the input.
    <View style={{ position: "relative", zIndex: 20, width }}>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(t) => {
          justSelectedRef.current = false;
          onChangeText(t);
        }}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onLayout={(e) => setInputHeight(e.nativeEvent.layout.height)}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        className={inputClass}
      />

      {showDropdown ? (
        <View
          style={{
            position: "absolute",
            top: inputHeight + 4,
            left: 0,
            right: 0,
            zIndex: 30,
            elevation: 8,
          }}
          className="overflow-hidden rounded-md border border-border bg-raised shadow-raised"
        >
          {results.map((s) => (
            <SuggestionRow
              key={s.placeId || s.description}
              suggestion={s}
              // onPressIn (not onPress) so selection wins the race against the
              // input's blur on web/native.
              onPressIn={() => handleSelect(s)}
            />
          ))}
        </View>
      ) : null}

      {loading && focused ? (
        <View style={{ position: "absolute", right: 10, top: 0, bottom: 0, justifyContent: "center" }}>
          <ActivityIndicator size="small" color={colors.muted} />
        </View>
      ) : null}
    </View>
  );

  if (variant === "inline") return input;

  return (
    <Field label={label} hint={hint}>
      {input}
    </Field>
  );
}

function SuggestionRow({
  suggestion,
  onPressIn,
}: {
  suggestion: Suggestion;
  onPressIn: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPressIn={onPressIn}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center gap-2.5 px-3 py-2.5 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      <Icon name="map-pin" size={15} color={colors.muted} />
      <View className="flex-1">
        <Text className="text-sm text-ink" numberOfLines={1}>
          {suggestion.mainText}
        </Text>
        {suggestion.secondaryText ? (
          <Text className="text-xs text-muted" numberOfLines={1}>
            {suggestion.secondaryText}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
