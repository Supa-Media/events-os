import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Button,
  SectionHeader,
  EmptyState,
} from "../../../components/ui";
import { EditableGrid } from "../../../components/grid/EditableGrid";
import { NameEditor } from "../../../components/template/NameEditor";
import { DescriptionEditor } from "../../../components/template/DescriptionEditor";
import { RolesCard } from "../../../components/template/RolesCard";
import { ModulesCard } from "../../../components/template/ModulesCard";
import { MODULE_LABELS, type ModuleKey } from "@events-os/shared";
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
