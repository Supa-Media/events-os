import { View, Pressable } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Which platform guide teaches each workstream (module key → guide slug under
 * docs/guides/). Workstreams whose specific guide isn't written yet — and
 * custom workstreams, which aren't in this map at all — fall back to the
 * generic "So you own a workstream" guide.
 */
const MODULE_GUIDE_SLUGS: Record<string, string> = {
  planning_doc: "owning-the-planning-doc",
  comms: "owning-the-comms-workstream",
  run_of_show: "owning-the-run-of-show",
  volunteer_expectations: "owning-expectations",
  site_map: "owning-the-site-map",
  supplies: "owning-supplies-and-packing",
  permits: "owning-permits",
  retro: "owning-the-retro",
};

/** The generic workstream-owner guide every workstream can fall back to. */
const FALLBACK_GUIDE_SLUG = "so-you-own-a-workstream";

/**
 * Quiet "How this works" affordance for a workstream's section header: a small
 * "?" that opens the platform guide for this workstream (its specific guide
 * when seeded, else the generic workstream-owner guide). Renders nothing when
 * the chapter has neither doc — so it never points at a missing page.
 */
export function GuideLink({ moduleKey }: { moduleKey: string }) {
  const router = useRouter();
  const pathname = usePathname();

  const slug = MODULE_GUIDE_SLUGS[moduleKey] ?? FALLBACK_GUIDE_SLUG;
  const specific = useQuery(api.docs.getGuideBySlug, { slug });
  // Only fetch the fallback once the specific guide is known to be missing.
  const fallback = useQuery(
    api.docs.getGuideBySlug,
    specific === null && slug !== FALLBACK_GUIDE_SLUG
      ? { slug: FALLBACK_GUIDE_SLUG }
      : "skip",
  );

  const guide = specific ?? fallback ?? null;
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
