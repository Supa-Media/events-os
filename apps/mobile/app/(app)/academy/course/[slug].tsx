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
 * within THIS course), and a compact TEAM training grid. Each module routes
 * to the shared module screen (`/academy/<moduleSlug>`).
 */
export default function AcademyCourseScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const course = getAcademyCourse(slug ?? "");

  const progress = useQuery(api.academy.myProgress);
  // Owner fix (2026-07-18): was `api.academy.courseCompleters` (chapter-
  // visible, decision D4, but completers-ONLY — every chapter person who'd
  // earned the course, in a full-width vertical row each) — replaced with a
  // TEAM-only roster that ALSO carries the untrained state, so the page shows
  // a compact grid instead of a growing list that only ever grows down.
  // `courseCompleters` itself is untouched — `academy/path/[seatSlug].tsx`
  // still uses it as-is.
  const roster = useQuery(
    api.academy.courseTeamTrainingRoster,
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

      {/* Team training — a compact avatar+name grid, team members only, each
          marked trained/untrained. `null` = the caller has no chapter
          (nothing to show); `[]` = no team members in the chapter yet. */}
      {roster != null ? (
        <>
          <SectionHeader title="Team training" count={roster.length} />
          <Card padding="md">
            {roster.length === 0 ? (
              <Text className="text-sm text-muted">
                No team members in this chapter yet.
              </Text>
            ) : (
              <View className="flex-row flex-wrap gap-2">
                {roster.map((p) => (
                  <View
                    key={String(p.personId)}
                    className={`flex-row items-center gap-1.5 rounded-full border px-2 py-1 ${
                      p.trained
                        ? "border-success-bg bg-success-bg"
                        : "border-border bg-sunken"
                    }`}
                  >
                    <Avatar name={p.name} uri={p.imageUrl} size={20} />
                    <Text
                      className={`max-w-[120px] text-xs font-medium ${
                        p.trained ? "text-ink" : "text-muted"
                      }`}
                      numberOfLines={1}
                    >
                      {p.name}
                    </Text>
                    {p.trained ? (
                      <Icon name="award" size={12} color={colors.success} />
                    ) : null}
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
