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
import { View, Text, Pressable, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  PROJECT_STATUS_LABELS,
  startOfDay,
  type ProjectStatus,
} from "@events-os/shared";
import {
  Icon,
  InlineText,
  SelectCell,
  PersonPicker,
  Popover,
  Calendar,
  useAnchor,
  type SelectOption,
} from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";
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

export type ProjectDoc = Doc<"projects"> & {
  /** Joined by projects.list — the thread's newest entry, for the preview. */
  lastComment?: {
    body: string;
    authorName: string | null;
    createdAt: number;
  } | null;
};

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
  defaultExpanded = false,
  canManage = false,
  showOpenPage = false,
  partOf,
}: {
  project: ProjectDoc;
  childrenOf: Map<Id<"projects">, ProjectDoc[]>;
  /** Roster names for the owner chip (id → name). */
  peopleById: Map<Id<"people">, string>;
  depth?: number;
  /** Show + edit the owner chip (rollup/unassigned surfaces). */
  showOwner?: boolean;
  /** Open pre-expanded (the full-project modal's root). */
  defaultExpanded?: boolean;
  /** Show an "Open page ↗" link to the project's own shareable route — the
   *  detail page you can send someone when talking about a project. */
  showOpenPage?: boolean;
  /** Whether the caller may DELETE this project. Everyone can edit fields, add
   *  updates, and comment (the update log keeps it accountable) — deletion is
   *  the one destructive action, kept to the owner's chain + admins. */
  canManage?: boolean;
  /** Set when this card is a sub-project shown OUTSIDE its parent (e.g. under
   *  its assignee) — a chip back to the full project it belongs to. */
  partOf?: { name: string; onPress: () => void };
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
  // Condensed by default: one row like a responsibility; expand IN PLACE for
  // meta, the manager's fields, and sub-projects. Empty fields cost no space.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const id = project._id;
  const children = childrenOf.get(id) ?? [];
  const ownerName = project.ownerPersonId
    ? peopleById.get(project.ownerPersonId) ?? null
    : null;
  // "Due today" isn't overdue; a shipped project can't be.
  const overdue =
    project.deadline != null &&
    project.deadline < startOfDay(Date.now()) &&
    project.status !== "done";

  return (
    <View
      className={`rounded-lg border border-border bg-raised ${
        depth > 0 ? "mt-1.5" : ""
      }`}
    >
      {/* The condensed row: expand toggle · title · at-a-glance chips · status */}
      <View
        className={`flex-row items-center gap-1.5 py-0.5 pl-1 pr-2 ${
          expanded ? "border-b border-border/60" : ""
        }`}
      >
        <Pressable
          onPress={() => setExpanded((cur) => !cur)}
          hitSlop={6}
          accessibilityLabel={expanded ? "Collapse project" : "Expand project"}
          className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon
            name={expanded ? "chevron-down" : "chevron-right"}
            size={15}
            color={colors.muted}
          />
        </Pressable>
        <InlineText
          value={project.name}
          placeholder="Project name"
          weight="medium"
          onCommit={(t) => {
            if (t.trim()) update({ projectId: id, name: t.trim() });
          }}
        />
        {/* Everything from here to the status cell is the row's "whitespace":
            press it to open the project's own page. The chips inside stay
            independently tappable — RN's responder system lets a nested
            Pressable (or the DeadlineCell/owner triggers below) claim its own
            touch before it reaches this wrapper, on native AND web. The one
            thing that pattern doesn't cover is a raw TextInput (the name
            field above), which is why that's a sibling kept OUTSIDE this
            Pressable rather than nested inside it — nesting it would double-
            fire (focus the input AND navigate) on web. */}
        <Pressable
          onPress={() => router.push(`/project/${id}` as any)}
          className="flex-1 flex-row flex-wrap items-center gap-1.5"
          accessibilityLabel={`Open ${project.name || "project"}`}
        >
          {partOf ? (
            <Pressable
              onPress={partOf.onPress}
              hitSlop={4}
              accessibilityLabel={`Open full project: ${partOf.name}`}
              style={{ maxWidth: 160 }}
              className="flex-row items-center gap-1 rounded px-1 py-0.5 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="corner-left-up" size={12} color={colors.accent} />
              <Text
                className="text-xs font-medium text-accent"
                numberOfLines={1}
              >
                {partOf.name}
              </Text>
            </Pressable>
          ) : null}
          {!expanded ? (
            <>
              {project.blocker ? (
                <Icon name="alert-triangle" size={13} color={colors.danger} />
              ) : null}
              {children.length > 0 ? (
                <Text className="text-2xs font-semibold text-faint">
                  {children.length} sub{children.length === 1 ? "" : "s"}
                </Text>
              ) : null}
              <DeadlineCell
                compact
                value={project.deadline}
                overdue={overdue}
                onChange={(v) => update({ projectId: id, deadline: v })}
              />
              {showOwner ? (
                <Pressable
                  onPress={() => setOwnerPickerOpen(true)}
                  hitSlop={4}
                  accessibilityLabel={
                    ownerName ? `Owner: ${ownerName}` : "Assign owner"
                  }
                  className="rounded px-1 py-0.5 active:bg-sunken web:hover:bg-sunken"
                >
                  <Text
                    className={`text-xs ${ownerName ? "text-muted" : "text-faint"}`}
                    numberOfLines={1}
                  >
                    {ownerName ?? "—"}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </Pressable>
        <View style={{ width: 112 }}>
          <SelectCell
            value={project.status}
            options={PROJECT_STATUS_OPTIONS}
            onChange={(status) => update({ projectId: id, status })}
          />
        </View>
        <Pressable
          onPress={() => router.push(`/project/${id}` as any)}
          hitSlop={4}
          accessibilityLabel="Open project page"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="external-link" size={13} color={colors.faint} />
        </Pressable>
        {canManage ? (
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
        ) : null}
      </View>

      {/* Quick preview: the latest comment IS the state of the project. */}
      {!expanded && project.lastComment ? (
        <Text className="px-8 pb-1.5 text-xs text-muted" numberOfLines={1}>
          {project.lastComment.authorName ?? "Former member"}:{" "}
          {project.lastComment.body}
        </Text>
      ) : null}

      {expanded ? (
        <>
      {/* Meta: deadline · budget · owner · linked event */}
      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 px-2 py-1">
        <DeadlineCell
          value={project.deadline}
          overdue={overdue}
          onChange={(v) => update({ projectId: id, deadline: v })}
        />
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
              {/* An owner whose name isn't in this page's map is still an
                  owner — never present owned work as assignable-from-scratch. */}
              {ownerName ??
                (project.ownerPersonId ? "Owned elsewhere" : "Assign owner")}
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
        {showOpenPage && depth === 0 ? (
          <Pressable
            onPress={() => router.push(`/project/${id}` as any)}
            className="flex-row items-center gap-1.5 py-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon name="external-link" size={13} color={colors.muted} />
            <Text className="text-sm font-medium text-muted">Open page</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Purpose + blocker stay as fields; progression lives in the thread. */}
      <View className="px-1 py-1">
        <FieldRow label="Purpose">
          <InlineText
            value={project.purpose ?? ""}
            placeholder="—"
            onCommit={(t) => update({ projectId: id, purpose: t.trim() || null })}
          />
        </FieldRow>
        <FieldRow label="Blocker" alert={!!project.blocker}>
          <InlineText
            value={project.blocker ?? ""}
            placeholder="—"
            onCommit={(t) => update({ projectId: id, blocker: t.trim() || null })}
          />
        </FieldRow>
      </View>

      {/* The running history: every comment is one step of the progression. */}
      <ProjectComments projectId={id} />

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
            canManage={canManage}
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
        </>
      ) : null}

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

/**
 * The project's comment thread — its history and progression, oldest first,
 * with a composer anyone who can see the project may post to. Mounted only
 * while the card is expanded, so collapsed cards cost no extra subscription.
 */
function ProjectComments({ projectId }: { projectId: Id<"projects"> }) {
  const comments = useQuery(api.projects.comments, { projectId });
  const addComment = useMutation(api.projects.addComment);
  const removeComment = useMutation(api.projects.removeComment);
  const [draft, setDraft] = useState("");

  function post() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    void addComment({ projectId, body }).catch((err) => {
      // Put the text back — a rejected post must not eat the update.
      setDraft(body);
      alertError(err);
    });
  }

  return (
    <View className="border-t border-border/60 px-2.5 py-1.5" style={{ gap: 4 }}>
      {comments === undefined ? (
        <Text className="text-xs text-faint">Loading history…</Text>
      ) : comments === null ? (
        <Text className="text-xs text-faint">
          The thread is only visible to this project's team.
        </Text>
      ) : (
        comments.map((c) => (
          <View key={c._id} className="flex-row items-start gap-1.5">
            <Text className="flex-1 text-xs text-ink">
              <Text className="font-semibold">
                {c.authorName ?? "Former member"}
              </Text>
              <Text className="text-faint"> · {formatDate(c.createdAt)}  </Text>
              {c.body}
            </Text>
            <Pressable
              onPress={() =>
                confirmAction({
                  title: "Delete comment?",
                  message: "Only the author or an admin can do this.",
                  confirmLabel: "Delete",
                  destructive: true,
                  onConfirm: () => {
                    void removeComment({ commentId: c._id }).catch(alertError);
                  },
                })
              }
              hitSlop={6}
              accessibilityLabel="Delete comment"
              className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="x" size={11} color={colors.faint} />
            </Pressable>
          </View>
        ))
      )}
      <View className="flex-row items-center gap-1.5">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add an update…"
          placeholderTextColor={colors.faint}
          onSubmitEditing={post}
          className="flex-1 rounded-md border border-border bg-raised px-2 py-1 text-xs text-ink"
        />
        <Pressable
          onPress={post}
          hitSlop={6}
          accessibilityLabel="Post update"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="send" size={14} color={colors.accent} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The deadline field — a flag-labelled trigger opening the shared Calendar
 * (same picker as the event schedule / DUE cells), so nobody hand-types
 * YYYY-MM-DD. Red flag + red date once it slips past today unshipped.
 */
function DeadlineCell({
  value,
  overdue,
  onChange,
  compact = false,
}: {
  value: number | null | undefined;
  overdue: boolean;
  onChange: (v: number | null) => void;
  /** The condensed row's flag+date chip: smaller glyph/text, no "Due"/"Set
   *  deadline" copy, and — like the row's other at-a-glance chips — rendered
   *  only once a deadline exists. Same trigger mechanics (Popover + Calendar)
   *  as the full meta-row cell; only the trigger's chrome differs. */
  compact?: boolean;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  if (compact && value == null) return null;
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityLabel={
          value != null ? `Deadline: ${formatDate(value)}` : "Set deadline"
        }
        className={
          compact
            ? "flex-row items-center gap-1 active:opacity-70 web:hover:opacity-90"
            : "flex-row items-center gap-1.5 py-1 active:opacity-70 web:hover:opacity-90"
        }
      >
        <Icon
          name="flag"
          size={compact ? 12 : 13}
          color={overdue ? colors.danger : colors.muted}
        />
        <Text
          className={
            compact
              ? `text-xs ${overdue ? "font-medium text-danger" : "text-muted"}`
              : `text-sm ${
                  value != null
                    ? overdue
                      ? "font-medium text-danger"
                      : "text-ink"
                    : "text-faint"
                }`
          }
          numberOfLines={1}
        >
          {compact
            ? formatDate(value as number)
            : value != null
              ? `Due ${formatDate(value)}`
              : "Set deadline"}
        </Text>
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={288}>
        <Calendar
          selected={value ?? null}
          onSelect={(ms) => {
            onChange(ms);
            close();
          }}
          footer={
            value != null ? (
              <Pressable
                onPress={() => {
                  onChange(null);
                  close();
                }}
                className="mt-2 flex-row items-center justify-center gap-1.5 border-t border-border pt-2.5 active:opacity-70 web:hover:opacity-90"
              >
                <Icon name="x" size={13} color={colors.muted} />
                <Text className="text-xs font-semibold text-muted">
                  Clear deadline
                </Text>
              </Pressable>
            ) : null
          }
        />
      </Popover>
    </>
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
        // Wide enough for "BLOCKER" at tracking-wider — w-16 wrapped mid-word.
        style={{ width: 76 }}
        className={`px-2 text-2xs font-bold uppercase tracking-wider ${
          alert ? "text-danger" : "text-faint"
        }`}
        numberOfLines={1}
      >
        {label}
      </Text>
      <View className="flex-1">{children}</View>
    </View>
  );
}
