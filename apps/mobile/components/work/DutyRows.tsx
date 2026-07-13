/**
 * DutyRows — compact recurring-duty rows: title · cadence · how-to (doc-aware).
 * Extracted from WorkloadView so person surfaces (workload page, People detail)
 * share one rendering.
 *
 * Pass `person` to turn on per-person provenance: rows that reach them through
 * their title show a "via {title}" tag — those aren't memberships, so the only
 * way to stop them is editing the definition's roles in the Duties grid or
 * changing the person's title. `canUnassign` (manager/admin — the server
 * enforces it again) adds the ✕ on directly-assigned rows, calling the
 * targeted `removeAssignee` mutation.
 */
import { View, Text, Pressable, Linking } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCE_LABELS,
  normalizeRole,
} from "@events-os/shared";
import { Icon, OptionTag } from "../ui";
import { colors, spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

type Responsibility = FunctionReturnType<
  typeof api.responsibilities.list
>[number];

export function DutyRows({
  items,
  person,
  canUnassign = false,
}: {
  items: Responsibility[];
  /** The person these rows are shown FOR — enables provenance + unassign. */
  person?: { _id: Id<"people">; role: string | null };
  /** Show the unassign ✕ on directly-assigned rows (managers/admins). */
  canUnassign?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const removeAssignee = useMutation(api.responsibilities.removeAssignee);
  return (
    <View style={{ gap: spacing.xs }}>
      {items.map((r) => {
        const doc = r.howToDoc;
        const openDoc = doc
          ? () => {
              if ((doc.kind === "link" || doc.kind === "video") && doc.url) {
                void Linking.openURL(doc.url);
              } else {
                router.push(
                  `/doc/${doc._id}?from=${encodeURIComponent(pathname)}` as any,
                );
              }
            }
          : null;
        const direct = person
          ? (r.assigneePersonIds ?? []).includes(person._id)
          : false;
        const viaRole = person?.role
          ? (r.assigneeRoles ?? []).find(
              (x) => normalizeRole(x) === normalizeRole(person.role),
            )
          : undefined;
        return (
          <View
            key={r._id}
            className="rounded-md border border-border bg-raised px-3 py-2"
          >
            <View className="flex-row items-center gap-2">
              <Icon name="repeat" size={13} color={colors.muted} />
              <Text
                className="flex-1 text-sm font-medium text-ink"
                numberOfLines={1}
              >
                {r.title}
              </Text>
              {doc && doc.kind !== "note" && openDoc ? (
                <Pressable
                  onPress={openDoc}
                  hitSlop={6}
                  className="flex-row items-center gap-1 rounded px-1 py-0.5 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon
                    name={
                      doc.kind === "video"
                        ? "video"
                        : doc.kind === "markdown"
                          ? "book-open"
                          : "external-link"
                    }
                    size={13}
                    color={colors.accent}
                  />
                  <Text className="text-xs font-medium text-accent">
                    How-To
                  </Text>
                </Pressable>
              ) : null}
              {viaRole ? (
                <Text className="text-2xs text-faint" numberOfLines={1}>
                  via {viaRole}
                </Text>
              ) : null}
              <OptionTag
                label={RESPONSIBILITY_CADENCE_LABELS[r.cadence]}
                color={r.cadence === "ad_hoc" ? "gray" : "teal"}
              />
              {canUnassign && direct && person ? (
                <Pressable
                  onPress={() =>
                    confirmAction({
                      title: "Unassign duty?",
                      message: viaRole
                        ? `${r.title} will no longer be directly assigned — it still applies to them via the “${viaRole}” title.`
                        : `${r.title} will no longer apply to them.`,
                      confirmLabel: "Unassign",
                      destructive: true,
                      onConfirm: () => {
                        void removeAssignee({
                          responsibilityId: r._id,
                          personId: person._id,
                        }).catch(alertError);
                      },
                    })
                  }
                  hitSlop={6}
                  accessibilityLabel={`Unassign ${r.title}`}
                  className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon name="x" size={13} color={colors.faint} />
                </Pressable>
              ) : null}
            </View>
            {doc?.kind === "note" && doc.body ? (
              <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
                {doc.body}
              </Text>
            ) : r.description ? (
              <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
                {r.description}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
