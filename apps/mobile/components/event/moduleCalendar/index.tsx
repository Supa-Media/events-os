/**
 * MODULE CALENDAR — a month view for any day-offset module (Comms Schedule,
 * Planning Doc). The same data a module shows as a table, read as a calendar:
 * every item lands on its due day, the EVENT's own day is anchored above and
 * flagged in the grid, and a day panel details the selected day. Cards edit
 * everything in place — title, status, timing, and every other column via field
 * chips — and an item moves days three ways: long-press-drag onto a day, the
 * timing chip's presets/stepper, or move mode ("pick a day on the calendar").
 * Every move confirms with an Undo toast. What each module surfaces (channel
 * logos vs status glyphs, which fields to capture) is declared in
 * {@link MODULE_CALENDAR_CONFIG} and threaded through here — no per-module
 * views. Rendered from `ModuleSection`'s table ↔ calendar toggle.
 */
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import {
  calendarMonthGrid,
  commsTimingLabel,
  offsetDaysBetween,
} from "@events-os/shared";
import { Card, Button } from "../../ui";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { optionColor } from "../../../lib/optionColor";
import {
  WEEKDAYS,
  MONTHS,
  asArray,
  channelIcon,
  statusIcon,
  readCopy,
  type ModuleCalendarConfig,
  type ScheduleItem,
  type SelectOption,
} from "./config";
import { useModuleCalendar } from "./useModuleCalendar";
import { useCalendarDrag, DraggableCard, DragAnimated } from "./dragToReschedule";
import { EventBanner } from "./EventBanner";
import { DayCell } from "./DayCell";
import { DayPanel } from "./DayPanel";
import { ItemCard } from "./ItemCard";
import { Composer } from "./Composer";
import { Legend, type LegendEntry } from "./badges";

export function ModuleCalendar({
  eventId,
  eventDate,
  config,
  filterItemIds,
}: {
  eventId: string;
  eventDate: number;
  config: ModuleCalendarConfig;
  /** Me view: only show these item ids. */
  filterItemIds?: Set<string> | null;
}) {
  const cal = useModuleCalendar({ eventId, eventDate, config, filterItemIds });
  const {
    loading, wide, today, eventDay, view, selected, setSelected,
    composing, setComposing, items, byDay, unscheduled,
    optionSets, columnLabel, statusOpts, statusMap,
  } = cal;

  // Long-press-drag a card onto a day — dropping reschedules (with Undo).
  const drag = useCalendarDrag({
    onDrop: (item, dayMs) =>
      cal.reschedule(item, offsetDaysBetween(eventDate, dayMs)),
  });

  const badgeMap = config.badgeField ? optionSets[config.badgeField]?.map : undefined;

  const legend = useMemo<LegendEntry[]>(() => {
    if (config.badgeField) {
      const map = optionSets[config.badgeField]?.map;
      const seen = new Set<string>();
      const used: string[] = [];
      for (const it of items)
        for (const v of asArray(it.fields?.[config.badgeField]))
          if (!seen.has(v)) {
            seen.add(v);
            used.push(v);
          }
      return used.map((v) => ({
        icon: channelIcon(v),
        color: optionColor(map?.get(v)?.color).text,
        label: map?.get(v)?.label ?? v,
      }));
    }
    return statusOpts.map((o) => ({
      icon: statusIcon(o.value),
      color: optionColor(o.color).text,
      label: o.label,
    }));
  }, [config.badgeField, items, optionSets, statusOpts]);

  const composerGroups = config.composerFields.map((field) => ({
    field,
    label: columnLabel(field),
    options: optionSets[field]?.list ?? [],
    withIcons: field === config.badgeField,
  }));

  const renderItemCard = (item: ScheduleItem) => (
    <DraggableCard key={item._id} drag={drag} item={item}>
      <ItemCard
        item={item}
        eventDate={eventDate}
        statusOpts={statusOpts}
        statusMap={statusMap}
        badgeField={config.badgeField}
        badgeMap={badgeMap}
        badgeColumn={cal.badgeColumn}
        chipCols={cal.chipCols}
        roles={cal.roles}
        copyLabel={config.copyLabel}
        copyPlaceholder={config.copyPlaceholder}
        initialCopy={readCopy(item, config.copyField)}
        onSetStatus={(status) => cal.setStatus(item, status)}
        onSetOffset={(offset) => cal.reschedule(item, offset)}
        onPickOnCalendar={() => cal.startMove(item)}
        onSaveField={(column, value) => cal.saveField(item, column, value)}
        onSaveCopy={(copy) => cal.saveCopy(item, copy)}
        onSaveTitle={(title) => cal.saveTitle(item, title)}
      />
    </DraggableCard>
  );

  if (loading) {
    return (
      <View className="py-16">
        <Text className="text-center text-sm text-muted">Loading schedule…</Text>
      </View>
    );
  }

  const cells = calendarMonthGrid(view.year, view.month);
  const selectedItems = (byDay.get(selected) ?? []).map((x) => x.item);
  const moving = cal.moving;

  // The drag ghost's caption resolves the hovered day before the drop commits.
  const ghostTarget =
    drag.dragging && drag.hoverDay != null
      ? `${formatDate(drag.hoverDay)} · ${commsTimingLabel(
          offsetDaysBetween(eventDate, drag.hoverDay),
        )}`
      : drag.dragging
        ? commsTimingLabel(drag.dragging.offsetDays)
        : "";

  return (
    <View ref={drag.containerRef} collapsable={false}>
      {/* Month nav: prev · serif month · next, with a jump-to-today reset. */}
      <View className="mb-4 flex-row items-center gap-3">
        <NavButton icon="chevron-left" onPress={() => cal.step(-1)} />
        <Text className="font-display text-2xl text-ink">
          {MONTHS[view.month]} {view.year}
        </Text>
        <NavButton icon="chevron-right" onPress={() => cal.step(1)} />
        <View className="flex-1" />
        <Button title="Today" variant="secondary" size="sm" onPress={cal.goToday} />
      </View>

      <EventBanner
        eventDate={eventDate}
        daysAway={cal.daysAway}
        onPress={cal.goToEvent}
      />

      {/* Move mode — the calendar itself is the date picker: tap a day. */}
      {moving ? (
        <View className="mb-3 flex-row items-center gap-2.5 rounded-lg bg-ink px-3.5 py-2.5">
          <Icon name="move" size={14} color={colors.raised} />
          <Text className="flex-1 text-xs font-semibold text-white" numberOfLines={1}>
            Moving “{moving.title || "Untitled"}” — tap a day
          </Text>
          <Pressable onPress={cal.cancelMove} hitSlop={8} className="active:opacity-70">
            <Text className="text-xs font-bold uppercase tracking-wide text-accent-soft">
              Cancel
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View className={wide ? "flex-row items-start gap-5" : "gap-5"}>
        <View className="flex-1">
          <Card padding="none" className="overflow-hidden">
            <View className="flex-row border-b border-border bg-sunken">
              {WEEKDAYS.map((w, i) => (
                <View key={i} className="flex-1 items-center py-2">
                  <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
                    {w}
                  </Text>
                </View>
              ))}
            </View>

            {Array.from({ length: 6 }, (_, wk) => (
              <View key={wk} className="flex-row">
                {cells.slice(wk * 7, wk * 7 + 7).map((c) => (
                  <View
                    key={c.ms}
                    ref={drag.registerDayCell(c.ms)}
                    collapsable={false}
                    style={{ width: `${100 / 7}%` }}
                  >
                    <DayCell
                      day={c.day}
                      inMonth={c.inMonth}
                      isToday={c.ms === today}
                      isSelected={c.ms === selected}
                      isEventDay={c.ms === eventDay}
                      isPast={c.ms < today}
                      daysToEvent={offsetDaysBetween(c.ms, eventDate)}
                      items={(byDay.get(c.ms) ?? []).map((x) => x.item)}
                      badgeField={config.badgeField}
                      badgeMap={badgeMap}
                      statusMap={statusMap}
                      compact={!wide}
                      isDropTarget={drag.hoverDay === c.ms}
                      moveMode={moving != null}
                      onPress={() =>
                        moving ? cal.completeMove(c.ms) : setSelected(c.ms)
                      }
                      onAdd={() => cal.openComposeOn(c.ms)}
                    />
                  </View>
                ))}
              </View>
            ))}
          </Card>

          <Legend entries={legend} />
        </View>

        <View style={wide ? { width: 360 } : undefined}>
          {composing ? (
            <Composer
              timing={cal.selectedTiming}
              itemNoun={config.itemNoun}
              copyLabel={config.copyLabel}
              copyPlaceholder={config.copyPlaceholder}
              groups={composerGroups}
              onCancel={() => setComposing(false)}
              onSubmit={cal.createItem}
            />
          ) : null}

          <DayPanel
            day={selected}
            isToday={selected === today}
            isEventDay={selected === eventDay}
            items={selectedItems}
            itemNoun={config.itemNoun}
            onAdd={() => setComposing(true)}
            renderItem={renderItemCard}
          />

          {unscheduled.length > 0 ? (
            <View className="mt-5">
              <Text className="mb-2 px-1 text-2xs font-bold uppercase tracking-wider text-warn">
                Unscheduled · {unscheduled.length}
              </Text>
              <View className="gap-2.5">{unscheduled.map(renderItemCard)}</View>
            </View>
          ) : null}
        </View>
      </View>

      {/* Undo toast — confirms a move and keeps it one tap from reverting. */}
      {cal.undoToast ? (
        <View
          pointerEvents="box-none"
          className="absolute left-0 right-0 top-16 z-20 items-center"
        >
          <View className="max-w-full flex-row items-center gap-3 rounded-lg bg-ink px-4 py-2.5 shadow-pop">
            <Text className="text-xs font-semibold text-white" numberOfLines={1}>
              {cal.undoToast.message}
            </Text>
            <Pressable onPress={cal.undoToast.undo} hitSlop={8} className="active:opacity-70">
              <Text className="text-xs font-bold uppercase tracking-wide text-accent-soft">
                Undo
              </Text>
            </Pressable>
            <Pressable onPress={cal.dismissUndo} hitSlop={8} className="active:opacity-70">
              <Icon name="x" size={13} color={colors.faint} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Drag ghost — a slim stand-in that follows the pointer and previews the
          day it would land on. The grid cell under it lights up in parallel. */}
      {drag.dragging ? (
        <DragAnimated.View
          pointerEvents="none"
          style={[drag.ghostStyle, { zIndex: 30, width: 230 }]}
        >
          <View className="rounded-lg border border-accent bg-raised px-3 py-2 shadow-pop">
            <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
              {drag.dragging.title || "Untitled"}
            </Text>
            <View className="mt-1 self-start rounded-sm bg-accent-soft px-1.5 py-0.5">
              <Text className="text-2xs font-bold text-accent">{ghostTarget}</Text>
            </View>
          </View>
        </DragAnimated.View>
      ) : null}
    </View>
  );
}

function NavButton({
  icon,
  onPress,
}: {
  icon: "chevron-left" | "chevron-right";
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      className="h-9 w-9 items-center justify-center rounded-md border border-border bg-raised active:bg-sunken"
    >
      <Icon name={icon} size={18} color={colors.ink} />
    </Pressable>
  );
}
