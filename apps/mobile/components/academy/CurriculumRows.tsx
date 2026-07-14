import { View, Text } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { Card, Button, Badge, Icon, type BadgeTone } from "../ui";
import { colors } from "../../lib/theme";
import type { AcademyLevel, AcademySection } from "@events-os/shared";

/** One section's slice of `myProgress` — the state a curriculum row renders. */
export type SectionProgress = FunctionReturnType<
  typeof api.academy.myProgress
>["sections"][number];

/** A course level's chip label + tone — the founder's four-tier scale. */
const LEVEL_META: Record<AcademyLevel, { label: string; tone: BadgeTone }> = {
  beginner: { label: "Beginner", tone: "success" },
  intermediate: { label: "Intermediate", tone: "accent" },
  advanced: { label: "Advanced", tone: "warn" },
  leader: { label: "Leader", tone: "lavender" },
};

/** The difficulty chip a course card / course header shows. */
export function LevelChip({ level }: { level: AcademyLevel }) {
  const m = LEVEL_META[level];
  return <Badge label={m.label} tone={m.tone} />;
}

/**
 * The numbered circle at the head of each curriculum row. `order` is a DISPLAY
 * number the caller supplies — the course page passes the module's 1-based
 * position within its course, not the section's global curriculum order.
 */
function OrderMark({
  order,
  passed,
  locked,
}: {
  order: number;
  passed: boolean;
  locked: boolean;
}) {
  if (passed) {
    return (
      <View className="h-9 w-9 items-center justify-center rounded-pill bg-success-bg">
        <Icon name="check" size={16} color={colors.success} />
      </View>
    );
  }
  return (
    <View
      className={`h-9 w-9 items-center justify-center rounded-pill ${
        locked ? "bg-sunken" : "bg-accent-soft"
      }`}
    >
      <Text
        className={`text-sm font-bold ${locked ? "text-faint" : "text-accent"}`}
      >
        {order}
      </Text>
    </View>
  );
}

/** State badge: quiz passed ✓ · read · not started. */
function StateBadge({ state }: { state: SectionProgress | undefined }) {
  if (state?.passed) return <Badge label="Quiz passed ✓" tone="success" />;
  if (state?.readAt != null) return <Badge label="Read" tone="info" />;
  return <Badge label="Not started" tone="neutral" />;
}

/**
 * A quiz-section row. Always readable (the whole card taps through); only the
 * quiz-passed "complete" state unlocks sequentially, and the server gates that
 * — the UI just reflects it. `order` is the display number (course position).
 */
export function SectionRow({
  section,
  state,
  order,
  onPress,
}: {
  section: AcademySection;
  state: SectionProgress | undefined;
  order: number;
  onPress: () => void;
}) {
  const locked = state ? !state.unlocked : order > 1;
  return (
    <Card padding="md" onPress={onPress}>
      <View className="flex-row items-center gap-3.5">
        <OrderMark
          order={order}
          passed={state?.passed === true}
          locked={locked}
        />
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>
            {section.title}
          </Text>
          <Text className="mt-0.5 text-sm text-muted" numberOfLines={2}>
            {section.subtitle} · {section.minutes} min read
          </Text>
          {state?.quizBestScore != null && !state.passed ? (
            <Text className="mt-0.5 text-xs text-faint">
              Best quiz score {state.quizBestScore}/{state.quizTotal}
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-1.5">
          <StateBadge state={state} />
          {locked && !state?.passed ? (
            <View className="flex-row items-center gap-1">
              <Icon name="lock" size={11} color={colors.faint} />
              <Text className="text-2xs text-faint">Quiz locked · readable</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/**
 * The capstone row. Locked until the previous module in the course is passed
 * (the server gates too — the UI just shouldn't offer it). All interaction
 * routes to the capstone module screen, which owns the single Start-training
 * flow. `order` is the display number (course position).
 */
export function CapstoneRow({
  section,
  state,
  order,
  training,
  onOpen,
}: {
  section: AcademySection;
  state: SectionProgress | undefined;
  order: number;
  training: { questsDone: number; questsTotal: number } | null;
  onOpen: () => void;
}) {
  const complete = state?.passed === true;
  const locked = !complete && (state ? !state.unlocked : true);
  return (
    <Card padding="md" onPress={locked ? undefined : onOpen}>
      <View className="flex-row items-center gap-3.5">
        <OrderMark order={order} passed={complete} locked={locked} />
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text
              className="shrink text-base font-semibold text-ink"
              numberOfLines={1}
            >
              {section.title}
            </Text>
            {section.optional ? <Badge label="Bonus" tone="info" /> : null}
          </View>
          <Text className="mt-0.5 text-sm text-muted" numberOfLines={2}>
            {section.subtitle}
          </Text>
          {training && !complete ? (
            <Text className="mt-0.5 text-xs font-semibold text-accent">
              {training.questsDone}/{training.questsTotal} quests done
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-1.5">
          {complete ? (
            <Badge label="Complete 🎉" tone="success" />
          ) : locked ? (
            <Badge label="Locked" tone="neutral" icon="lock" />
          ) : training ? (
            <Badge label="In progress" tone="accent" icon="play" />
          ) : (
            <Badge label="Not started" tone="neutral" />
          )}
          {locked ? (
            <View className="flex-row items-center gap-1">
              <Icon name="lock" size={11} color={colors.faint} />
              <Text className="text-2xs text-faint">
                Pass the previous module to unlock
              </Text>
            </View>
          ) : !complete ? (
            <Button
              title={training ? "Resume" : "Start training"}
              size="sm"
              variant={training ? "secondary" : "primary"}
              icon={training ? undefined : "play"}
              onPress={onOpen}
            />
          ) : null}
        </View>
      </View>
    </Card>
  );
}
