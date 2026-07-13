/**
 * DUTIES GRID — the chapter's recurring duties as a database grid.
 *
 * Extracted from the Duties screen so it can render both there (its own route,
 * kept for deep links) and inside the Work tab's Duties segment. Each row is a
 * DEFINITION that fans out: assign it to roles ("Director") and every person
 * holding that role gets it as an individual duty on their Work page; assign
 * specific people when no role fits. The How-to column is the handoff
 * documentation; cadence says how often (daily … yearly, or ad hoc).
 *
 * Self-contained: it owns its own queries + mutations, so both mount points
 * render `<DutiesGrid />` with no wiring. Callers gate visibility (nav.canManage)
 * — this component assumes the caller is allowed to manage the catalog.
 */
import { useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCES,
  RESPONSIBILITY_CADENCE_LABELS,
  responsibilityAppliesTo,
  normalizeRole,
  type ResponsibilityCadence,
} from "@events-os/shared";
import {
  Narrow,
  TextField,
  EmptyState,
  Icon,
  OptionTag,
  InlineText,
  GridHeaderCell,
  SelectCell,
  PersonPicker,
  type SelectOption,
} from "../ui";
import {
  HowToDocCell,
  type HowToDocSummary,
} from "../team/HowToDocCell";
import { colors, spacing } from "../../lib/theme";
import { parseList } from "../../lib/format";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

const CADENCE_OPTIONS: SelectOption<ResponsibilityCadence>[] =
  RESPONSIBILITY_CADENCES.map((c) => ({
    value: c,
    label: RESPONSIBILITY_CADENCE_LABELS[c],
    color: c === "ad_hoc" ? "gray" : "teal",
  }));

type Responsibility = Doc<"responsibilities"> & {
  howToDoc: HowToDocSummary | null;
};

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

export function DutiesGrid() {
  const responsibilities = useQuery(api.responsibilities.list);
  const people = useQuery(api.people.list, {});
  const create = useMutation(api.responsibilities.create);
  const update = useMutation(api.responsibilities.update);

  const [search, setSearch] = useState("");
  // ONE picker for the whole grid (a per-row picker would mount a hidden
  // Modal + roster watcher on every row); rows just say which row it's for.
  const [pickerForRow, setPickerForRow] =
    useState<Id<"responsibilities"> | null>(null);

  const nameById = useMemo(
    () => new Map((people ?? []).map((p) => [p._id, p.name])),
    [people],
  );
  // Distinct job titles across the roster (original casing) — autocomplete.
  const allRoles = useMemo(() => {
    const byNorm = new Map<string, string>();
    for (const p of people ?? []) {
      const norm = normalizeRole(p.role);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, p.role!.trim());
    }
    return Array.from(byNorm.values()).sort((a, b) => a.localeCompare(b));
  }, [people]);

  // How many people hold each (normalized) role — dangling-role warnings.
  const roleHolders = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of people ?? []) {
      const role = normalizeRole(p.role);
      if (role) map.set(role, (map.get(role) ?? 0) + 1);
    }
    return map;
  }, [people]);

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
    return (
      <Narrow>
        <View style={{ paddingVertical: spacing.lg }}>
          <Text className="text-sm text-faint">Loading duties…</Text>
        </View>
      </Narrow>
    );
  }

  return (
    <>
      <Narrow>
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: spacing.md,
          }}
        >
          <Text className="font-display text-2xl text-ink">Duties</Text>
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
              <GridHeaderCell label="Duty" width={COLS.title} />
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
                  No duties yet — add the ongoing work your team runs on
                  below.
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
                  roleHolders={roleHolders}
                  allRoles={allRoles}
                  holders={holderCount.get(r._id) ?? 0}
                  isLast={i === filtered.length - 1}
                  onOpenPicker={() => setPickerForRow(r._id)}
                />
              ))
            )}
          </View>
        </ScrollView>

        {/* Add row */}
        <Pressable
          onPress={() => {
            // A live search filter would hide the new row — clear it first.
            setSearch("");
            void create({ title: "New duty" }).catch(alertError);
          }}
          className="flex-row items-center gap-1.5 border-t border-border px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="plus" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">
            Add duty
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

      <PersonPicker
        visible={pickerForRow !== null}
        title="Assign to person"
        onPick={(personId) => {
          const row = responsibilities.find((r) => r._id === pickerForRow);
          setPickerForRow(null);
          if (!row) return;
          const cur = row.assigneePersonIds ?? [];
          if (!cur.includes(personId as Id<"people">)) {
            void update({
              responsibilityId: row._id,
              assigneePersonIds: [...cur, personId as Id<"people">],
            }).catch(alertError);
          }
        }}
        onClose={() => setPickerForRow(null)}
      />
    </>
  );
}

function ResponsibilityRow({
  row,
  nameById,
  roleHolders,
  allRoles,
  holders,
  isLast,
  onOpenPicker,
}: {
  row: Responsibility;
  nameById: Map<Id<"people">, string>;
  roleHolders: Map<string, number>;
  allRoles: string[];
  holders: number;
  isLast: boolean;
  onOpenPicker: () => void;
}) {
  const updateMutation = useMutation(api.responsibilities.update);
  const removeMutation = useMutation(api.responsibilities.remove);
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
          placeholder="Duty"
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

      {/* Assignee roles (fan-out): comma-edited chips; a role nobody holds
          reads in danger red so a job-title rename can't silently detach it. */}
      <Cell width={COLS.roles}>
        <RolesCell
          values={row.assigneeRoles ?? []}
          roleHolders={roleHolders}
          allRoles={allRoles}
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
            onPress={onOpenPicker}
            hitSlop={6}
            accessibilityLabel="Assign a person"
            className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="plus" size={13} color={colors.faint} />
          </Pressable>
        </View>
      </Cell>

      {/* Fan-out count (derived, read-only) */}
      <Cell width={COLS.holders}>
        <Text className={`px-2 text-sm ${holders > 0 ? "text-ink" : "text-faint"}`}>
          {holders > 0 ? holders : "—"}
        </Text>
      </Cell>

      {/* How to (the handoff doc): link / video / note / markdown page —
          the same doc primitive behind event-grid How-To cells. */}
      <Cell width={COLS.howTo}>
        <HowToDocCell
          doc={row.howToDoc}
          onSetDoc={(docId) =>
            update(docId ? { howToDocId: docId } : { howToDocId: null })
          }
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
          onPress={() =>
            confirmAction({
              title: "Delete duty?",
              message: `"${row.title || "This duty"}" will be removed for everyone holding it.`,
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                void removeMutation({ responsibilityId: id }).catch(alertError);
              },
            })
          }
          hitSlop={4}
          accessibilityLabel="Delete duty"
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

// Role chips + comma editor with type-ahead over the roster's job titles.
function RolesCell({
  values,
  roleHolders,
  allRoles,
  onCommit,
}: {
  values: string[];
  roleHolders: Map<string, number>;
  allRoles: string[];
  onCommit: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <RolesEditor
        initial={values}
        allRoles={allRoles}
        onDone={(next) => {
          onCommit(next);
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
        values.map((s) => {
          const holds = (roleHolders.get(normalizeRole(s)) ?? 0) > 0;
          return (
            <OptionTag
              key={s}
              label={holds ? s : `${s} — no one holds this role`}
              color={holds ? "purple" : "red"}
            />
          );
        })
      )}
    </Pressable>
  );
}

/**
 * Comma-list editor with INLINE type-ahead: as you type a role, existing job
 * titles matching the current (last) token render as tappable chips right
 * below the input — inside the cell, NOT in a Modal popover. (A Modal steals
 * focus from the input the moment it mounts on web, which blurred the field,
 * fired the blur-commit, and closed the editor before a single keystroke —
 * the flicker.) Exactly ONE commit ever fires (`done` guard): a chip's
 * onPressIn wins over the input's blur, and blur itself is the click-away
 * commit.
 */
function RolesEditor({
  initial,
  allRoles,
  onDone,
}: {
  initial: string[];
  allRoles: string[];
  onDone: (next: string[]) => void;
}) {
  const [text, setText] = useState(initial.join(", "));
  const done = useRef(false);
  const latest = useRef(text);
  latest.current = text;

  const parts = text.split(",");
  const token = normalizeRole(parts[parts.length - 1]);
  const already = new Set(parseList(text).map(normalizeRole));
  const matches = allRoles
    .filter(
      (r) =>
        !already.has(normalizeRole(r)) &&
        (token === "" || normalizeRole(r).includes(token)),
    )
    .slice(0, 5);

  function commit(finalText: string) {
    if (done.current) return; // pick+blur / submit+blur must not double-fire
    done.current = true;
    onDone(parseList(finalText));
  }

  return (
    <View className="flex-1 py-1">
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Director, Designer…"
        placeholderTextColor={colors.faint}
        autoFocus
        autoCapitalize="words"
        onSubmitEditing={() => commit(latest.current)}
        // Click-away commits; a chip's onPressIn already committed by the
        // time this runs, and the `done` guard makes it a no-op.
        onBlur={() => commit(latest.current)}
        className="px-2 py-0.5 text-sm leading-snug text-ink"
        style={{ minWidth: 40 }}
      />
      {matches.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-1 px-2 pt-1">
          {matches.map((r) => (
            <Pressable
              key={r}
              onPressIn={() => {
                // Fires before the input's blur — deterministic pick.
                const kept = parts.slice(0, -1).join(",");
                commit(kept ? `${kept}, ${r}` : r);
              }}
              className="flex-row items-center gap-1 rounded-pill border border-border bg-sunken px-2 py-0.5 active:opacity-70 web:hover:border-border-strong"
            >
              <Icon name="plus" size={10} color={colors.muted} />
              <Text className="text-xs font-medium text-muted">{r}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
