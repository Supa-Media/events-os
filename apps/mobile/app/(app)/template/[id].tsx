import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  Pill,
  TextField,
  SectionHeader,
} from "../../../components/ui";
import { colors, radius, spacing } from "../../../lib/theme";
import {
  ROLE_KEYS,
  ROLE_LABELS,
  COMPONENT_LABELS,
  type RoleKey,
  type ComponentKey,
} from "@events-os/shared";

export default function TemplateEditorScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventTypeId = id as any;

  const data = useQuery(api.eventTypes.get, { eventTypeId });
  const update = useMutation(api.eventTypes.update);

  if (data === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Template" }} />
        <Screen loading />
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Template" }} />
        <Screen>
          <Text style={styles.muted}>This template no longer exists.</Text>
          <Button title="Back" variant="secondary" onPress={() => router.back()} />
        </Screen>
      </>
    );
  }

  const { eventType, tasks, runOfShow } = data;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: eventType.name }} />
      <Screen>
        <View style={styles.versionRow}>
          <Badge label={`v${eventType.version}`} />
        </View>

        <MetaEditor
          key={eventType._id}
          name={eventType.name}
          description={eventType.description ?? ""}
          onSave={(name, description) =>
            update({ eventTypeId, name, description })
          }
        />

        {/* Roles + components (read-only) */}
        <SectionHeader title="Roles" />
        <View style={styles.pillWrap}>
          {(eventType.roles as string[]).map((r) => (
            <Pill key={r} label={ROLE_LABELS[r as RoleKey] ?? r} />
          ))}
        </View>

        <SectionHeader title="Components" />
        <View style={styles.pillWrap}>
          {(eventType.activeComponents as string[]).map((c) => (
            <Pill key={c} label={COMPONENT_LABELS[c as ComponentKey] ?? c} />
          ))}
        </View>

        {/* Tasks */}
        <TasksEditor eventTypeId={eventTypeId} tasks={tasks} />

        {/* Run of show */}
        <RunOfShowEditor eventTypeId={eventTypeId} rows={runOfShow} />

        <View style={styles.startWrap}>
          <Button
            title="Start an event from this template"
            onPress={() => router.push(`/event/new?templateId=${eventType._id}`)}
          />
        </View>
      </Screen>
    </>
  );
}

/* ── Name / description ─────────────────────────────────────────────────── */

function MetaEditor({
  name,
  description,
  onSave,
}: {
  name: string;
  description: string;
  onSave: (name: string, description: string) => Promise<unknown>;
}) {
  const [localName, setLocalName] = useState(name);
  const [localDesc, setLocalDesc] = useState(description);

  // Re-sync if the server value changes underneath us.
  useEffect(() => {
    setLocalName(name);
    setLocalDesc(description);
  }, [name, description]);

  const dirty = localName.trim() !== name || localDesc !== description;

  return (
    <Card>
      <TextField label="Name" value={localName} onChangeText={setLocalName} />
      <TextField
        label="Description"
        value={localDesc}
        onChangeText={setLocalDesc}
        placeholder="What is this template for?"
        multiline
      />
      <Button
        title="Save details"
        size="sm"
        variant="secondary"
        disabled={!dirty || !localName.trim()}
        onPress={() => onSave(localName.trim(), localDesc)}
      />
    </Card>
  );
}

/* ── Tasks editor ───────────────────────────────────────────────────────── */

function TasksEditor({
  eventTypeId,
  tasks,
}: {
  eventTypeId: string;
  tasks: any[];
}) {
  const addTask = useMutation(api.eventTypes.addTask);
  const reorder = useMutation(api.eventTypes.reorderTasks);

  const [newTitle, setNewTitle] = useState("");
  const [newOffset, setNewOffset] = useState("7");
  const [newRole, setNewRole] = useState<RoleKey>("event_lead");

  async function handleAdd() {
    const title = newTitle.trim();
    const offset = parseInt(newOffset, 10);
    if (!title || Number.isNaN(offset)) return;
    await addTask({
      eventTypeId: eventTypeId as any,
      title,
      tMinusOffsetDays: offset,
      owningRole: newRole,
    });
    setNewTitle("");
    setNewOffset("7");
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= tasks.length) return;
    const ids = tasks.map((t) => t._id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder({ eventTypeId: eventTypeId as any, orderedIds: ids });
  }

  return (
    <>
      <SectionHeader title={`Tasks (${tasks.length})`} />
      <View style={styles.list}>
        {tasks.map((t, i) => (
          <TaskEditorRow
            key={t._id}
            task={t}
            isFirst={i === 0}
            isLast={i === tasks.length - 1}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
          />
        ))}
      </View>

      {/* Add task */}
      <Card style={styles.addCard}>
        <TextField
          label="New task"
          placeholder="Task title"
          value={newTitle}
          onChangeText={setNewTitle}
        />
        <View style={styles.inlineRow}>
          <View style={styles.offsetField}>
            <TextField
              label="T-minus days"
              value={newOffset}
              onChangeText={setNewOffset}
              keyboardType="number-pad"
            />
          </View>
        </View>
        <Text style={styles.fieldLabel}>Owning role</Text>
        <RolePicker value={newRole} onChange={setNewRole} />
        <Button
          title="+ Add task"
          size="sm"
          onPress={handleAdd}
          disabled={!newTitle.trim()}
        />
      </Card>
    </>
  );
}

function TaskEditorRow({
  task,
  isFirst,
  isLast,
  onUp,
  onDown,
}: {
  task: any;
  isFirst: boolean;
  isLast: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const updateTask = useMutation(api.eventTypes.updateTask);
  const removeTask = useMutation(api.eventTypes.removeTask);

  const [title, setTitle] = useState(task.title);
  const [offset, setOffset] = useState(String(task.tMinusOffsetDays));

  useEffect(() => {
    setTitle(task.title);
    setOffset(String(task.tMinusOffsetDays));
  }, [task.title, task.tMinusOffsetDays]);

  function saveTitle() {
    const t = title.trim();
    if (t && t !== task.title) {
      updateTask({ templateTaskId: task._id, title: t });
    }
  }

  function saveOffset() {
    const n = parseInt(offset, 10);
    if (!Number.isNaN(n) && n !== task.tMinusOffsetDays) {
      updateTask({ templateTaskId: task._id, tMinusOffsetDays: n });
    }
  }

  return (
    <Card>
      <TextField
        value={title}
        onChangeText={setTitle}
        onBlur={saveTitle}
        placeholder="Task title"
      />
      <View style={styles.inlineRow}>
        <View style={styles.offsetField}>
          <TextField
            label="T-minus days"
            value={offset}
            onChangeText={setOffset}
            onBlur={saveOffset}
            keyboardType="number-pad"
          />
        </View>
      </View>
      <Text style={styles.fieldLabel}>Owning role</Text>
      <RolePicker
        value={task.owningRole}
        onChange={(role) =>
          updateTask({ templateTaskId: task._id, owningRole: role })
        }
      />
      <View style={styles.taskActions}>
        <View style={styles.reorder}>
          <SquareBtn label="↑" disabled={isFirst} onPress={onUp} />
          <SquareBtn label="↓" disabled={isLast} onPress={onDown} />
        </View>
        <Button
          title="Remove"
          size="sm"
          variant="ghost"
          onPress={() => removeTask({ templateTaskId: task._id })}
        />
      </View>
    </Card>
  );
}

/* ── Run of show editor ─────────────────────────────────────────────────── */

function RunOfShowEditor({
  eventTypeId,
  rows,
}: {
  eventTypeId: string;
  rows: any[];
}) {
  const addRow = useMutation(api.eventTypes.addRunOfShowRow);
  const removeRow = useMutation(api.eventTypes.removeRunOfShowRow);

  const [offset, setOffset] = useState("0");
  const [segment, setSegment] = useState("");
  const [role, setRole] = useState<RoleKey | "">("");
  const [notes, setNotes] = useState("");

  async function handleAdd() {
    const seg = segment.trim();
    const off = parseInt(offset, 10);
    if (!seg || Number.isNaN(off)) return;
    await addRow({
      eventTypeId: eventTypeId as any,
      offsetMinutes: off,
      segment: seg,
      owningRole: role || undefined,
      notes: notes.trim() || undefined,
    });
    setOffset("0");
    setSegment("");
    setRole("");
    setNotes("");
  }

  return (
    <>
      <SectionHeader title={`Run of Show (${rows.length})`} />
      <View style={styles.list}>
        {rows.map((r) => (
          <Card key={r._id}>
            <View style={styles.rosRow}>
              <Text style={styles.rosOffset}>
                {r.offsetMinutes >= 0 ? `+${r.offsetMinutes}` : r.offsetMinutes}m
              </Text>
              <View style={styles.rosBody}>
                <Text style={styles.rosSegment}>{r.segment}</Text>
                {r.owningRole ? (
                  <Text style={styles.muted}>
                    {ROLE_LABELS[r.owningRole as RoleKey] ?? r.owningRole}
                  </Text>
                ) : null}
                {r.notes ? <Text style={styles.muted}>{r.notes}</Text> : null}
              </View>
              <Button
                title="Remove"
                size="sm"
                variant="ghost"
                onPress={() => removeRow({ rowId: r._id })}
              />
            </View>
          </Card>
        ))}
      </View>

      <Card style={styles.addCard}>
        <View style={styles.inlineRow}>
          <View style={styles.offsetField}>
            <TextField
              label="Offset (min)"
              value={offset}
              onChangeText={setOffset}
              keyboardType="numbers-and-punctuation"
            />
          </View>
        </View>
        <TextField
          label="Segment"
          placeholder="e.g. Doors open"
          value={segment}
          onChangeText={setSegment}
        />
        <Text style={styles.fieldLabel}>Owning role (optional)</Text>
        <View style={styles.pillWrap}>
          <Pill label="None" selected={role === ""} onPress={() => setRole("")} />
          {ROLE_KEYS.map((r) => (
            <Pill
              key={r}
              label={ROLE_LABELS[r]}
              selected={role === r}
              onPress={() => setRole(r)}
            />
          ))}
        </View>
        <TextField
          label="Notes (optional)"
          value={notes}
          onChangeText={setNotes}
          placeholder="Anything to flag"
        />
        <Button
          title="+ Add row"
          size="sm"
          onPress={handleAdd}
          disabled={!segment.trim()}
        />
      </Card>
    </>
  );
}

/* ── Shared bits ────────────────────────────────────────────────────────── */

function RolePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (role: RoleKey) => void;
}) {
  return (
    <View style={styles.pillWrap}>
      {ROLE_KEYS.map((r) => (
        <Pill
          key={r}
          label={ROLE_LABELS[r]}
          selected={value === r}
          onPress={() => onChange(r)}
        />
      ))}
    </View>
  );
}

function SquareBtn({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[styles.square, disabled && styles.squareDisabled]}
    >
      <Text style={styles.squareText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  muted: { fontSize: 14, color: colors.muted },
  versionRow: { flexDirection: "row", marginBottom: spacing.sm },
  pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  list: { gap: spacing.sm },
  addCard: { gap: spacing.sm, marginTop: spacing.md },
  inlineRow: { flexDirection: "row", gap: spacing.md },
  offsetField: { flex: 1 },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    marginBottom: spacing.xs,
  },
  taskActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  reorder: { flexDirection: "row", gap: spacing.sm },
  square: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  squareDisabled: { opacity: 0.4 },
  squareText: { fontSize: 16, fontWeight: "700", color: colors.text },
  rosRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  rosOffset: { fontSize: 15, fontWeight: "700", color: colors.accent, minWidth: 48 },
  rosBody: { flex: 1, gap: 2 },
  rosSegment: { fontSize: 15, fontWeight: "600", color: colors.text },
  startWrap: { marginTop: spacing.xl },
});
