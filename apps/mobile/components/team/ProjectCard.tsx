/**
 * ProjectCard — one editable project, with its sub-projects nested inside.
 *
 * The manager's tracking surface: every field commits inline (same
 * commit-on-blur cells as the People grid) so a manager can sweep through the
 * team's work updating status, notes, deadlines, and blockers without a
 * separate edit mode. Recurses through `childrenOf` to render sub-projects,
 * so "Music recording" can hold "Pitch to artists" and so on.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  PROJECT_STATUS_LABELS,
  type ProjectStatus,
} from "@events-os/shared";
import {
  Icon,
  InlineText,
  SelectCell,
  PersonPicker,
  type SelectOption,
} from "../ui";
import { colors } from "../../lib/theme";
import { parseDateInput, toDateInput } from "../../lib/format";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

// Status palette: gray until started, blue while moving, red when stuck,
// amber when parked, green when shipped.
export const PROJECT_STATUS_OPTIONS: SelectOption<ProjectStatus>[] = [
  { value: "not_started", label: PROJECT_STATUS_LABELS.not_started, color: "gray" },
  { value: "in_progress", label: PROJECT_STATUS_LABELS.in_progress, color: "blue" },
  { value: "blocked", label: PROJECT_STATUS_LABELS.blocked, color: "red" },
  { value: "on_hold", label: PROJECT_STATUS_LABELS.on_hold, color: "amber" },
  { value: "done", label: PROJECT_STATUS_LABELS.done, color: "green" },
];

export type ProjectDoc = Doc<"projects">;

/** Group a flat project list into a parent → children map (sub-project tree). */
export function buildProjectTree(
  projects: ProjectDoc[],
): Map<Id<"projects">, ProjectDoc[]> {
  const childrenOf = new Map<Id<"projects">, ProjectDoc[]>();
  for (const p of projects) {
    if (!p.parentProjectId) continue;
    const list = childrenOf.get(p.parentProjectId) ?? [];
    list.push(p);
    childrenOf.set(p.parentProjectId, list);
  }
  return childrenOf;
}

export function ProjectCard({
  project,
  childrenOf,
  peopleById,
  depth = 0,
  showOwner = false,
}: {
  project: ProjectDoc;
  childrenOf: Map<Id<"projects">, ProjectDoc[]>;
  /** Roster names for the owner chip (id → name). */
  peopleById: Map<Id<"people">, string>;
  depth?: number;
  /** Show + edit the owner chip (rollup/unassigned surfaces). */
  showOwner?: boolean;
}) {
  const router = useRouter();
  const updateMutation = useMutation(api.projects.update);
  const createMutation = useMutation(api.projects.create);
  const removeMutation = useMutation(api.projects.remove);
  // Cells commit fire-and-forget; surface server rejections (scope changes,
  // concurrent edits) instead of a silent revert + unhandled rejection.
  const update = (args: Parameters<typeof updateMutation>[0]) => {
    void updateMutation(args).catch(alertError);
  };
  const create = (args: Parameters<typeof createMutation>[0]) => {
    void createMutation(args).catch(alertError);
  };
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const id = project._id;
  const children = childrenOf.get(id) ?? [];
  const ownerName = project.ownerPersonId
    ? peopleById.get(project.ownerPersonId) ?? null
    : null;

  return (
    <View
      className={`rounded-lg border border-border bg-raised ${
        depth > 0 ? "mt-2" : ""
      }`}
    >
      {/* Name + status + delete */}
      <View className="flex-row items-center gap-2 border-b border-border/60 py-1 pl-1 pr-2">
        <InlineText
          value={project.name}
          placeholder="Project name"
          weight="medium"
          onCommit={(t) => {
            if (t.trim()) update({ projectId: id, name: t.trim() });
          }}
        />
        <View style={{ width: 118 }}>
          <SelectCell
            value={project.status}
            options={PROJECT_STATUS_OPTIONS}
            onChange={(status) => update({ projectId: id, status })}
          />
        </View>
        <Pressable
          onPress={() =>
            confirmAction({
              title: "Delete project?",
              message: `${project.name || "This project"} will be deleted. Sub-projects are kept.`,
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                void removeMutation({ projectId: id }).catch(alertError);
              },
            })
          }
          hitSlop={4}
          accessibilityLabel="Delete project"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="trash-2" size={13} color={colors.faint} />
        </Pressable>
      </View>

      {/* Meta: deadline · budget · owner · linked event */}
      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 px-2 py-1">
        <MetaField icon="calendar" width={104}>
          <InlineText<number | null | undefined>
            value={project.deadline}
            placeholder="YYYY-MM-DD"
            format={(v) => (v != null ? toDateInput(v) : "")}
            parse={(t) =>
              t.trim() === "" ? null : parseDateInput(t) ?? undefined
            }
            onCommit={(v) => {
              if (v === undefined) return; // unparsable → leave unchanged
              update({ projectId: id, deadline: v });
            }}
          />
        </MetaField>
        <MetaField icon="dollar-sign" width={84}>
          <InlineText<number | null | undefined>
            value={project.budgetUsd}
            numeric
            placeholder="Budget"
            format={(v) => (v != null ? `$${v}` : "")}
            parse={(t) => {
              if (t.trim() === "") return null;
              const cleaned = t.replace(/[^0-9.]/g, "");
              // Digit-free input ("tbd") must NOT become $0 — leave unchanged.
              if (cleaned === "") return undefined;
              const n = Number(cleaned);
              return Number.isFinite(n) ? n : undefined;
            }}
            onCommit={(v) => {
              if (v === undefined) return;
              update({ projectId: id, budgetUsd: v });
            }}
          />
        </MetaField>
        {showOwner ? (
          <Pressable
            onPress={() => setOwnerPickerOpen(true)}
            className="flex-row items-center gap-1.5 py-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon name="user" size={13} color={colors.muted} />
            <Text
              className={`text-sm ${ownerName ? "text-ink" : "text-faint"}`}
              numberOfLines={1}
            >
              {ownerName ?? "Assign owner"}
            </Text>
          </Pressable>
        ) : null}
        {project.eventId ? (
          <Pressable
            onPress={() => router.push(`/event/${project.eventId}` as any)}
            className="flex-row items-center gap-1.5 py-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon name="external-link" size={13} color={colors.accent} />
            <Text className="text-sm font-medium text-accent">Open event</Text>
          </Pressable>
        ) : null}
      </View>

      {/* The manager's read: purpose, running note, blocker, what's next. */}
      <View className="px-1 py-1">
        <FieldRow label="Purpose">
          <InlineText
            value={project.purpose ?? ""}
            placeholder="—"
            onCommit={(t) => update({ projectId: id, purpose: t.trim() || null })}
          />
        </FieldRow>
        <FieldRow label="Note">
          <InlineText
            value={project.statusNote ?? ""}
            placeholder="State of the project…"
            onCommit={(t) =>
              update({ projectId: id, statusNote: t.trim() || null })
            }
          />
        </FieldRow>
        <FieldRow label="Blocker" alert={!!project.blocker}>
          <InlineText
            value={project.blocker ?? ""}
            placeholder="—"
            onCommit={(t) => update({ projectId: id, blocker: t.trim() || null })}
          />
        </FieldRow>
        <FieldRow label="Next">
          <InlineText
            value={project.nextSteps ?? ""}
            placeholder="—"
            onCommit={(t) =>
              update({ projectId: id, nextSteps: t.trim() || null })
            }
          />
        </FieldRow>
      </View>

      {/* Sub-projects */}
      <View className={children.length > 0 ? "px-2 pb-2" : ""}>
        {children.map((child) => (
          <ProjectCard
            key={child._id}
            project={child}
            childrenOf={childrenOf}
            peopleById={peopleById}
            depth={depth + 1}
            showOwner={showOwner}
          />
        ))}
      </View>
      <Pressable
        onPress={() =>
          create({
            name: "New sub-project",
            parentProjectId: id,
            ownerPersonId: project.ownerPersonId,
          })
        }
        className="flex-row items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="corner-down-right" size={12} color={colors.faint} />
        <Text className="text-xs font-medium text-faint">Add sub-project</Text>
      </Pressable>

      <PersonPicker
        visible={ownerPickerOpen}
        title="Project owner"
        selectedId={project.ownerPersonId ?? null}
        onPick={(personId) => {
          update({ projectId: id, ownerPersonId: personId as Id<"people"> });
          setOwnerPickerOpen(false);
        }}
        onClear={() => {
          update({ projectId: id, ownerPersonId: null });
          setOwnerPickerOpen(false);
        }}
        onClose={() => setOwnerPickerOpen(false)}
      />
    </View>
  );
}

function MetaField({
  icon,
  width,
  children,
}: {
  icon: "calendar" | "dollar-sign";
  width: number;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-0.5">
      <Icon name={icon} size={13} color={colors.muted} />
      <View style={{ width }}>{children}</View>
    </View>
  );
}

function FieldRow({
  label,
  alert,
  children,
}: {
  label: string;
  alert?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center">
      <Text
        className={`w-16 px-2 text-2xs font-bold uppercase tracking-wider ${
          alert ? "text-danger" : "text-faint"
        }`}
      >
        {label}
      </Text>
      <View className="flex-1">{children}</View>
    </View>
  );
}
