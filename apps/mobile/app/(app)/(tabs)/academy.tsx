import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  PageHeader,
  Card,
  Badge,
  Icon,
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
 * THE ACADEMY HUB — themes → courses. The flat curriculum is now organised into
 * courses (each with a level + a badge you earn); the hub lists every theme that
 * has courses, a card per course showing the caller's progress + earned state,
 * and drills into a course page for its module path. Reading is never gated;
 * only the quiz-passed "complete" state unlocks sequentially inside a course.
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

      {/* Themes → courses. Only themes that HAVE courses render (Management /
          Leadership are seeded empty and fill as content is written). */}
      {ACADEMY_THEMES.map((theme) => {
        const courses = academyCoursesForTheme(theme.key);
        if (courses.length === 0) return null;
        return (
          <View key={theme.key}>
            <SectionHeader title={theme.title} count={courses.length} />
            <View className="gap-3">
              {courses.map((course) => (
                <CourseCard
                  key={course.slug}
                  course={course}
                  passedSlugs={passedSlugs}
                  earned={earnedSlugs.has(course.slug)}
                  onPress={() => router.push(`/academy/course/${course.slug}`)}
                />
              ))}
            </View>
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
 * One course card: title, level chip, the caller's REQUIRED-module progress
 * (passed-flags ∩ the course's required set), and an earned indicator once the
 * badge is held. Taps through to the course page.
 */
function CourseCard({
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
    <Card padding="md" onPress={onPress}>
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text
              className="shrink text-base font-semibold text-ink"
              numberOfLines={1}
            >
              {course.title}
            </Text>
            <LevelChip level={course.level} />
          </View>
          <Text className="mt-1 text-sm text-muted" numberOfLines={2}>
            {course.description}
          </Text>
          <Text className="mt-2 text-xs font-semibold text-muted">
            {passed} of {total} required modules passed
          </Text>
          <View className="mt-1.5">
            <ProgressBar fraction={total === 0 ? 0 : passed / total} />
          </View>
        </View>
        <View className="items-end">
          {earned ? (
            <Badge label="Earned" tone="success" icon="award" />
          ) : (
            <Icon name="chevron-right" size={18} color={colors.faint} />
          )}
        </View>
      </View>
    </Card>
  );
}
