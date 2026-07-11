import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, TextInput, Platform } from "react-native";
import {
  Card,
  Button,
  Avatar,
  Icon,
  PhaseBreakdown,
  Popover,
  LocationAutocomplete,
  useAnchor,
  statusTone,
  type BadgeTone,
} from "../ui";
import { DateTimePanel } from "../ui/DateTimeField";
import {
  RoleChipMenu,
  confirmDeleteRole,
  measureAnchor,
  type ChipAnchor,
} from "../role/RoleChips";
import { colors } from "../../lib/theme";
import { formatDateTime } from "../../lib/format";
import {
  EVENT_STATUSES,
  EVENT_STATUS_LABELS,
  type EventStatus,
  type PhaseKey,
  type PhasePace,
  type PhaseScores,
} from "@events-os/shared";

type RoleRow = {
  roleId: string;
  roleLabel: string;
  person: { _id: string; name: string } | null;
};

/**
 * Workspace header for an event — the calm, everything-inline design:
 *
 *   1. Title (borderless inline edit) + status pill (tap → menu)
 *   2. One quiet META LINE — date · location · budget as text, not chips;
 *      hovering shows the edit affordance, tapping edits in place
 *   3. PEOPLE row — owner + assigned role chips (avatar carries the person,
 *      the label names the role), unfilled roles folded into one "N open"
 *      chip, trailing ＋ to add
 *   4. Phase rings (right) with ONE pace pill under them — the aggregate
 *      "▲ N overdue" / "✓ on pace" signal, which doubles as the What's-next
 *      toggle so the count lives in exactly one place
 *
 * Facts are quiet text; borders mean "interactive". The only loud element is
 * the amber pace pill when work is overdue. Operational tools (Day-of /
 * Me view / ⋯) live on the tab rail below via {@link EventTools}.
 */
export function EventHeader({
  event,
  eventTypeName,
  phases,
  expectedPhases,
  pacePhases,
  budgetSpent,
  budgetPct,
  nameValue,
  onChangeName,
  onSaveName,
  onSetStatus,
  onReschedule,
  locationValue,
  onChangeLocation,
  onSaveLocation,
  budgetValue,
  onChangeBudget,
  onSaveBudget,
  owner,
  roleRows,
  onOpenOwner,
  onPickRole,
  onRenameRole,
  onDeleteRole,
  onAddRole,
  whatsNextOpen,
  onToggleWhatsNext,
  onSelectPhase,
  activePhase,
}: {
  event: any;
  eventTypeName: string;
  phases: PhaseScores;
  /** Pacing ghost: where each ring should be today (see PhaseBreakdown). */
  expectedPhases?: PhaseScores;
  /** Per-phase overdue tallies — feeds the single pace pill + label tints. */
  pacePhases?: Record<PhaseKey, PhasePace | null>;
  budgetSpent: number;
  budgetPct: number;
  nameValue: string;
  onChangeName: (text: string) => void;
  onSaveName: () => void;
  onSetStatus: (status: EventStatus) => void;
  /** Reschedule to an epoch-ms timestamp (the date popover commits live). */
  onReschedule: (ts: number) => void;
  locationValue: string;
  onChangeLocation: (text: string) => void;
  /** Commit the location (explicit value on suggestion pick, buffer on blur). */
  onSaveLocation: (value?: string) => void;
  budgetValue: string;
  onChangeBudget: (text: string) => void;
  onSaveBudget: () => void;
  owner: { _id: string; name: string } | null;
  roleRows: RoleRow[];
  onOpenOwner: () => void;
  onPickRole: (role: RoleRow) => void;
  onRenameRole: (roleId: string, label: string) => void;
  onDeleteRole: (roleId: string) => void;
  onAddRole: (label: string) => void;
  /** The What's-next panel (outstanding work) toggled below the header. */
  whatsNextOpen: boolean;
  onToggleWhatsNext: () => void;
  /** Tap a phase ring → pulse the tabs that feed it (see EventTabBar). */
  onSelectPhase?: (phase: PhaseKey) => void;
  activePhase?: PhaseKey | null;
}) {
  return (
    <Card className="mb-4">
      <View className="flex-row flex-wrap items-start gap-x-6 gap-y-4">
        <View className="flex-1 gap-2.5" style={{ minWidth: 300 }}>
          {/* Event type eyebrow — only when it says something the title doesn't. */}
          {eventTypeName && eventTypeName !== event.name ? (
            <Text className="-mb-1 text-xs font-bold uppercase tracking-wider text-accent">
              {eventTypeName}
            </Text>
          ) : null}

          {/* Row 1 — title + status pill */}
          <View className="flex-row flex-wrap items-center gap-2.5">
            <TitleInput
              value={nameValue}
              onChangeText={onChangeName}
              onBlur={onSaveName}
            />
            <StatusPill status={event.status as EventStatus} onSetStatus={onSetStatus} />
          </View>

          {/* Row 2 — the quiet meta line: date · location · budget */}
          <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
            <DateSeg eventDate={event.eventDate} onReschedule={onReschedule} />
            <MetaDot />
            <LocationSeg
              location={event.location ?? null}
              value={locationValue}
              onChangeText={onChangeLocation}
              onSave={onSaveLocation}
            />
            <MetaDot />
            <BudgetSeg
              budget={event.budget ?? null}
              spent={budgetSpent}
              pct={budgetPct}
              value={budgetValue}
              onChangeText={onChangeBudget}
              onSave={onSaveBudget}
            />
          </View>

          {/* Row 3 — people: owner, assigned roles, folded open roles, ＋ */}
          <PeopleRow
            owner={owner}
            roleRows={roleRows}
            onOpenOwner={onOpenOwner}
            onPickRole={onPickRole}
            onRenameRole={onRenameRole}
            onDeleteRole={onDeleteRole}
            onAddRole={onAddRole}
          />
        </View>

        {/* Phase readiness (right) — quiet rings + the single pace pill. */}
        <View className="items-end gap-2">
          <PhaseBreakdown
            phases={phases}
            expected={expectedPhases}
            pace={pacePhases}
            size={48}
            onSelectPhase={onSelectPhase}
            activePhase={activePhase}
          />
          <PacePill
            pace={pacePhases}
            open={whatsNextOpen}
            onToggle={onToggleWhatsNext}
          />
        </View>
      </View>
    </Card>
  );
}

/* ── Title ──────────────────────────────────────────────────────────────── */

/** Borderless inline title — reads as a heading, edits on click. */
function TitleInput({
  value,
  onChangeText,
  onBlur,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onBlur: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onBlur();
      }}
      placeholder="Event name"
      placeholderTextColor={colors.faint}
      className={`-ml-1.5 rounded-md px-1.5 py-0.5 text-xl font-bold text-ink web:hover:bg-sunken ${
        focused ? "bg-sunken" : "bg-transparent"
      }`}
      style={{ flexGrow: 1, flexShrink: 1, minWidth: 180, outlineWidth: 0 } as any}
    />
  );
}

/* ── Status pill ────────────────────────────────────────────────────────── */

const PILL_TONES: Record<BadgeTone, { text: string; bg: string }> = {
  neutral: { text: colors.muted, bg: colors.sunken },
  accent: { text: colors.accent, bg: colors.accentSoft },
  success: { text: colors.success, bg: colors.successBg },
  warn: { text: colors.warn, bg: colors.warnBg },
  danger: { text: colors.danger, bg: colors.dangerBg },
  info: { text: colors.info, bg: colors.infoBg },
  lavender: { text: colors.statPurple, bg: colors.sunken },
};

/** The lifecycle status as ONE pill — tap to change (replaces the 4-chip strip). */
function StatusPill({
  status,
  onSetStatus,
}: {
  status: EventStatus;
  onSetStatus: (status: EventStatus) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const tone = PILL_TONES[statusTone(status)];
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Status: ${EVENT_STATUS_LABELS[status]}. Change status`}
        className="flex-row items-center gap-1 rounded-pill border px-2.5 py-1 active:opacity-80"
        style={{ backgroundColor: tone.bg, borderColor: tone.text }}
      >
        <Text className="text-xs font-bold" style={{ color: tone.text }}>
          {EVENT_STATUS_LABELS[status]}
        </Text>
        <Icon name="chevron-down" size={11} color={tone.text} />
      </Pressable>
      <Popover visible={visible} anchor={anchor} width={180} onClose={close}>
        {EVENT_STATUSES.map((s) => {
          const t = PILL_TONES[statusTone(s)];
          const current = s === status;
          return (
            <Pressable
              key={s}
              onPress={() => {
                close();
                if (!current) onSetStatus(s);
              }}
              className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: t.text,
                }}
              />
              <Text
                className={`flex-1 text-sm ${current ? "font-semibold text-ink" : "text-ink"}`}
              >
                {EVENT_STATUS_LABELS[s]}
              </Text>
              {current ? <Icon name="check" size={14} color={colors.muted} /> : null}
            </Pressable>
          );
        })}
      </Popover>
    </>
  );
}

/* ── Meta line segments ─────────────────────────────────────────────────── */

function MetaDot() {
  return <Text className="text-base text-faint">·</Text>;
}

/**
 * One tappable fact on the meta line. Quiet text at rest; hover reveals the
 * pencil + a soft wash (borders mean "editable", so facts don't wear boxes).
 */
function MetaSeg({
  text,
  faint,
  danger,
  suffix,
  onPress,
  innerRef,
  editLabel,
}: {
  text: string;
  /** Placeholder styling for "Add location" / "Add budget". */
  faint?: boolean;
  danger?: boolean;
  /** Muted trailing fragment (e.g. the budget "· 19%"). */
  suffix?: string;
  onPress: () => void;
  innerRef?: React.MutableRefObject<any>;
  editLabel: string;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = danger
    ? "font-semibold text-danger"
    : faint
      ? "text-faint"
      : "text-ink";
  return (
    <Pressable
      ref={innerRef}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={editLabel}
      className={`-mx-1 flex-row items-center gap-1 rounded-md px-1 py-0.5 active:opacity-70 ${
        hovered ? "bg-sunken" : ""
      }`}
    >
      <Text className={`text-base ${tone}`}>{text}</Text>
      {suffix ? <Text className="text-base text-muted">{suffix}</Text> : null}
      {hovered ? <Icon name="edit-2" size={11} color={colors.faint} /> : null}
    </Pressable>
  );
}

/** Date — opens the calendar/time popover; rescheduling reflows due dates. */
function DateSeg({
  eventDate,
  onReschedule,
}: {
  eventDate: number;
  onReschedule: (ts: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  return (
    <>
      <MetaSeg
        innerRef={ref}
        text={formatDateTime(eventDate)}
        onPress={open}
        editLabel="Reschedule event"
      />
      <Popover visible={visible} anchor={anchor} width={388} onClose={close}>
        <View className="border-b border-border bg-warn-bg px-3 py-2">
          <Text className="text-xs font-semibold text-warn">
            Rescheduling reflows every relative due date.
          </Text>
        </View>
        <DateTimePanel value={eventDate} onChange={onReschedule} />
      </Popover>
    </>
  );
}

/** Location — swaps to the autocomplete input in place; commits on blur/pick. */
function LocationSeg({
  location,
  value,
  onChangeText,
  onSave,
}: {
  location: string | null;
  value: string;
  onChangeText: (text: string) => void;
  onSave: (value?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <LocationAutocomplete
        variant="inline"
        value={value}
        onChangeText={onChangeText}
        onSelect={(v) => {
          setEditing(false);
          onSave(v);
        }}
        onBlur={() => {
          setEditing(false);
          onSave();
        }}
        placeholder="Where is it?"
        width={240}
        autoFocus
      />
    );
  }
  return (
    <MetaSeg
      text={location ?? "Add location"}
      faint={location == null}
      onPress={() => setEditing(true)}
      editLabel="Edit location"
    />
  );
}

/** Budget — "$spent of $budget · pct%" (danger when over); popover edits. */
function BudgetSeg({
  budget,
  spent,
  pct,
  value,
  onChangeText,
  onSave,
}: {
  budget: number | null;
  spent: number;
  pct: number;
  value: string;
  onChangeText: (text: string) => void;
  onSave: () => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const over = budget != null && budget > 0 && spent > budget;
  const text =
    budget != null
      ? `$${spent} of $${budget}`
      : spent > 0
        ? `$${spent} planned`
        : "Add budget";
  return (
    <>
      <MetaSeg
        innerRef={ref}
        text={text}
        faint={budget == null && spent === 0}
        danger={over}
        suffix={budget != null && budget > 0 ? `· ${pct}%` : undefined}
        onPress={open}
        editLabel="Edit budget"
      />
      <Popover visible={visible} anchor={anchor} width={240} onClose={close}>
        <View className="gap-2 p-3">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Budget
          </Text>
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder="0"
            placeholderTextColor={colors.faint}
            keyboardType="numeric"
            autoFocus
            className="rounded-md border border-border-strong bg-raised px-2.5 py-1.5 text-sm text-ink"
            style={{ outlineWidth: 0 } as any}
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-2xs text-faint">Blank clears.</Text>
            <Button
              title="Save"
              icon="check"
              size="sm"
              variant="secondary"
              onPress={() => {
                close();
                onSave();
              }}
            />
          </View>
        </View>
      </Popover>
    </>
  );
}

/* ── People row ─────────────────────────────────────────────────────────── */

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Owner + roles on one compact line. The avatar identifies the person and the
 * small label names the role — full names live in the pickers. Unassigned
 * roles fold into a single dashed "N open" chip so they stay visible without
 * shouting. Tap a chip to (re)assign; right-click / long-press to rename or
 * delete the role.
 */
function PeopleRow({
  owner,
  roleRows,
  onOpenOwner,
  onPickRole,
  onRenameRole,
  onDeleteRole,
  onAddRole,
}: {
  owner: { _id: string; name: string } | null;
  roleRows: RoleRow[];
  onOpenOwner: () => void;
  onPickRole: (role: RoleRow) => void;
  onRenameRole: (roleId: string, label: string) => void;
  onDeleteRole: (roleId: string) => void;
  onAddRole: (label: string) => void;
}) {
  const [menu, setMenu] = useState<{ roleId: string; anchor: ChipAnchor } | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const assigned = roleRows.filter((r) => r.person !== null);
  const unassigned = roleRows.filter((r) => r.person === null);
  const menuRole = roleRows.find((r) => r.roleId === menu?.roleId) ?? null;

  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <OwnerChip owner={owner} onPress={onOpenOwner} />
      {roleRows.length > 0 ? <View className="h-4 w-px bg-border-strong" /> : null}

      {assigned.map((r) => (
        <RolePill
          key={r.roleId}
          role={r}
          editing={editingId === r.roleId}
          onPress={() => onPickRole(r)}
          onOpenMenu={(anchor) => setMenu({ roleId: r.roleId, anchor })}
          onCommitRename={(label) => {
            const trimmed = label.trim();
            if (trimmed && trimmed !== r.roleLabel) onRenameRole(r.roleId, trimmed);
            setEditingId(null);
          }}
        />
      ))}

      {unassigned.length > 0 ? (
        <OpenRolesChip
          roles={unassigned}
          onPickRole={onPickRole}
          onDeleteRole={onDeleteRole}
        />
      ) : null}

      {adding ? (
        <AddRoleInput
          onCommit={(label) => {
            const trimmed = label.trim();
            if (trimmed) onAddRole(trimmed);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Pressable
          onPress={() => setAdding(true)}
          accessibilityRole="button"
          accessibilityLabel="Add role"
          className="rounded-pill border border-dashed border-border-strong bg-raised px-2.5 py-1.5 active:opacity-80 web:hover:border-accent"
        >
          <Icon name="plus" size={13} color={colors.muted} />
        </Pressable>
      )}

      <RoleChipMenu
        anchor={menu?.anchor}
        onClose={() => setMenu(null)}
        onRename={() => {
          if (menuRole) setEditingId(menuRole.roleId);
          setMenu(null);
        }}
        onDelete={() => {
          setMenu(null);
          if (menuRole) confirmDeleteRole(() => onDeleteRole(menuRole.roleId));
        }}
      />
    </View>
  );
}

/** The single accountable person — first chip of the people row, warm-tinted. */
function OwnerChip({
  owner,
  onPress,
}: {
  owner: { _id: string; name: string } | null;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        owner ? `Event owner: ${owner.name}. Change owner` : "Assign event owner"
      }
      className={`flex-row items-center gap-1.5 rounded-pill py-0.5 pl-0.5 pr-2.5 active:opacity-80 ${
        owner
          ? "bg-warn-bg web:hover:opacity-90"
          : "border border-dashed border-border-strong bg-raised py-1 pl-2"
      }`}
    >
      {owner ? (
        <>
          <Avatar name={owner.name} size={20} />
          <Text className="text-sm font-medium text-ink">
            {firstName(owner.name)}
          </Text>
          <Text className="text-xs text-muted">owner</Text>
        </>
      ) : (
        <>
          <Icon name="user-plus" size={13} color={colors.muted} />
          <Text className="text-sm text-faint">Owner</Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * One ASSIGNED role: avatar + role label (the person's full name lives in the
 * assign picker + accessibility label). Tap = reassign; context menu = rename
 * or delete; `editing` swaps the chip for an inline rename field.
 */
function RolePill({
  role,
  editing,
  onPress,
  onOpenMenu,
  onCommitRename,
}: {
  role: RoleRow;
  editing: boolean;
  onPress: () => void;
  onOpenMenu: (anchor: ChipAnchor) => void;
  onCommitRename: (label: string) => void;
}) {
  const ref = useRef<any>(null);
  const [draft, setDraft] = useState(role.roleLabel);

  if (editing) {
    return (
      <View
        ref={ref}
        className="rounded-pill border border-accent bg-raised px-2.5 py-1"
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          placeholderTextColor={colors.faint}
          onBlur={() => onCommitRename(draft)}
          onSubmitEditing={() => onCommitRename(draft)}
          blurOnSubmit
          className="text-sm text-ink"
          style={{ minWidth: 70, outlineWidth: 0 } as any}
        />
      </View>
    );
  }

  const webProps =
    Platform.OS === "web"
      ? ({
          onContextMenu: (e: any) => {
            e?.preventDefault?.();
            measureAnchor(ref.current, onOpenMenu);
          },
        } as any)
      : {};

  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => measureAnchor(ref.current, onOpenMenu)}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${role.roleLabel}: ${role.person!.name}. Reassign`}
    >
      <View
        ref={ref}
        {...webProps}
        className="flex-row items-center gap-1.5 rounded-pill border border-transparent py-0.5 pl-0.5 pr-2.5 active:opacity-80 web:hover:border-border web:hover:bg-sunken"
      >
        <Avatar name={role.person!.name} size={20} />
        <Text className="text-sm text-muted">{role.roleLabel}</Text>
      </View>
    </Pressable>
  );
}

/**
 * All UNASSIGNED roles folded into one dashed chip. One open role assigns
 * directly; several open a popover listing each (assign on tap, trash to
 * delete an unwanted one).
 */
function OpenRolesChip({
  roles,
  onPickRole,
  onDeleteRole,
}: {
  roles: RoleRow[];
  onPickRole: (role: RoleRow) => void;
  onDeleteRole: (roleId: string) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const label = roles.length === 1 ? "1 open role" : `${roles.length} open roles`;
  return (
    <>
      <Pressable
        ref={ref}
        onPress={roles.length === 1 ? () => onPickRole(roles[0]) : open}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${roles.map((r) => r.roleLabel).join(", ")}. Assign`}
        className="flex-row items-center gap-1.5 rounded-pill border border-dashed border-border-strong bg-raised px-2.5 py-1 active:opacity-80 web:hover:border-accent"
      >
        <Icon name="user-plus" size={12} color={colors.muted} />
        <Text className="text-sm text-muted">{label}</Text>
      </Pressable>
      <Popover visible={visible} anchor={anchor} width={230} onClose={close}>
        {roles.map((r) => (
          <View key={r.roleId} className="flex-row items-center">
            <Pressable
              onPress={() => {
                close();
                onPickRole(r);
              }}
              className="flex-1 flex-row items-center gap-2 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="user-plus" size={13} color={colors.muted} />
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {r.roleLabel}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                close();
                confirmDeleteRole(() => onDeleteRole(r.roleId));
              }}
              accessibilityRole="button"
              accessibilityLabel={`Delete role ${r.roleLabel}`}
              hitSlop={4}
              className="px-3 py-2.5 active:opacity-70 web:hover:bg-sunken"
            >
              <Icon name="trash-2" size={13} color={colors.faint} />
            </Pressable>
          </View>
        ))}
      </Popover>
    </>
  );
}

/** Tiny inline input shown by the "＋" chip to name a new event role. */
function AddRoleInput({
  onCommit,
  onCancel,
}: {
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <View className="rounded-pill border border-accent bg-raised px-2.5 py-1">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        placeholder="Role name"
        placeholderTextColor={colors.faint}
        onBlur={() => (draft.trim() ? onCommit(draft) : onCancel())}
        onSubmitEditing={() => onCommit(draft)}
        blurOnSubmit
        className="text-sm text-ink"
        style={{ minWidth: 80, outlineWidth: 0 } as any}
      />
    </View>
  );
}

/* ── Pace pill (the What's-next toggle) ─────────────────────────────────── */

/**
 * THE one attention element in the header. Behind → amber "▲ N overdue";
 * on pace → quiet green "✓ On pace" (good news still shows, exactly once).
 * Either way it opens the What's-next panel — the pill's count and the
 * list's OVERDUE badges are the same rows, so they can never disagree.
 */
function PacePill({
  pace,
  open,
  onToggle,
}: {
  pace?: Record<PhaseKey, PhasePace | null>;
  open: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const overdue = pace
    ? Object.values(pace).reduce((n, p) => n + (p?.overdue ?? 0), 0)
    : null;
  const behind = (overdue ?? 0) > 0;

  const label = behind
    ? `▲ ${overdue} overdue · What's next`
    : overdue !== null
      ? "✓ On pace · What's next"
      : "What's next";
  const tint = behind ? colors.warn : overdue !== null ? colors.success : colors.muted;
  const bg = behind
    ? colors.warnBg
    : hovered || open
      ? overdue !== null
        ? colors.successBg
        : colors.sunken
      : "transparent";

  return (
    <Pressable
      onPress={onToggle}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={
        behind
          ? `${overdue} items overdue. ${open ? "Hide" : "Show"} what's next`
          : `On pace. ${open ? "Hide" : "Show"} what's next`
      }
      className="flex-row items-center gap-1.5 rounded-pill border px-3 py-1 active:opacity-80"
      style={{
        backgroundColor: bg,
        borderColor: behind ? (open || hovered ? tint : colors.warnSoft) : "transparent",
      }}
    >
      <Text className="text-xs font-bold" style={{ color: tint }}>
        {label}
      </Text>
      <Icon name={open ? "chevron-up" : "chevron-down"} size={12} color={tint} />
    </Pressable>
  );
}

/* ── Tab-rail tools ─────────────────────────────────────────────────────── */

/**
 * The operational tools, pinned to the right of the tab rail: Day-of and
 * Me view stay one tap away; the occasional surfaces (Tickets, Songs, the
 * crew share link) and the destructive Delete live behind ⋯. Rendered via
 * EventTabBar's `trailing` slot.
 */
export function EventTools({
  eventId,
  onDayOf,
  onTickets,
  onSongs,
  meView,
  onToggleMeView,
  onDelete,
}: {
  eventId: string;
  onDayOf: () => void;
  onTickets: () => void;
  onSongs: () => void;
  meView: boolean;
  onToggleMeView: () => void;
  onDelete: () => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  /**
   * Copy the event's PUBLIC volunteer-briefing link (/share/<id>) — volunteers
   * view it without an account. Shows "Link copied!" in place, then closes.
   */
  function shareCrew() {
    const url =
      (typeof window !== "undefined" ? window.location.origin : "") +
      `/share/${eventId}`;
    const done = () => {
      setCopied(true);
      copyTimer.current = setTimeout(() => {
        setCopied(false);
        close();
      }, 1200);
    };
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done);
    } else if (typeof window !== "undefined") {
      window.prompt("Share this volunteer link:", url);
      close();
    }
  }

  return (
    <>
      <Button
        title="Day-of"
        icon="play"
        size="sm"
        variant="secondary"
        onPress={onDayOf}
      />
      <Button
        title="Me view"
        icon="user"
        size="sm"
        variant={meView ? "primary" : "secondary"}
        onPress={onToggleMeView}
      />
      <Pressable
        ref={ref}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel="More tools"
        className="rounded-md border border-border-strong bg-raised px-2.5 py-2 active:opacity-80 web:hover:bg-sunken"
      >
        <Icon name="more-horizontal" size={15} color={colors.ink} />
      </Pressable>
      <Popover visible={visible} anchor={anchor} width={210} onClose={close}>
        <ToolsMenuRow
          icon="tag"
          label="Tickets"
          onPress={() => {
            close();
            onTickets();
          }}
        />
        <ToolsMenuRow
          icon="music"
          label="Songs"
          onPress={() => {
            close();
            onSongs();
          }}
        />
        <ToolsMenuRow
          icon={copied ? "check" : "share-2"}
          label={copied ? "Link copied!" : "Share crew link"}
          onPress={copied ? () => {} : shareCrew}
        />
        <View className="h-px bg-border" />
        <ToolsMenuRow
          icon="trash-2"
          label="Delete event…"
          danger
          onPress={() => {
            close();
            onDelete();
          }}
        />
      </Popover>
    </>
  );
}

function ToolsMenuRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name={icon} size={14} color={danger ? colors.danger : colors.muted} />
      <Text className="text-sm" style={{ color: danger ? colors.danger : colors.ink }}>
        {label}
      </Text>
    </Pressable>
  );
}
