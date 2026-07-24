/**
 * MentionInlineText — a mention-aware inline text cell with a display/edit
 * toggle, closing the "raw token" gap: a note CONTAINING mentions renders
 * them as tappable links (MentionText) until the cell is tapped, then flips
 * to the live `@`-picker input (MentionTextInput); committing (blur or
 * mention insert) flips back to the rendered view. A note with NO mentions
 * skips the toggle entirely and stays an always-live input — identical UX
 * to the plain InlineText cells it replaces, so the grid only "changes"
 * where mentions are actually in play.
 *
 * Same value/onCommit-on-blur contract as the grid's InlineText, including
 * its optional `parse` (trim → null etc.) and the web hover copy affordance.
 */
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { splitMentionSegments } from "@events-os/shared";
import { CopyButton } from "../ui/CopyButton";
import { MentionText } from "./MentionText";
import { MentionTextInput } from "./MentionTextInput";

export function MentionInlineText({
  value,
  onCommit,
  placeholder,
  multiline,
  weight,
  numberOfLines,
  parse,
  people,
  seatHoldings,
  seatOptions,
  inputClassName,
  onFocusChange,
}: {
  value: any;
  onCommit: (v: any) => void;
  placeholder?: string;
  multiline?: boolean;
  weight?: "normal" | "medium";
  /** Line clamp for the rendered (display-mode) note; omit to wrap freely. */
  numberOfLines?: number;
  /** Parse the editor's raw string into the logical value (grid contract). */
  parse?: (t: string) => any;
  people: { _id: string; name: string }[];
  seatHoldings: { personId: string; seatDefId: string }[];
  seatOptions: { seatDefId: string; title: string }[];
  /** Style override for the edit-mode input, passed through to
   *  MentionTextInput — lets a caller with its own box styling (e.g.
   *  CopyEditor) replace the default cell className. */
  inputClassName?: string;
  /** Fires on the edit-mode input's focus/blur, passed through to
   *  MentionTextInput — lets a caller drive its own focus-state styling. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const text = value == null ? "" : String(value);
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hasMentions = splitMentionSegments(text).some(
    (s) => s.kind === "mention",
  );

  // Display mode: rendered, tappable mentions. Tapping a link navigates
  // (MentionText stops propagation); tapping anywhere else enters edit mode.
  if (hasMentions && !editing) {
    const rendered = (
      <Pressable
        className="flex-1 justify-center py-1.5"
        onPress={() => setEditing(true)}
      >
        <MentionText
          text={text}
          people={people}
          seatHoldings={seatHoldings}
          numberOfLines={numberOfLines}
        />
      </Pressable>
    );
    if (Platform.OS !== "web") return rendered;
    return (
      <View
        className="flex-1"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {rendered}
        {hovered && text.trim().length > 0 ? (
          <View className="absolute right-1 top-1">
            <CopyButton text={text} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <MentionTextInput
      value={text}
      placeholder={placeholder}
      multiline={multiline}
      weight={weight}
      autoFocus={editing}
      people={people}
      seatHoldings={seatHoldings}
      seatOptions={seatOptions}
      onCommit={(t) => onCommit(parse ? parse(t) : t)}
      onDone={() => setEditing(false)}
      inputClassName={inputClassName}
      onFocusChange={onFocusChange}
    />
  );
}
