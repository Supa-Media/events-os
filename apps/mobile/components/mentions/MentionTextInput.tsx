/**
 * MentionTextInput — edit-mode drop-in replacement for `InlineText` on a
 * `notes` field, adding an `@`-trigger mention picker. Same value/onCommit
 * contract as `InlineText` (commits on blur), plus `people` and
 * `seatOptions` (this cell's own already-fetched suggestion sources) and
 * `seatHoldings` (used to show each seat suggestion's current holder, so a
 * chapter lead can tell "Music Director — Alex" from "Music Director —
 * Vacant" before picking).
 *
 * The input EDITS A DISPLAY PROJECTION of the stored value: a stored token
 * `@[Label](mention:type:id)` shows as just `@Label` while editing (the raw
 * markup made typing after a mention miserable — see
 * `mentionDisplay.logic.ts`). Every keystroke against the projection is
 * mapped back onto the raw string (`applyDisplayEdit`); mentions behave as
 * atomic chips — an edit touching one deletes/replaces the whole token.
 * `value` in and `onCommit` out remain the RAW stored string.
 *
 * Selecting a suggestion commits IMMEDIATELY rather than waiting for blur:
 * on web, pressing a `Popover` row blurs the underlying `TextInput` first
 * (focus moves to the pressable), which would otherwise commit the
 * pre-selection text before the mention is spliced in. `justSelectedRef`
 * suppresses that stale blur-commit; `insertMention` is the sole committer
 * for the selection path.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { encodeMention, type MentionType } from "@events-os/shared";
import { MentionPopover } from "./MentionPopover";
import { useAnchor } from "../ui/useAnchor";
import { detectMentionTrigger, type MentionTrigger } from "./mentionTrigger.logic";
import {
  applyDisplayEdit,
  buildMentionDisplay,
  displayPosToRaw,
  mentionDisplayLabel,
  posTouchesMention,
  type DisplaySpan,
} from "./mentionDisplay.logic";
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
  onDone,
  placeholder,
  multiline,
  autoFocus,
  weight,
  people,
  seatHoldings,
  seatOptions,
  inputClassName,
  onFocusChange,
}: {
  value: string;
  onCommit: (v: string) => void;
  /** Fires when an editing session ends (blur, or a mention was inserted) —
   *  lets a display/edit wrapper (MentionInlineText) flip back to rendered
   *  links. Distinct from onCommit, which is about persisting the value. */
  onDone?: () => void;
  placeholder?: string;
  /** Auto-growing multiline input (mirrors the grid InlineText's behavior). */
  multiline?: boolean;
  autoFocus?: boolean;
  weight?: "normal" | "medium";
  people: { _id: string; name: string }[];
  seatHoldings: { personId: string; seatDefId: string }[];
  seatOptions: { seatDefId: string; title: string }[];
  /** Overrides the default `className` on the underlying `TextInput` — lets
   *  callers with their own box styling (e.g. CopyEditor) avoid the grid's
   *  default cell padding/typography. */
  inputClassName?: string;
  /** Fires on focus and blur, in addition to (not instead of) this input's
   *  own onBlur commit logic — lets a caller drive its own focus-state
   *  styling (e.g. CopyEditor's border-accent toggle). */
  onFocusChange?: (focused: boolean) => void;
}) {
  // The RAW stored string is the source of truth; the TextInput renders and
  // edits its display projection (`@Label` per token).
  const [raw, setRaw] = useState(value);
  const projection = useMemo(() => buildMentionDisplay(raw), [raw]);
  const [trigger, setTrigger] = useState<MentionTrigger>(null);
  // Auto-grow multiline inputs to their content height (same rationale as the
  // grid's InlineText: wrapped text must never clip).
  const [contentH, setContentH] = useState<number | undefined>(undefined);
  // Caret position, in DISPLAY coordinates (what the input shows).
  const cursorRef = useRef(projection.display.length);
  const justSelectedRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const { ref, anchor, visible, open, close } = useAnchor();

  // Where the caret is RIGHT NOW. react-native-web does not reliably fire
  // onSelectionChange while typing (it did fire on native), so relying on
  // cursorRef alone left it permanently stale on web and the `@` trigger
  // never detected. On web the TextInput ref IS the DOM <input>/<textarea>,
  // whose selectionEnd is already updated when the change event fires — read
  // it directly; fall back to cursorRef (native) or end-of-text.
  const readCursor = (fallbackText: string): number => {
    const el = inputRef.current as unknown as { selectionEnd?: unknown } | null;
    if (el && typeof el.selectionEnd === "number") return el.selectionEnd;
    return cursorRef.current ?? fallbackText.length;
  };

  // When an edit collapses an atomic mention (or splices one in), the new
  // display differs from what the DOM just showed — after React re-renders
  // the projected value, put the caret where the edit logic says it belongs.
  const pendingCursorRef = useRef<number | null>(null);
  useEffect(() => {
    const pending = pendingCursorRef.current;
    if (pending == null) return;
    pendingCursorRef.current = null;
    cursorRef.current = pending;
    const el = inputRef.current as unknown as {
      setSelectionRange?: (s: number, e: number) => void;
    } | null;
    // Web: the ref is the DOM input/textarea. Native falls back to
    // cursorRef, which the line above already updated.
    el?.setSelectionRange?.(pending, pending);
  }, [raw]);

  // Keep the field in sync when the underlying value changes from elsewhere
  // (mirrors InlineText).
  useEffect(() => {
    setRaw(value);
    cursorRef.current = buildMentionDisplay(value).display.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const runTrigger = (displayText: string, cursor: number, spans: DisplaySpan[]) => {
    let next = detectMentionTrigger(displayText, cursor);
    // An existing token's own `@Label` must never read as an in-progress
    // query (placing the caret right after `@Treasurer` would otherwise
    // reopen the picker).
    if (next && posTouchesMention(spans, next.start)) next = null;
    setTrigger(next);
    if (next) open();
    else close();
  };

  const suggestions: Suggestion[] = trigger
    ? buildSuggestions(trigger.query, people, seatOptions, seatHoldings)
    : [];

  const insertMention = (s: Suggestion) => {
    if (!trigger) return;
    // Trigger start/caret are display positions inside plain text (an
    // in-progress `@query` is never inside a token) — map them to raw and
    // splice the encoded token into the RAW string.
    const rStart = displayPosToRaw(projection, trigger.start);
    const rEnd = displayPosToRaw(projection, cursorRef.current);
    const nextRaw =
      raw.slice(0, rStart) + encodeMention(s.type, s.id, s.label) + " " + raw.slice(rEnd);
    setRaw(nextRaw);
    pendingCursorRef.current =
      trigger.start + mentionDisplayLabel(s.label).length + 1;
    setTrigger(null);
    close();
    onCommit(nextRaw);
    // On web the portal popover prevents the suggestion click from blurring
    // the input (see MentionPopover.web), so the pressIn flag is never reset
    // by a blur — reset it here or the NEXT genuine blur would be swallowed.
    justSelectedRef.current = false;
    // Inserting is a natural end-of-session: surface the rendered link as
    // immediate payoff.
    onDone?.();
  };

  return (
    <>
      <View ref={ref} className="flex-1">
        <TextInput
          ref={inputRef}
          value={projection.display}
          onChangeText={(nextDisplay) => {
            const result = applyDisplayEdit(raw, projection.display, nextDisplay);
            setRaw(result.raw);
            if (result.cursorNeedsForce) {
              pendingCursorRef.current = result.cursor;
            } else {
              cursorRef.current = readCursor(result.display);
            }
            runTrigger(
              result.display,
              result.cursorNeedsForce ? result.cursor : cursorRef.current,
              result.spans,
            );
          }}
          onSelectionChange={(e) => {
            const sel = e.nativeEvent.selection.end;
            cursorRef.current = sel;
            runTrigger(projection.display, sel, projection.spans);
          }}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => {
            close();
            setTrigger(null);
            onFocusChange?.(false);
            if (justSelectedRef.current) {
              justSelectedRef.current = false;
              return;
            }
            onCommit(raw);
            onDone?.();
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          multiline={multiline}
          autoFocus={autoFocus}
          textAlignVertical="top"
          onContentSizeChange={
            multiline
              ? (e) => setContentH(e.nativeEvent.contentSize.height)
              : undefined
          }
          className={
            inputClassName ??
            `flex-1 px-2 py-1.5 text-sm leading-snug text-ink ${
              weight === "medium" ? "font-medium" : ""
            }`
          }
          style={[
            { minWidth: 40 },
            // minHeight (not height) — same as the grid InlineText: a
            // manually-stretched row's extra space is filled via flex.
            multiline && contentH ? { minHeight: Math.max(contentH, 22) } : null,
          ]}
        />
      </View>
      <MentionPopover visible={visible} onClose={close} anchor={anchor}>
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
      </MentionPopover>
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
