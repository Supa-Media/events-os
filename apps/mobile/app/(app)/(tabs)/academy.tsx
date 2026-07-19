import { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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
import { colors, spacing } from "../../../lib/theme";
import {
  ACADEMY_THEMES,
  academyCoursesForTheme,
  requiredModuleSlugsForCourse,
  ROLE_PATHS,
  getRolePath,
  rolePathProgress,
  nextIncompleteModuleForPath,
  seatsForChart,
  type Course,
  type RolePath,
} from "@events-os/shared";

/**
 * THE ACADEMY HUB — streams → courses. The catalog is organised into three
 * STREAMS (Events, Works, Management), stacked vertically; each stream shows a
 * horizontal rail of compact course tiles with the caller's progress + earned
 * state, and drills into a course page for its module path. Reading is never
 * gated; only the quiz-passed "complete" state unlocks sequentially inside a
 * course.
 */
type AcademyView = "tracks" | "roles";
type AcademyProgress = FunctionReturnType<typeof api.academy.myProgress>;
type AcademyChapter =
  | FunctionReturnType<typeof api.academy.chapterProgress>
  | undefined;
type SeatAssignments = FunctionReturnType<typeof api.seats.deskQueries.mySeatAssignments>;
type FullChart = FunctionReturnType<typeof api.seats.chartQueries.chart>;

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

  // The Roles view: the caller's held seats (drives "Your path"), plus the
  // full org chart (read ONCE — the same payload the Org Chart tab holds) for
  // per-seat chart classification + vacancy tags.
  const mySeatAssignments = useQuery(api.seats.deskQueries.mySeatAssignments, {});
  const fullChart = useQuery(api.seats.chartQueries.chart, {});

  // Segmented mode. Default "tracks"; auto-flip to "roles" exactly once, the
  // first time the caller's seat assignments resolve non-empty — but never
  // fight a user who has already toggled manually.
  const [view, setView] = useState<AcademyView>("tracks");
  const autoDecided = useRef(false);
  const userToggled = useRef(false);
  useEffect(() => {
    if (autoDecided.current || userToggled.current) return;
    if (mySeatAssignments === undefined) return;
    autoDecided.current = true;
    if (mySeatAssignments.length > 0) setView("roles");
  }, [mySeatAssignments]);

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

      <Segmented<AcademyView>
        value={view}
        onChange={(key) => {
          userToggled.current = true;
          setView(key);
        }}
        options={[
          { key: "tracks", icon: "layers", label: "Tracks" },
          { key: "roles", icon: "git-branch", label: "Roles" },
        ]}
      />

      {view === "roles" ? (
        <RolesView
          passedSlugs={passedSlugs}
          mySeatAssignments={mySeatAssignments}
          fullChart={fullChart}
          onOpenPath={(path) =>
            router.push(
              `/academy/path/${path.seatSlug}?kind=${path.kind}`,
            )
          }
        />
      ) : (
        <TracksView
          passedSlugs={passedSlugs}
          earnedSlugs={earnedSlugs}
          progress={progress}
          chapter={chapter}
          onOpenCourse={(slug) => router.push(`/academy/course/${slug}`)}
        />
      )}
    </Screen>
  );
}

/**
 * TRACKS — the original Academy hub: overall progress, the three theme rails of
 * course tiles, and the managers-only "Who's trained" roster. Unchanged behavior,
 * just gated behind the Tracks/Roles segmented control now.
 */
function TracksView({
  passedSlugs,
  earnedSlugs,
  progress,
  chapter,
  onOpenCourse,
}: {
  passedSlugs: Set<string>;
  earnedSlugs: Set<string>;
  progress: AcademyProgress;
  chapter: AcademyChapter;
  onOpenCourse: (slug: string) => void;
}) {
  return (
    <>
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
                    onPress={() => onOpenCourse(course.slug)}
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
    </>
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
    <Card padding="md" onPress={onPress} className="h-52 w-60">
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

/**
 * The compact segmented toggle for the Tracks ⇄ Roles views. Mirrors the Work
 * tab's local `Segmented` (kept per-screen — this repo deliberately does NOT
 * share this component across screens).
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; icon: IconName; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <View
      className="flex-row self-start rounded-lg bg-sunken"
      style={{ padding: 3, gap: spacing.xs }}
    >
      {options.map((v) => {
        const active = value === v.key;
        return (
          <Pressable
            key={v.key}
            onPress={() => onChange(v.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className={`flex-row items-center gap-1.5 rounded-md px-2.5 py-1 active:opacity-80 ${
              active ? "bg-raised shadow-sm" : ""
            }`}
          >
            <Icon
              name={v.icon}
              size={13}
              color={active ? colors.ink : colors.muted}
            />
            <Text
              className={`text-xs font-semibold ${
                active ? "text-ink" : "text-muted"
              }`}
            >
              {v.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * ROLES — the org-chart-keyed view of the Academy: the caller's own seat paths
 * ("Your path"), then every chapter / central seat path, then the per-event
 * "event hat" paths. Every path is a preview: progress is ALWAYS the caller's
 * own, even for seats they don't hold. Nothing here gates content — it's a
 * navigation/recommendation layer over the same courses the Tracks view shows.
 */
function RolesView({
  passedSlugs,
  mySeatAssignments,
  fullChart,
  onOpenPath,
}: {
  passedSlugs: Set<string>;
  mySeatAssignments: SeatAssignments | undefined;
  fullChart: FullChart | undefined;
  onOpenPath: (path: RolePath) => void;
}) {
  const assignments = mySeatAssignments ?? [];
  const heldSlugs = new Set(assignments.map((a) => a.slug));
  // "My chapter" for chapter-scope vacancy: the chapter a held seat lives in.
  // Exact (a chapter id off the assignment), no new query — but only known when
  // the caller holds at least one chapter seat (see report note).
  const myChapterId = assignments.find((a) => a.scope !== "central")?.scope;

  // Vacancy comes from a SINGLE full-tree chart read (the same payload the Org
  // Chart tab holds). Classification (chapter vs central) comes from the seat
  // taxonomy so the sections are stable even before the chart query resolves.
  const centralVacantBySlug = new Map<string, boolean>();
  const myChapterVacantBySlug = new Map<string, boolean>();
  if (fullChart && fullChart.kind === "full") {
    for (const s of fullChart.central) centralVacantBySlug.set(s.slug, s.vacant);
    if (myChapterId) {
      const mine = fullChart.chapters.find((c) => c.chapterId === myChapterId);
      for (const s of mine?.seats ?? []) {
        myChapterVacantBySlug.set(s.slug, s.vacant);
      }
    }
  }

  const centralSeatSlugs = new Set<string>(
    seatsForChart("central").map((d) => d.id),
  );
  const seatPaths = ROLE_PATHS.filter((p) => p.kind === "seat");
  const chapterPaths = seatPaths.filter(
    (p) => !centralSeatSlugs.has(p.seatSlug),
  );
  const centralPaths = seatPaths.filter((p) =>
    centralSeatSlugs.has(p.seatSlug),
  );
  const eventPaths = ROLE_PATHS.filter((p) => p.kind === "event_hat");

  // The caller's held seats that have a role path (seats only — never hats).
  const yourPath = assignments.flatMap((assignment) => {
    const path = getRolePath("seat", assignment.slug);
    return path ? [{ assignment, path }] : [];
  });

  return (
    <>
      {yourPath.length > 0 ? (
        <View>
          <SectionHeader title="Your path" count={yourPath.length} />
          <View className="gap-3">
            {yourPath.map(({ assignment, path }) => (
              <RolePathCard
                key={String(assignment.assignmentId)}
                path={path}
                scopeName={assignment.scopeName}
                passedSlugs={passedSlugs}
                onPress={() => onOpenPath(path)}
              />
            ))}
          </View>
        </View>
      ) : null}

      <RoleRail
        title="Chapter roles"
        paths={chapterPaths}
        passedSlugs={passedSlugs}
        heldSlugs={heldSlugs}
        vacantBySlug={myChapterVacantBySlug}
        onOpenPath={onOpenPath}
      />
      <RoleRail
        title="Central roles"
        paths={centralPaths}
        passedSlugs={passedSlugs}
        heldSlugs={heldSlugs}
        vacantBySlug={centralVacantBySlug}
        onOpenPath={onOpenPath}
      />
      <RoleRail
        title="Event roles"
        paths={eventPaths}
        passedSlugs={passedSlugs}
        heldSlugs={null}
        vacantBySlug={null}
        onOpenPath={onOpenPath}
      />
    </>
  );
}

/**
 * One "Your path" card — a seat the caller holds, full-width: icon + title, the
 * scope they hold it in, their progress, and the next module to tackle.
 */
function RolePathCard({
  path,
  scopeName,
  passedSlugs,
  onPress,
}: {
  path: RolePath;
  scopeName: string;
  passedSlugs: Set<string>;
  onPress: () => void;
}) {
  const { fraction } = rolePathProgress(path, passedSlugs);
  const next = nextIncompleteModuleForPath(path, passedSlugs);
  return (
    <Card padding="md" onPress={onPress}>
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-lg bg-accent-soft">
          <Icon name={path.icon as IconName} size={21} color={colors.accent} />
        </View>
        <View className="flex-1">
          <Text
            className="text-base font-semibold text-ink"
            numberOfLines={1}
          >
            {path.title}
          </Text>
          <Text className="mt-0.5 text-sm text-muted" numberOfLines={1}>
            {scopeName} · you hold this seat
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={colors.muted} />
      </View>
      <View className="mt-2.5">
        <ProgressBar fraction={fraction} />
      </View>
      {next ? (
        <Text
          className="mt-2 text-sm font-semibold text-accent"
          numberOfLines={1}
        >
          Next: {next.title} →
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * A horizontal rail of role-path tiles — the same rail styling the Tracks view
 * uses for course tiles. `heldSlugs`/`vacantBySlug` are null for event roles
 * (event hats aren't org-chart seats, so "held"/"vacant" don't apply).
 */
function RoleRail({
  title,
  paths,
  passedSlugs,
  heldSlugs,
  vacantBySlug,
  onOpenPath,
}: {
  title: string;
  paths: RolePath[];
  passedSlugs: Set<string>;
  heldSlugs: Set<string> | null;
  vacantBySlug: Map<string, boolean> | null;
  onOpenPath: (path: RolePath) => void;
}) {
  if (paths.length === 0) return null;
  return (
    <View>
      <SectionHeader title={title} count={paths.length} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingVertical: 2 }}
      >
        {paths.map((path) => (
          <RolePathTile
            key={`${path.kind}-${path.seatSlug}`}
            path={path}
            passedSlugs={passedSlugs}
            held={heldSlugs?.has(path.seatSlug) ?? false}
            vacant={vacantBySlug?.get(path.seatSlug) ?? false}
            onPress={() => onOpenPath(path)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * One compact role-path tile on a rail: icon + held/vacant tags, title, the
 * caller's own path progress. Fixed width so rails scan as uniform rectangles —
 * mirrors `CourseTile`. Taps through to the role-path detail page.
 */
function RolePathTile({
  path,
  passedSlugs,
  held,
  vacant,
  onPress,
}: {
  path: RolePath;
  passedSlugs: Set<string>;
  held: boolean;
  vacant: boolean;
  onPress: () => void;
}) {
  const { completed, total, fraction } = rolePathProgress(path, passedSlugs);
  return (
    <Card padding="md" onPress={onPress} className="h-52 w-60">
      <View className="flex-row items-center justify-between gap-2">
        <View
          className={`h-10 w-10 items-center justify-center rounded-lg ${
            held ? "bg-success-bg" : "bg-accent-soft"
          }`}
        >
          <Icon
            name={path.icon as IconName}
            size={19}
            color={held ? colors.success : colors.accent}
          />
        </View>
        <View className="flex-row items-center gap-1.5">
          {vacant ? <Badge label="Vacant" tone="neutral" /> : null}
          {held ? <Badge label="Held" tone="success" icon="check" /> : null}
        </View>
      </View>
      <Text
        className="mt-2.5 text-base font-semibold text-ink"
        numberOfLines={2}
      >
        {path.title}
      </Text>
      <View className="mt-1 flex-1 justify-end">
        <Text className="text-xs font-semibold text-muted">
          {total > 0 ? `${completed} of ${total} modules` : "Coming soon"}
        </Text>
        <View className="mt-1.5">
          <ProgressBar fraction={fraction} />
        </View>
      </View>
    </Card>
  );
}
