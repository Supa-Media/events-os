import { useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  PageHeader,
  Card,
  Button,
  Badge,
  Icon,
  SectionHeader,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  ACADEMY_CAPSTONE_SLUG,
  ACADEMY_SECTIONS,
  type AcademySection,
} from "@events-os/shared";

type MyProgress = FunctionReturnType<typeof api.academy.myProgress>;
type SectionProgress = MyProgress["sections"][number];
type TrainingStatus = FunctionReturnType<typeof api.academy.trainingStatus>;

/**
 * THE ACADEMY HUB — the ordered curriculum as a completion path. Every section
 * is always readable (adults skim); only the quiz-passed "complete" state
 * unlocks sequentially, and the server enforces that gate. The capstone row
 * doubles as the Training Event launcher.
 */
export default function AcademyScreen() {
  const router = useRouter();
  const progress = useQuery(api.academy.myProgress);
  const training = useQuery(api.academy.trainingStatus);
  const chapter = useQuery(api.academy.chapterProgress);
  const startTraining = useMutation(api.academy.startTraining);
  const [starting, setStarting] = useState(false);
  const { run, toast, dismiss } = useActionRunner();

  if (progress === undefined || training === undefined) {
    return <Screen loading />;
  }

  const bySlug = new Map(progress.sections.map((s) => [s.slug, s]));

  async function handleStart() {
    setStarting(true);
    try {
      const res = await run(() => startTraining({}), {
        errorTitle: "Couldn't start training",
      });
      if (res) router.push(`/academy/${ACADEMY_CAPSTONE_SLUG}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Screen maxWidth={860}>
      <ToastView toast={toast} onDismiss={dismiss} />
      <PageHeader
        eyebrow="Academy"
        title="Academy"
        subtitle="Learn to run events nobody has to rescue."
      />

      {/* Overall path progress */}
      <Card padding="md">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-ink">
            {progress.completed} of {progress.total} sections complete
          </Text>
          {progress.completed === progress.total ? (
            <Badge label="Fully trained 🎉" tone="success" icon="award" />
          ) : null}
        </View>
        <View className="mt-2.5 h-2 overflow-hidden rounded-pill bg-sunken">
          <View
            className="h-full rounded-pill bg-accent"
            style={{
              width: `${Math.round((progress.completed / progress.total) * 100)}%`,
            }}
          />
        </View>
      </Card>

      {/* The curriculum path */}
      <SectionHeader title="The curriculum" count={ACADEMY_SECTIONS.length} />
      <View className="gap-3">
        {ACADEMY_SECTIONS.map((section) => {
          const state = bySlug.get(section.slug);
          return section.slug === ACADEMY_CAPSTONE_SLUG ? (
            <CapstoneRow
              key={section.slug}
              section={section}
              state={state}
              training={training}
              starting={starting}
              onStart={handleStart}
              onOpen={() =>
                router.push(`/academy/${section.slug}`)
              }
            />
          ) : (
            <SectionRow
              key={section.slug}
              section={section}
              state={state}
              onPress={() => router.push(`/academy/${section.slug}`)}
            />
          );
        })}
      </View>

      {/* Who's trained — managers/admins only (the server returns null
          otherwise, mirroring how the Team/Duties nav gates). */}
      {chapter ? (
        <>
          <SectionHeader title="Who's trained" count={chapter.people.length} />
          <Card padding="md">
            <View className="gap-2.5">
              {chapter.people.map((p) => (
                <View
                  key={String(p.personId)}
                  className="flex-row items-center gap-3"
                >
                  <Text
                    className="flex-1 text-sm font-medium text-ink"
                    numberOfLines={1}
                  >
                    {p.name}
                  </Text>
                  <View className="h-1.5 w-28 overflow-hidden rounded-pill bg-sunken">
                    <View
                      className={`h-full rounded-pill ${
                        p.completed === p.total ? "bg-success" : "bg-accent"
                      }`}
                      style={{
                        width: `${Math.round((p.completed / p.total) * 100)}%`,
                      }}
                    />
                  </View>
                  <Text className="w-10 text-right text-xs font-semibold text-muted">
                    {p.completed}/{p.total}
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

/** The numbered circle at the head of each curriculum row. */
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

function SectionRow({
  section,
  state,
  onPress,
}: {
  section: AcademySection;
  state: SectionProgress | undefined;
  onPress: () => void;
}) {
  const locked = state ? !state.unlocked : section.order > 1;
  return (
    <Card padding="md" onPress={onPress}>
      <View className="flex-row items-center gap-3.5">
        <OrderMark
          order={section.order}
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

function CapstoneRow({
  section,
  state,
  training,
  starting,
  onStart,
  onOpen,
}: {
  section: AcademySection;
  state: SectionProgress | undefined;
  training: TrainingStatus;
  starting: boolean;
  onStart: () => void;
  onOpen: () => void;
}) {
  const complete = state?.passed === true;
  const locked = state ? !state.unlocked : true;
  return (
    <Card padding="md" onPress={onOpen}>
      <View className="flex-row items-center gap-3.5">
        <OrderMark order={section.order} passed={complete} locked={locked} />
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>
            {section.title}
          </Text>
          <Text className="mt-0.5 text-sm text-muted" numberOfLines={2}>
            {section.subtitle}
          </Text>
          {training && !complete ? (
            <Text className="mt-0.5 text-xs font-semibold text-accent">
              {training.doneCount}/{training.total} quests done
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-1.5">
          {complete ? (
            <Badge label="Complete 🎉" tone="success" />
          ) : training ? (
            <Badge label="In progress" tone="accent" icon="play" />
          ) : (
            <Badge label="Not started" tone="neutral" />
          )}
          {!complete ? (
            training ? (
              <Button title="Resume" size="sm" variant="secondary" onPress={onOpen} />
            ) : (
              <Button
                title="Start training"
                size="sm"
                icon="play"
                loading={starting}
                onPress={onStart}
              />
            )
          ) : null}
        </View>
      </View>
    </Card>
  );
}
