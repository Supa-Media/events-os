/**
 * The card's two inline free-text editors: the title (reads as plain text until
 * focused) and the copy/details box below it. Both commit on blur so a stray tap
 * never loses an edit. The copy box also offers a one-tap "Copy" that puts its
 * text on the clipboard — handy for pasting a comms send into email/socials.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput } from "react-native";
import { Icon } from "../../ui/Icon";
import { CopyButton } from "../../ui/CopyButton";
import { colors } from "../../../lib/theme";

/**
 * Inline title editor — reads as the plain card title until focused; commits on
 * blur (Enter commits too, via the newline intercept below). An emptied title
 * reverts to the last saved one rather than saving "".
 */
export function TitleEditor({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (title: string) => void;
}) {
  const ref = useRef<TextInput>(null);
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);

  // Track renames made elsewhere (e.g. the table view) — but never clobber an
  // edit in flight.
  useEffect(() => {
    if (!focused) setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const commit = () => {
    setFocused(false);
    const next = value.replace(/\n/g, " ").trim();
    if (!next) {
      setValue(initial);
      return;
    }
    if (next !== initial.trim()) onSave(next);
  };

  return (
    <TextInput
      ref={ref}
      value={value}
      // Multiline only so long titles wrap like the old <Text>; Enter commits
      // instead of inserting a newline.
      multiline
      onChangeText={(t) => {
        if (t.includes("\n")) {
          setValue(t.replace(/\n/g, " "));
          ref.current?.blur();
          return;
        }
        setValue(t);
      }}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      placeholder="Untitled"
      placeholderTextColor={colors.faint}
      textAlignVertical="top"
      className={`-mx-1 rounded px-1 py-0 text-sm font-semibold leading-snug text-ink ${
        focused ? "bg-sunken" : ""
      }`}
    />
  );
}

/**
 * The always-present copy/details box. Shows the body when set and a prompt when
 * empty; commits on blur so a stray tap never loses an edit. Seeded once from the
 * item — our own save keeps it in sync, which is all this fast path needs.
 */
export function CopyEditor({
  label,
  placeholder,
  initial,
  onSave,
}: {
  label: string;
  placeholder: string;
  initial: string;
  onSave: (copy: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);

  const commit = () => {
    setFocused(false);
    const next = value.trim();
    if (next !== initial.trim()) onSave(next);
  };

  return (
    <View className="mt-2 border-t border-border pt-2">
      <View className="mb-1 flex-row items-center justify-between">
        <View className="flex-row items-center gap-1">
          <Icon name="edit-3" size={10} color={colors.faint} />
          <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
            {label}
          </Text>
        </View>
        {value.trim() ? <CopyButton text={value} label /> : null}
      </View>
      <TextInput
        value={value}
        onChangeText={setValue}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        multiline
        textAlignVertical="top"
        className={`rounded-md border bg-sunken px-2.5 py-2 text-xs text-ink ${
          focused ? "border-accent" : "border-border"
        }`}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
