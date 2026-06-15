import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
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
  EmptyState,
} from "../../../components/ui";
import { EditableGrid } from "../../../components/grid/EditableGrid";
import {
  MODULE_LABELS,
  CORE_MODULE_KEYS,
  type ModuleKey,
} from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * TEMPLATE EDITOR — author a reusable event template on the unified-items model.
 *
 * Edits the template's metadata, its active roles + modules, and (for each
 * active list-backed module) embeds an EditableGrid of base items. All edits
 * save eagerly (toggles immediately, text fields on blur when dirty).
 */
export default function TemplateEditorScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventTypeId = id as Id<"eventTypes">;

  const data = useQuery(api.eventTypes.get, { eventTypeId });
  const templateRoles = useQuery(api.roles.listForTemplate, { eventTypeId });
  const updateTemplate = useMutation(api.eventTypes.update);

  if (data === undefined) return <Screen loading />;

  if (data === null) {
    return (
      <Screen>
        <EmptyState
          icon="inbox"
          title="Template not found"
          message="This template no longer exists."
          action={
            <Button title="Back to pipeline" variant="secondary" onPress={() => router.back()} />
          }
        />
      </Screen>
    );
  }

  const { eventType, modules } = data;
  // The grid wants the template's roles (id + label); [] while loading.
  const roleList = (templateRoles ?? []).map((r) => ({
    _id: r._id as string,
    label: r.label,
  }));
  const activeComponents = (eventType.activeComponents ?? []) as string[];

  return (
    <Screen>
      <NameEditor
        key={eventType._id}
        name={eventType.name}
        version={eventType.version}
        onSave={(name) => updateTemplate({ eventTypeId, name })}
        onStart={() => router.push(`/event/new?templateId=${eventTypeId}`)}
      />

      <DescriptionEditor
        key={`desc-${eventType._id}`}
        description={eventType.description ?? ""}
        onSave={(description) => updateTemplate({ eventTypeId, description })}
      />

      <RolesCard eventTypeId={eventTypeId} roles={roleList} />

      <ModulesCard
        activeComponents={activeComponents}
        onToggle={(module) => {
          const next = activeComponents.includes(module)
            ? activeComponents.filter((c) => c !== module)
            : [...activeComponents, module];
          updateTemplate({ eventTypeId, activeComponents: next });
        }}
      />

      {modules.length === 0 ? (
        <View className="mt-6">
          <EmptyState
            icon="layout"
            title="No modules active"
            message="Turn on a module above to start building."
          />
        </View>
      ) : (
        modules.map((m: ModuleKey) => (
          <View key={m}>
            <SectionHeader title={MODULE_LABELS[m]} />
            <EditableGrid
              mode="template"
              parentId={eventTypeId}
              module={m}
              roles={roleList}
              addLabel={`Add ${MODULE_LABELS[m].toLowerCase()} row`}
            />
          </View>
        ))
      )}
    </Screen>
  );
}

/* ── Name + version + start ─────────────────────────────────────────────── */

function NameEditor({
  name,
  version,
  onSave,
  onStart,
}: {
  name: string;
  version: number;
  onSave: (name: string) => Promise<unknown>;
  onStart: () => void;
}) {
  const [local, setLocal] = useState(name);
  useEffect(() => setLocal(name), [name]);

  function save() {
    const trimmed = local.trim();
    if (trimmed && trimmed !== name) onSave(trimmed);
    else if (!trimmed) setLocal(name);
  }

  return (
    <View className="mb-6 flex-row items-start justify-between gap-4">
      <View className="flex-1">
        <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-accent">
          Template
        </Text>
        <TextField value={local} onChangeText={setLocal} onBlur={save} placeholder="Template name" />
      </View>
      <View className="flex-row items-center gap-3 pt-1">
        <Badge label={`v${version}`} />
        <Button title="Start an event" icon="play" onPress={onStart} />
      </View>
    </View>
  );
}

/* ── Description ────────────────────────────────────────────────────────── */

function DescriptionEditor({
  description,
  onSave,
}: {
  description: string;
  onSave: (description: string) => Promise<unknown>;
}) {
  const [local, setLocal] = useState(description);
  useEffect(() => setLocal(description), [description]);

  function save() {
    if (local !== description) onSave(local);
  }

  return (
    <Card className="mb-2">
      <TextField
        label="Description"
        value={local}
        placeholder="What is this template for?"
        onChangeText={setLocal}
        onBlur={save}
        multiline
      />
    </Card>
  );
}

/* ── Roles ──────────────────────────────────────────────────────────────── */

/**
 * The template OWNS its roles — a single editable list (rename inline, delete,
 * add). No active-vs-pool distinction. An event clones these and edits its own
 * copy independently.
 */
function RolesCard({
  eventTypeId,
  roles,
}: {
  eventTypeId: Id<"eventTypes">;
  roles: Array<{ _id: string; label: string }>;
}) {
  const updateRole = useMutation(api.roles.updateTemplateRole);
  const createRole = useMutation(api.roles.createForTemplate);
  const deleteRole = useMutation(api.roles.deleteTemplateRole);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  function startEdit(role: { _id: string; label: string }) {
    setEditingId(role._id);
    setEditLabel(role.label);
  }

  function saveEdit(roleId: string) {
    const trimmed = editLabel.trim();
    if (trimmed) updateRole({ roleId: roleId as Id<"templateRoles">, label: trimmed });
    setEditingId(null);
    setEditLabel("");
  }

  async function handleAdd() {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    await createRole({ eventTypeId, label: trimmed });
    setNewLabel("");
    setAdding(false);
  }

  return (
    <Card className="mb-2">
      <SectionHeader title="Roles" />
      <Text className="mb-3 text-sm text-muted">
        Roles for this template. Rename inline, remove, or add your own.
      </Text>
      {roles.length === 0 ? (
        <Text className="mb-3 text-sm text-faint">
          No roles yet — add one below.
        </Text>
      ) : (
        <View className="gap-2">
          {roles.map((r) => {
            const editing = editingId === r._id;
            return (
              <View key={r._id} className="flex-row items-center gap-2">
                <View className="flex-1">
                  {editing ? (
                    <TextField
                      value={editLabel}
                      onChangeText={setEditLabel}
                      onBlur={() => saveEdit(r._id)}
                      autoFocus
                    />
                  ) : (
                    <Pill label={r.label} />
                  )}
                </View>
                <Button
                  title={editing ? "Save" : "Rename"}
                  size="sm"
                  variant="ghost"
                  onPress={() => (editing ? saveEdit(r._id) : startEdit(r))}
                />
                {!editing ? (
                  <Button
                    title=""
                    icon="trash-2"
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      deleteRole({ roleId: r._id as Id<"templateRoles"> })
                    }
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {adding ? (
        <View className="mt-3">
          <TextField
            label="New role"
            placeholder="Role name"
            value={newLabel}
            onChangeText={setNewLabel}
            onBlur={handleAdd}
            autoFocus
          />
          <Button title="Add role" size="sm" onPress={handleAdd} disabled={!newLabel.trim()} />
        </View>
      ) : (
        <View className="mt-3 flex-row">
          <Button title="Add role" size="sm" variant="secondary" icon="plus" onPress={() => setAdding(true)} />
        </View>
      )}
    </Card>
  );
}

/* ── Modules ───────────────────────────────────────────────────────────── */

function ModulesCard({
  activeComponents,
  onToggle,
}: {
  activeComponents: string[];
  onToggle: (module: string) => void;
}) {
  return (
    <Card className="mb-2">
      <SectionHeader title="Modules" />
      <ModuleGroup
        heading="Core"
        keys={CORE_MODULE_KEYS}
        activeComponents={activeComponents}
        onToggle={onToggle}
      />
      {/* Custom modules (author-created, full grid) arrive in a later phase. */}
    </Card>
  );
}

function ModuleGroup({
  heading,
  keys,
  activeComponents,
  onToggle,
}: {
  heading: string;
  keys: ModuleKey[];
  activeComponents: string[];
  onToggle: (module: string) => void;
}) {
  return (
    <View>
      <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-faint">{heading}</Text>
      <View className="flex-row flex-wrap gap-2">
        {keys.map((c) => (
          <Pill
            key={c}
            label={MODULE_LABELS[c]}
            selected={activeComponents.includes(c)}
            onPress={() => onToggle(c)}
          />
        ))}
      </View>
    </View>
  );
}
