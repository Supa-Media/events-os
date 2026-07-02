/**
 * MODULE CALENDAR — a month view for any day-offset module (Comms Schedule,
 * Planning Doc). The same data a module shows as a table, read as a calendar:
 * every item lands on its due day, the EVENT's own day is anchored above and
 * flagged in the grid, and a day panel details the selected day with inline
 * status + copy edits and an add-on-this-day composer. What each module
 * surfaces (channel logos vs status glyphs, which fields to capture) is declared
 * in {@link MODULE_CALENDAR_CONFIG} and threaded through here — no per-module
 * views. Rendered from `ModuleSection`'s table ↔ calendar toggle.
 */
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { calendarMonthGrid } from "@events-os/shared";
import { Card, Button } from "../../ui";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";
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
import { EventBanner } from "./EventBanner";
import { DayCell } from "./DayCell";
import { DayPanel } from "./DayPanel";
import { ItemCard } from "./ItemCard";
import { Composer } from "./Composer";
import { Legend, type LegendEntry } from "./badges";

const EMPTY_MAP: Map<string, SelectOption> = new Map();

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
    <ItemCard
      key={item._id}
      item={item}
      statusMap={statusMap}
      badgeField={config.badgeField}
      badgeMap={badgeMap}
      metas={config.metaFields.map((field) => ({
        field,
        map: optionSets[field]?.map ?? EMPTY_MAP,
      }))}
      copyLabel={config.copyLabel}
      copyPlaceholder={config.copyPlaceholder}
      initialCopy={readCopy(item, config.copyField)}
      onCycleStatus={() => cal.cycleStatus(item)}
      onSaveCopy={(copy) => cal.saveCopy(item, copy)}
    />
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

  return (
    <View>
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
                  <DayCell
                    key={c.ms}
                    day={c.day}
                    inMonth={c.inMonth}
                    isToday={c.ms === today}
                    isSelected={c.ms === selected}
                    isEventDay={c.ms === eventDay}
                    isPast={c.ms < today}
                    items={(byDay.get(c.ms) ?? []).map((x) => x.item)}
                    badgeField={config.badgeField}
                    badgeMap={badgeMap}
                    statusMap={statusMap}
                    compact={!wide}
                    onPress={() => setSelected(c.ms)}
                    onAdd={() => cal.openComposeOn(c.ms)}
                  />
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
