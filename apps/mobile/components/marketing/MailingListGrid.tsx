/**
 * MARKETING · Mailing list — the GRID itself.
 *
 * ── Why a grid and not cards ────────────────────────────────────────────────
 * Founder call, 2026-08-28: "Mailing list should definitely be a database view.
 * There's no reason why it should be these cards… should be able to do box
 * selection operations and stuff like that." The screen used to render one
 * `Card` per person, which made the one question this desk exists to answer —
 * "who can we reach, and who asked us not to?" — a scroll instead of a scan,
 * and made acting on twenty people twenty separate taps.
 *
 * ── Why it looks like the People tab ────────────────────────────────────────
 * "Every people is the superset, and the mailing list is the subset." The
 * mailing list is a VIEW over `people`, so it is built from the same primitives
 * the People roster is (`app/(app)/(tabs)/people.tsx`, `ui/DataGrid.tsx`,
 * `ui/EditableTable.tsx`): a checkbox gutter, a `bg-sunken` header of
 * fixed-width sortable/resizable columns, dense hairline-bordered cells,
 * horizontal scroll rather than squeezed columns. A marketer who has used the
 * People tab has already learned this screen. Tapping a name opens that
 * person's record, which is the superset/subset relationship made clickable.
 *
 * ── Read-only cells, on purpose ─────────────────────────────────────────────
 * The People grid edits in place; this one does not. Every column here is
 * either derived (`destination` is the RESOLVED send address, not the roster
 * column — `lib/personEmails.ts#resolveSendAddress`) or a consent fact whose
 * only honest editors are the person themselves and the two mutations this
 * desk owns. An `InlineText` over a derived value would promise a save that
 * writes somewhere the marketer didn't mean.
 *
 * ── Selection ───────────────────────────────────────────────────────────────
 * Tap a checkbox to toggle one; the header box selects/deselects everything on
 * screen. On WEB, shift-click extends from the last row you touched — the "box
 * selection" muscle memory from every spreadsheet. Native has no shift key, so
 * it gets tap-toggle plus select-all and nothing pretends otherwise; this is
 * the same web-only-where-the-input-only-exists-on-web line
 * `useResizableColumns` already draws for column dragging.
 */
import { memo, useCallback, useEffect, useRef } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  Badge,
  Checkbox,
  GridCell,
  GridContainer,
  GridHeaderCell,
  GridHeaderRow,
  GridRow,
  Icon,
  useResizableColumns,
  type BadgeTone,
} from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";
// The giving desk's PURE client-side sort helpers (nulls always last,
// direction applied on top). Imported rather than re-derived: this grid sorts
// exactly the way the Donors/Backers/Gifts grids do — over already-loaded rows
// — and a second comparator that disagreed about where a person with no
// consent date lands would be a difference nobody asked for.
import { sortRows, type SortDirection } from "../giving/gridSort";
import {
  MAILING_EXCLUSION_LABELS,
  type MailingChannel,
  type MailingExclusion,
  type MailingListRow,
} from "@events-os/shared";

/** Which column the grid is ordered by. Only the three that are cheap to
 *  compare on the client — a status sort would have to invent an order for a
 *  multi-valued exclusion list, which is a ranking this desk doesn't have. */
export type MailingSortKey = "name" | "destination" | "consent";
export type MailingSort = { key: MailingSortKey; dir: SortDirection };

/** Default column widths (px) — drag-resizable on web and remembered per
 *  browser, same mechanism and same storage-key convention as the Reconcile
 *  and Receipts grids. */
const DEFAULT_COLS = {
  name: 200,
  destination: 240,
  status: 210,
  consent: 180,
  chapter: 140,
} as const;
type ColKey = keyof typeof DEFAULT_COLS;
const COLUMNS_STORAGE_KEY = "marketing-mailing-list-columns";

/** The checkbox gutter and the right-hand action gutter. Neither resizes:
 *  they hold one control each, so a wider one is only ever wasted row. */
const SELECT_W = 36;
const ACTIONS_W = 96;

/** An exclusion's chip colour. `suppressed` is the one that reads as a hard
 *  stop, because it is the one this desk cannot undo. */
export function exclusionTone(reason: MailingExclusion): BadgeTone {
  switch (reason) {
    case "suppressed":
      return "danger";
    case "opted_out":
      return "warn";
    case "no_address":
      return "neutral";
    case "inactive":
      return "neutral";
  }
}

/**
 * Whether "Put back" may be offered for a row.
 *
 * ONLY an opt-out can be lifted here. A `suppressed` row came from the person
 * themselves (an unsubscribe click, a texted STOP) or from the address itself
 * (a hard bounce, a spam complaint), and `restoreToList` will not touch that
 * ledger — so a button offered on such a row could not honor its own label.
 * Exported because the bulk bar has to count exactly the same rows the
 * per-row gutter would offer the button on.
 */
export function canPutBack(row: MailingListRow): boolean {
  return row.exclusions.includes("opted_out");
}

/** Order rows for display. The server already returns them name-ascending; this
 *  re-sorts the LOADED page only, never re-queries — the same contract the
 *  giving grids' sortable headers have. */
export function sortMailingRows(
  rows: MailingListRow[],
  sort: MailingSort,
): MailingListRow[] {
  switch (sort.key) {
    case "destination":
      return sortRows(rows, (r) => r.destination?.toLowerCase() ?? null, sort.dir);
    case "consent":
      return sortRows(rows, (r) => r.consentedAt, sort.dir);
    case "name":
    default:
      return sortRows(rows, (r) => r.name.toLowerCase(), sort.dir);
  }
}

/**
 * Tracks whether Shift is held, WEB ONLY, in a ref.
 *
 * A ref rather than state because nothing on screen depends on the key being
 * down — only the next checkbox press reads it — and re-rendering a 500-row
 * grid on every Shift keypress would be a real cost for no visible change.
 * Read from `window` rather than from the press event because the shared
 * `Checkbox` (which this file does not own) hands its `onPress` no event, and
 * forking a second checkbox just to see one modifier key would put two
 * different checkboxes in the same app.
 */
function useShiftHeld(): { current: boolean } {
  const held = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") held.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") held.current = false;
    };
    // Tabbing away mid-chord leaves the keyup on another window; without this
    // the grid would think Shift was held for the rest of the session.
    const clear = () => {
      held.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}

export function MailingListGrid({
  rows,
  channel,
  showChapter,
  canEdit,
  selected,
  allSelected,
  sort,
  onSortChange,
  onToggleAll,
  onToggleOne,
  onSelectRange,
  onOpenPerson,
  onRemoveOne,
  onRestoreOne,
}: {
  /** Already sorted — see `sortMailingRows`. The order here IS the order the
   *  shift-range below walks, which is why sorting is not done inside. */
  rows: MailingListRow[];
  channel: MailingChannel;
  /** The chapter column earns its width only when the view actually spans more
   *  than one chapter — on a single-chapter lens the backend leaves
   *  `chapterName` null on every row and the column would be a stripe of
   *  em-dashes. */
  showChapter: boolean;
  canEdit: boolean;
  selected: ReadonlySet<string>;
  allSelected: boolean;
  sort: MailingSort;
  onSortChange: (sort: MailingSort) => void;
  onToggleAll: () => void;
  onToggleOne: (personId: string) => void;
  /** Select every row between the last-touched row and this one, inclusive
   *  (web shift-click). Additive — it never clears what's already selected. */
  onSelectRange: (personIds: string[]) => void;
  onOpenPerson: (personId: string, name: string) => void;
  onRemoveOne: (row: MailingListRow) => void;
  onRestoreOne: (row: MailingListRow) => void;
}) {
  const { widths, startResize } = useResizableColumns<ColKey>(
    COLUMNS_STORAGE_KEY,
    DEFAULT_COLS,
  );
  const shiftHeld = useShiftHeld();
  // Where a shift-range starts: the last row whose checkbox was pressed
  // WITHOUT shift. A ref, not state, for the same reason as `shiftHeld`.
  const anchorRef = useRef<number | null>(null);

  const tableWidth =
    SELECT_W +
    widths.name +
    widths.destination +
    widths.status +
    widths.consent +
    (showChapter ? widths.chapter : 0) +
    (canEdit ? ACTIONS_W : 0);

  const handleSelect = useCallback(
    (index: number) => {
      const anchor = anchorRef.current;
      if (shiftHeld.current && anchor !== null && anchor !== index) {
        const from = Math.min(anchor, index);
        const to = Math.max(anchor, index);
        onSelectRange(rows.slice(from, to + 1).map((r) => r.personId));
        return;
      }
      anchorRef.current = index;
      onToggleOne(rows[index].personId);
    },
    [rows, onSelectRange, onToggleOne, shiftHeld],
  );

  function toggleSort(key: MailingSortKey) {
    onSortChange(
      sort.key === key
        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  return (
    <GridContainer width={tableWidth}>
      <GridHeaderRow>
        <View
          style={{ width: SELECT_W }}
          className="items-center justify-center border-r border-border/60 py-1.5"
        >
          <Checkbox
            checked={allSelected}
            onPress={onToggleAll}
            accessibilityLabel={
              allSelected
                ? "Deselect everyone on screen"
                : "Select everyone on screen"
            }
          />
        </View>
        <GridHeaderCell
          label="Name"
          width={widths.name}
          onResizeStart={startResize("name")}
          onSort={() => toggleSort("name")}
          sortActive={sort.key === "name"}
          sortDirection={sort.dir}
        />
        <GridHeaderCell
          label={channel === "email" ? "Email" : "Phone"}
          width={widths.destination}
          onResizeStart={startResize("destination")}
          onSort={() => toggleSort("destination")}
          sortActive={sort.key === "destination"}
          sortDirection={sort.dir}
        />
        <GridHeaderCell
          label="Status"
          width={widths.status}
          onResizeStart={startResize("status")}
        />
        <GridHeaderCell
          label="Said yes"
          width={widths.consent}
          onResizeStart={startResize("consent")}
          onSort={() => toggleSort("consent")}
          sortActive={sort.key === "consent"}
          sortDirection={sort.dir}
        />
        {showChapter ? (
          <GridHeaderCell
            label="Chapter"
            width={widths.chapter}
            onResizeStart={startResize("chapter")}
          />
        ) : null}
        {canEdit ? <View style={{ width: ACTIONS_W }} /> : null}
      </GridHeaderRow>

      {rows.map((row, i) => (
        <MailingRow
          key={row.personId}
          row={row}
          index={i}
          widths={widths}
          showChapter={showChapter}
          canEdit={canEdit}
          selected={selected.has(row.personId)}
          isLast={i === rows.length - 1}
          onSelect={handleSelect}
          onOpenPerson={onOpenPerson}
          onRemove={onRemoveOne}
          onRestore={onRestoreOne}
        />
      ))}
    </GridContainer>
  );
}

/**
 * One person, one row.
 *
 * Memoized: the search box and the selection both live on the screen above, so
 * every keystroke and every checkbox press re-renders the parent. Without memo
 * that re-rendered all 500 rows to change one checkbox — the same reason
 * `PersonRow` on the People tab is memoized.
 *
 * The ROW is deliberately not a press target (unlike the receipts library's
 * grid): this row already contains three of them — the checkbox, the name, and
 * the action gutter — and a whole-row press behind them makes "did I select
 * that or open it?" a coin flip, on touch especially.
 */
const MailingRow = memo(function MailingRow({
  row,
  index,
  widths,
  showChapter,
  canEdit,
  selected,
  isLast,
  onSelect,
  onOpenPerson,
  onRemove,
  onRestore,
}: {
  row: MailingListRow;
  index: number;
  widths: Record<ColKey, number>;
  showChapter: boolean;
  canEdit: boolean;
  selected: boolean;
  isLast: boolean;
  /** Takes the row's INDEX, not its id: a shift-range is a span of positions
   *  in the currently displayed order, which only the grid knows. */
  onSelect: (index: number) => void;
  onOpenPerson: (personId: string, name: string) => void;
  onRemove: (row: MailingListRow) => void;
  onRestore: (row: MailingListRow) => void;
}) {
  const reachable = row.exclusions.length === 0;
  const putBack = canPutBack(row);

  return (
    <GridRow isLast={isLast}>
      <View
        style={{ width: SELECT_W }}
        className={`items-center justify-center border-r border-border/60 ${
          selected ? "bg-accent/10" : ""
        }`}
      >
        <Checkbox
          checked={selected}
          onPress={() => onSelect(index)}
          accessibilityLabel={`Select ${row.name || "this person"}`}
        />
      </View>

      {/* Name → the person's record. "Every people is the superset, and the
          mailing list is the subset" — this is that sentence as a tap. The
          preview modal is the same one every other "who is this?" surface in
          the app opens, and it carries the "View full profile" door to the
          People tab rather than duplicating the roster's editor here. */}
      <GridCell width={widths.name}>
        <Pressable
          onPress={() => onOpenPerson(row.personId, row.name)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${row.name || "this person"}'s record`}
          className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
        >
          <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
            {row.name || "Unnamed"}
          </Text>
          <Icon name="chevron-right" size={12} color={colors.faint} />
        </Pressable>
      </GridCell>

      <GridCell width={widths.destination}>
        <Text
          className={`px-2 py-1.5 text-sm ${row.destination ? "text-muted" : "italic text-faint"}`}
          numberOfLines={1}
        >
          {row.destination ?? "No address on file"}
        </Text>
      </GridCell>

      {/* Status: one green chip when we can reach them, and otherwise EVERY
          reason we can't — `opted_out` and `suppressed` stay two different
          words on two different chips, because collapsing them is how a team
          ends up re-adding a complainer (see `MAILING_EXCLUSIONS`' doc). */}
      <GridCell width={widths.status}>
        <View className="flex-1 flex-row flex-wrap items-center gap-1 px-2 py-1.5">
          {reachable ? (
            <Badge label="On the list" tone="success" />
          ) : (
            row.exclusions.map((reason) => (
              <Badge
                key={reason}
                label={MAILING_EXCLUSION_LABELS[reason]}
                tone={exclusionTone(reason)}
              />
            ))
          )}
        </View>
      </GridCell>

      <GridCell width={widths.consent}>
        <View className="flex-1 px-2 py-1.5">
          {row.consentedAt ? (
            <>
              <Text className="text-sm text-ink" numberOfLines={1}>
                {formatDate(row.consentedAt)}
              </Text>
              {row.consentSource ? (
                <Text className="text-2xs text-faint" numberOfLines={1}>
                  {row.consentSource}
                </Text>
              ) : null}
            </>
          ) : (
            // Not a hole in the data so much as a fact about it: plenty of
            // these people predate the sign-up form. Saying "not recorded"
            // beats an em-dash that reads like a missing value.
            <Text className="text-sm italic text-faint" numberOfLines={1}>
              Not recorded
            </Text>
          )}
        </View>
      </GridCell>

      {showChapter ? (
        <GridCell width={widths.chapter}>
          <Text className="px-2 py-1.5 text-sm text-muted" numberOfLines={1}>
            {row.chapterName ?? "—"}
          </Text>
        </GridCell>
      ) : null}

      {canEdit ? (
        <View
          style={{ width: ACTIONS_W }}
          className="flex-row items-center justify-end gap-1 px-2"
        >
          {putBack ? (
            <RowAction
              icon="rotate-ccw"
              label={`Put ${row.name || "this person"} back on the list`}
              tint={colors.accent}
              onPress={() => onRestore(row)}
            />
          ) : null}
          {/* Removing an already-opted-out person is a no-op the row shouldn't
              offer — the only excluded rows worth removing are the ones
              excluded for a reason an opt-out doesn't cover (no address, or an
              inactive roster row), and those are still reachable-in-principle
              people the desk may want to mark. */}
          {!putBack ? (
            <RowAction
              icon="user-minus"
              label={`Remove ${row.name || "this person"} from the list`}
              tint={colors.danger}
              onPress={() => onRemove(row)}
            />
          ) : null}
        </View>
      ) : null}
    </GridRow>
  );
});

/** An icon affordance in the row's action gutter. Icon-only because the gutter
 *  is 96px and the labels ("Remove from the mailing list") are sentences —
 *  the sentence lives in `accessibilityLabel`, where a screen reader and a
 *  web tooltip both find it. */
function RowAction({
  icon,
  label,
  tint,
  onPress,
}: {
  icon: "rotate-ccw" | "user-minus";
  label: string;
  tint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="rounded p-1.5 active:bg-sunken web:hover:bg-sunken"
    >
      <Icon name={icon} size={15} color={tint} />
    </Pressable>
  );
}
