import { View, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  Button,
  SectionHeader,
  EmptyState,
} from "../../../components/ui";
import { EditableGrid } from "../../../components/grid/EditableGrid";
import { SiteMapEditor } from "../../../components/event/SiteMapEditor";
import { NameEditor } from "../../../components/template/NameEditor";
import { DescriptionEditor } from "../../../components/template/DescriptionEditor";
import { RolesCard } from "../../../components/template/RolesCard";
import { TemplateCrewCard } from "../../../components/template/TemplateCrewCard";
import { ModulesCard } from "../../../components/template/ModulesCard";
import type { ModuleKey } from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * TEMPLATE EDITOR — author a reusable event template on the unified-items model.
 *
 * Edits the template's metadata, its roles + modules (core toggles + owner
 * overrides, plus custom modules), and embeds an EditableGrid of base items for
 * each active GRID module. Non-grid surfaces (e.g. site_map) are configured by
 * toggle/owner only — they have no per-template grid. Edits save eagerly.
 */
export default function TemplateEditorScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventTypeId = id as Id<"eventTypes">;

  const data = useQuery(api.eventTypes.get, { eventTypeId });
  const templateRoles = useQuery(api.roles.listForTemplate, { eventTypeId });
  const moduleData = useQuery(api.modules.listForTemplate, { eventTypeId });
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

  const { eventType } = data;
  // The grid + module owner picker want the template's roles (id + key + label).
  const roleList = (templateRoles ?? []).map((r) => ({
    _id: r._id as string,
    key: r.key as string,
    label: r.label,
  }));

  const active = moduleData?.active ?? [];
  const gridModules = active.filter((m) => m.surface === "grid");
  // The site_map module is non-grid: when active, render the venue-map editor in
  // TEMPLATE scope (background + shapes + markers; placements are event-only and
  // hidden). The grid loop below skips it (it isn't surface === "grid").
  const siteMapModule = active.find((m) => m.surface === "site_map") ?? null;

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
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
          eventTypeId={eventTypeId}
          active={active}
          disabledCore={moduleData?.disabledCore ?? []}
          customRows={(moduleData?.customRows ?? []) as any}
          roles={roleList}
        />
      </Narrow>

      {gridModules.length === 0 && !siteMapModule ? (
        <Narrow>
          <View className="mt-6">
            <EmptyState
              icon="layout"
              title="No grid modules active"
              message="Turn on a module above to start building."
            />
          </View>
        </Narrow>
      ) : (
        gridModules.map((m) => (
          <View key={m.key}>
            <SectionHeader title={m.label} />
            <EditableGrid
              mode="template"
              parentId={eventTypeId}
              module={m.key as ModuleKey}
              roles={roleList}
              addLabel={`Add ${m.label.toLowerCase()} row`}
            />
            {/* Crew (placeholders) sits directly below the Expectations grid:
                its team dropdown is sourced from this grid's `team` column, so the
                two read as one unit. */}
            {m.key === "volunteer_expectations" ? (
              <TemplateCrewCard eventTypeId={eventTypeId} />
            ) : null}
          </View>
        ))
      )}

      {/* Site map (non-grid): author the template's venue layout — background
          image + shapes + labelled markers. Cloned onto every event spun up
          from this template. */}
      {siteMapModule ? (
        <View key={siteMapModule.key}>
          <SectionHeader title={siteMapModule.label} />
          <SiteMapEditor
            scope={{ kind: "template", eventTypeId: eventTypeId as string }}
            embedded
          />
        </View>
      ) : null}
    </Screen>
  );
}
