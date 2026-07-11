import { View, Text, Pressable } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Curated display order for the Overview's Guides section: responsibility
 * guides first (event owner, then the generic workstream one), then the
 * per-workstream guides. Slugs not listed here (future guides) sort after,
 * alphabetically — nothing seeded is ever hidden.
 */
const GUIDE_ORDER = [
  "so-you-own-an-event",
  "so-you-own-a-workstream",
  "owning-the-planning-doc",
  "owning-the-comms-workstream",
  "owning-the-run-of-show",
  "owning-expectations",
  "owning-supplies-and-logistics",
  "owning-permits",
  "owning-the-retro",
];

/**
 * "Guides" on the event Overview — the browsable index of the platform guides
 * seeded into this chapter, so finding "how do I use this?" doesn't depend on
 * already standing on the right workstream header. Renders nothing while
 * loading or when the chapter has no guides.
 */
export function GuidesSection() {
  const router = useRouter();
  const pathname = usePathname();
  const guides = useQuery(api.docs.listGuides, {});

  if (!guides || guides.length === 0) return null;

  const rank = (slug: string) => {
    const i = GUIDE_ORDER.indexOf(slug);
    return i === -1 ? GUIDE_ORDER.length : i;
  };
  const ordered = [...guides].sort(
    (a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug),
  );

  return (
    <View>
      <SectionHeader title="Guides" />
      <View className="gap-1">
        {ordered.map((g) => (
          <Pressable
            key={g.slug}
            onPress={() =>
              router.push(
                `/doc/${g._id}?from=${encodeURIComponent(pathname)}` as any,
              )
            }
            accessibilityRole="button"
            accessibilityLabel={`Open guide: ${g.title}`}
          >
            <View className="flex-row items-center gap-2.5 rounded-md px-2 py-2 active:opacity-70 web:hover:bg-sunken">
              <Icon name="book-open" size={15} color={colors.faint} />
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {g.title}
              </Text>
              <Icon name="chevron-right" size={14} color={colors.faint} />
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
