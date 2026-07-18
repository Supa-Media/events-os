import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
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
import { colors } from "../../../../lib/theme";
import {
  getRolePath,
  getAcademyCourse,
  requiredModuleSlugsForCourse,
  rolePathProgress,
  seatsForChart,
  RESPONSIBILITY_CADENCE_LABELS,
} from "@events-os/shared";

type FullChart = FunctionReturnType<typeof api.seats.chart>;
type CourseCompleters = FunctionReturnType<typeof api.academy.courseCompleters>;
type CompleterPerson = NonNullable<CourseCompleters>[number];

/**
 * Resolve a seat slug → its `seatDefs` id via the full org-chart payload. Seat
 * defs are shared across chapters (identical `defId` per slug), so the FIRST
 * match — central chart first, then any chapter subtree — is the seat's def.
 */
function findSeatDefId(
  chart: FullChart,
  slug: string,
): Id<"seatDefs"> | undefined {
  if (chart.kind !== "full") return undefined;
  const central = chart.central.find((s) => s.slug === slug);
  if (central) return central.defId;
  for (const c of chart.chapters) {
    const s = c.seats.find((seat) => seat.slug === slug);
    if (s) return s.defId;
  }
  return undefined;
}

/**
 * ROLE PATH — `/academy/path/<seatSlug>?kind=seat|event_hat`. The drilled-in
 * view of one role path: its icon/title + chart chip, live seat duties (seat
 * paths only), the ordered course playlist with the caller's per-course
 * progress, any coming-soon courses, and a "Walked this path" footer of people
 * who've completed every course. Nothing here gates content — every course row
 * always taps through to the existing course page.
 *
 * The `(kind, seatSlug)` tuple identity matters: `"event_lead"` is BOTH an
 * event hat and a real chapter seat, so `kind` (a query param, defaulting to
 * `"seat"` for bare links) disambiguates which path this is.
 */
export default function RolePathScreen() {
  const router = useRouter();
  const { seatSlug, kind } = useLocalSearchParams<{
    seatSlug: string;
    kind?: string;
  }>();
  const pathKind: "seat" | "event_hat" =
    kind === "event_hat" ? "event_hat" : "seat";
  const path = getRolePath(pathKind, seatSlug ?? "");

  const progress = useQuery(api.academy.myProgress);
  // Full chart only to resolve slug → seatDefId for duties (seat paths only).
  const fullChart = useQuery(
    api.seats.chart,
    path && path.kind === "seat" ? {} : "skip",
  );
  const seatDefId =
    path && path.kind === "seat" && fullChart
      ? findSeatDefId(fullChart, path.seatSlug)
      : undefined;
  const duties = useQuery(
    api.responsibilities.dutiesForSeat,
    seatDefId ? { seatDefId } : "skip",
  );

  // "Walked this path" — a completer list per course; intersected once all load.
  const [completerLists, setCompleterLists] = useState<
    Record<string, CourseCompleters>
  >({});
  const onLoaded = useCallback((slug: string, list: CourseCompleters) => {
    setCompleterLists((prev) => ({ ...prev, [slug]: list }));
  }, []);

  if (!path) {
    return (
      <Screen>
        <EmptyState
          icon="git-branch"
          title="Role path not found"
          message="This role path doesn't exist."
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

  const passedSlugs = new Set(
    progress.sections.filter((s) => s.passed).map((s) => s.slug),
  );
  const isSeat = path.kind === "seat";
  const isCentral =
    isSeat && seatsForChart("central").some((d) => d.id === path.seatSlug);
  const chartLabel = isSeat ? (isCentral ? "Central" : "Chapter") : "Event role";

  const { completed, total, fraction } = rolePathProgress(path, passedSlugs);
  const courseSlugs = path.courseSlugs;

  // Intersect completers across every course, once all lists have resolved. Any
  // null list means the caller has no chapter (mirrors the course page's gate),
  // so the footer is hidden entirely.
  const allLoaded = courseSlugs.every((s) => s in completerLists);
  const anyNull = courseSlugs.some((s) => completerLists[s] === null);
  let walked: CompleterPerson[] = [];
  if (allLoaded && !anyNull && courseSlugs.length > 0) {
    const lists = courseSlugs.map((s) => completerLists[s] as CompleterPerson[]);
    const [first, ...rest] = lists;
    walked = first.filter((p) =>
      rest.every((l) => l.some((q) => q.personId === p.personId)),
    );
  }

  return (
    <Screen maxWidth={860}>
      <Stack.Screen options={{ title: path.title }} />

      {/* One hidden loader per course — populates `completerLists` via a stable
          callback. `courseSlugs` is fixed for this mounted route, so the hook
          count is stable (rules-of-hooks safe). */}
      {courseSlugs.map((slug) => (
        <CourseCompletersLoader
          key={slug}
          courseSlug={slug}
          onLoaded={onLoaded}
        />
      ))}

      {/* Header: back + eyebrow */}
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
          Academy · Role path
        </Text>
      </View>

      <View className="flex-row items-center gap-2.5">
        <View className="h-11 w-11 items-center justify-center rounded-lg bg-accent-soft">
          <Icon name={path.icon as IconName} size={22} color={colors.accent} />
        </View>
        <Text className="shrink font-display text-3xl text-ink">
          {path.title}
        </Text>
        <Badge label={chartLabel} tone={isSeat ? "accent" : "info"} />
      </View>

      {/* Overall path progress */}
      <Card padding="md" className="mt-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-ink">
            {total > 0
              ? `${completed} of ${total} modules complete`
              : "Courses on the way"}
          </Text>
          {total > 0 && completed === total ? (
            <Badge label="Path complete 🎉" tone="success" icon="award" />
          ) : null}
        </View>
        <View className="mt-2.5">
          <ProgressBar fraction={fraction} />
        </View>
      </Card>

      {/* Duties — live from Work → Duties, seat paths only (event hats aren't
          org-chart seats). */}
      {isSeat ? (
        <>
          <SectionHeader title="Duties" />
          <Card padding="md">
            {duties === undefined ? (
              <View className="items-start py-1">
                <ActivityIndicator size="small" color={colors.accent} />
              </View>
            ) : duties.length === 0 ? (
              <Text className="text-sm text-muted">
                No duties mapped yet — attach them in Work → Duties.
              </Text>
            ) : (
              <View className="gap-1.5">
                {duties.map((d) => (
                  <View
                    key={String(d.id)}
                    className="flex-row items-start justify-between gap-2"
                  >
                    <View className="flex-1 flex-row items-start gap-2">
                      <Text className="mt-0.5 text-sm text-muted">·</Text>
                      <Text className="flex-1 text-sm text-ink">{d.title}</Text>
                    </View>
                    <Text className="text-xs text-muted">
                      {RESPONSIBILITY_CADENCE_LABELS[d.cadence]}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </>
      ) : null}

      {/* The ordered course playlist + any coming-soon courses. */}
      <SectionHeader title="Courses" count={courseSlugs.length} />
      {courseSlugs.length === 0 && !path.comingSoon?.length ? (
        <Card padding="md">
          <Text className="text-sm text-muted">
            Courses for this path are on the way.
          </Text>
        </Card>
      ) : (
        <View className="gap-3">
          {courseSlugs.map((slug, i) => (
            <PathCourseRow
              key={slug}
              order={i + 1}
              courseSlug={slug}
              passedSlugs={passedSlugs}
              onPress={() => router.push(`/academy/course/${slug}`)}
            />
          ))}
          {path.comingSoon?.map((label) => (
            <ComingSoonRow key={label} label={label} />
          ))}
        </View>
      )}

      {/* Walked this path — everyone who completed every course. Hidden for a
          path with no courses (nobody can "walk" it) and while the caller has
          no chapter (all lists null). */}
      {courseSlugs.length > 0 && !anyNull ? (
        <>
          <SectionHeader title="Walked this path" count={walked.length} />
          <Card padding="md">
            {!allLoaded ? (
              <View className="items-start py-1">
                <ActivityIndicator size="small" color={colors.accent} />
              </View>
            ) : walked.length === 0 ? (
              <Text className="text-sm text-muted">
                No one's finished this whole path yet — be the first.
              </Text>
            ) : (
              <View className="gap-2.5">
                {walked.map((p) => (
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

/**
 * One numbered course row in the path playlist: order mark (✓ when complete),
 * the course title, the caller's required-module progress, and a state chip.
 * Every row taps through to the existing course page — no locking anywhere.
 */
function PathCourseRow({
  order,
  courseSlug,
  passedSlugs,
  onPress,
}: {
  order: number;
  courseSlug: string;
  passedSlugs: Set<string>;
  onPress: () => void;
}) {
  const course = getAcademyCourse(courseSlug);
  if (!course) return null; // asserted to exist at module load; defensive
  const required = requiredModuleSlugsForCourse(courseSlug);
  const passed = required.filter((s) => passedSlugs.has(s)).length;
  const total = required.length;
  const complete = total > 0 && passed >= total;
  const started = passed > 0;
  return (
    <Card padding="md" onPress={onPress}>
      <View className="flex-row items-center gap-3.5">
        <View
          className={`h-9 w-9 items-center justify-center rounded-pill ${
            complete ? "bg-success-bg" : "bg-accent-soft"
          }`}
        >
          {complete ? (
            <Icon name="check" size={16} color={colors.success} />
          ) : (
            <Text className="text-sm font-bold text-accent">{order}</Text>
          )}
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>
            {course.title}
          </Text>
          <Text className="mt-0.5 text-sm text-muted">
            {passed} of {total} modules
          </Text>
          {!started && !complete ? (
            <Text className="mt-0.5 text-xs text-faint">
              Open to read anytime
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-1.5">
          {complete ? (
            <Badge label="Complete ✓" tone="success" />
          ) : started ? (
            <Badge label="Continue →" tone="accent" icon="play" />
          ) : (
            <Badge label="Not started" tone="neutral" />
          )}
          <View className="w-20">
            <ProgressBar fraction={total === 0 ? 0 : passed / total} />
          </View>
        </View>
      </View>
    </Card>
  );
}

/** A muted, inert row for a planned-but-unwritten course in the path. */
function ComingSoonRow({ label }: { label: string }) {
  return (
    <Card padding="md">
      <View className="flex-row items-center gap-3.5">
        <View className="h-9 w-9 items-center justify-center rounded-pill bg-sunken">
          <Icon name="clock" size={15} color={colors.faint} />
        </View>
        <Text className="flex-1 text-base font-medium text-muted" numberOfLines={1}>
          {label}
        </Text>
        <Badge label="Coming soon" tone="neutral" />
      </View>
    </Card>
  );
}

/**
 * A hidden loader: subscribes to one course's completer list and reports it up
 * once resolved. Rendering one per course slug lets the parent intersect the
 * lists without an N-query hook in a loop (each loader owns exactly one query).
 */
function CourseCompletersLoader({
  courseSlug,
  onLoaded,
}: {
  courseSlug: string;
  onLoaded: (slug: string, list: CourseCompleters) => void;
}) {
  const completers = useQuery(api.academy.courseCompleters, { courseSlug });
  useEffect(() => {
    if (completers !== undefined) onLoaded(courseSlug, completers);
  }, [completers, courseSlug, onLoaded]);
  return null;
}
