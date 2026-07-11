import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  Icon,
  EmptyState,
  ToastView,
} from "../../../components/ui";
import { MarkdownView } from "../../../components/markdown";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  ACADEMY_CAPSTONE_SLUG,
  ACADEMY_SECTION_COUNT,
  getAcademySection,
  nextAcademySection,
  previousAcademySection,
  type AcademySection,
} from "@events-os/shared";

type QuizResult = FunctionReturnType<typeof api.academy.submitQuiz>;
type TrainingStatus = FunctionReturnType<typeof api.academy.trainingStatus>;

/**
 * ACADEMY SECTION — `/academy/<slug>`. Renders the article (markdown, same
 * MarkdownView the doc pages use), then the section's quiz: answer all
 * questions, submit, the SERVER grades, and each question comes back with its
 * correctness + the teaching explanation. Retakes keep the best score. The
 * capstone section renders the live Training Event quest checklist instead of
 * a quiz. Reading is never gated; only the quiz unlocks sequentially.
 */
export default function AcademySectionScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const section = getAcademySection(slug ?? "");

  const progress = useQuery(api.academy.myProgress);
  const markRead = useMutation(api.academy.markRead);

  // Stamp "read" once per section visit (first open wins server-side).
  useEffect(() => {
    if (section) void markRead({ sectionSlug: section.slug }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section?.slug]);

  if (!section) {
    return (
      <Screen>
        <EmptyState
          icon="book-open"
          title="Section not found"
          message="This Academy section doesn't exist."
          action={
            <Button
              title="Back to Academy"
              variant="secondary"
              onPress={() => router.replace("/academy")}
            />
          }
        />
      </Screen>
    );
  }
  if (progress === undefined) return <Screen loading />;

  const state = progress.sections.find((s) => s.slug === section.slug);
  const next = nextAcademySection(section.slug);
  const isCapstone = section.slug === ACADEMY_CAPSTONE_SLUG;

  return (
    <Screen maxWidth={820}>
      <Stack.Screen options={{ title: section.title }} />

      {/* Header: back + position + state */}
      <View className="mb-2 flex-row items-center gap-2">
        <Pressable
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/academy");
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to Academy"
          className="rounded-md p-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="arrow-left" size={18} color={colors.muted} />
        </Pressable>
        <Text className="text-xs font-bold uppercase tracking-wider text-accent">
          Academy · Section {section.order} of {ACADEMY_SECTION_COUNT}
        </Text>
        <View className="flex-1" />
        {state?.passed ? (
          <Badge
            label={isCapstone ? "Complete 🎉" : "Quiz passed ✓"}
            tone="success"
          />
        ) : null}
      </View>

      <Text className="font-display text-3xl text-ink">{section.title}</Text>
      <Text className="mt-1 text-base text-muted">
        {section.subtitle} · {section.minutes} min read
      </Text>

      {/* The article */}
      <View className="mt-4">
        <MarkdownView value={section.body} />
      </View>

      {/* Quiz or capstone quest checklist */}
      {isCapstone ? (
        <Capstone complete={state?.passed === true} />
      ) : (
        <Quiz
          section={section}
          unlocked={state?.unlocked !== false}
          passed={state?.passed === true}
          bestScore={state?.quizBestScore ?? null}
        />
      )}

      {/* Next section */}
      <View className="mb-4 mt-8 flex-row justify-end">
        {next ? (
          <Button
            title={`Next: ${next.title}`}
            variant="secondary"
            icon="arrow-right"
            onPress={() => router.push(`/academy/${next.slug}`)}
          />
        ) : (
          <Button
            title="Back to Academy"
            variant="secondary"
            icon="award"
            onPress={() => router.replace("/academy")}
          />
        )}
      </View>
    </Screen>
  );
}

// ── Quiz ──────────────────────────────────────────────────────────────────────

function Quiz({
  section,
  unlocked,
  passed,
  bestScore,
}: {
  section: AcademySection;
  unlocked: boolean;
  passed: boolean;
  bestScore: number | null;
}) {
  const submitQuiz = useMutation(api.academy.submitQuiz);
  const { run, toast, dismiss } = useActionRunner();
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fresh state when navigating between sections (the route reuses this
  // component instance across slugs).
  useEffect(() => {
    setAnswers({});
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.slug]);

  const total = section.quiz.length;
  const answered = Object.keys(answers).length;
  const previous = previousAcademySection(section.slug);

  if (!unlocked) {
    return (
      <Card padding="md" className="mt-6">
        <View className="flex-row items-center gap-2.5">
          <Icon name="lock" size={16} color={colors.muted} />
          <Text className="flex-1 text-sm text-muted">
            The quiz unlocks once you pass{" "}
            <Text className="font-semibold text-ink">
              {previous?.title ?? "the previous section"}
            </Text>
            . Reading ahead is always allowed.
          </Text>
        </View>
      </Card>
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await run(
        () =>
          submitQuiz({
            sectionSlug: section.slug,
            answers: section.quiz.map((_q, i) => answers[i] ?? -1),
          }),
        { errorTitle: "Couldn't grade the quiz" },
      );
      if (res) setResult(res);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="mt-6">
      <ToastView toast={toast} onDismiss={dismiss} />
      <View className="mb-3 flex-row items-center gap-2">
        <Icon name="help-circle" size={16} color={colors.accent} />
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">
          Check your understanding
        </Text>
        <View className="flex-1" />
        {passed ? (
          <Badge label="Passed ✓" tone="success" />
        ) : bestScore != null ? (
          <Badge label={`Best ${bestScore}/${total}`} tone="neutral" />
        ) : null}
      </View>

      <View className="gap-3">
        {section.quiz.map((q, qi) => {
          const graded = result?.results[qi] ?? null;
          return (
            <Card key={qi} padding="md">
              <View className="flex-row items-start gap-2">
                {graded ? (
                  <View className="pt-0.5">
                    <Icon
                      name={graded.correct ? "check-circle" : "x-circle"}
                      size={16}
                      color={graded.correct ? colors.success : colors.danger}
                    />
                  </View>
                ) : null}
                <Text className="flex-1 text-base font-semibold text-ink">
                  {qi + 1}. {q.prompt}
                </Text>
              </View>
              <View className="mt-3 gap-1.5">
                {q.options.map((opt, oi) => {
                  const selected = answers[qi] === oi;
                  const showCorrect = graded != null && oi === graded.correctIndex;
                  const showWrong =
                    graded != null && selected && !graded.correct;
                  return (
                    <Pressable
                      key={oi}
                      disabled={graded != null}
                      onPress={() =>
                        setAnswers((prev) => ({ ...prev, [qi]: oi }))
                      }
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      className={`flex-row items-center gap-2.5 rounded-md border px-3 py-2 ${
                        showCorrect
                          ? "border-success bg-success-bg"
                          : showWrong
                            ? "border-danger bg-danger-bg"
                            : selected
                              ? "border-accent bg-accent-soft"
                              : "border-border active:bg-sunken web:hover:bg-sunken"
                      }`}
                    >
                      <View
                        className={`h-4 w-4 items-center justify-center rounded-pill border ${
                          selected || showCorrect
                            ? "border-accent"
                            : "border-border-strong"
                        }`}
                      >
                        {selected ? (
                          <View className="h-2 w-2 rounded-pill bg-accent" />
                        ) : null}
                      </View>
                      <Text
                        className={`flex-1 text-sm ${
                          showCorrect
                            ? "font-semibold text-success"
                            : showWrong
                              ? "font-semibold text-danger"
                              : selected
                                ? "font-semibold text-ink"
                                : "text-ink"
                        }`}
                      >
                        {opt}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {graded ? (
                <View className="mt-3 rounded-md bg-sunken px-3 py-2.5">
                  <Text className="text-sm leading-5 text-muted">
                    {graded.explanation}
                  </Text>
                </View>
              ) : null}
            </Card>
          );
        })}
      </View>

      {/* Submit / results / retake */}
      <View className="mt-4">
        {result == null ? (
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-sm text-muted">
              {answered}/{total} answered
            </Text>
            <Button
              title="Submit answers"
              icon="check"
              disabled={answered < total}
              loading={submitting}
              onPress={handleSubmit}
            />
          </View>
        ) : (
          <Card padding="md">
            <View className="flex-row items-center justify-between gap-3">
              <View className="flex-1">
                <Text className="text-base font-semibold text-ink">
                  {result.passed
                    ? "Perfect — section complete 🎉"
                    : `${result.score}/${result.total} — read the explanations and go again`}
                </Text>
                <Text className="mt-0.5 text-sm text-muted">
                  {result.passed
                    ? "The next section is unlocked."
                    : "Retakes keep your best score; a perfect run passes the section."}
                </Text>
              </View>
              <Button
                title="Retake"
                variant="secondary"
                icon="rotate-ccw"
                onPress={() => {
                  setAnswers({});
                  setResult(null);
                }}
              />
            </View>
          </Card>
        )}
      </View>
    </View>
  );
}

// ── Capstone (Training Event quest checklist) ─────────────────────────────────

function Capstone({ complete }: { complete: boolean }) {
  const router = useRouter();
  const training: TrainingStatus | undefined = useQuery(
    api.academy.trainingStatus,
  );
  const startTraining = useMutation(api.academy.startTraining);
  const { run, toast, dismiss } = useActionRunner();
  const [starting, setStarting] = useState(false);

  if (training === undefined) return null;

  async function handleStart() {
    setStarting(true);
    try {
      await run(() => startTraining({}), {
        errorTitle: "Couldn't start training",
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <View className="mt-6">
      <ToastView toast={toast} onDismiss={dismiss} />
      <View className="mb-3 flex-row items-center gap-2">
        <Icon name="flag" size={16} color={colors.accent} />
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">
          Your quests
        </Text>
        <View className="flex-1" />
        {training ? (
          <Badge
            label={`${training.doneCount}/${training.total} done`}
            tone={training.complete ? "success" : "accent"}
          />
        ) : null}
      </View>

      {training == null ? (
        <Card padding="lg">
          <Text className="text-base font-semibold text-ink">
            Ready to run the drills?
          </Text>
          <Text className="mt-1 text-sm leading-5 text-muted">
            Start training to get your own sandbox event — real workstreams,
            real rows, invisible to the rest of the chapter.
          </Text>
          <View className="mt-3 flex-row">
            <Button
              title="Start training"
              icon="play"
              loading={starting}
              onPress={handleStart}
            />
          </View>
        </Card>
      ) : (
        <>
          {/* Live quest checklist — rows tick as they hit terminal statuses
              in the training event (reactive query, no refresh needed). */}
          <Card padding="md">
            <View className="gap-2.5">
              {training.quests.map((q) => (
                <View key={String(q.itemId)} className="flex-row items-center gap-2.5">
                  <Icon
                    name={q.done ? "check-circle" : "circle"}
                    size={16}
                    color={q.done ? colors.success : colors.faint}
                  />
                  <Text
                    className={`flex-1 text-sm ${
                      q.done ? "text-muted line-through" : "text-ink"
                    }`}
                    numberOfLines={2}
                  >
                    {q.title}
                  </Text>
                  <Badge
                    label={q.module === "supplies" ? "Supplies" : "Planning Doc"}
                    tone="neutral"
                  />
                </View>
              ))}
            </View>
          </Card>

          {training.complete || complete ? (
            <Card padding="lg" className="mt-3">
              <View className="flex-row items-center gap-2.5">
                <Icon name="award" size={20} color={colors.success} />
                <Text className="flex-1 text-base font-semibold text-ink">
                  You've run the drills — the real thing works exactly the same
                  way. 🎉
                </Text>
              </View>
              <Text className="mt-1.5 text-sm leading-5 text-muted">
                Every move you just made — roles, statuses, offsets, readiness,
                the assistant — transfers one-to-one to your first real event.
              </Text>
            </Card>
          ) : null}

          <View className="mt-3 flex-row">
            <Button
              title="Open training event"
              icon="external-link"
              variant={training.complete ? "secondary" : "primary"}
              onPress={() =>
                router.push(`/event/${training.eventId}`)
              }
            />
          </View>
        </>
      )}
    </View>
  );
}
