import { useMemo, useState } from "react";
import { View, Text, Image, Pressable } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  PageHeader,
  Card,
  Button,
  Icon,
  EmptyState,
  OptionTag,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";

type Phase = "in" | "out";

/** The fields-bag boolean key the active phase reads/writes. */
const PACKED_KEY: Record<Phase, "packedIn" | "packedOut"> = {
  in: "packedIn",
  out: "packedOut",
};

type Option = { value: string; label: string; color?: string | null };

/** Resolve an option's label + color from its stored value. */
function resolveOption(
  options: Option[] | undefined,
  value: unknown,
): Option | null {
  if (typeof value !== "string" || !value) return null;
  return (options ?? []).find((o) => o.value === value) ?? null;
}

/** Read a field from an item's fields bag (default falsy). */
function field(item: any, key: string): unknown {
  return item?.fields?.[key];
}

/** Thin progress bar driven by a 0..1 fraction. */
function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const done = pct >= 100;
  return (
    <View className="h-2 w-full overflow-hidden rounded-pill bg-sunken">
      <View
        className="h-full rounded-pill"
        style={{
          width: `${pct}%`,
          backgroundColor: done ? colors.success : colors.accent,
        }}
      />
    </View>
  );
}

/** Small rounded item photo, or a placeholder icon when there's no URL photo. */
function ItemPhoto({ photo }: { photo: unknown }) {
  const isUrl = typeof photo === "string" && photo.startsWith("http");
  if (isUrl) {
    return (
      <Image
        source={{ uri: photo as string }}
        className="h-11 w-11 rounded-md bg-sunken"
        resizeMode="cover"
      />
    );
  }
  return (
    <View className="h-11 w-11 items-center justify-center rounded-md border border-border bg-sunken">
      <Icon name="image" size={18} color={colors.faint} />
    </View>
  );
}

/** A tappable round check control that toggles the active-phase packed boolean. */
function CheckControl({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onToggle}
      hitSlop={8}
      className="active:opacity-70"
    >
      <View
        className="h-9 w-9 items-center justify-center rounded-pill border-2"
        style={{
          borderColor: checked ? colors.success : colors.borderStrong,
          backgroundColor: checked ? colors.success : colors.raised,
        }}
      >
        {checked ? <Icon name="check" size={18} color="#FFFFFF" /> : null}
      </View>
    </Pressable>
  );
}

/** One packable item row inside a container card. */
function ItemRow({
  item,
  sourceCol,
  checked,
  onToggle,
}: {
  item: any;
  sourceCol: any;
  checked: boolean;
  onToggle: () => void;
}) {
  const source = resolveOption(sourceCol?.options, field(item, "source"));
  return (
    <View
      className="flex-row items-center gap-3 rounded-md px-1 py-2"
      style={{ opacity: checked ? 0.55 : 1 }}
    >
      <ItemPhoto photo={field(item, "photo")} />
      <View className="flex-1 gap-1">
        <Text
          className="text-base font-semibold text-ink"
          style={checked ? { textDecorationLine: "line-through" } : undefined}
          numberOfLines={2}
        >
          {item.title || "Untitled item"}
        </Text>
        {source ? (
          <OptionTag label={source.label} color={source.color} />
        ) : null}
      </View>
      <CheckControl checked={checked} onToggle={onToggle} />
    </View>
  );
}

/** One container's grouped card: colored header tag + count + item rows. */
function ContainerCard({
  label,
  color,
  items,
  sourceCol,
  phaseKey,
  onToggle,
}: {
  label: string;
  color?: string | null;
  items: any[];
  sourceCol: any;
  phaseKey: "packedIn" | "packedOut";
  onToggle: (item: any, next: boolean) => void;
}) {
  const checked = items.filter((it) => !!field(it, phaseKey)).length;
  const allDone = items.length > 0 && checked === items.length;
  return (
    <Card padding="md">
      <View className="mb-1 flex-row items-center justify-between gap-2">
        <OptionTag label={label} color={color} />
        <View className="flex-row items-center gap-1.5">
          {allDone ? (
            <Icon name="check-circle" size={15} color={colors.success} />
          ) : null}
          <Text
            className="text-sm font-bold"
            style={{ color: allDone ? colors.success : colors.muted }}
          >
            {checked}/{items.length}
          </Text>
        </View>
      </View>
      <View className="divide-y divide-border">
        {items.map((it) => {
          const isChecked = !!field(it, phaseKey);
          return (
            <ItemRow
              key={it._id}
              item={it}
              sourceCol={sourceCol}
              checked={isChecked}
              onToggle={() => onToggle(it, !isChecked)}
            />
          );
        })}
      </View>
    </Card>
  );
}

/** PACKING MODE: check supplies in (load-in) and back out (load-out), grouped by container. */
export default function PackingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const eventId = id as any;

  const [phase, setPhase] = useState<Phase>("in");
  const phaseKey = PACKED_KEY[phase];

  const eventData = useQuery(api.events.get, { eventId });
  const data = useQuery(api.items.listForEventModule, {
    eventId,
    module: "supplies",
  });
  const updateItem = useMutation(api.items.updateEventItem);

  const toggle = (item: any, next: boolean) => {
    updateItem({ itemId: item._id, fields: { [phaseKey]: next } });
  };

  const containerCol = useMemo(
    () => data?.columns?.find((c: any) => c.key === "container") ?? null,
    [data],
  );
  const sourceCol = useMemo(
    () => data?.columns?.find((c: any) => c.key === "source") ?? null,
    [data],
  );

  // Group items by container option (in option order), with a trailing
  // "No container" bucket for items that have no container value.
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    const options: Option[] = containerCol?.options ?? [];
    const buckets = options.map((opt) => ({
      key: opt.value,
      label: opt.label,
      color: opt.color,
      items: items.filter((it: any) => field(it, "container") === opt.value),
    }));
    const known = new Set(options.map((o) => o.value));
    const orphans = items.filter((it: any) => {
      const c = field(it, "container");
      return typeof c !== "string" || !c || !known.has(c);
    });
    if (orphans.length > 0) {
      buckets.push({
        key: "__none__",
        label: "No container",
        color: "gray",
        items: orphans,
      });
    }
    return buckets.filter((b) => b.items.length > 0);
  }, [data, containerCol]);

  const { total, checked } = useMemo(() => {
    const items = data?.items ?? [];
    return {
      total: items.length,
      checked: items.filter((it: any) => !!field(it, phaseKey)).length,
    };
  }, [data, phaseKey]);

  if (eventData === undefined || data === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Packing" }} />
        <Screen loading />
      </>
    );
  }

  const eventName = eventData?.event?.name ?? "Event";
  const allPacked = total > 0 && checked === total;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Packing" }} />
      <Screen>
        <PageHeader
          eyebrow={eventName}
          title="Packing"
          subtitle="Check supplies in and back out so nothing gets left behind."
          actions={
            <Button
              title="Back"
              variant="ghost"
              icon="arrow-left"
              onPress={() => router.back()}
            />
          }
        />

        {/* Phase toggle (segmented) */}
        <View className="mb-5 flex-row self-start rounded-md border border-border bg-sunken p-1">
          <PhaseTab
            label="Load-in"
            icon="download"
            active={phase === "in"}
            onPress={() => setPhase("in")}
          />
          <PhaseTab
            label="Load-out"
            icon="upload"
            active={phase === "out"}
            onPress={() => setPhase("out")}
          />
        </View>

        {total === 0 ? (
          <EmptyState
            icon="package"
            title="Nothing to pack yet"
            message="Add supplies to this event to start packing."
          />
        ) : (
          <>
            {/* Overall progress / success banner */}
            {allPacked ? (
              <View className="mb-5 flex-row items-center gap-3 rounded-lg border border-success bg-success-bg px-4 py-3">
                <Icon name="check-circle" size={22} color={colors.success} />
                <Text className="flex-1 text-base font-bold text-success">
                  Everything's accounted for
                </Text>
              </View>
            ) : (
              <View className="mb-5 gap-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold text-ink">
                    {checked}/{total} packed
                  </Text>
                  <Text className="text-sm font-medium text-muted">
                    {phase === "in" ? "Loading in" : "Loading out"}
                  </Text>
                </View>
                <ProgressBar fraction={total === 0 ? 0 : checked / total} />
              </View>
            )}

            {/* Grouped by container */}
            <View className="gap-4">
              {groups.map((g) => (
                <ContainerCard
                  key={g.key}
                  label={g.label}
                  color={g.color}
                  items={g.items}
                  sourceCol={sourceCol}
                  phaseKey={phaseKey}
                  onToggle={toggle}
                />
              ))}
            </View>
          </>
        )}
      </Screen>
    </>
  );
}

/** A single segment in the load-in / load-out toggle. */
function PhaseTab({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: "download" | "upload";
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`flex-row items-center gap-2 rounded-sm px-4 py-2 ${
        active ? "bg-raised shadow-card" : ""
      }`}
    >
      <Icon
        name={icon}
        size={15}
        color={active ? colors.accent : colors.muted}
      />
      <Text
        className={`text-sm font-bold ${active ? "text-accent" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
