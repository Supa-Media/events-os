import { Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";

/**
 * The shared "go back" affordance for detail pages that can be reached from
 * more than one place (a person's workload, a list, a deep link…). Hardcoding
 * a single target sends you somewhere OTHER than where you came from the
 * moment a second entry point exists — this returns you to the actual
 * previous page instead.
 *
 * Precedence mirrors the doc editor's back button (`app/(app)/doc/[id].tsx`),
 * the app's one existing correct implementation:
 *   1. `from` (if passed) — an explicit origin path, `replace`d to (not
 *      pushed, so it never stacks a duplicate history entry).
 *   2. `router.canGoBack()` — step back through real navigation history.
 *   3. `fallback` — for deep links / no-history landings (a shared URL
 *      opened directly), where there's nothing to go back to.
 */
export function BackLink({
  fallback,
  label = "Back",
  from,
}: {
  /** Route to land on when there's no history to go back through. */
  fallback: string;
  label?: string;
  /** Optional origin path (e.g. from `usePathname()` at the linking site) —
   *  takes precedence over history when present. */
  from?: string;
}) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => {
        if (from) router.replace(decodeURIComponent(from) as any);
        else if (router.canGoBack()) router.back();
        else router.replace(fallback as any);
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="mb-4 flex-row items-center gap-1.5 self-start active:opacity-70"
    >
      <Icon name="arrow-left" size={15} color={colors.muted} />
      <Text className="text-sm font-medium text-muted">{label}</Text>
    </Pressable>
  );
}
