import { View, Text, Pressable } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  Avatar,
  Icon,
  type IconName,
  EmptyState,
  SectionHeader,
  ProgressBar,
} from "../../../../components/ui";
import {
  SectionRow,
  CapstoneRow,
  LevelChip,
} from "../../../../components/academy/CurriculumRows";
import { colors } from "../../../../lib/theme";
import {
  getAcademyCourse,
  academyCourseModules,
  requiredModuleSlugsForCourse,
} from "@events-os/shared";

/**
 * ACADEMY COURSE — `/academy/course/<slug>`. The drilled-in view of one course:
 * its title/level/description, the caller's required-module progress + earned
 * badge, the ordered module path (today's SectionRow/CapstoneRow, numbered
 * within THIS course), and a chapter-visible "Completed by" list. Each module
 * routes to the shared module screen (`/academy/<moduleSlug>`).
 */
export default function AcademyCourseScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const course = getAcademyCourse(slug ?? "");

  const progress = useQuery(api.academy.myProgress);
  // Completer list is chapter-visible (decision D4) — everyone subscribes.
  const completers = useQuery(
    api.academy.courseCompleters,
    course ? { courseSlug: course.slug } : "skip",
  );

  if (!course) {
    return (
      <Screen>
        <EmptyState
          icon="book-open"
          title="Course not found"
          message="This Academy course doesn't exist."
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

  const bySlug = new Map(progress.sections.map((s) => [s.slug, s]));
  const modules = academyCourseModules(course.slug);
  const required = requiredModuleSlugsForCourse(course.slug);
  const passedRequired = required.filter(
    (s) => bySlug.get(s)?.passed === true,
  ).length;
  const earned = progress.earnedCourseSlugs.includes(course.slug);

  return (
    <Screen maxWidth={860}>
      <Stack.Screen options={{ title: course.title }} />

      {/* Header: back + eyebrow + title + level + description */}
      <View className="mb-2 flex-row items-center gap-2">
        <Pressable
          onPress={() => router.replace("/academy")}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to Academy"
          className="rounded-md p-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="arrow-left" size={18} color={colors.muted} />
        </Pressable>
        <Text className="text-xs font-bold uppercase tracking-wider text-accent">
          Academy · Course
        </Text>
      </View>

      <View className="flex-row items-center gap-2.5">
        <View className="h-11 w-11 items-center justify-center rounded-lg bg-accent-soft">
          <Icon
            name={course.icon as IconName}
            size={22}
            color={colors.accent}
          />
        </View>
        <Text className="shrink font-display text-3xl text-ink">
          {course.title}
        </Text>
        <LevelChip level={course.level} />
      </View>
      <Text className="mt-1.5 text-base text-muted">{course.description}</Text>

      {/* Progress + earned banner */}
      <Card padding="md" className="mt-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-ink">
            {passedRequired} of {required.length} required modules passed
          </Text>
          {earned ? (
            <Badge label="Earned 🎉" tone="success" icon="award" />
          ) : null}
        </View>
        <View className="mt-2.5">
          <ProgressBar
            fraction={
              required.length === 0 ? 0 : passedRequired / required.length
            }
          />
        </View>
      </Card>

      {/* The course's module path — numbered within THIS course (1..M). */}
      <SectionHeader title="Modules" count={modules.length} />
      <View className="gap-3">
        {modules.map((section, i) => {
          const state = bySlug.get(section.slug);
          return section.capstone ? (
            <CapstoneRow
              key={section.slug}
              section={section}
              state={state}
              order={i + 1}
              training={state?.training ?? null}
              onOpen={() => router.push(`/academy/${section.slug}`)}
            />
          ) : (
            <SectionRow
              key={section.slug}
              section={section}
              state={state}
              order={i + 1}
              onPress={() => router.push(`/academy/${section.slug}`)}
            />
          );
        })}
      </View>

      {/* Completed by — chapter-visible. null = the caller has no chapter
          (nothing to show); [] = the course exists but nobody's earned it yet. */}
      {completers != null ? (
        <>
          <SectionHeader title="Completed by" count={completers.length} />
          <Card padding="md">
            {completers.length === 0 ? (
              <Text className="text-sm text-muted">
                No one's earned this course yet — be the first.
              </Text>
            ) : (
              <View className="gap-2.5">
                {completers.map((p) => (
                  <View
                    key={String(p.personId)}
                    className="flex-row items-center gap-3"
                  >
                    <Avatar name={p.name} uri={p.imageUrl} size={28} />
                    <Text
                      className="flex-1 text-sm font-medium text-ink"
                      numberOfLines={1}
                    >
                      {p.name}
                    </Text>
                    <Icon name="award" size={16} color={colors.success} />
                  </View>
                ))}
              </View>
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
