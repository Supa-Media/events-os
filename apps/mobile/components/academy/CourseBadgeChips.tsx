import { View, Text } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { getAcademyCourse } from "@events-os/shared";
import { Badge } from "../ui";

/**
 * A person's earned Academy course badges — a small, display-only chip row for
 * the profile surfaces (WorkloadView, the People-tab detail modal). Reads
 * `personBadges` (chapter-scoped) and resolves each slug's title via the shared
 * catalog. Renders NOTHING while loading, when the person has no badges, or when
 * every badge's course has left the catalog — these surfaces stay quiet rather
 * than showing an empty "Courses" heading.
 */
export function CourseBadgeChips({ personId }: { personId: Id<"people"> }) {
  const badges = useQuery(api.academy.personBadges, { personId });
  if (badges === undefined || badges.length === 0) return null;

  // Resolve titles from the catalog; drop any slug no longer defined there.
  const courses = badges
    .map((b) => getAcademyCourse(b.courseSlug))
    .filter((c): c is NonNullable<typeof c> => c != null);
  if (courses.length === 0) return null;

  return (
    <View className="mb-3">
      <Text className="mb-1.5 text-2xs font-bold uppercase tracking-wider text-muted">
        Courses
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        {courses.map((course) => (
          <Badge
            key={course.slug}
            label={course.title}
            tone="success"
            icon="award"
          />
        ))}
      </View>
    </View>
  );
}
