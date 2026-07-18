import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  getRolePath,
  RESPONSIBILITY_CADENCE_LABELS,
  SEAT_ROOT,
} from "@events-os/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  type IconName,
  SectionHeader,
} from "../ui";
import { colors } from "../../lib/theme";
import { SeatActionsPanel } from "./SeatActions";
import { RenameSeatControl, StructureEditActions } from "./StructureEditor";
import {
  avatarNameFor,
  capabilityLabel,
  type ReportsTo,
  type SeatDetail,
  type TreeNode,
} from "./treeUtils";

/**
 * The seat detail panel — right side on wide screens, full-width below the
 * tree on narrow (the caller decides layout; this just renders the content
 * column). Shows scope + holder-count, the seat title, who holds it, its
 * duties, its powers (capabilities translated to plain language), and who it
 * reports to (computed client-side in `treeUtils.computeReportsTo`).
 *
 * DUTIES come from `responsibilities.dutiesForSeat` — the REAL duties mapped
 * to this seat in Work → Duties (title + cadence) — NOT `detail.duties`
 * (`seatDefs.duties`), which is a seeded TEMPLATE string list the owner calls
 * "fake duties". That field stays in the schema (still editable nowhere —
 * see `StructureEditor.tsx`'s doc comment) but is never rendered here.
 *
 * Adds two OPTIONAL interactive layers on top of that same read-only view:
 *  - `SeatActionsPanel` (propose a change / assign directly) for any
 *    non-derived seat.
 *  - `StructureEditActions` + an inline rename control, shown only when
 *    `editMode` is true (the screen only sets it true for an eligible
 *    editor — see `org-chart.tsx`).
 * A caller that omits `isSuperuser`/`editMode`/`chartSeatOptions` gets back
 * EXACTLY the shipped read-only panel — no behavior change for anyone who
 * doesn't pass them.
 */
export function SeatDetailPanel({
  selected,
  scopeName,
  detail,
  reportsTo,
  isSuperuser = false,
  editMode = false,
  chartSeatOptions = [],
  onSeatRemoved,
}: {
  selected: TreeNode | null;
  scopeName: string;
  detail: SeatDetail | null | undefined;
  reportsTo: ReportsTo;
  /** Enables the "Assign directly" action for a superuser caller. */
  isSuperuser?: boolean;
  /** True only when the caller passed the `org.editChart` gate — see
   *  `org-chart.tsx`'s `canEditStructure`. */
  editMode?: boolean;
  /** Every OTHER seat in the SAME chart as the selected seat — reparent
   *  candidates for `StructureEditActions`' "Move" picker. */
  chartSeatOptions?: { slug: string; title: string }[];
  /** Called after a successful `removeSeat` so the screen can clear the
   *  now-nonexistent selection. */
  onSeatRemoved?: () => void;
}) {
  // Hooks run unconditionally, before the early returns below (rules of
  // hooks) — `"skip"` while there's no seat selected yet, same pattern
  // `org-chart.tsx` uses for `seats.seatDetail` itself.
  const duties = useQuery(
    api.responsibilities.dutiesForSeat,
    selected ? { seatDefId: selected.seat.defId } : "skip",
  );
  const router = useRouter();

  if (!selected) {
    return (
      <EmptyState
        icon="git-branch"
        title="Select a seat"
        message="Tap any box in the chart to see who holds it, their duties, and what they can do."
      />
    );
  }

  if (detail === undefined) {
    return (
      <Card>
        <View className="items-center justify-center py-10">
          <ActivityIndicator color={colors.accent} />
        </View>
      </Card>
    );
  }

  if (detail === null) {
    return <EmptyState icon="alert-circle" title="Seat not found" />;
  }

  const holderCountLabel =
    detail.holders.length === 0
      ? "Vacant"
      : detail.holders.length === 1
        ? "One holder"
        : "Multiple holders";

  // The role path for this seat, if any — org-chart seats are always
  // `kind: "seat"` (never event hats), so the lookup is unambiguous. The
  // derived-only rollup seat (`chapter_directors`) has none; guard for it.
  const rolePath = getRolePath("seat", detail.slug);

  return (
    <Card>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {scopeName} · {holderCountLabel}
      </Text>
      <View className="mt-1 flex-row items-center gap-2">
        <Text className="font-display text-2xl text-ink">{detail.title}</Text>
        {editMode ? <RenameSeatControl slug={detail.slug} title={detail.title} /> : null}
      </View>
      {detail.derived ? (
        <Text className="mt-1 text-xs italic text-faint">
          Mirrors each chapter — computed, never assigned directly.
        </Text>
      ) : null}

      {!detail.derived ? (
        <SeatActionsPanel
          seatDefId={detail.defId}
          scope={selected.scope}
          seatTitle={detail.title}
          maxHolders={detail.maxHolders}
          holders={detail.holders}
          isSuperuser={isSuperuser}
        />
      ) : null}

      {editMode && !detail.derived ? (
        <StructureEditActions
          slug={detail.slug}
          seatTitle={detail.title}
          chart={detail.chart}
          maxHolders={detail.maxHolders}
          capabilities={detail.capabilities}
          parentSlug={selected.seat.parentSlug}
          siblingSeats={chartSeatOptions}
          onRemoved={() => onSeatRemoved?.()}
        />
      ) : null}

      <SectionHeader title="Held by" />
      {detail.holders.length === 0 ? (
        <Text className="text-sm italic text-faint">Vacant</Text>
      ) : (
        <View className="gap-2.5">
          {detail.holders.map((h) => (
            <View key={h.personId} className="flex-row items-center gap-2.5">
              <Avatar name={avatarNameFor(h.name)} uri={h.imageUrl} size={28} />
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {h.name}
              </Text>
            </View>
          ))}
        </View>
      )}

      {rolePath ? (
        <>
          <SectionHeader title="Training" />
          <View className="gap-2.5">
            {/* Path identity — icon + title + course count, mirroring the
                role-path detail page's header treatment. */}
            <View className="flex-row items-center gap-2.5">
              <View className="h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
                <Icon name={rolePath.icon as IconName} size={16} color={colors.accent} />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                  {rolePath.title}
                </Text>
                <Text className="text-xs text-muted">
                  {rolePath.courseSlugs.length === 0
                    ? "Courses on the way"
                    : `${rolePath.courseSlugs.length} ${
                        rolePath.courseSlugs.length === 1 ? "course" : "courses"
                      }`}
                </Text>
              </View>
            </View>

            {/* Per-holder progress on THIS path's courses. Only holders (and
                only when the path has real courses) — one `personBadges` query
                per holder, which is fine at typical seat holder counts of 1. */}
            {rolePath.courseSlugs.length > 0 && detail.holders.length > 0 ? (
              <View className="gap-2">
                {detail.holders.map((h) => (
                  <HolderPathProgress
                    key={h.personId}
                    personId={h.personId}
                    name={h.name}
                    imageUrl={h.imageUrl}
                    courseSlugs={rolePath.courseSlugs}
                  />
                ))}
              </View>
            ) : null}

            <Button
              title="View the path →"
              variant="secondary"
              size="sm"
              onPress={() => router.push(`/academy/path/${detail.slug}?kind=seat`)}
              className="mt-0.5 self-start"
            />
          </View>
        </>
      ) : null}

      <SectionHeader title="Duties" />
      {duties === undefined ? (
        <View className="items-start py-2">
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      ) : duties.length === 0 ? (
        <Text className="text-sm text-muted">
          No duties mapped yet — attach them in Work → Duties.
        </Text>
      ) : (
        <View className="gap-1.5">
          {duties.map((d) => (
            <View key={d.id} className="flex-row items-start justify-between gap-2">
              <View className="flex-row items-start gap-2">
                <Text className="mt-0.5 text-sm text-muted">·</Text>
                <Text className="flex-1 text-sm text-ink">{d.title}</Text>
              </View>
              <Text className="text-xs text-muted">{RESPONSIBILITY_CADENCE_LABELS[d.cadence]}</Text>
            </View>
          ))}
        </View>
      )}

      <SectionHeader title="Powers" />
      {detail.capabilities.length === 0 ? (
        <Text className="text-sm text-muted">No special powers — standard member access.</Text>
      ) : (
        <View className="flex-row flex-wrap gap-1.5">
          {detail.capabilities.map((c) => (
            <Badge key={c} label={capabilityLabel(c)} tone="accent" />
          ))}
        </View>
      )}

      <SectionHeader title="Reports to" />
      {reportsTo === null ? (
        <Text className="text-sm text-muted">
          {selected.scope === "central" && selected.seat.parentSlug === SEAT_ROOT
            ? "Top of the org chart."
            : "Nothing further up — every seat above is either vacant or held by the same person."}
        </Text>
      ) : (
        <View className="gap-1">
          <Text className="text-sm font-semibold text-ink">
            {reportsTo.seatTitle}
            <Text className="font-normal text-muted"> · {reportsTo.scopeLabel}</Text>
          </Text>
          <View className="mt-1 gap-2">
            {reportsTo.holders.map((h) => (
              <View key={h.personId} className="flex-row items-center gap-2">
                <Avatar name={avatarNameFor(h.name)} uri={h.imageUrl} size={22} />
                <Text className="text-sm text-ink">{h.name}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </Card>
  );
}

/**
 * One holder's progress on a role path, scoped to that path's courses. Reads
 * `academy.personBadges` (fully-EARNED course badges only — there is no
 * per-module progress query for another person) and shows how many of the
 * path's own courses they've completed. One query per holder; holder counts
 * are low per seat (usually 1), so this stays cheap. Row layout matches the
 * "Held by" list above (Avatar + name).
 */
function HolderPathProgress({
  personId,
  name,
  imageUrl,
  courseSlugs,
}: {
  personId: Id<"people">;
  name: string;
  imageUrl: string | null;
  courseSlugs: string[];
}) {
  const badges = useQuery(api.academy.personBadges, { personId });
  const total = courseSlugs.length;
  const earned =
    badges === undefined
      ? undefined
      : courseSlugs.filter((slug) => badges.some((b) => b.courseSlug === slug)).length;
  const complete = earned !== undefined && total > 0 && earned === total;

  return (
    <View className="flex-row items-center gap-2.5">
      <Avatar name={avatarNameFor(name)} uri={imageUrl} size={28} />
      <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
        {name}
      </Text>
      {badges === undefined ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <Badge
          label={`${earned}/${total} courses`}
          tone={complete ? "success" : "neutral"}
          icon={complete ? "award" : undefined}
        />
      )}
    </View>
  );
}
