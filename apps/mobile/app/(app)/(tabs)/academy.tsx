import { View, Text, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  PageHeader,
  Card,
  Badge,
  Icon,
  type IconName,
  SectionHeader,
  ProgressBar,
} from "../../../components/ui";
import { LevelChip } from "../../../components/academy/CurriculumRows";
import { colors } from "../../../lib/theme";
import {
  ACADEMY_THEMES,
  academyCoursesForTheme,
  requiredModuleSlugsForCourse,
  type Course,
} from "@events-os/shared";

/**
 * THE ACADEMY HUB — streams → courses. The catalog is organised into three
 * STREAMS (Events, Works, Management), stacked vertically; each stream shows a
 * horizontal rail of compact course tiles with the caller's progress + earned
 * state, and drills into a course page for its module path. Reading is never
 * gated; only the quiz-passed "complete" state unlocks sequentially inside a
 * course.
 */
export default function AcademyScreen() {
  const router = useRouter();
  const progress = useQuery(api.academy.myProgress);

  // "Who's trained" is a managers/admins surface — only they subscribe.
  // org.nav is the app-wide policy signal AppShell already consumes.
  const org = useQuery(api.org.nav);
  const chapter = useQuery(
    api.academy.chapterProgress,
    org?.canManage === true ? {} : "skip",
  );

  if (progress === undefined) {
    return <Screen loading />;
  }

  // Passed module slugs + earned course slugs drive every course card below.
  const passedSlugs = new Set(
    progress.sections.filter((s) => s.passed).map((s) => s.slug),
  );
  const earnedSlugs = new Set(progress.earnedCourseSlugs);

  return (
    <Screen maxWidth={860}>
      <PageHeader
        eyebrow="Academy"
        title="Academy"
        subtitle="Learn to run events nobody has to rescue."
      />

      {/* Overall path progress */}
      <Card padding="md">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-ink">
            {progress.completed} of {progress.total} modules complete
          </Text>
          {progress.completed === progress.total ? (
            <Badge label="Fully trained 🎉" tone="success" icon="award" />
          ) : null}
        </View>
        <View className="mt-2.5">
          <ProgressBar
            fraction={
              progress.total === 0 ? 0 : progress.completed / progress.total
            }
          />
        </View>
      </Card>

      {/* Streams, stacked vertically. Each stream is a horizontal rail of
          compact course tiles — every stream renders, even before its first
          course ships, so the shape of the Academy is visible up front. */}
      {ACADEMY_THEMES.map((theme) => {
        const courses = academyCoursesForTheme(theme.key);
        return (
          <View key={theme.key}>
            <SectionHeader title={theme.title} count={courses.length} />
            <Text className="-mt-1 mb-2.5 text-sm text-muted">
              {theme.subtitle}
            </Text>
            {courses.length === 0 ? (
              <Card padding="md">
                <Text className="text-sm text-muted">
                  First courses in this stream are on the way.
                </Text>
              </Card>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12, paddingVertical: 2 }}
              >
                {courses.map((course) => (
                  <CourseTile
                    key={course.slug}
                    course={course}
                    passedSlugs={passedSlugs}
                    earned={earnedSlugs.has(course.slug)}
                    onPress={() =>
                      router.push(`/academy/course/${course.slug}`)
                    }
                  />
                ))}
              </ScrollView>
            )}
          </View>
        );
      })}

      {/* Who's trained — managers/admins only (the server returns null
          otherwise, mirroring how the Team/Duties nav gates; the query is
          skipped entirely for everyone else). */}
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
                  <View className="w-28">
                    <ProgressBar
                      fraction={p.total === 0 ? 0 : p.completed / p.total}
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

/**
 * One compact course tile on a stream's horizontal rail: level chip + earned
 * mark up top, title, description, then the caller's REQUIRED-module progress
 * (passed-flags ∩ the course's required set). Fixed width so rails scan as a
 * row of uniform rectangles. Taps through to the course page.
 */
function CourseTile({
  course,
  passedSlugs,
  earned,
  onPress,
}: {
  course: Course;
  passedSlugs: Set<string>;
  earned: boolean;
  onPress: () => void;
}) {
  const required = requiredModuleSlugsForCourse(course.slug);
  const passed = required.filter((slug) => passedSlugs.has(slug)).length;
  const total = required.length;

  return (
    <Card padding="md" onPress={onPress} className="w-60">
      <View className="flex-row items-center justify-between gap-2">
        {/* The course's glyph — a plain string in the shared catalog (that
            package can't see the icon font's types), narrowed here. */}
        <View
          className={`h-10 w-10 items-center justify-center rounded-lg ${
            earned ? "bg-success-bg" : "bg-accent-soft"
          }`}
        >
          <Icon
            name={course.icon as IconName}
            size={19}
            color={earned ? colors.success : colors.accent}
          />
        </View>
        <LevelChip level={course.level} />
      </View>
      <Text className="mt-2.5 text-base font-semibold text-ink" numberOfLines={2}>
        {course.title}
      </Text>
      <Text className="mt-1 flex-1 text-xs text-muted" numberOfLines={3}>
        {course.description}
      </Text>
      <View className="mt-2.5 flex-row items-center justify-between gap-2">
        <Text className="text-xs font-semibold text-muted">
          {passed} of {total} modules
        </Text>
        {earned ? (
          <Icon name="award" size={14} color={colors.success} />
        ) : null}
      </View>
      <View className="mt-1.5">
        <ProgressBar fraction={total === 0 ? 0 : passed / total} />
      </View>
    </Card>
  );
}
