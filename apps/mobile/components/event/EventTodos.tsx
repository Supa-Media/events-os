import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { PHASE_KEYS, PHASE_LABELS, type PhaseKey } from "@events-os/shared";
import { Card, Icon } from "../ui";
import { colors } from "../../lib/theme";

/** A risk tier for one action: how urgently its effective due date demands it. */
export type TodoRisk = "overdue" | "soon" | null;

/** One outstanding action. `tab` deep-links to the module that holds it. */
export type TodoAction = {
  id: string;
  label: string;
  tab?: string;
  risk: TodoRisk;
  due?: number | null;
  phase: PhaseKey;
};

/** The current-user action list returned by `api.events.todos`. */
export type EventTodosData = {
  yours: TodoAction[];
  overseeing: TodoAction[];
};

/** How many rows to show per group before collapsing the rest behind "+N more". */
const VISIBLE_PER_GROUP = 8;

/**
 * The Overview "What's next" card — the current user's focused action list on
 * this event, in two groups:
 *
 *   Yours      — incomplete things the caller owns (always shown).
 *   Overseeing — incomplete things the caller oversees, only when at risk.
 *
 * Overdue rows are tinted red (red left border + red label) so they stand out in
 * either group. Rows with a `tab` jump to that module tab; setup rows (no tab)
 * render as static text. If both groups are empty, a calm all-clear state shows.
 */
export function EventTodos({
  todos,
  onOpenTab,
}: {
  todos: EventTodosData;
  onOpenTab: (tab: string) => void;
}) {
  const total = todos.yours.length + todos.overseeing.length;

  if (total === 0) {
    return (
      <Card>
        <Text className="text-base text-muted">
          Nothing needs you right now ✓
        </Text>
      </Card>
    );
  }

  return (
    <Card padding="none">
      {todos.yours.length > 0 ? (
        <TodoGroup
          title="Yours"
          actions={todos.yours}
          first
          onOpenTab={onOpenTab}
        />
      ) : null}
      {todos.overseeing.length > 0 ? (
        <TodoGroup
          title="Overseeing"
          actions={todos.overseeing}
          first={todos.yours.length === 0}
          onOpenTab={onOpenTab}
        />
      ) : null}
    </Card>
  );
}

function TodoGroup({
  title,
  actions,
  first,
  onOpenTab,
}: {
  title: string;
  actions: TodoAction[];
  first: boolean;
  onOpenTab: (tab: string) => void;
}) {
  // Sub-group by phase (Pre-plan → Planning → Day-of → Post). Within a phase the
  // backend order already puts overdue/soon first.
  const byPhase = new Map<PhaseKey, TodoAction[]>();
  for (const a of actions) {
    const arr = byPhase.get(a.phase) ?? [];
    arr.push(a);
    byPhase.set(a.phase, arr);
  }

  return (
    <View className={first ? "px-4 py-3" : "border-t border-border px-4 py-3"}>
      <View className="mb-1 flex-row items-center gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {title}
        </Text>
        <Text className="text-2xs font-semibold text-faint">
          {actions.length}
        </Text>
      </View>

      {PHASE_KEYS.filter((p) => byPhase.has(p)).map((p) => (
        <PhaseSubGroup
          key={p}
          phase={p}
          actions={byPhase.get(p) as TodoAction[]}
          onOpenTab={onOpenTab}
        />
      ))}
    </View>
  );
}

/** One phase's actions within an ownership group, capped with "+N more". */
function PhaseSubGroup({
  phase,
  actions,
  onOpenTab,
}: {
  phase: PhaseKey;
  actions: TodoAction[];
  onOpenTab: (tab: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? actions : actions.slice(0, VISIBLE_PER_GROUP);
  const hidden = actions.length - visible.length;

  return (
    <View className="mt-2">
      <Text className="mb-1 pl-0.5 text-2xs font-semibold uppercase tracking-wider text-faint">
        {PHASE_LABELS[phase]}
      </Text>
      <View className="gap-0.5">
        {visible.map((a) => (
          <TodoRow key={a.id} action={a} onOpenTab={onOpenTab} />
        ))}
        {hidden > 0 ? (
          <Pressable
            onPress={() => setExpanded(true)}
            className="rounded-md py-1.5 active:opacity-70 web:hover:bg-sunken"
          >
            <Text className="pl-6 text-xs font-semibold text-accent">
              +{hidden} more
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function RiskChip({ risk }: { risk: TodoRisk }) {
  if (risk === "overdue") {
    return (
      <View className="rounded-full bg-danger-bg px-2 py-0.5">
        <Text className="text-2xs font-bold uppercase tracking-wide text-danger">
          Overdue
        </Text>
      </View>
    );
  }
  if (risk === "soon") {
    return (
      <View className="rounded-full bg-warn-bg px-2 py-0.5">
        <Text className="text-2xs font-bold uppercase tracking-wide text-warn">
          Due soon
        </Text>
      </View>
    );
  }
  return null;
}

function TodoRow({
  action,
  onOpenTab,
}: {
  action: TodoAction;
  onOpenTab: (tab: string) => void;
}) {
  const overdue = action.risk === "overdue";

  // Overdue rows get a red left border + red label so they clearly stand out.
  const content = (
    <View
      className={`flex-row items-center gap-2 py-1 ${
        overdue ? "border-l-2 border-danger pl-2" : ""
      }`}
    >
      <Icon
        name="circle"
        size={14}
        color={overdue ? colors.danger : colors.faint}
      />
      <Text
        className={`flex-1 text-sm ${overdue ? "text-danger" : "text-ink"}`}
        numberOfLines={2}
      >
        {action.label}
      </Text>
      <RiskChip risk={action.risk} />
      {action.tab ? (
        <Icon name="chevron-right" size={15} color={colors.faint} />
      ) : null}
    </View>
  );

  if (!action.tab) {
    return content;
  }

  const tab = action.tab;
  return (
    <Pressable
      onPress={() => onOpenTab(tab)}
      className="-mx-2 rounded-md px-2 active:opacity-70 web:hover:bg-sunken"
    >
      {content}
    </Pressable>
  );
}
