/**
 * THE INSPECTOR — the contextual panel for whichever block is selected.
 *
 * Canva's model, and the second half of the answer to "where do the validation
 * warnings live once there are no form fields?": the canvas shows a COUNT on
 * the block, and this panel shows those warnings in full — at the top, above
 * the controls that fix them, for one block at a time. Never a wall, never
 * lost.
 *
 * It shows one block's properties, never fifteen. With nothing selected it
 * says so rather than disappearing, because a panel that comes and goes moves
 * the layout under the designer's hands.
 */
import { Pressable, Text, View } from "react-native";
import type { EmailBlock } from "@events-os/shared";
import { Icon } from "../../../ui";
import { colors } from "../../../../lib/theme";
import { BLOCK_KIND_LABELS } from "../../../../lib/emailDesigner";
import type { ActionRunner } from "../../../../lib/useActionToast";
import type { UploadImage } from "../DesignerControls";
import { BlockFields } from "./BlockFields";
import type { BlockWarning } from "./blockWarnings";

export function BlockInspector({
  block,
  warnings,
  onChange,
  onDuplicate,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
  uploadImage,
  run,
}: {
  /** `null` when nothing is selected. */
  block: EmailBlock | null;
  warnings: BlockWarning[];
  onChange: (patch: Record<string, unknown>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
}) {
  if (!block) {
    return (
      <View className="rounded-lg border border-dashed border-border bg-raised px-4 py-6">
        <Text className="text-center text-xs text-muted">
          Click any part of the email to select it. Headings, body text, button
          labels and poll options type straight onto the page.
        </Text>
      </View>
    );
  }

  const label = BLOCK_KIND_LABELS[block.kind];

  return (
    <View className="rounded-lg border border-border bg-raised p-3">
      <View className="mb-3 flex-row items-center gap-2">
        <Text className="flex-1 text-xs font-bold uppercase tracking-wider text-faint">
          {label}
        </Text>
        <InspectorButton
          icon="chevron-up"
          label={`Move ${label} block up`}
          onPress={() => onMove(-1)}
          disabled={!canMoveUp}
        />
        <InspectorButton
          icon="chevron-down"
          label={`Move ${label} block down`}
          onPress={() => onMove(1)}
          disabled={!canMoveDown}
        />
        <InspectorButton icon="copy" label="Duplicate block" onPress={onDuplicate} />
        <InspectorButton icon="trash-2" label="Delete block" onPress={onDelete} danger />
      </View>

      <BlockWarningList warnings={warnings} />

      <BlockFields block={block} onChange={onChange} uploadImage={uploadImage} run={run} />
    </View>
  );
}

/**
 * One block's warnings, in full.
 *
 * Blocking ones (the write gate would refuse the document, taking every other
 * block's edits down with it) are danger-toned and named as such. Advisory
 * ones are warn-toned, because each describes something the designer can
 * knowingly ship — an image she means to be decorative — and red would cry
 * wolf. Each line names the CONTROL that fixes it, since on a canvas the fix
 * may not be directly beneath the words.
 */
export function BlockWarningList({ warnings }: { warnings: readonly BlockWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <View className="mb-3 gap-2">
      {warnings.map((warning) => {
        const blocking = warning.severity === "blocking";
        return (
          <View
            key={warning.key}
            className={`rounded-md border px-2.5 py-2 ${
              blocking ? "border-danger bg-danger-bg" : "border-warn-soft bg-warn-bg"
            }`}
          >
            <View className="mb-0.5 flex-row items-center gap-1.5">
              <Icon
                name="alert-triangle"
                size={11}
                color={blocking ? colors.danger : colors.warn}
              />
              <Text
                className={`text-2xs font-bold uppercase tracking-wider ${
                  blocking ? "text-danger" : "text-warn"
                }`}
              >
                {blocking ? `Blocks saving · ${warning.field}` : warning.field}
              </Text>
            </View>
            <Text className="text-xs text-ink">{warning.message}</Text>
          </View>
        );
      })}
    </View>
  );
}

function InspectorButton({
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
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      className={`rounded p-1.5 ${
        disabled ? "opacity-25" : "active:bg-sunken web:hover:bg-sunken"
      }`}
    >
      <Icon name={icon} size={16} color={danger ? colors.danger : colors.muted} />
    </Pressable>
  );
}
