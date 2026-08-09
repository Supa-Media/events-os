/**
 * The multi-select bulk bar for the Sales grid, mirroring the Reconcile one:
 * appears when rows are checked, offers the batch actions, and clears itself.
 *
 * TWO ACTIONS, and they have very different eligibility.
 *
 * SET EVENT always applies — attributing a run of orphaned taps to the event
 * they were taken at is the most common bulk fix there is, and nothing about one
 * row's amount constrains another's event.
 *
 * SET ITEMS only applies when every selected row is offered the SAME readings,
 * which happens exactly when they share an amount and a day's price list. That
 * is not a rare case — Pop The Balloon has dozens of identical $3 taps, and
 * settling them one at a time is the drudgery this bar exists to remove — but a
 * mixed selection has no basket that is correct for all of it. Rather than offer
 * a picker that would half-apply (or, worse, silently skip the rows it didn't
 * fit), the picker steps aside and says why, exactly as `BulkBar` does for a
 * selection that spans books.
 */
import { View, Text, Pressable } from "react-native";
import { Icon, OptionTag, Popover, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatCents, type BasketOption, type SaleEventOption } from "./helpers";

export function SalesBulkBar({
  count,
  events,
  basketOptions,
  sharedGrossCents,
  onSetEvent,
  onSetItems,
  onClear,
}: {
  count: number;
  events: SaleEventOption[];
  /** The readings every selected row shares, or `null` when they share none. */
  basketOptions: BasketOption[] | null;
  /** The one amount behind those readings — shown so the picker's heading can
   *  name what it is about to assert about every selected row. */
  sharedGrossCents: number | null;
  onSetEvent: (eventId: string | null) => void;
  onSetItems: (basketKey: string | null) => void;
  onClear: () => void;
}) {
  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5">
      <Text className="text-sm font-semibold text-ink">{count} selected</Text>
      <View className="flex-row flex-wrap items-center gap-2">
        <BulkPicker label="Set event">
          {(close) => (
            <>
              <Pressable
                onPress={() => {
                  onSetEvent(null);
                  close();
                }}
                className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                <Text className="text-sm text-muted">Unattributed</Text>
              </Pressable>
              {events.map((e) => (
                <Pressable
                  key={e.eventId}
                  onPress={() => {
                    onSetEvent(e.eventId);
                    close();
                  }}
                  className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                >
                  <OptionTag label={e.name} />
                </Pressable>
              ))}
            </>
          )}
        </BulkPicker>

        {basketOptions ? (
          <BulkPicker label="Set items">
            {(close) => (
              <>
                <Text className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-faint">
                  {sharedGrossCents != null
                    ? `What each ${formatCents(sharedGrossCents)} could be`
                    : "What each could be"}
                </Text>
                {basketOptions.map((o) => (
                  <Pressable
                    key={o.key}
                    onPress={() => {
                      onSetItems(o.key);
                      close();
                    }}
                    className="px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                  >
                    <Text className="text-sm text-ink">{o.label}</Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => {
                    onSetItems(null);
                    close();
                  }}
                  className="border-t border-border px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                >
                  <Text className="text-sm text-muted">Leave them unresolved</Text>
                </Pressable>
              </>
            )}
          </BulkPicker>
        ) : (
          <Text className="text-xs text-muted">
            Mixed amounts — select taps of the same amount to set their items
            together
          </Text>
        )}
      </View>
      <Pressable
        onPress={onClear}
        hitSlop={8}
        accessibilityLabel="Clear selection"
        className="ml-auto rounded p-1 active:opacity-70"
      >
        <Icon name="x" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

/** A labelled button that opens a Popover. Takes a render prop rather than an
 *  item list because the two menus here have genuinely different shapes (one is
 *  event tags, the other is headed basket text) and flattening them into one
 *  option type would only re-create the difference with flags. */
function BulkPicker({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center gap-1 rounded-md border border-border-strong bg-raised px-3 py-1.5 active:opacity-70 web:hover:bg-sunken"
      >
        <Text className="text-sm font-medium text-ink">{label}</Text>
        <Icon name="chevron-down" size={14} color={colors.muted} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="py-1">{children(close)}</View>
      </Popover>
    </>
  );
}
