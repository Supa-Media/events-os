/**
 * One item in the day panel — the rich, badge-forward card, shared by every
 * calendar module (a comms send or a planning task). The card's rule is "tap the
 * fact, not an edit button": every fact it shows is its own editor —
 *
 *   • title + the copy/details box edit inline ({@link ItemCardText}),
 *   • the status glyph/pill opens the same option picker as the table, and the
 *     channel badges (comms) open the channel multiselect ({@link ItemCardStatus}),
 *   • the timing line opens the grid's TimingPanel, "pick a day on the calendar"
 *     (move mode), and "Unschedule" ({@link ItemCardTiming}),
 *   • every other column lives in the FieldChips strip below the title.
 */
import { useRef, useState } from "react";
import { View, Pressable } from "react-native";
import { Card } from "../../ui";
import { Icon } from "../../ui/Icon";
import { Popover } from "../../ui/Popover";
import { type AnchorRect } from "../../ui/useAnchor";
import { measureAnchor } from "../../ui/ContextMenu";
import { colors } from "../../../lib/theme";
import { confirmAction } from "../ticketing/helpers";
import {
  asArray,
  statusIcon,
  type CalendarColumn,
  type ScheduleItem,
  type SelectOption,
} from "./config";
import { ChannelBadge } from "./badges";
import { FieldChips, type EventRole } from "./FieldChips";
import { TimingChip } from "./ItemCardTiming";
import { TitleEditor, CopyEditor } from "./ItemCardText";
import {
  StatusIconBadge,
  StatusPill,
  StatusRow,
  BadgeEditor,
} from "./ItemCardStatus";
import { SendToGoogleChatButton } from "./SendToGoogleChatButton";

export function ItemCard({
  item,
  eventDate,
  statusOpts,
  statusMap,
  badgeField,
  badgeMap,
  badgeColumn,
  chipCols,
  roles,
  copyLabel,
  copyPlaceholder,
  initialCopy,
  canSendGoogleChat,
  itemNoun,
  onSetStatus,
  onSetOffset,
  onPickOnCalendar,
  onSaveField,
  onSaveCopy,
  onSaveTitle,
  onDelete,
}: {
  item: ScheduleItem;
  eventDate: number;
  statusOpts: SelectOption[];
  statusMap: Map<string, SelectOption>;
  badgeField: string | null;
  badgeMap?: Map<string, SelectOption>;
  /** The badge field's column definition — makes the badges themselves editable. */
  badgeColumn?: CalendarColumn;
  /** Columns offered as editable field chips (see chipColumns in config). */
  chipCols: CalendarColumn[];
  roles: EventRole[];
  copyLabel: string;
  copyPlaceholder: string;
  initialCopy: string;
  /** Comms-module only — shows the Send-to-Google-Chat button next to Copy. */
  canSendGoogleChat?: boolean;
  /** Singular noun for this item, e.g. "send" / "task" — powers the delete confirm copy. */
  itemNoun: string;
  onSetStatus: (status: string | null) => void;
  /** Reschedule to a signed day offset; null unschedules. */
  onSetOffset: (offsetDays: number | null) => void;
  /** Hand off to move mode — "tap a day on the calendar". */
  onPickOnCalendar: () => void;
  onSaveField: (column: CalendarColumn, value: unknown) => void;
  onSaveCopy: (copy: string) => void;
  onSaveTitle: (title: string) => void;
  /** Permanently delete this item (already confirmed by the caller). */
  onDelete: () => void;
}) {
  const statusOpt = item.status ? statusMap.get(item.status) : undefined;
  const badges = badgeField ? asArray(item.fields?.[badgeField]) : [];

  // One status picker serves both entry points (leading glyph + trailing pill).
  const [statusAnchor, setStatusAnchor] = useState<AnchorRect | undefined>();
  const [statusOpen, setStatusOpen] = useState(false);
  const openStatus = (node: any) =>
    measureAnchor(node, (a) => {
      setStatusAnchor(a);
      setStatusOpen(true);
    });

  // Channel badges → the channel multiselect, anchored on the badge cluster.
  const badgeRef = useRef<any>(null);
  const [badgeEditOpen, setBadgeEditOpen] = useState(false);
  const [badgeAnchor, setBadgeAnchor] = useState<AnchorRect | undefined>();

  return (
    <Card padding="md">
      <View className="flex-row items-start gap-3">
        {/* Leading badges — WHERE this goes (comms, tap to edit the channels)
            or its status (planning, tap for the status picker). */}
        {badges.length > 0 && badgeMap ? (
          <Pressable
            ref={badgeRef}
            onPress={
              badgeColumn
                ? () =>
                    measureAnchor(badgeRef.current, (a) => {
                      setBadgeAnchor(a);
                      setBadgeEditOpen(true);
                    })
                : undefined
            }
            hitSlop={4}
            className="flex-row flex-wrap gap-1 active:opacity-70"
            style={{ maxWidth: 56 }}
          >
            {badges.map((b) => (
              <ChannelBadge key={b} value={b} option={badgeMap.get(b)} />
            ))}
          </Pressable>
        ) : (
          <StatusIconBadge option={statusOpt} onPress={openStatus} />
        )}

        <View className="flex-1">
          <TitleEditor initial={item.title} onSave={onSaveTitle} />

          <TimingChip
            item={item}
            eventDate={eventDate}
            onSetOffset={onSetOffset}
            onPickOnCalendar={onPickOnCalendar}
          />

          <FieldChips
            item={item}
            columns={chipCols}
            roles={roles}
            onSaveField={onSaveField}
          />
        </View>

        <View className="items-end gap-1.5">
          <Pressable
            onPress={() =>
              confirmAction({
                title: `Delete this ${itemNoun}?`,
                message: item.title
                  ? `“${item.title}” will be permanently deleted.`
                  : `This ${itemNoun} will be permanently deleted.`,
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: onDelete,
              })
            }
            hitSlop={6}
            accessibilityLabel={`Delete ${itemNoun}`}
            className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="trash-2" size={13} color={colors.faint} />
          </Pressable>
          <StatusPill option={statusOpt} onPress={openStatus} />
        </View>
      </View>

      <CopyEditor
        label={copyLabel}
        placeholder={copyPlaceholder}
        initial={initialCopy}
        onSave={onSaveCopy}
        headerExtra={
          canSendGoogleChat ? (
            <SendToGoogleChatButton item={item} message={initialCopy} />
          ) : null
        }
      />

      {/* Status picker — the same option rows the table's status cell shows. */}
      <Popover
        visible={statusOpen}
        onClose={() => setStatusOpen(false)}
        anchor={statusAnchor}
        width={210}
      >
        <View className="py-1">
          {item.status != null ? (
            <StatusRow
              label="Clear"
              muted
              onPress={() => {
                onSetStatus(null);
                setStatusOpen(false);
              }}
            />
          ) : null}
          {statusOpts.map((o) => (
            <StatusRow
              key={o.value}
              label={o.label}
              color={o.color}
              icon={statusIcon(o.value)}
              selected={o.value === item.status}
              onPress={() => {
                onSetStatus(o.value);
                setStatusOpen(false);
              }}
            />
          ))}
        </View>
      </Popover>

      {/* Channel editor — toggle where this send goes, saved on close. */}
      {badgeEditOpen && badgeColumn ? (
        <BadgeEditor
          column={badgeColumn}
          initial={badges}
          anchor={badgeAnchor}
          onSave={(value) => {
            onSaveField(badgeColumn, value);
            setBadgeEditOpen(false);
          }}
          onClose={() => setBadgeEditOpen(false)}
        />
      ) : null}
    </Card>
  );
}
