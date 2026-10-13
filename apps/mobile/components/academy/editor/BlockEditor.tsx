import { useState } from "react";
import { Text, View } from "react-native";
import {
  EDITABLE_BLOCK_KINDS,
  isCodeOnlyBlock,
  type AcademyBlock,
  type EditableBlockKind,
} from "@events-os/shared";
import { Button, Icon, Pill, type IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import { BlockFields } from "./BlockFields";
import { MoveControls } from "./EditorBits";
import { insertAt, moveItem, removeAt, replaceAt } from "./listOps";

/** What each block kind is called in the editor, and what it starts as. */
const KINDS: Record<
  EditableBlockKind,
  { label: string; icon: IconName; blank: () => AcademyBlock }
> = {
  p: { label: "Paragraph", icon: "align-left", blank: () => ({ kind: "p", text: "" }) },
  heading: { label: "Heading", icon: "type", blank: () => ({ kind: "heading", text: "" }) },
  bullets: { label: "Bullet list", icon: "list", blank: () => ({ kind: "bullets", items: [""] }) },
  rule: {
    label: "Key rule",
    icon: "bookmark",
    blank: () => ({ kind: "rule", title: "", text: "" }),
  },
  story: {
    label: "From the field",
    icon: "message-circle",
    blank: () => ({ kind: "story", title: "", text: "" }),
  },
  tip: { label: "In the app", icon: "smartphone", blank: () => ({ kind: "tip", text: "" }) },
  table: {
    label: "Table",
    icon: "grid",
    blank: () => ({ kind: "table", headers: ["", ""], rows: [["", ""]] }),
  },
  link: {
    label: "Link",
    icon: "external-link",
    blank: () => ({ kind: "link", label: "", url: "" }),
  },
  reveal: {
    label: "Tap to reveal",
    icon: "eye",
    blank: () => ({ kind: "reveal", prompt: "", answer: "" }),
  },
  scenario: {
    label: "What would you do?",
    icon: "help-circle",
    blank: () => ({
      kind: "scenario",
      prompt: "",
      options: [
        { text: "", correct: true, feedback: "" },
        { text: "", feedback: "" },
      ],
    }),
  },
};

/** Names for the built-in widgets the editor can move but not rewrite. */
const CODE_ONLY_LABELS: Record<string, string> = {
  tree: "Org chart diagram",
  try_status: "Practice: status chip",
  try_offset: "Practice: due-date offsets",
  try_chain: "Practice: accountability chain",
  try_ready: "Practice: mark ready",
  agent_demo: "Assistant demo",
};

/** The lesson's article: every block in order, each with its own form. */
export function BlockEditor({
  blocks,
  onChange,
}: {
  blocks: AcademyBlock[];
  onChange: (next: AcademyBlock[]) => void;
}) {
  // Where the add menu inserts: after this block (or at the end).
  const [addAfter, setAddAfter] = useState<number | null>(null);

  function add(kind: EditableBlockKind) {
    const at = addAfter == null ? blocks.length : addAfter + 1;
    onChange(insertAt(blocks, at, KINDS[kind].blank()));
    setAddAfter(null);
  }

  return (
    <View className="gap-3">
      {blocks.map((block, i) => {
        const codeOnly = isCodeOnlyBlock(block);
        const meta = codeOnly ? null : KINDS[block.kind as EditableBlockKind];
        return (
          <View key={i} className="gap-2">
            <View className="rounded-lg border border-border bg-raised p-3">
              <View className="mb-2 flex-row items-center justify-between gap-2">
                <View className="flex-row items-center gap-1.5">
                  <Icon
                    name={meta?.icon ?? "lock"}
                    size={14}
                    color={codeOnly ? colors.faint : colors.muted}
                  />
                  <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                    {meta?.label ?? CODE_ONLY_LABELS[block.kind] ?? block.kind}
                  </Text>
                </View>
                <MoveControls
                  index={i}
                  count={blocks.length}
                  noun="block"
                  onMove={(to) => onChange(moveItem(blocks, i, to))}
                  onRemove={() => onChange(removeAt(blocks, i))}
                />
              </View>
              {codeOnly ? (
                <Text className="text-sm text-muted">
                  A built-in practice widget. You can move or remove it here; changing
                  what's inside it needs a code change.
                </Text>
              ) : (
                <BlockFields
                  block={block}
                  onChange={(next) => onChange(replaceAt(blocks, i, next))}
                />
              )}
            </View>
            {addAfter === i ? (
              <AddMenu onPick={add} onCancel={() => setAddAfter(null)} />
            ) : (
              <View className="flex-row justify-center">
                <Button
                  title="Insert here"
                  icon="plus"
                  size="sm"
                  variant="ghost"
                  onPress={() => setAddAfter(i)}
                />
              </View>
            )}
          </View>
        );
      })}
      {blocks.length === 0 || addAfter == null ? (
        <AddMenu onPick={add} />
      ) : null}
    </View>
  );
}

function AddMenu({
  onPick,
  onCancel,
}: {
  onPick: (kind: EditableBlockKind) => void;
  onCancel?: () => void;
}) {
  return (
    <View className="gap-2 rounded-lg border border-dashed border-border-strong p-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-ink">
          {onCancel ? "Insert a block here" : "Add a block at the end"}
        </Text>
        {onCancel ? (
          <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {EDITABLE_BLOCK_KINDS.map((kind) => (
          <Pill key={kind} size="sm" label={KINDS[kind].label} onPress={() => onPick(kind)} />
        ))}
      </View>
    </View>
  );
}
