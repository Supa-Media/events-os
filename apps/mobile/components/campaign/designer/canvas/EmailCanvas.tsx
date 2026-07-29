/**
 * THE CANVAS — the document, drawn at its own scale, with the selection
 * affordances layered over it.
 *
 * This is what replaced the stack of form cards. The email is laid out at its
 * true 600px width and SCALED to fit the column (never reflowed — reflowing
 * would quietly make the thing you edit a different document from the thing
 * that sends). Clicking a block selects it; the selected block gets a ring, a
 * contextual toolbar, and — if the write gate would refuse it — a badge.
 *
 * ── The chrome never moves the document ────────────────────────────────────
 * Selection rings, toolbars and badges are ABSOLUTELY POSITIONED overlays, so
 * turning selection on and off cannot shift a single pixel of the email. A
 * ring that pushes the layout by 2px is a canvas that lies.
 *
 * ── The chrome does not scale with the document ────────────────────────────
 * Everything overlaid counter-scales by `1/scale`, so on a phone (where the
 * document is drawn at ~0.6) the delete button is still a real tap target
 * rather than a 9px one. The EMAIL scales; the EDITOR's controls don't.
 *
 * ── The iframe is still on screen ──────────────────────────────────────────
 * This surface is a faithful second renderer, not the arbiter. The sandboxed
 * `EmailHtmlPreview` stays beside it as "what Gmail will actually show" — see
 * `docs/plans/email-editor-canvas.md` §2 for why that is the honest split.
 *
 * ── Reordering: drag AND arrows ────────────────────────────────────────────
 * Blocks are wrapped in `components/grid/SortableRows` — the same drag stack
 * the grid uses, which works on web and native and starts only from a handle
 * it hands out, so clicking anywhere else on a block still selects and edits
 * it. The handle lives on the SELECTED block's toolbar (see `BlockToolbar`).
 * The up/down arrows stay: drag is an addition to them, never a replacement.
 * The list is told the document's `scale`, without which every drop lands
 * short of the finger on a phone — see `sortableRowMath.ts`.
 */
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import type { EmailBlock, EmailDocument, EmailTheme } from "@events-os/shared";
import { Icon } from "../../../ui";
import { colors } from "../../../../lib/theme";
import { SortableRows } from "../../../grid/SortableRows";
import { BlockView } from "./BlockView";
import {
  CANVAS_WIDTH,
  FALLBACK_FOOTER_PADDING,
  WORDMARK_PADDING,
  blockGutter,
  canvasScale,
  containerStyle,
  fallbackFooterTextStyle,
  pageStyle,
  transformOrigin,
  wordmarkStyle,
} from "./canvasStyles";
import { worstSeverity, type BlockWarning } from "./blockWarnings";

const IS_WEB = Platform.OS === "web";

/** `transformOrigin` takes a CSS string on web and an `[x, y, z]` TUPLE on
 *  native, where a two-element tuple is a dev-build crash rather than a
 *  fallback — see `canvasStyles.ts#transformOrigin`. */
const TOP_LEFT = transformOrigin("top-left", IS_WEB);
const TOP_RIGHT = transformOrigin("top-right", IS_WEB);

/** Air around the document inside the page. The top is deeper than the sides
 *  because the FIRST block's contextual toolbar sits above it, and a toolbar
 *  clipped off the top of the page is a toolbar the designer can't reach. */
const CANVAS_PADDING = 28;
const CANVAS_PADDING_TOP = 44;
/** How far above its block the contextual toolbar floats, in real pixels. */
const TOOLBAR_OFFSET = 30;

export type CanvasEditingTarget = { blockId: string; field: string } | null;

export type EmailCanvasProps = {
  doc: EmailDocument;
  theme: EmailTheme;
  editable: boolean;
  /** How much room the canvas column has. The document scales to fit it. */
  availableWidth: number;
  selectedId: string | null;
  onSelect: (blockId: string | null) => void;
  editing: CanvasEditingTarget;
  onEditingChange: (target: CanvasEditingTarget) => void;
  onChange: (blockId: string, patch: Record<string, unknown>) => void;
  onDuplicate: (blockId: string) => void;
  onDelete: (blockId: string) => void;
  onMove: (blockId: string, delta: -1 | 1) => void;
  /** A drag has dropped: the document's blocks in their new order. Fires ONCE
   *  per drop (never per frame), so it lands as a single history step and a
   *  single autosave. */
  onReorder: (orderedIds: string[]) => void;
  /** Per-block warnings, from `documentWarnings` — the canvas only ever shows
   *  the COUNT (see `blockWarnings.ts` for why). */
  warningsByBlockId: Record<string, BlockWarning[]>;
};

export function EmailCanvas({
  doc,
  theme,
  editable,
  availableWidth,
  selectedId,
  onSelect,
  editing,
  onEditingChange,
  onChange,
  onDuplicate,
  onDelete,
  onMove,
  onReorder,
  warningsByBlockId,
}: EmailCanvasProps) {
  const scale = canvasScale(availableWidth - CANVAS_PADDING * 2);
  const blockIds = useMemo(() => doc.blocks.map((b) => b.id), [doc.blocks]);
  // The document's natural height, measured once laid out — the scaled
  // wrapper needs it, because a transform doesn't change the space a view
  // takes up and the page would otherwise be 600-wide and full-height.
  const [naturalHeight, setNaturalHeight] = useState<number | null>(null);

  /** One block, drawn identically whether or not it came through the drag
   *  list — the ONLY difference is the handle it is (or isn't) given. */
  const renderBlock = (block: EmailBlock, index: number, drag?: GestureType) => (
    <CanvasBlock
      key={block.id}
      block={block}
      theme={theme}
      editable={editable}
      scale={scale}
      selected={selectedId === block.id}
      warnings={warningsByBlockId[block.id] ?? []}
      editingField={editing && editing.blockId === block.id ? editing.field : null}
      onSelect={() => {
        onSelect(block.id);
        if (editing && editing.blockId !== block.id) onEditingChange(null);
      }}
      onStartEditing={(field) => {
        onSelect(block.id);
        onEditingChange({ blockId: block.id, field });
      }}
      onStopEditing={() => onEditingChange(null)}
      onChange={(patch) => onChange(block.id, patch)}
      onDuplicate={() => onDuplicate(block.id)}
      onDelete={() => onDelete(block.id)}
      onMove={(delta) => onMove(block.id, delta)}
      canMoveUp={index > 0}
      canMoveDown={index < doc.blocks.length - 1}
      dragGesture={drag}
    />
  );

  return (
    <Pressable
      // Clicking the page around the email is how you get back to "nothing
      // selected", the same way it works in every design tool.
      onPress={() => {
        onSelect(null);
        onEditingChange(null);
      }}
      accessibilityRole="none"
      style={[
        pageStyle(theme),
        {
          paddingTop: CANVAS_PADDING_TOP,
          paddingBottom: CANVAS_PADDING,
          paddingHorizontal: CANVAS_PADDING,
          alignItems: "center",
          borderRadius: 8,
          // The chrome (toolbars, badges, selection rings) is drawn OUTSIDE
          // the block's own box, and RN Web clips a View's overflow by
          // default — without this the first block's toolbar disappears.
          overflow: "visible",
        },
      ]}
    >
      <View
        style={{
          width: CANVAS_WIDTH * scale,
          height: naturalHeight === null ? undefined : naturalHeight * scale,
          overflow: "visible",
        }}
      >
        <View
          onLayout={(e) => setNaturalHeight(e.nativeEvent.layout.height)}
          style={[
            containerStyle(theme),
            { transform: [{ scale }], transformOrigin: TOP_LEFT },
          ]}
        >
          {theme.wordmark ? (
            <View style={WORDMARK_PADDING}>
              <Text style={wordmarkStyle(theme, IS_WEB)}>{theme.wordmark}</Text>
            </View>
          ) : null}

          {/* Drag-to-reorder exists only on an editable canvas: a locked
              document doesn't mount the gesture stack at all, rather than
              mounting one whose handle never appears. */}
          {editable ? (
            <SortableRows
              ids={blockIds}
              // The document is drawn at `scale`; the gesture is not. Without
              // this the drop lands rows short of the finger — proved in
              // `canvasDrag.test.ts`.
              scale={scale}
              onReorder={onReorder}
              renderRow={({ id, index, drag }) => {
                const block = doc.blocks[index]?.id === id ? doc.blocks[index] : null;
                return block ? renderBlock(block, index, drag) : null;
              }}
            />
          ) : (
            doc.blocks.map((block, index) => renderBlock(block, index))
          )}

          {/* The unsubscribe row every send carries when the document has no
              `footer` block of its own (`renderCampaignEmail`'s
              `fallbackFooter`). Drawn so the email's real ending is visible;
              it is renderer furniture and has nothing to edit. */}
          {doc.blocks.some((b) => b.kind === "footer") ? null : (
            <View style={FALLBACK_FOOTER_PADDING}>
              <Text style={fallbackFooterTextStyle(theme, IS_WEB)}>
                Sent with love by Public Worship · Chapter OS{"\n"}
                Unsubscribe from all Public Worship emails
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * One block plus its selection chrome.
 *
 * The block's own view is untouched by selection — the ring and the toolbar
 * are overlays. `pointerEvents="none"` on the ring keeps clicks landing on the
 * block itself rather than on its own highlight.
 */
function CanvasBlock({
  block,
  theme,
  editable,
  scale,
  selected,
  warnings,
  editingField,
  onSelect,
  onStartEditing,
  onStopEditing,
  onChange,
  onDuplicate,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
  dragGesture,
}: {
  block: EmailBlock;
  theme: EmailTheme;
  editable: boolean;
  scale: number;
  selected: boolean;
  warnings: BlockWarning[];
  editingField: string | null;
  onSelect: () => void;
  onStartEditing: (field: string) => void;
  onStopEditing: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** This block's drag gesture, from `SortableRows`. Absent on a locked
   *  canvas, which mounts no drag list at all. */
  dragGesture?: GestureType;
}) {
  const severity = worstSeverity(warnings);
  const inverse = 1 / scale;

  return (
    <View style={{ paddingHorizontal: blockGutter(block) }}>
      <Pressable
        onPress={(e) => {
          // See `CanvasEditableText` — the page below deselects on press, and
          // RN Web's press handling bubbles.
          e?.stopPropagation?.();
          onSelect();
        }}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel={`${block.kind} block`}
        accessibilityState={{ selected }}
      >
        <BlockView
          block={block}
          theme={theme}
          editable={editable}
          selected={selected}
          editingField={editingField}
          onStartEditing={onStartEditing}
          onStopEditing={onStopEditing}
          onChange={onChange}
        />
      </Pressable>

      {selected && editable ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -3,
            bottom: -3,
            left: blockGutter(block) - 3,
            right: blockGutter(block) - 3,
            borderWidth: 1.5 * inverse,
            borderColor: colors.accent,
            borderRadius: 4 * inverse,
          }}
        />
      ) : null}

      {severity && editable ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            right: blockGutter(block),
            transform: [{ scale: inverse }],
            transformOrigin: TOP_RIGHT,
          }}
        >
          <WarningBadge count={warnings.length} severity={severity} onPress={onSelect} />
        </View>
      ) : null}

      {selected && editable ? (
        <View
          style={{
            position: "absolute",
            // Sits above the block, at true size whatever the document scale.
            top: -TOOLBAR_OFFSET * inverse,
            left: blockGutter(block),
            transform: [{ scale: inverse }],
            transformOrigin: TOP_LEFT,
          }}
        >
          <BlockToolbar
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onMove={onMove}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            dragGesture={dragGesture}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The count of problems on a block, and nothing more.
 *
 * The detail lives in the inspector, one click away — fifteen warning banners
 * over the artwork is what this badge exists to prevent. Red only when the
 * write gate would actually refuse the document; amber for advice the designer
 * is free to ignore (see `blockWarnings.ts`).
 */
function WarningBadge({
  count,
  severity,
  onPress,
}: {
  count: number;
  severity: "blocking" | "advisory";
  onPress: () => void;
}) {
  const blocking = severity === "blocking";
  return (
    <Pressable
      onPress={(e) => {
        e?.stopPropagation?.();
        onPress();
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        blocking
          ? `${count} problem${count === 1 ? "" : "s"} blocking this email from saving. Select the block to see them.`
          : `${count} suggestion${count === 1 ? "" : "s"} on this block`
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: blocking ? colors.danger : colors.warn,
      }}
    >
      <Icon name="alert-triangle" size={11} color="#FFFFFF" />
      <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "700" }}>{count}</Text>
    </Pressable>
  );
}

/**
 * The selected block's contextual toolbar — and the one place a drag starts.
 *
 * The up/down arrows are KEPT from the form-card designer, deliberately: they
 * exist because dragging a fifteen-block newsletter on a phone was "a
 * long-press-and-scroll fight". Drag is an ADDITION to them, never a
 * replacement — moving the last of fifteen blocks to the top is one drag or
 * fourteen taps, and both are now available.
 *
 * The GRIP lives here rather than on the block itself, for three reasons:
 *
 *  1. It cannot fight in-place editing. Every other pixel of a block is text
 *     you click to type into; a press-and-hold anywhere on the block would
 *     have to decide between "start dragging" and "put the caret here", and
 *     the loser of that fight is always the one you wanted.
 *  2. The toolbar counter-scales by `1/scale`, so the handle is a real tap
 *     target on a phone where the document is drawn at ~0.6 — a grip in the
 *     document's own coordinate space would be a 9px one.
 *  3. It appears exactly when the block is selected and editable, which is
 *     the only state in which reordering is meaningful. On a locked canvas
 *     the toolbar isn't rendered and no drag list is mounted at all.
 */
function BlockToolbar({
  onDuplicate,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
  dragGesture,
}: {
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dragGesture?: GestureType;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingHorizontal: 4,
        paddingVertical: 3,
        borderRadius: 8,
        backgroundColor: colors.raised,
        borderWidth: 1,
        borderColor: colors.borderStrong,
      }}
    >
      {dragGesture ? (
        <GestureDetector gesture={dragGesture}>
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Drag to reorder this block"
            accessibilityHint="Or use the up and down arrows beside this handle"
            hitSlop={6}
            className="cursor-grab rounded p-1.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="move" size={15} color={colors.muted} />
          </View>
        </GestureDetector>
      ) : null}
      <ToolbarButton
        icon="chevron-up"
        label="Move block up"
        onPress={() => onMove(-1)}
        disabled={!canMoveUp}
      />
      <ToolbarButton
        icon="chevron-down"
        label="Move block down"
        onPress={() => onMove(1)}
        disabled={!canMoveDown}
      />
      <ToolbarButton icon="copy" label="Duplicate block" onPress={onDuplicate} />
      <ToolbarButton icon="trash-2" label="Delete block" onPress={onDelete} danger />
    </View>
  );
}

function ToolbarButton({
  icon,
  label,
  onPress,
  disabled = false,
  danger = false,
}: {
  icon: "copy" | "trash-2" | "chevron-up" | "chevron-down";
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={
        disabled
          ? undefined
          : (e) => {
              // Without this the press also reaches the canvas page, which
              // deselects — so "move up" would move the block and then drop
              // the selection you were about to move again.
              e?.stopPropagation?.();
              onPress();
            }
      }
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      className={`rounded p-1.5 ${
        disabled ? "opacity-25" : "active:bg-sunken web:hover:bg-sunken"
      }`}
    >
      <Icon name={icon} size={15} color={danger ? colors.danger : colors.muted} />
    </Pressable>
  );
}
