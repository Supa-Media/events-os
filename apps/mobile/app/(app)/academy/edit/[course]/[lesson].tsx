import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  builtInChangedSince,
  builtInSection,
  draftSection,
  sectionFingerprint,
  toEditedSection,
  type CourseEdit,
  type EditedSection,
} from "@events-os/shared";
import { Button, Card, EmptyState, Icon, Pill, Screen, TextField } from "../../../../../components/ui";
import { ArticleBlocks } from "../../../../../components/academy/ArticleBlocks";
import { BlockEditor } from "../../../../../components/academy/editor/BlockEditor";
import { EditorBanner, SaveStatus } from "../../../../../components/academy/editor/EditorBits";
import { QuizEditor } from "../../../../../components/academy/editor/QuizEditor";
import { useCourseDraft } from "../../../../../components/academy/editor/useCourseDraft";
import { colors } from "../../../../../lib/theme";

/**
 * LESSON EDITOR — `/academy/edit/<course>/<lesson>`. One lesson of the
 * course's shared draft: its title, read time, article and quiz, with a
 * preview that renders exactly what learners will see. Changes autosave into
 * the course draft; nothing is live until the course is published.
 */
export default function LessonEditorScreen() {
  const router = useRouter();
  const { course: courseSlug = "", lesson: lessonSlug = "" } = useLocalSearchParams<{
    course: string;
    lesson: string;
  }>();
  const canEdit = useQuery(api.academyEditor.canEditCourses);
  if (canEdit === undefined) return <Screen loading />;
  if (!canEdit) {
    return (
      <Screen>
        <EmptyState
          icon="lock"
          title="You can't edit courses"
          message='Editing the Academy takes the "Edit Academy courses" power.'
          action={
            <Button
              title="Back to the Academy"
              variant="secondary"
              onPress={() => router.replace("/academy")}
            />
          }
        />
      </Screen>
    );
  }
  return <LessonEditor courseSlug={courseSlug} lessonSlug={lessonSlug} />;
}

function LessonEditor({ courseSlug, lessonSlug }: { courseSlug: string; lessonSlug: string }) {
  const router = useRouter();
  const draft = useCourseDraft(courseSlug);
  const { catalog, edit } = draft;
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  if (!draft.state || !catalog) return <Screen loading />;
  const shown = edit ? draftSection(edit, lessonSlug, catalog) : undefined;
  const back = async () => {
    await draft.flush();
    router.replace(`/academy/edit/${courseSlug}`);
  };
  if (!edit || !shown || !edit.moduleSlugs.includes(lessonSlug)) {
    return (
      <Screen>
        <EmptyState
          icon="book-open"
          title="Lesson not in this course"
          message="It may have been removed or moved to another course in the draft."
          action={<Button title="Back to the course" variant="secondary" onPress={() => void back()} />}
        />
      </Screen>
    );
  }

  const base = builtInSection(lessonSlug);
  const isCapstone = base?.capstone != null;
  const edited = edit.sections.find((s) => s.slug === lessonSlug);

  /** Change this lesson, copying it into the draft on its first change. */
  const change = (patch: (s: EditedSection) => EditedSection) =>
    draft.update((prev: CourseEdit) => {
      const current =
        prev.sections.find((s) => s.slug === lessonSlug) ??
        toEditedSection(draftSection(prev, lessonSlug, catalog) ?? shown);
      const next = patch(current);
      const exists = prev.sections.some((s) => s.slug === lessonSlug);
      return {
        ...prev,
        sections: exists
          ? prev.sections.map((s) => (s.slug === lessonSlug ? next : s))
          : [...prev.sections, next],
      };
    });
  /** Drop this lesson's edits so it shows its built-in version again. */
  const useBuiltIn = () =>
    draft.update((prev) => ({
      ...prev,
      sections: prev.sections.filter((s) => s.slug !== lessonSlug),
    }));
  const keepMine = () =>
    change((s) => (base ? { ...s, baseFingerprint: sectionFingerprint(base) } : s));

  return (
    <Screen maxWidth={860}>
      <Stack.Screen options={{ title: `Editing ${shown.title}` }} />
      <View className="mb-4 flex-row flex-wrap items-center gap-2">
        <Pressable
          onPress={() => void back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to the course editor"
          className="rounded-md p-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="arrow-left" size={18} color={colors.muted} />
        </Pressable>
        <View className="min-w-[180px] flex-1">
          <Text className="text-xs font-bold uppercase tracking-wider text-accent">
            {`Editing lesson · ${edit.course.title}`}
          </Text>
          <Text className="font-display text-2xl text-ink" numberOfLines={1}>
            {shown.title || "Untitled lesson"}
          </Text>
        </View>
        <SaveStatus saveState={draft.saveState} hasDraft={draft.hasDraft} isReset={draft.isReset} />
        <Button title="Done" size="sm" variant="secondary" onPress={() => void back()} />
      </View>

      {draft.saveError ? (
        <EditorBanner tone="danger" text={`Your last change didn't save: ${draft.saveError}`} />
      ) : null}
      {edited && builtInChangedSince(edited) ? (
        <EditorBanner text="The built-in version of this lesson changed in the app since it was edited here. Your edited version is what learners see.">
          <Button title="Use the built-in version" size="sm" variant="secondary" onPress={useBuiltIn} />
          <Button title="Keep mine" size="sm" variant="ghost" onPress={keepMine} />
        </EditorBanner>
      ) : null}

      <View className="mb-4 flex-row gap-1.5">
        <Pill label="Edit" selected={tab === "edit"} onPress={() => setTab("edit")} />
        <Pill label="Preview" selected={tab === "preview"} onPress={() => setTab("preview")} />
      </View>

      {tab === "preview" ? (
        <Preview section={shown} isCapstone={isCapstone} />
      ) : (
        <View className="gap-4">
          <Card padding="md">
            <TextField
              label="Title"
              value={shown.title}
              onChangeText={(title) => change((s) => ({ ...s, title }))}
            />
            <TextField
              label="Subtitle"
              value={shown.subtitle}
              onChangeText={(subtitle) => change((s) => ({ ...s, subtitle }))}
            />
            <TextField
              label="Read time"
              suffix="min"
              keyboardType="number-pad"
              value={String(shown.minutes)}
              onChangeText={(t) => {
                const minutes = Number.parseInt(t.replace(/\D/g, ""), 10);
                change((s) => ({ ...s, minutes: Number.isFinite(minutes) ? minutes : 0 }));
              }}
            />
            {edited && base ? (
              <View className="flex-row">
                <Button
                  title="Undo all edits to this lesson"
                  icon="rotate-ccw"
                  size="sm"
                  variant="ghost"
                  onPress={useBuiltIn}
                />
              </View>
            ) : null}
          </Card>

          <Text className="text-base font-semibold text-ink">Article</Text>
          <BlockEditor
            blocks={shown.blocks}
            onChange={(blocks) => change((s) => ({ ...s, blocks }))}
          />

          <Text className="mt-2 text-base font-semibold text-ink">Quiz</Text>
          {isCapstone ? (
            <Card padding="md">
              <Text className="text-sm text-muted">
                This lesson ends in a training event instead of a quiz. Its steps are built
                into the app, so they can't be changed here; the article above can.
              </Text>
            </Card>
          ) : (
            <>
              <Text className="-mt-2 text-sm text-muted">
                Learners must get every question right to pass this lesson.
              </Text>
              <QuizEditor quiz={shown.quiz} onChange={(quiz) => change((s) => ({ ...s, quiz }))} />
            </>
          )}
        </View>
      )}
    </Screen>
  );
}

/** The lesson as learners will see it, quiz answers marked. */
function Preview({
  section,
  isCapstone,
}: {
  section: { slug: string; title: string; subtitle: string; minutes: number } & Pick<
    EditedSection,
    "blocks" | "quiz"
  >;
  isCapstone: boolean;
}) {
  return (
    <View className="gap-4">
      <View>
        <Text className="font-display text-3xl text-ink">{section.title}</Text>
        {section.subtitle ? (
          <Text className="mt-1 text-base text-muted">{section.subtitle}</Text>
        ) : null}
        <Text className="mt-1 text-xs text-faint">{`${section.minutes} min read`}</Text>
      </View>
      <ArticleBlocks blocks={section.blocks} sectionKey={`preview-${section.slug}`} />
      {isCapstone ? null : (
        <Card padding="md">
          <Text className="mb-2 text-base font-semibold text-ink">Quiz</Text>
          <View className="gap-3">
            {section.quiz.map((q, i) => (
              <View key={i} className="gap-1">
                <Text className="text-sm font-semibold text-ink">{`${i + 1}. ${q.prompt}`}</Text>
                {q.options.map((o, j) => (
                  <Text
                    key={j}
                    className={`text-sm ${j === q.answerIndex ? "font-semibold text-success" : "text-muted"}`}
                  >
                    {`${j === q.answerIndex ? "✓" : "·"} ${o}`}
                  </Text>
                ))}
                <Text className="text-xs text-muted">{q.explanation}</Text>
              </View>
            ))}
          </View>
        </Card>
      )}
    </View>
  );
}
