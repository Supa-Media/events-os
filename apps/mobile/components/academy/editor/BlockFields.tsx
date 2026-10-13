import { Text, View } from "react-native";
import type { AcademyBlock } from "@events-os/shared";
import { Button, Radio, RadioGroup, TextField } from "../../ui";
import { EditorIconButton, EditorLabel, MoveControls, RadioDot } from "./EditorBits";
import { insertAt, moveItem, removeAt, replaceAt } from "./listOps";

/**
 * The form for one editable block, by kind. Each change hands back the whole
 * next block; the list it sits in decides where it goes.
 */
export function BlockFields({
  block,
  onChange,
}: {
  block: AcademyBlock;
  onChange: (next: AcademyBlock) => void;
}) {
  switch (block.kind) {
    case "p":
    case "heading":
    case "tip":
      return (
        <TextField
          label={block.kind === "tip" ? "In the app" : undefined}
          hint={block.kind === "tip" ? "Point at the exact screen or button to use." : undefined}
          value={block.text}
          multiline={block.kind !== "heading"}
          numberOfLines={block.kind === "p" ? 4 : 2}
          placeholder={block.kind === "heading" ? "Heading" : "Write here…"}
          onChangeText={(text) => onChange({ ...block, text })}
        />
      );
    case "story":
    case "rule":
      return (
        <>
          <TextField
            label="Title"
            hint={block.kind === "story" ? 'Who and when, like "Eden, 2026".' : undefined}
            value={block.title}
            onChangeText={(title) => onChange({ ...block, title })}
          />
          <TextField
            label={block.kind === "story" ? "What happened" : "The rule"}
            value={block.text}
            multiline
            numberOfLines={3}
            onChangeText={(text) => onChange({ ...block, text })}
          />
        </>
      );
    case "bullets":
      return (
        <StringList
          label="Points"
          noun="point"
          items={block.items}
          onChange={(items) => onChange({ ...block, items })}
        />
      );
    case "link":
      return (
        <>
          <TextField
            label="Label"
            value={block.label}
            onChangeText={(label) => onChange({ ...block, label })}
          />
          <TextField
            label="Address"
            value={block.url}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="https://…"
            onChangeText={(url) => onChange({ ...block, url })}
          />
          <TextField
            label="Note (optional)"
            value={block.note ?? ""}
            onChangeText={(note) => {
              const { note: _drop, ...rest } = block;
              onChange(note ? { ...rest, note } : rest);
            }}
          />
        </>
      );
    case "reveal":
      return (
        <>
          <TextField
            label="Question"
            value={block.prompt}
            multiline
            numberOfLines={2}
            onChangeText={(prompt) => onChange({ ...block, prompt })}
          />
          <TextField
            label="Answer, shown on tap"
            value={block.answer}
            multiline
            numberOfLines={3}
            onChangeText={(answer) => onChange({ ...block, answer })}
          />
        </>
      );
    case "scenario":
      return <ScenarioFields block={block} onChange={onChange} />;
    case "table":
      return <TableFields block={block} onChange={onChange} />;
    default:
      return null;
  }
}

/** An ordered list of one-line strings. */
function StringList({
  label,
  noun,
  items,
  onChange,
}: {
  label: string;
  noun: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <View className="mb-3 gap-2">
      <EditorLabel>{label}</EditorLabel>
      {items.map((item, i) => (
        <View key={i} className="flex-row items-start gap-2">
          <View className="flex-1">
            <TextField
              value={item}
              multiline
              numberOfLines={1}
              accessibilityLabel={`${noun} ${i + 1}`}
              onChangeText={(t) => onChange(replaceAt(items, i, t))}
            />
          </View>
          <MoveControls
            index={i}
            count={items.length}
            noun={noun}
            onMove={(to) => onChange(moveItem(items, i, to))}
            onRemove={items.length > 1 ? () => onChange(removeAt(items, i)) : undefined}
          />
        </View>
      ))}
      <View className="flex-row">
        <Button
          title={`Add a ${noun}`}
          icon="plus"
          size="sm"
          variant="ghost"
          onPress={() => onChange([...items, ""])}
        />
      </View>
    </View>
  );
}

type Scenario = Extract<AcademyBlock, { kind: "scenario" }>;

function ScenarioFields({
  block,
  onChange,
}: {
  block: Scenario;
  onChange: (next: Scenario) => void;
}) {
  const setOptions = (options: Scenario["options"]) => onChange({ ...block, options });
  return (
    <>
      <TextField
        label="Situation"
        value={block.prompt}
        multiline
        numberOfLines={2}
        onChangeText={(prompt) => onChange({ ...block, prompt })}
      />
      <EditorLabel>Choices (mark the right one)</EditorLabel>
      <RadioGroup accessibilityLabel="The right choice" className="mt-2 gap-3">
        {block.options.map((o, i) => (
          <View key={i} className="gap-2 rounded-md border border-border bg-sunken p-3">
            <View className="flex-row items-center justify-between gap-2">
              <Radio
                checked={Boolean(o.correct)}
                accessibilityLabel={`Choice ${i + 1} is right`}
                onSelect={() =>
                  setOptions(
                    block.options.map((x, j) => {
                      const { correct: _c, ...rest } = x;
                      return j === i ? { ...rest, correct: true } : rest;
                    }),
                  )
                }
              >
                <View className="flex-row items-center gap-2">
                  <RadioDot checked={Boolean(o.correct)} />
                  <Text className="text-sm text-ink">
                    {o.correct ? "The right choice" : `Choice ${i + 1}`}
                  </Text>
                </View>
              </Radio>
              <MoveControls
                index={i}
                count={block.options.length}
                noun="choice"
                onMove={(to) => setOptions(moveItem(block.options, i, to))}
                onRemove={
                  block.options.length > 2
                    ? () => setOptions(removeAt(block.options, i))
                    : undefined
                }
              />
            </View>
            <TextField
              label="Choice"
              value={o.text}
              onChangeText={(text) => setOptions(replaceAt(block.options, i, { ...o, text }))}
            />
            <TextField
              label="What they hear after picking it"
              value={o.feedback}
              multiline
              numberOfLines={2}
              onChangeText={(feedback) =>
                setOptions(replaceAt(block.options, i, { ...o, feedback }))
              }
            />
          </View>
        ))}
      </RadioGroup>
      <View className="mt-2 flex-row">
        <Button
          title="Add a choice"
          icon="plus"
          size="sm"
          variant="ghost"
          onPress={() => setOptions([...block.options, { text: "", feedback: "" }])}
        />
      </View>
    </>
  );
}

type Table = Extract<AcademyBlock, { kind: "table" }>;

function TableFields({
  block,
  onChange,
}: {
  block: Table;
  onChange: (next: Table) => void;
}) {
  const cols = block.headers.length;
  const addColumn = () =>
    onChange({
      headers: [...block.headers, ""],
      rows: block.rows.map((r) => [...r, ""]),
      kind: "table",
    });
  const removeColumn = (c: number) =>
    onChange({
      kind: "table",
      headers: removeAt(block.headers, c),
      rows: block.rows.map((r) => removeAt(r, c)),
    });
  return (
    <View className="mb-3 gap-2">
      <EditorLabel>Column headings</EditorLabel>
      <View className="flex-row flex-wrap items-start gap-2">
        {block.headers.map((h, c) => (
          <View key={c} className="min-w-[120px] flex-1 flex-row items-start gap-1">
            <View className="flex-1">
              <TextField
                value={h}
                accessibilityLabel={`Column ${c + 1} heading`}
                onChangeText={(t) =>
                  onChange({ ...block, headers: replaceAt(block.headers, c, t) })
                }
              />
            </View>
            {cols > 1 ? (
              <EditorIconButton
                icon="x"
                label={`Remove column ${c + 1}`}
                tone="danger"
                onPress={() => removeColumn(c)}
              />
            ) : null}
          </View>
        ))}
      </View>
      <EditorLabel>Rows</EditorLabel>
      {block.rows.map((row, r) => (
        <View key={r} className="flex-row flex-wrap items-start gap-2 border-t border-border pt-2">
          {row.map((cell, c) => (
            <View key={c} className="min-w-[120px] flex-1">
              <TextField
                value={cell}
                multiline
                numberOfLines={1}
                accessibilityLabel={`Row ${r + 1}, ${block.headers[c] || `column ${c + 1}`}`}
                onChangeText={(t) =>
                  onChange({
                    ...block,
                    rows: replaceAt(block.rows, r, replaceAt(row, c, t)),
                  })
                }
              />
            </View>
          ))}
          <MoveControls
            index={r}
            count={block.rows.length}
            noun="row"
            onMove={(to) => onChange({ ...block, rows: moveItem(block.rows, r, to) })}
            onRemove={
              block.rows.length > 1
                ? () => onChange({ ...block, rows: removeAt(block.rows, r) })
                : undefined
            }
          />
        </View>
      ))}
      <View className="flex-row flex-wrap gap-2">
        <Button
          title="Add a row"
          icon="plus"
          size="sm"
          variant="ghost"
          onPress={() =>
            onChange({
              ...block,
              rows: insertAt(block.rows, block.rows.length, block.headers.map(() => "")),
            })
          }
        />
        {cols < 6 ? (
          <Button title="Add a column" icon="plus" size="sm" variant="ghost" onPress={addColumn} />
        ) : null}
      </View>
    </View>
  );
}
