import { View, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, SectionHeader } from "../ui";
import { RoleChips } from "../role/RoleChips";

/* ── Roles ──────────────────────────────────────────────────────────────── */

/**
 * The template OWNS its roles — a compact row of chips. Right-click (web) /
 * long-press (native) a chip to Rename or Delete; the trailing "＋" chip adds
 * one. An event clones these and edits its own copy independently.
 */
export function RolesCard({
  eventTypeId,
  roles,
}: {
  eventTypeId: Id<"eventTypes">;
  roles: Array<{ _id: string; label: string }>;
}) {
  const updateRole = useMutation(api.roles.updateTemplateRole);
  const createRole = useMutation(api.roles.createForTemplate);
  const deleteRole = useMutation(api.roles.deleteTemplateRole);

  return (
    <Card className="mb-2">
      <SectionHeader title="Roles" />
      <Text className="mb-3 text-sm text-muted">
        Roles for this template. Right-click a chip to rename or delete; use ＋ to
        add.
      </Text>
      <RoleChips
        roles={roles}
        onRename={(roleId, label) =>
          updateRole({ roleId: roleId as Id<"templateRoles">, label })
        }
        onDelete={(roleId) =>
          deleteRole({ roleId: roleId as Id<"templateRoles"> })
        }
        onAdd={(label) => createRole({ eventTypeId, label })}
      />
    </Card>
  );
}
