/**
 * RESPONSIBILITIES — the chapter's recurring duties as a database grid.
 *
 * Each row is a DEFINITION that fans out: assign it to roles ("Director") and
 * every person holding that role gets it as an individual responsibility on
 * their Team page; assign specific people when no role fits. The How-to
 * column is the handoff documentation — how the work actually gets done —
 * and cadence says how often (daily … yearly, or ad hoc, e.g. event flyers).
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, Platform } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCES,
  RESPONSIBILITY_CADENCE_LABELS,
  responsibilityAppliesTo,
  type ResponsibilityCadence,
} from "@events-os/shared";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  TextField,
  EmptyState,
  Icon,
  OptionTag,
  InlineText,
  GridHeaderCell,
  SelectCell,
  PersonPicker,
  type SelectOption,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

const CADENCE_OPTIONS: SelectOption<ResponsibilityCadence>[] =
  RESPONSIBILITY_CADENCES.map((c) => ({
    value: c,
    label: RESPONSIBILITY_CADENCE_LABELS[c],
    color: c === "ad_hoc" ? "gray" : "teal",
  }));

type Responsibility = Doc<"responsibilities">;

// Fixed column widths (px) — mirrors the People grid's chrome.
const COLS = {
  title: 230,
  cadence: 120,
  roles: 210,
  people: 230,
  holders: 90,
  howTo: 280,
  description: 240,
  notes: 200,
} as const;
const DELETE_W = 38;
const TABLE_WIDTH =
  Object.values(COLS).reduce((sum, w) => sum + w, 0) + DELETE_W;

/** Parse a comma list into trimmed, de-duped values, preserving case. */
function parseList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (s) seen.add(s);
  }
  return Array.from(seen);
}

/** Confirm a destructive action — window.confirm on web, no prompt on native. */
function confirmRemove(title: string): boolean {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.confirm(`Delete "${title || "this responsibility"}"?`);
  }
  return true;
}

export default function ResponsibilitiesScreen() {
  const responsibilities = useQuery(api.responsibilities.list);
  const people = useQuery(api.people.list);
  const create = useMutation(api.responsibilities.create);

  const [search, setSearch] = useState("");

  const nameById = useMemo(
    () => new Map((people ?? []).map((p) => [p._id, p.name])),
    [people],
  );
  // How many people each row currently fans out to (role match + direct).
  const holderCount = useMemo(() => {
    const map = new Map<Id<"responsibilities">, number>();
    for (const r of responsibilities ?? []) {
      map.set(
        r._id,
        (people ?? []).filter((p) => responsibilityAppliesTo(r, p)).length,
      );
    }
    return map;
  }, [responsibilities, people]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return responsibilities ?? [];
    return (responsibilities ?? []).filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.assigneeRoles ?? []).some((role) =>
          role.toLowerCase().includes(q),
        ),
    );
  }, [responsibilities, search]);

  if (responsibilities === undefined || people === undefined) {
    return <Screen loading />;
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: spacing.md,
          }}
        >
          <Text className="font-display text-2xl text-ink">
            Responsibilities
          </Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {responsibilities.length} ongoing
          </Text>
        </View>
        <TextField
          placeholder="Search by title or role…"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />
      </Narrow>

      {/* The grid */}
      <View className="overflow-hidden rounded-lg border border-border bg-raised">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
            <View className="flex-row items-center border-b border-border bg-sunken">
              <GridHeaderCell label="Responsibility" width={COLS.title} />
              <GridHeaderCell label="Cadence" width={COLS.cadence} />
              <GridHeaderCell label="Roles" width={COLS.roles} />
              <GridHeaderCell label="People" width={COLS.people} />
              <GridHeaderCell label="Holders" width={COLS.holders} />
              <GridHeaderCell label="How to" width={COLS.howTo} />
              <GridHeaderCell label="Description" width={COLS.description} />
              <GridHeaderCell label="Notes" width={COLS.notes} />
              <View style={{ width: DELETE_W }} />
            </View>

            {responsibilities.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  No responsibilities yet — add the ongoing duties your team
                  runs on below.
                </Text>
              </View>
            ) : filtered.length === 0 ? (
              <View className="px-3 py-6">
                <Text className="text-sm text-faint">
                  Nothing matches your search.
                </Text>
              </View>
            ) : (
              filtered.map((r, i) => (
                <ResponsibilityRow
                  key={r._id}
                  row={r}
                  nameById={nameById}
                  holders={holderCount.get(r._id) ?? 0}
                  isLast={i === filtered.length - 1}
                />
              ))
            )}
          </View>
        </ScrollView>

        {/* Add row */}
        <Pressable
          onPress={() =>
            void create({ title: "New responsibility" }).catch(alertError)
          }
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">
            Add responsibility
          </Text>
        </Pressable>
      </View>

      {responsibilities.length === 0 ? (
        <Narrow>
          <View style={{ marginTop: spacing.md }}>
            <EmptyState
              title="Document the recurring work"
              message="e.g. “Meet with directs — bi-weekly — Directors” or “Create event flyers — ad hoc — Designer”. Assign to roles so one row covers everyone holding it."
            />
          </View>
        </Narrow>
      ) : null}
    </Screen>
  );
}

function ResponsibilityRow({
  row,
  nameById,
  holders,
  isLast,
}: {
  row: Responsibility;
  nameById: Map<Id<"people">, string>;
  holders: number;
  isLast: boolean;
}) {
  const updateMutation = useMutation(api.responsibilities.update);
  const removeMutation = useMutation(api.responsibilities.remove);
  const [pickerOpen, setPickerOpen] = useState(false);
  const id = row._id;

  const update = (args: Omit<Parameters<typeof updateMutation>[0], "responsibilityId">) => {
    void updateMutation({ responsibilityId: id, ...args }).catch(alertError);
  };

  return (
    <View
      className={`flex-row items-stretch border-b border-border bg-raised ${
        isLast ? "border-b-0" : ""
      }`}
    >
      {/* Title */}
      <Cell width={COLS.title}>
        <InlineText
          value={row.title}
          placeholder="Responsibility"
          weight="medium"
          onCommit={(t) => {
            if (t.trim()) update({ title: t.trim() });
          }}
        />
      </Cell>

      {/* Cadence */}
      <Cell width={COLS.cadence}>
        <SelectCell
          value={row.cadence}
          options={CADENCE_OPTIONS}
          onChange={(cadence) => update({ cadence })}
        />
      </Cell>

      {/* Assignee roles (fan-out): comma-edited chips */}
      <Cell width={COLS.roles}>
        <RolesCell
          values={row.assigneeRoles ?? []}
          onCommit={(next) =>
            update({ assigneeRoles: next.length > 0 ? next : null })
          }
        />
      </Cell>

      {/* Directly-assigned people: chips + picker */}
      <Cell width={COLS.people}>
        <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
          {(row.assigneePersonIds ?? []).map((pid) => (
            <OptionTag
              key={pid}
              label={nameById.get(pid) ?? "?"}
              onRemove={() =>
                update({
                  assigneePersonIds:
                    (row.assigneePersonIds ?? []).filter((x) => x !== pid)
                      .length > 0
                      ? (row.assigneePersonIds ?? []).filter((x) => x !== pid)
                      : null,
                })
              }
            />
          ))}
          <Pressable
            onPress={() => setPickerOpen(true)}
            hitSlop={6}
            accessibilityLabel="Assign a person"
            className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="plus" size={13} color={colors.faint} />
          </Pressable>
        </View>
        <PersonPicker
          visible={pickerOpen}
          title="Assign to person"
          onPick={(personId) => {
            const cur = row.assigneePersonIds ?? [];
            if (!cur.includes(personId as Id<"people">)) {
              update({
                assigneePersonIds: [...cur, personId as Id<"people">],
              });
            }
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      </Cell>

      {/* Fan-out count (derived, read-only) */}
      <Cell width={COLS.holders}>
        <Text className={`px-2 text-sm ${holders > 0 ? "text-ink" : "text-faint"}`}>
          {holders > 0 ? holders : "—"}
        </Text>
      </Cell>

      {/* How to (the handoff doc) */}
      <Cell width={COLS.howTo}>
        <InlineText
          value={row.howTo ?? ""}
          placeholder="Steps, links, tools…"
          onCommit={(t) => update({ howTo: t.trim() || null })}
        />
      </Cell>

      {/* Description */}
      <Cell width={COLS.description}>
        <InlineText
          value={row.description ?? ""}
          placeholder="—"
          onCommit={(t) => update({ description: t.trim() || null })}
        />
      </Cell>

      {/* Notes */}
      <Cell width={COLS.notes}>
        <InlineText
          value={row.notes ?? ""}
          placeholder="—"
          onCommit={(t) => update({ notes: t.trim() || null })}
        />
      </Cell>

      {/* Delete gutter */}
      <View style={{ width: DELETE_W }} className="items-center justify-center">
        <Pressable
          onPress={() => {
            if (confirmRemove(row.title)) {
              void removeMutation({ responsibilityId: id }).catch(alertError);
            }
          }}
          hitSlop={4}
          accessibilityLabel="Delete responsibility"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="trash-2" size={14} color={colors.danger} />
        </Pressable>
      </View>
    </View>
  );
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View
      style={{ width }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
  );
}

// Role chips + inline comma editor (case-preserving, like the People grid).
function RolesCell({
  values,
  onCommit,
}: {
  values: string[];
  onCommit: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineText
        value={values.join(", ")}
        placeholder="Director, Designer…"
        onCommit={(t) => {
          onCommit(parseList(t));
          setEditing(false);
        }}
      />
    );
  }

  return (
    <Pressable
      onPress={() => setEditing(true)}
      className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      {values.length === 0 ? (
        <Text className="text-sm text-faint">—</Text>
      ) : (
        values.map((s) => <OptionTag key={s} label={s} color="purple" />)
      )}
    </Pressable>
  );
}
