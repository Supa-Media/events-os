import { View, Pressable } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Which platform guide teaches each area (module key → guide slug under
 * docs/guides/). Areas whose specific guide isn't written yet — and
 * custom areas, which aren't in this map at all — fall back to the
 * generic "So you own an area" guide.
 */
const MODULE_GUIDE_SLUGS: Record<string, string> = {
  planning_doc: "owning-the-planning-doc",
  comms: "owning-the-comms-workstream",
  run_of_show: "owning-the-run-of-show",
  volunteer_expectations: "owning-expectations",
  supplies: "owning-supplies-and-logistics",
  permits: "owning-permits",
  retro: "owning-the-retro",
};

/** The generic area-owner guide every area can fall back to. */
const FALLBACK_GUIDE_SLUG = "so-you-own-a-workstream";

/**
 * Quiet "How this works" affordance for an area's section header: a small
 * "?" that opens the platform guide for this area (its specific guide
 * when seeded, else the generic area-owner guide). Renders nothing when
 * the chapter has neither doc — so it never points at a missing page.
 *
 * Reads the same `listGuides` query as GuidesSection — the Convex client
 * dedupes identical useQuery(fn, args) pairs into ONE subscription, so every
 * GuideLink on the page (plus the Guides section) shares a single query
 * instead of fanning out per-header slug lookups with a fallback waterfall.
 * Specific-vs-fallback resolution happens client-side on the small guide list.
 */
export function GuideLink({ moduleKey }: { moduleKey: string }) {
  const router = useRouter();
  const pathname = usePathname();

  const guides = useQuery(api.docs.listGuides, {});

  const slug = MODULE_GUIDE_SLUGS[moduleKey] ?? FALLBACK_GUIDE_SLUG;
  const guide =
    guides?.find((g) => g.slug === slug) ??
    guides?.find((g) => g.slug === FALLBACK_GUIDE_SLUG) ??
    null;
  if (!guide) return null;

  return (
    <Pressable
      onPress={() =>
        router.push(
          `/doc/${guide._id}?from=${encodeURIComponent(pathname)}` as any,
        )
      }
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`How this works: ${guide.title}`}
    >
      <View className="rounded-pill p-1.5 active:opacity-70 web:hover:bg-sunken">
        <Icon name="help-circle" size={15} color={colors.faint} />
      </View>
    </Pressable>
  );
}
