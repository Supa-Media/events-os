/**
 * MARKETING · Mailing list — the selection bar, the confirmation it puts in
 * front of a bulk removal, and the CSV panel both export paths share.
 *
 * ── Why the confirmation exists ─────────────────────────────────────────────
 * "Remove" here is not a row disappearing from a list. It sets
 * `people.marketingOptOut`, and on the SMS channel it also writes an
 * `smsOptOuts` row — a promise to a real person that we will stop texting
 * them. Doing that to forty people is one press away from doing it to four
 * hundred, and the ONLY thing standing between the two is a bar that says
 * which number it is about to act on. So the confirm is not a "are you sure?"
 * reflex: it exists to say the count out loud, name the first few people, and
 * spell out the SMS consequence before it happens.
 *
 * There is no undo affordance here, deliberately. "Put back" is a real,
 * separate act with its own rules (only an opt-out can be lifted — never a
 * suppression), and dressing the removal in a five-second "Undo" would imply
 * a symmetry the data does not have.
 *
 * ── Why the same dialog handles a single row ────────────────────────────────
 * The row gutter's Remove routes through this too, with a count of one. One
 * code path means the SMS sentence can never be shown for the bulk case and
 * quietly skipped for the single one — which is exactly the sort of drift that
 * makes a promise to a person depend on which button they were removed with.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Badge, Button, CopyButton, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { copyToClipboard } from "../../lib/clipboard";
import type { MailingChannel } from "@events-os/shared";

/** How many names the confirmation lists before it stops and counts instead. */
const NAMES_SHOWN = 5;

/**
 * The most people one bulk action may touch — a MIRROR of the server's own
 * `mailingList.ts#BULK_LIMIT`, not a second policy. The server refuses a larger
 * call outright (it does not truncate), so the honest thing for the bar to do
 * is say so before the press rather than let a 340-row selection fail with a
 * server error. Same shape as the People roster's `EMAIL_SELECTED_CAP`. If the
 * backend's limit moves, this number is stale and the server still wins.
 */
const MAILING_BULK_LIMIT = 200;

/**
 * The bar that appears once anything is selected.
 *
 * Mirrors the People tab's own selection bar (`app/(app)/(tabs)/people.tsx` —
 * count, Clear, then the actions), because it is the same gesture on the same
 * kind of grid and there is no reason for a marketer to learn it twice.
 *
 * Every action reports the size of the subset it would actually touch, not the
 * size of the selection: selecting thirty rows of which three are opted out
 * offers "Put back 3", never "Put back 30". A button whose label overstates
 * its own reach is how a desk stops trusting the numbers on the screen.
 */
export function MailingListBulkBar({
  selectedCount,
  removableCount,
  restorableCount,
  exportableCount,
  canEdit,
  canExport,
  onClear,
  onRemove,
  onRestore,
  onExport,
}: {
  selectedCount: number;
  /** Selected rows that a removal would change — i.e. not already opted out. */
  removableCount: number;
  /** Selected rows excluded by `opted_out`, the only ones "Put back" can lift. */
  restorableCount: number;
  /** Selected rows that are reachable, and so may be exported. An export is a
   *  file that gets pasted into a sending tool, so it carries reachable people
   *  ONLY — the same rule `exportMailingList` enforces server-side. */
  exportableCount: number;
  canEdit: boolean;
  canExport: boolean;
  onClear: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onExport: () => void;
}) {
  if (selectedCount === 0) return null;
  const removeOverCap = removableCount > MAILING_BULK_LIMIT;
  const restoreOverCap = restorableCount > MAILING_BULK_LIMIT;
  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2">
      <Text className="text-sm font-semibold text-ink">
        {selectedCount} selected
      </Text>
      <Pressable
        onPress={onClear}
        accessibilityRole="button"
        accessibilityLabel="Clear the selection"
        className="active:opacity-70"
      >
        <Text className="text-xs font-medium text-muted underline">Clear</Text>
      </Pressable>
      <View className="flex-1" />
      {canEdit && (removeOverCap || restoreOverCap) ? (
        <Text className="text-xs text-danger">
          Select {MAILING_BULK_LIMIT} or fewer to act on them at once.
        </Text>
      ) : null}
      {canEdit && restorableCount > 0 ? (
        <Button
          title={`Put back ${restorableCount}`}
          icon="rotate-ccw"
          size="sm"
          variant="secondary"
          disabled={restoreOverCap}
          onPress={onRestore}
        />
      ) : null}
      {canEdit ? (
        <Button
          title={`Remove ${removableCount}`}
          icon="user-minus"
          size="sm"
          variant="secondary"
          disabled={removableCount === 0 || removeOverCap}
          onPress={onRemove}
        />
      ) : null}
      {canExport ? (
        <Button
          title={`Export ${exportableCount}`}
          icon="download"
          size="sm"
          variant="ghost"
          disabled={exportableCount === 0}
          onPress={onExport}
        />
      ) : null}
    </View>
  );
}

/**
 * The bulk-removal confirmation.
 *
 * A `Modal` rather than `window.confirm`: this screen runs on native too,
 * where `window` does not exist, and the People tab's own `confirmRemove`
 * (web prompt, silent yes on native) would mean the native app removed forty
 * people with no question asked at all. The one honest cross-platform answer
 * is a dialog the app draws itself.
 */
export function MailingListRemoveConfirm({
  visible,
  names,
  count,
  channel,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  /** The people about to be removed, in display order. */
  names: string[];
  count: number;
  channel: MailingChannel;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const shown = names.slice(0, NAMES_SHOWN);
  const rest = count - shown.length;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised p-5 shadow-pop"
        >
          <View className="mb-3 flex-row items-center gap-2">
            <Icon name="alert-triangle" size={18} color={colors.danger} />
            <Text className="font-display text-lg text-ink">
              {count === 1
                ? "Remove 1 person from the list?"
                : `Remove ${count} people from the list?`}
            </Text>
          </View>

          <Text className="mb-2 text-sm text-muted">
            {shown.join(", ")}
            {rest > 0 ? ` and ${rest} more` : ""}.
          </Text>

          <Text className="mb-4 text-sm text-muted">
            {channel === "sms"
              ? "They stop receiving marketing email and text, and we record a text opt-out against their number so nothing goes out by accident. You can put them back from the “Not reachable” view."
              : "They stop receiving marketing mail. Receipts and event confirmations still reach them — those aren't marketing. You can put them back from the “Not reachable” view."}
          </Text>

          <View className="flex-row items-center justify-end gap-2">
            <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
            <Button
              title={count === 1 ? "Remove them" : `Remove ${count}`}
              size="sm"
              variant="danger"
              loading={busy}
              onPress={onConfirm}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * A CSV, ready to leave the app — used both for the whole-channel export
 * (`exportMailingList`) and for "Export N" over a selection.
 *
 * Copy-to-clipboard is the primary affordance because the destination is
 * Mailchimp's paste box, and because a real file download is web-only in this
 * app. `copyToClipboard` returns false on native (no clipboard module is
 * installed), so the rows stay reachable there through "Show the rows" — a
 * selectable text block. A copy button that silently did nothing on a phone
 * would be worse than one that admits what it can do.
 */
export function MailingListCsvPanel({
  title,
  note,
  csv,
  rows,
  onDismiss,
}: {
  title: string;
  note: string;
  csv: string;
  rows: number;
  onDismiss: () => void;
}) {
  const [showRows, setShowRows] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <View className="mb-3 rounded-lg border border-border bg-raised p-3">
      <View className="mb-1 flex-row items-center gap-2">
        <Text className="flex-1 text-sm font-semibold text-ink">
          {title} · {rows} row{rows === 1 ? "" : "s"}
        </Text>
        <Button
          title={copied ? "Copied" : "Copy CSV"}
          size="sm"
          variant="secondary"
          onPress={() => {
            void copyToClipboard(csv).then((ok) => {
              setCopied(ok);
              // No clipboard on native — open the rows instead of leaving the
              // press looking like it worked.
              if (!ok) setShowRows(true);
            });
          }}
        />
        <Pressable
          onPress={onDismiss}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Dismiss the export"
          className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="x" size={14} color={colors.muted} />
        </Pressable>
      </View>
      <Text className="text-xs text-muted">{note}</Text>
      <Pressable
        onPress={() => setShowRows((v) => !v)}
        accessibilityRole="button"
        className="mt-1.5 self-start active:opacity-70"
      >
        <Text className="text-xs font-medium text-accent">
          {showRows ? "Hide the rows" : "Show the rows"}
        </Text>
      </Pressable>
      {showRows ? (
        <ScrollView
          style={{ maxHeight: 160 }}
          className="mt-2 rounded border border-border bg-sunken p-2"
        >
          <Text selectable className="text-2xs text-muted">
            {csv}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** The compact sign-up-link strip. It used to be a full `Card` at the top of
 *  the screen, which cost the grid a whole fold of height for a line of text
 *  that is copied once a month. Still first, still copyable — one row now. */
export function MailingListSignupLink({ url }: { url: string }) {
  return (
    <View className="mb-3 flex-row items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2">
      <Icon name="link-2" size={14} color={colors.muted} />
      <Text className="text-xs font-semibold text-ink">Sign-up link</Text>
      <Text className="flex-1 text-xs text-faint" numberOfLines={1}>
        {url}
      </Text>
      <Badge label="Writes straight into this list" tone="neutral" />
      <CopyButton text={url} />
    </View>
  );
}
