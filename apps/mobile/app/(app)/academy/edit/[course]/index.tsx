import { useMemo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { courseEditProblems, describeCourseEditChanges } from "@events-os/shared";
import { Button, EmptyState, Icon, Screen, ToastView } from "../../../../../components/ui";
import { CourseDetailsCard } from "../../../../../components/academy/editor/CourseDetailsCard";
import { DraftPanel } from "../../../../../components/academy/editor/DraftPanel";
import { EditorBanner, SaveStatus } from "../../../../../components/academy/editor/EditorBits";
import { LessonListCard } from "../../../../../components/academy/editor/LessonListCard";
import { useCourseDraft } from "../../../../../components/academy/editor/useCourseDraft";
import { confirmAction } from "../../../../../lib/confirmAction";
import { colors } from "../../../../../lib/theme";
import { useActionRunner } from "../../../../../lib/useActionToast";

/**
 * COURSE EDITOR — `/academy/edit/<course>`, for holders of the "Edit Academy
 * courses" power (`people.academy.edit`). Edits the course's details and its
 * lesson list as one shared, autosaved draft; Publish puts it in front of every
 * learner at once and records a version that can be restored later.
 */
export default function CourseEditorScreen() {
  const router = useRouter();
  const { course: courseSlug = "" } = useLocalSearchParams<{ course: string }>();
  const canEdit = useQuery(api.academyEditor.canEditCourses);
  if (canEdit === undefined) return <Screen loading />;
  if (!canEdit) {
    return (
      <Screen>
        <EmptyState
          icon="lock"
          title="You can't edit courses"
          message='Editing the Academy takes the "Edit Academy courses" power. Ask whoever runs the org chart to give it to your seat.'
          action={
            <Button
              title="Back to the course"
              variant="secondary"
              onPress={() => router.replace(`/academy/course/${courseSlug}`)}
            />
          }
        />
      </Screen>
    );
  }
  return <CourseEditor courseSlug={courseSlug} />;
}

function CourseEditor({ courseSlug }: { courseSlug: string }) {
  const router = useRouter();
  const wide = useWindowDimensions().width >= 1000;
  const draft = useCourseDraft(courseSlug);
  const { state, catalog, edit } = draft;
  const publishDraft = useMutation(api.academyEditor.publishDraft);
  const discardDraft = useMutation(api.academyEditor.discardDraft);
  const restoreVersion = useMutation(api.academyEditor.restoreVersion);
  const { run, toast, dismiss } = useActionRunner();
  const [published, setPublished] = useState<number | null>(null);

  const changes = useMemo(
    () =>
      catalog && edit
        ? draft.isReset
          ? ["Put the course back to its built-in version"]
          : describeCourseEditChanges(courseSlug, edit, catalog)
        : [],
    [catalog, edit, courseSlug, draft.isReset],
  );
  const problems = useMemo(
    () => (catalog && edit && !draft.isReset ? courseEditProblems(courseSlug, edit, catalog) : []),
    [catalog, edit, courseSlug, draft.isReset],
  );

  if (!state || !catalog) return <Screen loading />;
  if (!edit) {
    return (
      <Screen>
        <EmptyState icon="book-open" title="Course not found" message="This Academy course doesn't exist." />
      </Screen>
    );
  }

  const close = async () => {
    await draft.flush();
    router.replace(`/academy/course/${courseSlug}`);
  };
  const openLesson = async (slug: string) => {
    await draft.flush();
    router.push(`/academy/edit/${courseSlug}/${slug}`);
  };

  const publish = async () => {
    await draft.flush();
    confirmAction({
      title: "Publish to every learner?",
      message: `${changes.join("\n")}\n\nIt goes live right away and is recorded in History, so it can be undone.`,
      confirmLabel: "Publish",
      onConfirm: () =>
        void run(() => publishDraft({ courseSlug }), {
          errorTitle: "Couldn't publish",
          onSuccess: (r) => setPublished((r as { version: number }).version),
        }),
    });
  };
  const discard = () =>
    confirmAction({
      title: "Discard this draft?",
      message: "Every unpublished change to this course is thrown away. Learners keep seeing the published course.",
      confirmLabel: "Discard",
      destructive: true,
      onConfirm: () => {
        draft.cancelPending();
        void run(() => discardDraft({ courseSlug }), { errorTitle: "Couldn't discard" });
      },
    });
  const restore = (version: number, label: string) =>
    confirmAction({
      title: `Restore ${label}?`,
      message: "It becomes this course's draft, replacing any draft in progress. Nothing changes for learners until you publish.",
      confirmLabel: "Restore",
      onConfirm: () => {
        draft.cancelPending();
        void run(() => restoreVersion({ courseSlug, version }), { errorTitle: "Couldn't restore" });
      },
    });

  const canPublish = draft.hasDraft && problems.length === 0 && draft.saveState !== "error";
  const main = (
    <View className="gap-4">
      {draft.isReset ? (
        <EditorBanner text="This draft puts the course back to how it ships in the app. Publish to make that live, or change anything to start editing from there." />
      ) : null}
      <CourseDetailsCard
        course={edit.course}
        themes={catalog.themes}
        onChange={(course) => draft.update((prev) => ({ ...prev, course }))}
      />
      <LessonListCard
        courseSlug={courseSlug}
        edit={edit}
        catalog={catalog}
        onChange={draft.update}
        onOpenLesson={(slug) => void openLesson(slug)}
      />
    </View>
  );
  const side = <DraftPanel state={state} changes={changes} problems={problems} onRestore={restore} />;

  return (
    <Screen maxWidth={1180}>
      <Stack.Screen options={{ title: `Editing ${edit.course.title}` }} />
      <View className="mb-4 flex-row flex-wrap items-center gap-2">
        <Pressable
          onPress={() => void close()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close the editor"
          className="rounded-md p-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
        <View className="min-w-[180px] flex-1">
          <Text className="text-xs font-bold uppercase tracking-wider text-accent">
            Editing course
          </Text>
          <Text className="font-display text-2xl text-ink" numberOfLines={1}>
            {edit.course.title || "Untitled course"}
          </Text>
        </View>
        <SaveStatus saveState={draft.saveState} hasDraft={draft.hasDraft} isReset={draft.isReset} />
        {state.draft ? (
          <Button title="Discard draft" variant="ghost" size="sm" onPress={discard} />
        ) : null}
        <Button
          title="Publish"
          icon="upload-cloud"
          size="sm"
          disabled={!canPublish}
          onPress={() => void publish()}
        />
      </View>
      {draft.saveError ? (
        <EditorBanner tone="danger" text={`Your last change didn't save: ${draft.saveError}`} />
      ) : null}
      {published != null && !state.draft ? (
        <EditorBanner tone="success" text={`Published as version ${published}. Every learner sees it now.`} />
      ) : null}
      <ToastView toast={toast} onDismiss={dismiss} />
      {wide ? (
        <View className="mt-2 flex-row items-start gap-5">
          <View className="flex-1">{main}</View>
          <View className="w-[340px]">{side}</View>
        </View>
      ) : (
        <View className="mt-2 gap-4">
          {main}
          {side}
        </View>
      )}
    </Screen>
  );
}
