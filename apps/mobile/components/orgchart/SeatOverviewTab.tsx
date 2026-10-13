/**
 * A seat's Overview tab: who it reports to, how many people it seats, its
 * training path (its Academy courses — a chart editor picks them here), and
 * (for a chart editor) removing it.
 *
 * Every structural change here is a click on the thing itself — "Change" on
 * the reporting line opens the tree picker, the seat-size control saves on
 * tap — rather than a separate edit mode with its own buttons. The gate is
 * the same one the mutations enforce (`seatDetail.canEditPowers`: superuser
 * or `org.chart.edit`).
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { MULTI_HOLDER_CAP, SEAT_ROOT, getRolePath, seatRolePath } from "@events-os/shared";
import { Avatar, Badge, Button, Icon, type IconName } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../../lib/confirmAction";
import { CoursesPicker } from "./CoursesPicker";
import { ReportsToPicker } from "./ReportsToPicker";
import type { HolderLite } from "./SeatActions";
import type { ReportsTo, SeatNode } from "./treeUtils";

function Label({ children }: { children: string }) {
  return (
    <Text className="text-2xs font-bold uppercase tracking-wider text-muted">{children}</Text>
  );
}

export function SeatOverviewTab({
  seat,
  scope,
  maxHolders,
  courseSlugs,
  holders,
  derived,
  canEdit,
  reportsTo,
  chartSeats,
  onRemoved,
}: {
  seat: SeatNode;
  scope: "central" | Id<"chapters">;
  maxHolders: number;
  /** The seat's stored course list; absent = its built-in role path. */
  courseSlugs: string[] | undefined;
  holders: HolderLite[];
  derived: boolean;
  canEdit: boolean;
  reportsTo: ReportsTo;
  /** Every seat in this seat's chart — the "Reports to" picker's options. */
  chartSeats: readonly SeatNode[];
  onRemoved: () => void;
}) {
  const router = useRouter();
  const updateSeat = useMutation(api.seatStructure.updateSeat);
  const removeSeat = useMutation(api.seatStructure.removeSeat);
  const [moveOpen, setMoveOpen] = useState(false);
  const [savingSize, setSavingSize] = useState(false);
  const [coursesOpen, setCoursesOpen] = useState(false);
  const isRoot = seat.parentSlug === SEAT_ROOT;
  const editable = canEdit && !derived;
  // A derived seat's holders are computed, but its position isn't: moving the
  // Chapter Directors mirror is how an editor changes where the chapters report.
  const movable = canEdit && !isRoot;
  const parentTitle = chartSeats.find((s) => s.slug === seat.parentSlug)?.title ?? null;
  const rolePath = seatRolePath({ slug: seat.slug, title: seat.title, courseSlugs });
  const builtInPath = getRolePath("seat", seat.slug);
  const customized = courseSlugs !== undefined;

  async function saveCourses(next: string[] | null) {
    await updateSeat({ slug: seat.slug, courseSlugs: next });
  }

  function resetCourses() {
    confirmAction({
      title: "Go back to the standard courses?",
      message: `${seat.title} will use its built-in path again: ${builtInPath?.courseSlugs.length ?? 0} courses.`,
      confirmLabel: "Use standard courses",
      onConfirm: () =>
        void (async () => {
          try {
            await saveCourses(null);
          } catch (err) {
            alertError(err);
          }
        })(),
    });
  }

  async function setSize(next: number) {
    if (next === maxHolders) return;
    setSavingSize(true);
    try {
      await updateSeat({ slug: seat.slug, maxHolders: next });
    } catch (err) {
      alertError(err);
    } finally {
      setSavingSize(false);
    }
  }

  function remove() {
    confirmAction({
      title: `Remove ${seat.title}?`,
      message:
        "This can't be undone. The seat must already be empty, have no duties, and have no seats reporting to it.",
      confirmLabel: "Remove seat",
      destructive: true,
      onConfirm: () =>
        void (async () => {
          try {
            await removeSeat({ slug: seat.slug });
            onRemoved();
          } catch (err) {
            alertError(err);
          }
        })(),
    });
  }

  return (
    <View className="gap-5">
      <View className="gap-1.5">
        <View className="flex-row items-center justify-between gap-2">
          <Label>Reports to</Label>
          {movable ? (
            <Button title="Change" variant="ghost" size="sm" icon="corner-up-right" onPress={() => setMoveOpen(true)} />
          ) : null}
        </View>
        {isRoot ? (
          <Text className="text-sm text-muted">Top of this chart.</Text>
        ) : (
          <Text className="text-sm font-semibold text-ink">{parentTitle ?? "Another seat"}</Text>
        )}
        {reportsTo ? (
          <View className="gap-1.5">
            <Text className="text-xs text-muted">
              In practice: {reportsTo.seatTitle} · {reportsTo.scopeLabel}
            </Text>
            {reportsTo.holders.map((h) => (
              <View key={h.personId} className="flex-row items-center gap-2">
                <Avatar name={h.name} uri={h.imageUrl} size={22} />
                <Text className="text-sm text-ink">{h.name}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View className="gap-1.5">
        <Label>Seat size</Label>
        {editable ? (
          <View className="flex-row overflow-hidden rounded-md border border-border-strong">
            {[
              { value: 1, label: "One person" },
              { value: MULTI_HOLDER_CAP, label: "Several people" },
            ].map((o, i) => {
              const on = (o.value === 1) === (maxHolders === 1);
              return (
                <Pressable
                  key={o.label}
                  onPress={() => void setSize(o.value)}
                  disabled={savingSize}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  className={`flex-1 items-center py-2 ${i > 0 ? "border-l border-border-strong" : ""} ${
                    on ? "bg-accent-soft" : "bg-raised"
                  }`}
                >
                  <Text className={`text-sm ${on ? "font-semibold text-accent" : "text-muted"}`}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text className="text-sm text-ink">{maxHolders === 1 ? "One person" : "Several people"}</Text>
        )}
        {maxHolders > 1 ? (
          <Text className="text-xs text-faint">
            Up to {maxHolders} people per {scope === "central" ? "seat" : "chapter"}.
          </Text>
        ) : null}
      </View>

      {rolePath || editable ? (
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-2">
            <Label>Training</Label>
            {editable ? (
              <Button
                title={rolePath ? "Edit courses" : "Add courses"}
                variant="ghost"
                size="sm"
                icon="book-open"
                onPress={() => setCoursesOpen(true)}
              />
            ) : null}
          </View>
          {rolePath ? (
            <>
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
                      : `${rolePath.courseSlugs.length} ${rolePath.courseSlugs.length === 1 ? "course" : "courses"}`}
                  </Text>
                </View>
              </View>
              {rolePath.courseSlugs.length > 0
                ? holders.map((h) => (
                    <HolderPathProgress key={h.personId} holder={h} courseSlugs={rolePath.courseSlugs} />
                  ))
                : null}
              <Button
                title="View the path"
                variant="secondary"
                size="sm"
                onPress={() => router.push(`/academy/path/${seat.slug}?kind=seat`)}
                className="self-start"
              />
            </>
          ) : (
            <Text className="text-sm text-muted">No courses yet. Pick the ones this seat should take.</Text>
          )}
          {editable && customized && builtInPath ? (
            <Pressable onPress={resetCourses} accessibilityRole="button" className="self-start">
              <Text className="text-xs text-muted underline">Use the standard courses instead</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {editable && !isRoot ? (
        <View className="gap-1.5 border-t border-border pt-4">
          <Text className="text-xs text-muted">
            Removing a seat needs it empty, with no duties and no seats under it.
          </Text>
          <Button title="Remove seat" variant="danger" size="sm" icon="trash-2" onPress={remove} className="self-start" />
        </View>
      ) : null}

      {editable ? (
        <CoursesPicker
          visible={coursesOpen}
          seatTitle={seat.title}
          initial={rolePath?.courseSlugs ?? []}
          onSave={(next) => saveCourses(next)}
          onClose={() => setCoursesOpen(false)}
        />
      ) : null}

      {movable ? (
        <ReportsToPicker
          visible={moveOpen}
          seat={seat}
          chartSeats={chartSeats}
          onClose={() => setMoveOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** One holder's progress on the seat's role path (fully earned course badges
 *  only — there is no per-module progress query for another person). */
function HolderPathProgress({ holder, courseSlugs }: { holder: HolderLite; courseSlugs: string[] }) {
  const badges = useQuery(api.academy.personBadges, { personId: holder.personId });
  const total = courseSlugs.length;
  const earned =
    badges === undefined ? undefined : courseSlugs.filter((c) => badges.some((b) => b.courseSlug === c)).length;
  const complete = earned !== undefined && total > 0 && earned === total;
  return (
    <View className="flex-row items-center gap-2.5">
      <Avatar name={holder.name} uri={holder.imageUrl} size={24} />
      <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
        {holder.name}
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
