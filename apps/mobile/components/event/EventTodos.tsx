import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import {
  PHASE_KEYS,
  PHASE_LABELS,
  type PhaseKey,
} from "@events-os/shared";
import { Card, Icon } from "../ui";
import { colors } from "../../lib/theme";

/** One outstanding action. `tab` deep-links to the module that holds it. */
export type TodoAction = { id: string; label: string; tab?: string };

/** The phase-grouped to-dos returned by `api.events.todos`. */
export type EventTodosData = Record<PhaseKey, TodoAction[]>;

/** How many rows to show per phase before collapsing the rest behind "+N more". */
const VISIBLE_PER_PHASE = 6;

/** A soft accent dot per phase, so the four groups read as distinct stages. */
const PHASE_DOT: Record<PhaseKey, string> = {
  prePlan: colors.statPurple,
  planning: colors.info,
  dayOf: colors.warn,
  post: colors.success,
};

/**
 * The Overview "What's next" card: the outstanding work on an event, grouped by
 * phase (Pre-plan / Planning / Day-of / Post). Each action row is pressable when
 * it has a `tab` (jumps to that module tab); role/owner-assignment lines have no
 * tab and render as static text. If everything is done, an all-set state shows.
 */
export function EventTodos({
  todos,
  onOpenTab,
}: {
  todos: EventTodosData;
  onOpenTab: (tab: string) => void;
}) {
  const total = PHASE_KEYS.reduce((n, k) => n + todos[k].length, 0);

  if (total === 0) {
    return (
      <Card>
        <Text className="text-base text-muted">
          Nothing outstanding — you're all set 🎉
        </Text>
      </Card>
    );
  }

  return (
    <Card padding="none">
      {PHASE_KEYS.filter((k) => todos[k].length > 0).map((phase, i) => (
        <PhaseGroup
          key={phase}
          phase={phase}
          actions={todos[phase]}
          first={i === 0}
          onOpenTab={onOpenTab}
        />
      ))}
    </Card>
  );
}

function PhaseGroup({
  phase,
  actions,
  first,
  onOpenTab,
}: {
  phase: PhaseKey;
  actions: TodoAction[];
  first: boolean;
  onOpenTab: (tab: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? actions : actions.slice(0, VISIBLE_PER_PHASE);
  const hidden = actions.length - visible.length;

  return (
    <View className={first ? "px-4 py-3" : "border-t border-border px-4 py-3"}>
      <View className="mb-2 flex-row items-center gap-2">
        <View
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: PHASE_DOT[phase] }}
        />
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {PHASE_LABELS[phase]}
        </Text>
        <Text className="text-2xs font-semibold text-faint">
          {actions.length}
        </Text>
      </View>

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

function TodoRow({
  action,
  onOpenTab,
}: {
  action: TodoAction;
  onOpenTab: (tab: string) => void;
}) {
  const content = (
    <View className="flex-row items-center gap-2 py-1">
      <Icon name="circle" size={14} color={colors.faint} />
      <Text className="flex-1 text-sm text-ink" numberOfLines={2}>
        {action.label}
      </Text>
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
