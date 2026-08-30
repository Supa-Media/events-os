/**
 * MARKETING · Designs — the viewer panel, and the one place anything is edited.
 *
 * The tab that shipped put a pencil and a bin on every row, and the founder's
 * read of it was that the page "just looks like an editor, but no viewer". This
 * component is the other half of the fix: the browse surface goes back to being
 * a browse surface, and everything you can DO to a thing lives in the panel
 * that shows you the thing.
 *
 * ── Why a Modal and not an inline pane ──────────────────────────────────────
 * One file serves phone, tablet and web. A modal is the only container that
 * behaves on all three without a layout branch per platform: it takes the focus,
 * it closes on the Android back button (`onRequestClose`), and RN-web renders it
 * as an overlay rather than as a third column that would leave a phone with a
 * 90px-wide grid.
 *
 * It is still SHAPED per width — an edge sheet on a desk, a bottom sheet on a
 * phone — because a 460px panel pinned to the right of a 390px screen is a
 * dialog covering everything, and a bottom sheet on a 1400px desk wastes the
 * space that made the split worth having.
 *
 * ── Read-only is a real state here ──────────────────────────────────────────
 * The panel is NOT gated on `canEdit`: reading the kit is ungated on purpose
 * (`marketingDesigns.ts`), so a volunteer taps a swatch and gets the swatch,
 * the hex, and a copy button — with no fields and no footer at all. The
 * inspectors decide that; this shell only renders what it's handed.
 */
import type { ReactNode } from "react";
import {
  Modal,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { KeyboardAwareScroll } from "../../ui/KeyboardAwareScroll";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";

/** Below this the panel is a bottom sheet; at or above it, an edge sheet. */
const EDGE_SHEET_MIN_WIDTH = 720;

export function Inspector({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  /** The one line under the title — what kind of thing this is, and where it
   *  sits. */
  subtitle?: string | null;
  onClose: () => void;
  children: ReactNode;
  /** Actions pinned under the scroll area. Absent for a read-only caller,
   *  which is what makes the ungated read genuinely affordance-free. */
  footer?: ReactNode;
}) {
  // 0 in a test environment, which lands on the bottom-sheet branch — the
  // narrower of the two, and the one that doesn't assume a viewport.
  const edge = useWindowDimensions().width >= EDGE_SHEET_MIN_WIDTH;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close"
        className={`flex-1 bg-ink/30 ${edge ? "flex-row justify-end" : "justify-end"}`}
      >
        {/* An inner Pressable with an empty handler is how a tap inside the
            panel stops short of the scrim's dismiss (the SaleDetailModal
            pattern). */}
        <Pressable
          onPress={() => {}}
          className={
            edge
              ? "h-full w-[460px] max-w-full border-l border-border bg-raised shadow-pop"
              : "max-h-[86%] w-full rounded-t-xl border-t border-border bg-raised shadow-pop"
          }
        >
          <View className="flex-row items-start gap-3 border-b border-border px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="font-display text-lg text-ink" numberOfLines={2}>
                {title}
              </Text>
              {subtitle ? (
                <Text className="mt-0.5 text-2xs text-faint" numberOfLines={2}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              className="rounded-md p-1"
            >
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          {/* The SAME scroller `Screen` uses, not a plain ScrollView: this
              panel is a `Modal`, so it sits outside the page's scroller and
              would otherwise let the phone keyboard cover the field being
              typed into — a bottom sheet is exactly where that bites. The
              provider is at the app root, and React context reaches through a
              Modal. */}
          <KeyboardAwareScroll
            style={edge ? { flex: 1 } : { maxHeight: 520 }}
            contentContainerStyle={{ padding: 20 }}
            keyboardShouldPersistTaps="handled"
            bottomOffset={24}
          >
            {children}
          </KeyboardAwareScroll>

          {footer ? (
            <View className="flex-row flex-wrap items-center gap-2 border-t border-border px-5 py-3.5">
              {footer}
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * The "move earlier / move later" pair, as labelled buttons rather than the
 * chevrons that used to sit on every row.
 *
 * Ordering is the team's own idea of primary-first, so it stays editable — it
 * just stops being a permanent fixture of the browse surface. Ends are disabled
 * rather than hidden so the footer doesn't reflow as you move something to the
 * top.
 */
export function ReorderControls({
  onEarlier,
  onLater,
  earlierDisabled,
  laterDisabled,
  label,
}: {
  onEarlier: () => void;
  onLater: () => void;
  earlierDisabled: boolean;
  laterDisabled: boolean;
  /** What is being moved, for the screen reader — "PW Red", "Logos". */
  label: string;
}) {
  return (
    <View className="mb-4 flex-row items-center gap-2">
      <Text className="text-xs font-semibold text-muted">Order</Text>
      <ReorderButton
        icon="arrow-up"
        label={`Move ${label} earlier`}
        disabled={earlierDisabled}
        onPress={onEarlier}
      />
      <ReorderButton
        icon="arrow-down"
        label={`Move ${label} later`}
        disabled={laterDisabled}
        onPress={onLater}
      />
    </View>
  );
}

function ReorderButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: "arrow-up" | "arrow-down";
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`h-8 w-8 items-center justify-center rounded-md border border-border bg-raised ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <Icon name={icon} size={15} color={disabled ? colors.faint : colors.ink} />
    </Pressable>
  );
}
