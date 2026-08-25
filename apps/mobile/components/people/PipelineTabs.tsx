import { View, ScrollView } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Pill } from "../ui";

/**
 * The People desk's two pipelines, side by side.
 *
 * They are separate screens rather than one filtered list because they are
 * separate commitments — a seat on the org chart, and a pair of hands at a
 * gathering (see `@events-os/shared`'s `volunteers.ts`). One person is
 * answerable for both, which is why they sit under one nav entry and share
 * one gate; merging them into a single queue would only make the lighter one
 * feel like a rejected version of the heavier one.
 */
const TABS: { label: string; path: string }[] = [
  { label: "Team applications", path: "/people/pipeline" },
  { label: "Volunteer signups", path: "/people/volunteers" },
  // The postings themselves — what's advertised on /team. Sits under the same
  // People-desk nav and gate as the pipelines it feeds: the person who works
  // the funnel is the person who owns what's open (see `lib/hiringAccess.ts`'s
  // `requireListingManage`).
  { label: "Job listings", path: "/people/listings" },
];

export function PipelineTabs() {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <View className="mb-3">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {TABS.map((t) => (
          <Pill
            key={t.path}
            label={t.label}
            selected={pathname === t.path || pathname.startsWith(`${t.path}/`)}
            onPress={() => router.navigate(t.path as never)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
