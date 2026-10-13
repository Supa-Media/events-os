import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  APP_LESSON_SLUG_PREFIX,
  blankLesson,
  builtInChangedSince,
  builtInCourse,
  builtInSection,
  draftSection,
  newAppLessonSlug,
  sameContent,
  toEditedSection,
  type AcademyCatalog,
  type CourseEdit,
} from "@events-os/shared";
import { Badge, Button, Card, Select } from "../../ui";
import { confirmAction } from "../../../lib/confirmAction";
import { MoveControls } from "./EditorBits";
import { moveItem, removeAt } from "./listOps";

/**
 * The course's lessons in teaching order: reorder, open one to edit, remove
 * one, write a new one, or bring in a lesson from another course (which moves
 * it — a lesson belongs to one course). Learners unlock lessons in this order.
 */
export function LessonListCard({
  courseSlug,
  edit,
  catalog,
  onChange,
  onOpenLesson,
}: {
  courseSlug: string;
  edit: CourseEdit;
  catalog: AcademyCatalog;
  onChange: (fn: (prev: CourseEdit) => CourseEdit) => void;
  onOpenLesson: (slug: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const baseModules = builtInCourse(courseSlug)?.moduleSlugs ?? [];

  const otherLessons = catalog.courses
    .filter((c) => c.slug !== courseSlug)
    .flatMap((c) => [
      { value: `course:${c.slug}`, label: c.title, header: true },
      ...catalog
        .courseModules(c.slug)
        .filter((s) => !edit.moduleSlugs.includes(s.slug))
        .map((s) => ({ value: s.slug, label: s.title })),
    ]);

  function newLesson() {
    const slug = newAppLessonSlug(Date.now(), Math.random());
    onChange((prev) => ({
      ...prev,
      moduleSlugs: [...prev.moduleSlugs, slug],
      sections: [...prev.sections, blankLesson(slug)],
    }));
    onOpenLesson(slug);
  }

  function addExisting(slug: string) {
    if (slug.startsWith("course:")) return;
    setAdding(false);
    onChange((prev) => ({
      ...prev,
      moduleSlugs: [...prev.moduleSlugs, slug],
      removedSlugs: prev.removedSlugs.filter((s) => s !== slug),
    }));
  }

  function remove(index: number, title: string) {
    const slug = edit.moduleSlugs[index];
    const madeHere = slug.startsWith(APP_LESSON_SLUG_PREFIX);
    confirmAction({
      title: `Remove "${title}"?`,
      message: madeHere
        ? "This lesson was written in the app, so removing it deletes it once you publish. An earlier version can still be restored from History."
        : "Learners stop seeing it in this course once you publish. Progress people already made on it is kept.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () =>
        onChange((prev) => ({
          ...prev,
          moduleSlugs: removeAt(prev.moduleSlugs, index),
          removedSlugs: baseModules.includes(slug)
            ? [...new Set([...prev.removedSlugs, slug])]
            : prev.removedSlugs,
          sections: madeHere
            ? prev.sections.filter((s) => s.slug !== slug)
            : prev.sections,
        })),
    });
  }

  return (
    <Card padding="md">
      <View className="mb-3 flex-row flex-wrap items-baseline justify-between gap-2">
        <Text className="text-base font-semibold text-ink">Lessons, in teaching order</Text>
        <Text className="text-xs text-muted">Learners unlock them in this order.</Text>
      </View>
      <View className="gap-2">
        {edit.moduleSlugs.map((slug, i) => {
          const section = draftSection(edit, slug, catalog);
          const edited = edit.sections.find((s) => s.slug === slug);
          const shown = catalog.getSection(slug);
          const base = builtInSection(slug);
          const isNew = !base && !shown;
          const changed =
            edited != null &&
            shown != null &&
            !sameContent(
              { ...edited, baseFingerprint: undefined },
              { ...toEditedSection(shown), baseFingerprint: undefined },
            );
          const movedFrom = catalog.courseForModuleSlug(slug);
          const title = section?.title || "Untitled lesson";
          return (
            <View
              key={slug}
              className="flex-row flex-wrap items-center gap-2.5 rounded-md border border-border bg-raised px-3 py-2.5"
            >
              <View className="h-7 w-7 items-center justify-center rounded-full bg-sunken">
                <Text className="text-xs font-bold text-muted">{i + 1}</Text>
              </View>
              <Pressable
                onPress={() => onOpenLesson(slug)}
                className="min-w-[160px] flex-1"
                accessibilityRole="button"
                accessibilityLabel={`Edit lesson ${title}`}
              >
                <Text className="text-sm font-semibold text-ink" numberOfLines={2}>
                  {title}
                </Text>
                <Text className="text-xs text-muted">
                  {section
                    ? `${section.minutes} min · ${section.blocks.length} blocks · ${
                        base?.capstone ? "training event" : `${section.quiz.length} quiz questions`
                      }`
                    : "Missing lesson"}
                </Text>
              </Pressable>
              <View className="flex-row flex-wrap gap-1">
                {isNew ? <Badge label="New" tone="warn" /> : null}
                {changed ? <Badge label="Edited" tone="warn" /> : null}
                {movedFrom && movedFrom.slug !== courseSlug ? (
                  <Badge label={`From ${movedFrom.title}`} tone="info" />
                ) : null}
                {edited && builtInChangedSince(edited) ? (
                  <Badge label="Built-in updated" tone="danger" icon="alert-triangle" />
                ) : null}
              </View>
              <Button
                title="Edit"
                size="sm"
                variant="ghost"
                onPress={() => onOpenLesson(slug)}
              />
              <MoveControls
                index={i}
                count={edit.moduleSlugs.length}
                noun="lesson"
                onMove={(to) =>
                  onChange((prev) => ({
                    ...prev,
                    moduleSlugs: moveItem(prev.moduleSlugs, i, to),
                  }))
                }
                onRemove={() => remove(i, title)}
              />
            </View>
          );
        })}
      </View>
      <View className="mt-3 flex-row flex-wrap gap-2">
        <Button title="New lesson" icon="plus" variant="secondary" size="sm" onPress={newLesson} />
        <Button
          title={adding ? "Cancel" : "Add an existing lesson"}
          icon={adding ? "x" : "corner-down-right"}
          variant="secondary"
          size="sm"
          onPress={() => setAdding((a) => !a)}
        />
      </View>
      {adding ? (
        <View className="mt-3">
          <Select
            label="Move a lesson here from another course"
            hint="A lesson belongs to one course, so it leaves its old course when you publish."
            value={null}
            options={otherLessons}
            onChange={addExisting}
            placeholder="Pick a lesson…"
            searchable
          />
        </View>
      ) : null}
    </Card>
  );
}
