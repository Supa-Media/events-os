/**
 * ColumnOptionsEditor — edit the option set of a select/status column (e.g. the
 * "Source" or "Packed in" choices). Existing option VALUES are preserved when
 * you rename/recolor, so item data referencing them is never orphaned; only new
 * options get a freshly-slugged value.
 */
import { useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { colors } from "../../lib/theme";
import { optionColor } from "../../lib/optionColor";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";

const PALETTE = ["red", "amber", "green", "blue", "teal", "purple", "pink", "orange", "gray"];

interface Opt {
  value: string;
  label: string;
  color?: string;
  isComplete?: boolean;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "option";
}
function uniqueValue(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function ColumnOptionsEditor({
  column,
  onSave,
}: {
  column: { label: string; options?: Opt[] };
  onSave: (options: Opt[]) => void;
}) {
  const [opts, setOpts] = useState<Opt[]>(() =>
    (column.options ?? []).map((o) => ({ ...o })),
  );

  const setAt = (i: number, patch: Partial<Opt>) =>
    setOpts((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));

  const cycleColor = (i: number) => {
    const cur = opts[i].color ?? "gray";
    const next = PALETTE[(PALETTE.indexOf(cur) + 1) % PALETTE.length];
    setAt(i, { color: next });
  };

  const remove = (i: number) => setOpts((prev) => prev.filter((_, idx) => idx !== i));

  const add = () => {
    const taken = new Set(opts.map((o) => o.value));
    setOpts((prev) => [
      ...prev,
      { value: uniqueValue("option", taken), label: "", color: PALETTE[prev.length % PALETTE.length] },
    ]);
  };

  const save = () => {
    // Finalize: give still-default-valued new options a label-based value, drop blanks.
    const taken = new Set<string>();
    const finalized = opts
      .filter((o) => o.label.trim())
      .map((o) => {
        let value = o.value;
        if (value.startsWith("option")) value = slugify(o.label);
        value = uniqueValue(value, taken);
        taken.add(value);
        return { ...o, value, label: o.label.trim() };
      });
    onSave(finalized);
  };

  return (
    <View className="gap-2 p-3" style={{ minWidth: 260 }}>
      <Text className="font-display text-base text-ink">{column.label} options</Text>
      {opts.map((o, i) => {
        const c = optionColor(o.color);
        return (
          <View key={i} className="flex-row items-center gap-2">
            <Pressable
              onPress={() => cycleColor(i)}
              hitSlop={6}
              className="h-5 w-5 rounded-full"
              style={{ backgroundColor: c.bg, borderWidth: 1, borderColor: c.text }}
            />
            <TextInput
              value={o.label}
              onChangeText={(t) => setAt(i, { label: t })}
              placeholder="Option label"
              placeholderTextColor={colors.faint}
              className="flex-1 rounded-md border border-border bg-raised px-2 py-1.5 text-sm text-ink"
            />
            <Pressable onPress={() => remove(i)} hitSlop={6} className="rounded p-1 active:bg-sunken">
              <Icon name="x" size={15} color={colors.faint} />
            </Pressable>
          </View>
        );
      })}
      <Pressable
        onPress={add}
        className="flex-row items-center gap-1.5 self-start rounded-md px-1 py-1 active:opacity-70"
      >
        <Icon name="plus" size={14} color={colors.muted} />
        <Text className="text-sm font-medium text-muted">Add option</Text>
      </Pressable>
      <View className="mt-1 flex-row justify-end">
        <Button title="Save options" size="sm" onPress={save} />
      </View>
    </View>
  );
}
