/**
 * TimingCell — the planning grid's TIMING column (`offset_days`).
 *
 * An item's timing is a single signed day offset from the event (negative =
 * before, 0 = day-of, positive = after); the DUE date is derived from it. Rather
 * than force people to type "T-14", this opens a designed dropdown:
 *
 *   • a live preview that resolves the relative offset to the real calendar day,
 *   • preset rows laid out along the event timeline (each showing its date),
 *   • a Before/After + stepper for any custom offset — still fully typeable.
 *
 * Picking writes back the signed offset via the normal grid `onChange`, which
 * reflows both the TIMING chip and the DUE date together.
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { formatOffsetDays, computeDueDate } from "@events-os/shared";
import { formatDate } from "../../lib/format";
import { colors } from "../../lib/theme";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { useAnchor } from "../ui/useAnchor";

/** Curated quick-picks along the event timeline (mirrors the seed templates). */
const PRESETS = [-21, -14, -7, -3, -1, 0, 2];

/** "3 weeks before" / "1 day after" / "Event day" — a human gloss on the offset. */
function humanizeOffset(n: number): string {
  if (n === 0) return "Event day";
  const abs = Math.abs(n);
  const unit =
    abs % 7 === 0
      ? `${abs / 7} week${abs / 7 === 1 ? "" : "s"}`
      : `${abs} day${abs === 1 ? "" : "s"}`;
  return `${unit} ${n < 0 ? "before" : "after"}`;
}

export function TimingCell({
  value,
  eventDate,
  editable,
  onChange,
}: {
  value: number | null | undefined;
  eventDate?: number;
  editable: boolean;
  onChange: (value: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  const chip =
    value != null ? (
      <View className="self-start rounded-sm bg-sunken px-2 py-0.5">
        <Text className="text-xs font-semibold text-muted">
          {formatOffsetDays(value)}
        </Text>
      </View>
    ) : (
      <Text className="text-sm text-faint">T-…</Text>
    );

  if (!editable) {
    return <View className="px-2 py-1.5">{chip}</View>;
  }

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70"
      >
        {chip}
        <Icon name="chevron-down" size={13} color={colors.faint} />
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <TimingPanel
          value={value ?? null}
          eventDate={eventDate}
          commit={onChange}
          close={close}
        />
      </Popover>
    </>
  );
}

/**
 * The timing dropdown's body — exported so the Module Calendar's day-panel cards
 * can reuse the exact same editor. `live` (the grid default) commits every tweak
 * as it happens; with `live: false` the custom controls only build a draft and an
 * explicit "Set timing" row commits it — the calendar needs this because a commit
 * moves the card to another day, unmounting the popover mid-edit.
 */
export function TimingPanel({
  value,
  eventDate,
  commit,
  close,
  live = true,
}: {
  value: number | null;
  eventDate?: number;
  commit: (offset: number) => void;
  close: () => void;
  live?: boolean;
}) {
  // Draft drives the header preview + custom controls; presets bypass it
  // (apply + close immediately). Seed custom from the current value, else T-7.
  const [draft, setDraft] = useState<number>(value ?? -7);

  const resolved = (offset: number) =>
    eventDate != null ? formatDate(computeDueDate(eventDate, offset)) : null;

  const after = draft > 0;
  const absDays = Math.abs(draft);

  const setCustom = (offset: number) => {
    setDraft(offset);
    if (live) commit(offset); // live — the row behind updates as you tweak
  };

  return (
    <View className="py-1.5">
      {/* Live preview — relative offset resolved to the real day */}
      <View className="flex-row items-center gap-2 px-3 pb-2 pt-1">
        <View className="rounded-sm bg-accent-soft px-2 py-0.5">
          <Text className="text-xs font-bold text-accent">
            {formatOffsetDays(draft)}
          </Text>
        </View>
        <Text className="flex-1 text-xs text-muted" numberOfLines={1}>
          {resolved(draft) ? `Falls on ${resolved(draft)}` : humanizeOffset(draft)}
        </Text>
      </View>

      <View className="h-px bg-border" />

      {/* Presets — the event timeline, each with its resulting date */}
      <View className="py-1">
        {PRESETS.map((p) => (
          <PresetRow
            key={p}
            offset={p}
            date={resolved(p)}
            selected={value === p}
            onPress={() => {
              commit(p);
              close();
            }}
          />
        ))}
      </View>

      <View className="h-px bg-border" />

      {/* Custom — direction toggle + typeable stepper (no sign-wrangling) */}
      <View className="px-3 pb-1 pt-2">
        <Text className="mb-1.5 text-2xs font-bold uppercase tracking-wide text-faint">
          Custom
        </Text>
        <View className="flex-row items-center justify-between gap-2">
          {/* Before / After segmented */}
          <View className="flex-row rounded-md border border-border bg-sunken p-0.5">
            <DirButton
              label="Before"
              active={!after && absDays !== 0}
              onPress={() => setCustom(-(absDays || 1))}
            />
            <DirButton
              label="After"
              active={after}
              onPress={() => setCustom(absDays || 1)}
            />
          </View>

          {/* − [n] + stepper. Always acts on the displayed magnitude — minus
              reduces the number, plus increases it — regardless of direction;
              Before/After owns the sign. The number is also typeable. */}
          <View className="flex-row items-center gap-1.5">
            <StepBtn
              icon="minus"
              onPress={() => {
                const n = Math.max(0, absDays - 1);
                setCustom(after ? n : -n);
              }}
            />
            <TextInput
              value={String(absDays)}
              onChangeText={(t) => {
                const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
                const next = Number.isFinite(n) ? n : 0;
                setCustom(after ? next : -next);
              }}
              keyboardType="number-pad"
              selectTextOnFocus
              className="h-7 w-9 rounded-md border border-border bg-raised text-center text-sm text-ink"
            />
            <StepBtn
              icon="plus"
              onPress={() => {
                const n = absDays + 1;
                setCustom(after ? n : -n);
              }}
            />
          </View>
        </View>
        <Text className="mt-1.5 text-2xs text-faint">
          {absDays === 0
            ? "0 = the event day"
            : `${absDays} day${absDays === 1 ? "" : "s"} ${after ? "after" : "before"} the event`}
        </Text>

        {/* Draft mode: nothing has been written yet — commit the draft here. */}
        {!live ? (
          <Pressable
            onPress={() => {
              commit(draft);
              close();
            }}
            className="mt-2 items-center rounded-md bg-accent py-1.5 active:opacity-80"
          >
            <Text className="text-xs font-bold text-white">
              Set to {formatOffsetDays(draft)}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function PresetRow({
  offset,
  date,
  selected,
  onPress,
}: {
  offset: number;
  date: string | null;
  selected: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = selected ? "bg-accent-soft" : hovered ? "bg-sunken" : "";

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`mx-1.5 flex-row items-center gap-2.5 rounded-md px-1.5 py-1 ${bg}`}
    >
      {/* fixed-width chip so labels and captions align into clean columns */}
      <View
        className={`w-12 items-center rounded-sm py-0.5 ${selected ? "bg-accent" : "bg-sunken"}`}
      >
        <Text
          className={`text-xs font-semibold ${selected ? "text-white" : "text-muted"}`}
        >
          {formatOffsetDays(offset)}
        </Text>
      </View>
      <Text
        className={`flex-1 text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}
        numberOfLines={1}
      >
        {humanizeOffset(offset)}
      </Text>
      {date ? <Text className="text-xs text-faint">{date}</Text> : null}
      {selected ? <Icon name="check" size={14} color={colors.accent} /> : null}
    </Pressable>
  );
}

function DirButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-[5px] px-2.5 py-1 ${active ? "bg-raised shadow-card" : ""}`}
    >
      <Text
        className={`text-xs font-semibold ${active ? "text-ink" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function StepBtn({
  icon,
  onPress,
}: {
  icon: "minus" | "plus";
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`h-7 w-7 items-center justify-center rounded-md border border-border ${hovered ? "bg-sunken" : "bg-raised"}`}
    >
      <Icon name={icon} size={14} color={colors.muted} />
    </Pressable>
  );
}
