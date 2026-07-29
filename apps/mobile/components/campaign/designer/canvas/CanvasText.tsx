/**
 * TEXT ON THE CANVAS — the markdown subset drawn as real type, and the
 * in-place editing that replaces "type in a field, look at a preview".
 *
 * Two components, both universal (RN primitives only — no `<div>`, no
 * `onMouseDown`, so the composer keeps working on native exactly as it does
 * today):
 *
 *  - `CanvasMarkdown` walks the tree `@events-os/shared`'s
 *    `parseMarkdownSubset` produces. That is the SAME parse `emailRender.ts`
 *    walks into HTML, so "is this bold?" cannot be answered differently by the
 *    canvas and the inbox.
 *  - `CanvasEditableText` is the direct-manipulation primitive: the text as it
 *    will send, until you click it, and then a `TextInput` wearing exactly the
 *    same type styles in exactly the same place.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Image,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  parseMarkdownSubset,
  type MarkdownInlineNode,
  type MarkdownSubsetBlock,
} from "@events-os/shared";
import {
  BODY_LIST_INDENT,
  BODY_PARAGRAPH_SPACING,
  bodyParagraphSpacing,
} from "./canvasStyles";
import {
  editingBoxGeometry,
  slotLineHeight,
  splitTextBox,
} from "./canvasEditBox";
import {
  emptySlotDraw,
  promptStyle,
  slotPrompt,
  type CanvasSlot,
} from "./placeholders";

/** A web `<textarea>` does not grow with its content; React Native's multiline
 *  input does. `canvasEditBox.ts#editingBoxGeometry` is what does something
 *  about it — this is the only place that has to know which platform we're on. */
const IS_WEB = Platform.OS === "web";

/** One inline run and its children, as nested `<Text>` — RN inherits type
 *  styles down a `<Text>` tree the same way HTML does. */
function InlineNodes({
  nodes,
  linkStyle,
}: {
  nodes: readonly MarkdownInlineNode[];
  linkStyle: TextStyle;
}) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "text") return <Text key={index}>{node.text}</Text>;
        const style: TextStyle =
          node.kind === "strong"
            ? { fontWeight: "700" }
            : node.kind === "em"
              ? { fontStyle: "italic" }
              : linkStyle;
        return (
          <Text key={index} style={style}>
            <InlineNodes nodes={node.children} linkStyle={linkStyle} />
          </Text>
        );
      })}
    </>
  );
}

/**
 * The markdown subset, drawn.
 *
 * A list renders as a bullet column plus a text column rather than as RN has
 * no list primitive — the `listIndent` matches the HTML's own `padding-left`
 * so the two wrap at the same place.
 */
export function CanvasMarkdown({
  markdown,
  style,
  linkStyle,
  align = "left",
}: {
  markdown: string;
  /** The paragraph type style — font, size, line-height, colour. */
  style: TextStyle;
  linkStyle: TextStyle;
  align?: "left" | "center";
}) {
  const blocks: MarkdownSubsetBlock[] = parseMarkdownSubset(markdown);
  return (
    <>
      {blocks.map((block, index) => {
        // Including the LAST one — see `bodyParagraphSpacing`. The canvas
        // scales rather than reflows so that its vertical geometry is honest;
        // a body that ends 12px higher than the email's is exactly the drift
        // that costs.
        const spacing = bodyParagraphSpacing(index === blocks.length - 1);
        if (block.kind === "paragraph") {
          return (
            <Text
              key={index}
              style={[style, { textAlign: align, marginBottom: spacing }]}
            >
              <InlineNodes nodes={block.content} linkStyle={linkStyle} />
            </Text>
          );
        }
        return (
          <View key={index} style={{ marginBottom: spacing }}>
            {block.items.map((item, itemIndex) => (
              <View key={itemIndex} style={{ flexDirection: "row" }}>
                <Text style={[style, { width: BODY_LIST_INDENT }]}>{"•"}</Text>
                <Text style={[style, { flex: 1 }]}>
                  <InlineNodes nodes={item} linkStyle={linkStyle} />
                </Text>
              </View>
            ))}
          </View>
        );
      })}
    </>
  );
}

/**
 * A run of text that edits WHERE IT SITS.
 *
 * Three states, one geometry: read-only text, clickable text, and a focused
 * `TextInput` carrying the identical type styles. Same type in the same place
 * is the whole point — the words must not move, resize or change colour when
 * you start typing, or the canvas stops being a preview.
 *
 * ── The box, not just the type ─────────────────────────────────────────────
 * Same type was never enough. The static render of a body is SEVERAL text runs
 * with paragraph gaps; the editing render is ONE input holding raw markdown,
 * and a `<textarea>` on web takes its own default height. A three-paragraph
 * hero body collapsed to two lines the moment it was clicked and the whole
 * document jumped up the page.
 *
 * So the static render is MEASURED (`onLayout`) and the input is floored at
 * the height it found — see `canvasEditBox.ts`, which owns that arithmetic and
 * is unit-tested on it. The box then grows with what the author types and
 * never shrinks below the words that were on screen when the caret landed.
 * The slot's own margins are hoisted onto whichever view is outermost in each
 * state (`splitTextBox`), so all three states are the same shape.
 *
 * An EMPTY value draws whatever `emptySlotDraw` says it may (see
 * `placeholders.ts`): a quiet hint for an OPTIONAL slot and the prompt in the
 * slot's own type for a required one, both only when this block is selected; a
 * wordless outline when it isn't; and nothing at all on a locked canvas —
 * where the prompt would be help text sitting exactly where the approver
 * expects the newsletter's own copy. The outline is what keeps "the block
 * vanished" from coming back: an empty block stays visible and clickable for
 * the author without putting a single word on the page that the email
 * doesn't have.
 */
export function CanvasEditableText({
  value,
  slot,
  pollIndex,
  style,
  editable,
  selected,
  editing,
  onStartEditing,
  onStopEditing,
  onChangeText,
  multiline = false,
  accessibilityLabel,
  /** Rendered instead of plain text when NOT editing — how a `text` block
   *  shows formatted markdown but edits raw. */
  renderStatic,
  /**
   * Drawn in front of the value when NOT editing, and never part of it.
   *
   * For punctuation the RENDERER adds — a quote's `— ` — so the canvas shows
   * the line the email will show while the field still edits the bare string.
   * Folding it into the value instead is how a typed dash ends up doubled in
   * the send.
   */
  staticPrefix,
}: {
  value: string;
  /** Which slot this is. Carries both the prompt and whether the slot is one
   *  the email is complete without — see `placeholders.ts`. */
  slot: CanvasSlot;
  /** A poll option's number, for the one slot whose prompt isn't fixed. */
  pollIndex?: number;
  style: TextStyle;
  editable: boolean;
  /** Whether the BLOCK this slot belongs to is the selected one — the other
   *  half of `emptySlotDraw`'s decision. */
  selected: boolean;
  editing: boolean;
  onStartEditing: () => void;
  onStopEditing: () => void;
  onChangeText: (next: string) => void;
  multiline?: boolean;
  accessibilityLabel: string;
  renderStatic?: () => React.ReactNode;
  staticPrefix?: string;
}) {
  /** The height the STATIC render last occupied. Kept across the swap to the
   *  input — that is the entire trick, and it survives because this component
   *  stays mounted through it. */
  const [staticHeight, setStaticHeight] = useState<number | null>(null);
  /** What the input says its content needs (web only — see `IS_WEB`). */
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  // A new editing session starts from the static box again, whether it ended
  // by blurring or by the selection moving to another block.
  useEffect(() => {
    if (!editing) setContentHeight(null);
  }, [editing]);

  const placeholder = slotPrompt(slot, pollIndex);
  const line = slotLineHeight(style.lineHeight, style.fontSize);
  const { box, type } = splitTextBox(style);

  // Both stable: RN Web re-subscribes a `ResizeObserver` (and re-attaches the
  // input's ref, which re-measures it) whenever one of these changes identity,
  // and these fire on every keystroke.
  const measure = useCallback((e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    setStaticHeight((prev) =>
      prev !== null && Math.abs(prev - height) < 0.5 ? prev : height,
    );
  }, []);
  const measureContent = useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) =>
      setContentHeight(e.nativeEvent.contentSize.height),
    [],
  );

  if (editable && editing) {
    const geometry = editingBoxGeometry({
      value,
      multiline,
      lineHeight: line,
      // Only a slot drawn through `CanvasMarkdown` has paragraph gaps under
      // its blocks; a quote is one run however many lines it wraps to.
      paragraphSpacing: renderStatic ? BODY_PARAGRAPH_SPACING : 0,
      measured: staticHeight,
      contentHeight,
      selfSizing: !IS_WEB,
    });
    return (
      // The wrapper holds the box the static render occupied. It carries the
      // slot's margins too, so entering and leaving edit mode cannot change
      // the space the block takes up.
      <View style={[box, { minHeight: geometry.wrapperMinHeight }]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onBlur={onStopEditing}
          onContentSizeChange={measureContent}
          multiline={multiline}
          autoFocus
          accessibilityLabel={accessibilityLabel}
          placeholder={placeholder}
          // `padding: 0` and no border: the input must occupy exactly the box
          // the text occupied. RN gives a TextInput its own padding on Android
          // and a focus ring on web, both of which would nudge the layout.
          style={[
            type,
            {
              padding: 0,
              margin: 0,
              borderWidth: 0,
              // Android centres a multiline input's text in a box taller than
              // its content; the words have to start where the static ones
              // did. Ignored elsewhere.
              textAlignVertical: "top",
              minHeight: geometry.inputMinHeight,
              height: geometry.inputHeight,
              // `outlineWidth` is web-only; harmless on native (unknown style
              // keys are ignored) and it removes the browser's focus ring, which
              // would otherwise sit around a heading mid-email.
              outlineWidth: 0,
            } as TextStyle,
          ]}
        />
      </View>
    );
  }

  const empty = value.trim().length === 0;

  // The canvas page deselects on press and RN Web's press handling BUBBLES,
  // so every one of these has to stop the click reaching it — otherwise
  // clicking a heading to edit it would select the block and immediately
  // deselect it again.
  const start = (e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    onStartEditing();
  };

  const draw = empty ? emptySlotDraw(editable, selected, slot) : null;
  // A locked canvas is a picture of the email, and the email has nothing
  // here. Note this also drops the slot's own margin, exactly as the
  // renderer's `if (content.body)` does.
  if (draw === "nothing") return null;
  if (draw === "outline") {
    return (
      <EmptySlot
        line={line}
        box={box}
        color={type.color}
        centered={type.textAlign === "center"}
        label={accessibilityLabel}
        onPress={start}
        onLayout={measure}
      />
    );
  }

  const body =
    draw !== null ? (
      <Text style={[type, promptStyle(draw, { fontSize: type.fontSize, lineHeight: line })]}>
        {placeholder}
      </Text>
    ) : renderStatic ? (
      <>{renderStatic()}</>
    ) : (
      <Text style={type}>{staticPrefix ? `${staticPrefix}${value}` : value}</Text>
    );

  if (!editable) return <View style={box}>{body}</View>;

  // `renderStatic` means block-level content (a markdown body renders lists as
  // Views), and a View nested inside a `<Text>` lays out badly on native — so
  // that case gets a Pressable wrapper. Everything else keeps a `<Text>`
  // wrapper, which preserves the inline flow a View would break.
  if (renderStatic && !empty) {
    return (
      <Pressable
        onPress={start}
        onLayout={measure}
        style={box}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${accessibilityLabel}`}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <Text
      onPress={start}
      onLayout={measure}
      style={box}
      accessibilityRole="button"
      accessibilityLabel={`Edit ${accessibilityLabel}`}
      suppressHighlighting
    >
      {body}
    </Text>
  );
}

/** The outline state's proportions. EDITOR chrome, not email geometry — so
 *  these are the only numbers in this file, and nothing reads them but the
 *  mark below (its sibling, how loudly a prompt is drawn, lives with the rule
 *  in `placeholders.ts#PROMPT_VOICE`). A short bar rather than a full-width
 *  rule: a full-width one reads as a divider, which IS a block the email can
 *  contain. */
const EMPTY_SLOT_BAR = { widthPct: 32, height: 2, opacity: 0.22 } as const;

/**
 * An empty slot on an EDITABLE canvas whose block isn't selected: a small
 * neutral bar in the slot's own colour, occupying one line of its own type.
 *
 * It says "something goes here" without saying what — the prompt is one click
 * away, on the selected block. It takes the slot's colour from the style it
 * would have drawn, so it stays visible on a maroon hero card and a cream one
 * alike, and it follows the slot's alignment so a centred card's marks sit
 * under its centred heading. One line of type is also exactly what a hint
 * occupies (`promptStyle` keeps the slot's line box), so selecting the block
 * swaps the mark for its words without moving anything.
 */
function EmptySlot({
  line,
  box,
  color,
  centered,
  label,
  onPress,
  onLayout,
}: {
  line: number;
  box: ViewStyle;
  color: ColorValue | undefined;
  centered: boolean;
  label: string;
  onPress: (e?: { stopPropagation?: () => void }) => void;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="button"
      accessibilityLabel={`Add ${label}`}
      style={[
        box,
        {
          height: line,
          justifyContent: "center",
          alignItems: centered ? "center" : "flex-start",
        },
      ]}
    >
      <View
        style={{
          width: `${EMPTY_SLOT_BAR.widthPct}%`,
          height: EMPTY_SLOT_BAR.height,
          borderRadius: 999,
          opacity: EMPTY_SLOT_BAR.opacity,
          backgroundColor: color,
        }}
      />
    </Pressable>
  );
}

/**
 * A remote image at the canvas's own width.
 *
 * The email says `width:100%` and lets the client work the height out; RN has
 * no auto height for a remote source, so the intrinsic size is fetched once
 * and kept as an aspect ratio. Until it arrives the tile holds a neutral 16:9
 * so the document doesn't reflow around a zero-height hole.
 */
export function CanvasImage({
  url,
  style,
  accessibilityLabel,
}: {
  url: string;
  style?: ImageStyle;
  accessibilityLabel: string;
}) {
  const [aspect, setAspect] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAspect(null);
    Image.getSize(
      url,
      (width, height) => {
        if (!cancelled && height > 0) setAspect(width / height);
      },
      () => {
        // A URL that won't load is the designer's problem to see, not a crash:
        // the tile keeps its placeholder ratio and the image simply stays
        // blank, exactly as it would in a mail client.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <Image
      source={{ uri: url }}
      accessibilityLabel={accessibilityLabel}
      accessible
      resizeMode="cover"
      style={[{ width: "100%", aspectRatio: aspect ?? 16 / 9 }, style]}
    />
  );
}
