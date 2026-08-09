/**
 * SALES GRID — the database view of every in-person payment, built on the same
 * `EditableTable` primitives as the Reconcile grid: `DEFAULT_COLS` widths
 * (drag-adjustable and remembered per browser via `useResizableColumns`), a
 * `GridHeaderCell` header row, per-row `Cell`-wrapped cells, multi-select
 * driving a bulk bar, and a detail affordance at the end of the row.
 *
 * Columns: [☐] Date · Event▾ · Items▾ · Gross · Fee · Net · Payment · [detail]
 *
 * ── WHAT IT DELIBERATELY DOESN'T BORROW FROM RECONCILE ──────────────────────
 * A sale is not a bank charge, and copying the whole pattern would say things
 * about it that aren't true.
 *
 *  - NO STATUS COLUMN. A charge is a piece of work with a lifecycle — unreviewed,
 *    categorized, reconciled. A sale is a completed fact: somebody paid, the
 *    money is in the bank, nothing is pending. Inventing a status would create a
 *    queue that never empties for no reason.
 *  - NO INLINE TEXT CELLS. Everything editable here is a CHOICE from a closed
 *    set — one of the baskets the amount actually makes, one of the chapter's
 *    events. Reconcile can afford a free-text merchant rename because a merchant
 *    name is a label; a sale's item breakdown is a claim about money, and a
 *    typed one could contradict the amount that cleared.
 *  - THE MONEY IS READ-ONLY, and shown in three columns rather than one. Gross,
 *    fee and net are all the processor's word, and a treasurer reading this page
 *    is reconciling against a bank statement that shows the net while the books
 *    count the gross — putting both on the row is what stops that difference
 *    reading as a discrepancy.
 *
 * ── THE TWO EDITABLE CELLS ──────────────────────────────────────────────────
 * ITEMS offers only the baskets this amount can be, computed server-side from
 * the day's frozen price list (`lib/salesCatalog.ts`) and shipped down with the
 * row. Where there are several, the cell says so on its face ("3 readings") so
 * the work is visible before anyone opens anything; where there are none, it
 * says which of the two reasons applies instead of offering an empty menu.
 *
 * EVENT offers the chapter's events plus "Unattributed". The importer matches by
 * name and date and leaves genuine orphans behind — a tap taken the morning
 * after a two-day event — and this is the only place they can be adopted.
 *
 * Both commit one field, per row, on pick, exactly like Reconcile's cells; the
 * server is the authority on whether the caller may (`row`-level `canEdit`
 * mirrors `listSales`'s own answer rather than being re-derived here).
 */
import { View, Text, Pressable, ScrollView } from "react-native";
import {
  Checkbox,
  CopyButton,
  GridHeaderCell,
  Icon,
  OptionTag,
  Popover,
  useAnchor,
  useResizableColumns,
} from "../../ui";
import { colors } from "../../../lib/theme";
import {
  formatCents,
  itemsLabel,
  shortDate,
  UNATTRIBUTED,
  type BasketOption,
  type SaleEventOption,
  type SaleRow,
} from "./helpers";

const NUM = { fontVariant: ["tabular-nums" as const] };

// Default column widths (px) — the grid scrolls horizontally on narrow web
// while columns stay put, mirroring Reconcile and the People roster.
const DEFAULT_COLS = {
  check: 40,
  date: 118, // fits "Dec 06, 2025"
  event: 178,
  // The widest column on purpose: a resolved basket can read "2 × $2 item +
  // Water", and an unresolved one carries its "3 readings" hint alongside.
  items: 264,
  gross: 96,
  fee: 84,
  net: 96,
  // A Stripe charge id is 27 characters and a Cash App ref is longer; neither
  // fits, so the cell shows a tail and a copy button rather than pretending.
  payment: 172,
  detail: 44,
} as const;
type ColKey = keyof typeof DEFAULT_COLS;
const SALES_COLUMNS_STORAGE_KEY = "sales-grid-columns";

export function SalesTable({
  rows,
  events,
  canEdit,
  selected,
  onToggle,
  onToggleAll,
  onSetItems,
  onSetEvent,
  onOpenDetail,
}: {
  rows: SaleRow[];
  events: SaleEventOption[];
  /** Server-resolved: whether this caller may write these rows at all. */
  canEdit: boolean;
  selected: Set<string>;
  onToggle: (saleId: string) => void;
  onToggleAll: () => void;
  onSetItems: (saleId: string, basketKey: string | null) => void;
  onSetEvent: (saleId: string, eventId: string | null) => void;
  onOpenDetail: (row: SaleRow) => void;
}) {
  const { widths, startResize } = useResizableColumns<ColKey>(
    SALES_COLUMNS_STORAGE_KEY,
    DEFAULT_COLS,
  );
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.saleId));
  const width = (Object.values(widths) as number[]).reduce((sum, w) => sum + w, 0);

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(width, 320) }}>
          {/* Column header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            <View
              style={{ width: widths.check }}
              className="items-center justify-center py-2.5"
            >
              {canEdit ? (
                <Checkbox
                  checked={allSelected}
                  onPress={onToggleAll}
                  accessibilityLabel={allSelected ? "Deselect all sales" : "Select all sales"}
                />
              ) : null}
            </View>
            <GridHeaderCell label="Date" width={widths.date} onResizeStart={startResize("date")} />
            <GridHeaderCell label="Event" width={widths.event} onResizeStart={startResize("event")} />
            <GridHeaderCell label="Items" width={widths.items} onResizeStart={startResize("items")} />
            <GridHeaderCell label="Gross" width={widths.gross} onResizeStart={startResize("gross")} />
            <GridHeaderCell label="Fee" width={widths.fee} onResizeStart={startResize("fee")} />
            <GridHeaderCell label="Banked" width={widths.net} onResizeStart={startResize("net")} />
            <GridHeaderCell
              label="Payment"
              width={widths.payment}
              onResizeStart={startResize("payment")}
            />
            <View style={{ width: widths.detail }} />
          </View>

          {/* Body */}
          {rows.map((row, i) => (
            <SaleGridRow
              key={row.saleId}
              row={row}
              events={events}
              canEdit={canEdit}
              selected={selected.has(row.saleId)}
              onToggle={() => onToggle(row.saleId)}
              onSetItems={(key) => onSetItems(row.saleId, key)}
              onSetEvent={(eventId) => onSetEvent(row.saleId, eventId)}
              onOpenDetail={() => onOpenDetail(row)}
              isLast={i === rows.length - 1}
              widths={widths}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function SaleGridRow({
  row,
  events,
  canEdit,
  selected,
  onToggle,
  onSetItems,
  onSetEvent,
  onOpenDetail,
  isLast,
  widths,
}: {
  row: SaleRow;
  events: SaleEventOption[];
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
  onSetItems: (basketKey: string | null) => void;
  onSetEvent: (eventId: string | null) => void;
  onOpenDetail: () => void;
  isLast: boolean;
  widths: Record<ColKey, number>;
}) {
  return (
    <View
      className={`flex-row items-stretch border-b border-border ${
        selected ? "bg-accent-soft" : "bg-raised"
      } ${isLast ? "border-b-0" : ""}`}
    >
      <View style={{ width: widths.check }} className="items-center justify-center">
        {canEdit ? (
          <Checkbox
            checked={selected}
            onPress={onToggle}
            accessibilityLabel={`Select the sale for ${row.eventName ?? "this event"}`}
          />
        ) : null}
      </View>

      <Cell width={widths.date}>
        <Text className="px-2 text-sm text-ink" style={NUM} numberOfLines={1}>
          {shortDate(row.soldAt)}
        </Text>
      </Cell>

      <Cell width={widths.event}>
        <EventCell
          value={row.eventId}
          name={row.eventName}
          events={events}
          canEdit={canEdit}
          onChange={onSetEvent}
        />
      </Cell>

      <Cell width={widths.items}>
        <BasketCell row={row} canEdit={canEdit} onChange={onSetItems} />
      </Cell>

      <Cell width={widths.gross}>
        <Text className="flex-1 px-2 text-right text-sm font-semibold text-ink" style={NUM}>
          {formatCents(row.grossCents)}
        </Text>
      </Cell>
      <Cell width={widths.fee}>
        <Text className="flex-1 px-2 text-right text-sm text-muted" style={NUM}>
          {formatCents(row.feeCents)}
        </Text>
      </Cell>
      <Cell width={widths.net}>
        <Text className="flex-1 px-2 text-right text-sm text-ink" style={NUM}>
          {formatCents(row.netCents)}
        </Text>
      </Cell>

      <Cell width={widths.payment}>
        <View className="flex-1 flex-row items-center gap-1.5 px-2">
          <Text className="flex-1 text-2xs text-faint" numberOfLines={1}>
            {/* The tail, not the head: every Stripe charge id starts `ch_3…`,
                so the leading characters distinguish nothing and the trailing
                ones are what you'd match against a statement line. */}
            {row.paymentRef ? `…${row.paymentRef.slice(-10)}` : "—"}
          </Text>
          {row.paymentRef ? <CopyButton text={row.paymentRef} /> : null}
        </View>
      </Cell>

      <View style={{ width: widths.detail }} className="items-center justify-center">
        <Pressable
          onPress={onOpenDetail}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Sale detail"
          className="rounded p-1 active:opacity-70 web:hover:bg-sunken"
        >
          <Icon name="info" size={15} color={colors.muted} />
        </Pressable>
      </View>
    </View>
  );
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View style={{ width }} className="flex-row items-center border-r border-border/60">
      {children}
    </View>
  );
}

// ── Event cell ───────────────────────────────────────────────────────────────
/**
 * The chapter's events plus "Unattributed", committing on pick.
 *
 * Every event is offered, not only the ones that already carry sales: adopting
 * an ORPHAN is the whole reason this cell exists, and an orphan by definition
 * names none of them.
 */
function EventCell({
  value,
  name,
  events,
  canEdit,
  onChange,
}: {
  value: string | null;
  name: string | null;
  events: SaleEventOption[];
  canEdit: boolean;
  onChange: (eventId: string | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  if (!canEdit) {
    return name ? (
      <View className="px-2">
        <OptionTag label={name} />
      </View>
    ) : (
      <Text className="px-2 text-sm text-faint">Unattributed</Text>
    );
  }

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
      >
        {name ? (
          <OptionTag label={name} />
        ) : (
          // Warn-toned, not muted: an unattributed sale is money whose event
          // reporting is silently short, which is a thing to fix rather than a
          // blank to accept.
          <Text className="text-sm text-warn">Unattributed</Text>
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={240}>
        <View className="py-1">
          <Pressable
            onPress={() => {
              onChange(null);
              close();
            }}
            className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
          >
            <Text className="text-sm text-muted">Unattributed</Text>
            {value === null ? <Icon name="check" size={15} color={colors.accent} /> : null}
          </Pressable>
          {events.map((e) => (
            <Pressable
              key={e.eventId}
              onPress={() => {
                onChange(e.eventId);
                close();
              }}
              className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <OptionTag label={e.name} />
              {value === e.eventId ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
        </View>
      </Popover>
    </>
  );
}

// ── Items cell ───────────────────────────────────────────────────────────────
/**
 * The basket picker — the one control on this page that turns a report into a
 * tool.
 *
 * A closed menu of the readings the AMOUNT allows, never a free entry. Three
 * distinct states, and the difference between the last two is the whole point:
 *
 *  - a breakdown is recorded → the basket reads plainly, with a small pencil on
 *    a hand-set one so a recollection is never mistaken for arithmetic;
 *  - unresolved WITH options → "Unresolved" plus how many readings exist, which
 *    is an invitation and a size estimate at once;
 *  - unresolved with NO options → a flat statement of which dead end it is (no
 *    price list for that day, or an amount no combination reaches). No menu,
 *    because there is genuinely nothing to choose, and an empty dropdown would
 *    imply the work just hadn't been done.
 */
function BasketCell({
  row,
  canEdit,
  onChange,
}: {
  row: SaleRow;
  canEdit: boolean;
  onChange: (basketKey: string | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const resolved = row.items.length > 0;
  const options: BasketOption[] = row.itemOptions;

  const face = (
    <View className="flex-row items-center gap-1.5">
      {row.itemSource === "manual" ? (
        <Icon name="edit-3" size={12} color={colors.muted} />
      ) : null}
      {resolved ? (
        <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
          {itemsLabel(row)}
        </Text>
      ) : (
        <Text className="flex-1 text-sm text-faint" numberOfLines={1}>
          Unresolved
          {options.length > 0 ? (
            <Text className="text-2xs text-accent">
              {`  ${options.length} reading${options.length === 1 ? "" : "s"}`}
            </Text>
          ) : null}
        </Text>
      )}
    </View>
  );

  if (options.length === 0 && !resolved) {
    return (
      <View className="flex-1 px-2 py-1.5">
        <Text className="text-sm text-faint" numberOfLines={1}>
          Unresolved
        </Text>
        <Text className="text-2xs text-faint" numberOfLines={1}>
          {row.hasCatalog ? "no basket makes this amount" : "no price list for this day"}
        </Text>
      </View>
    );
  }

  if (!canEdit) return <View className="flex-1 px-2 py-1.5">{face}</View>;

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
      >
        {face}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={280}>
        <View className="py-1">
          <Text className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-faint">
            {`What ${formatCents(row.grossCents)} could be`}
          </Text>
          {options.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => {
                onChange(o.key);
                close();
              }}
              className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <Text className="flex-1 text-sm text-ink">{o.label}</Text>
              {o.key === row.itemsKey ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
          {resolved ? (
            <Pressable
              onPress={() => {
                onChange(null);
                close();
              }}
              className="border-t border-border px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              {/* Available even on a row the importer resolved by itself: a
                  single-reading decomposition is still only arithmetic, and if
                  the person who was there says it's wrong, "Unresolved" is a
                  better record than a confident falsehood. */}
              <Text className="text-sm text-muted">Leave it unresolved</Text>
            </Pressable>
          ) : null}
        </View>
      </Popover>
    </>
  );
}
