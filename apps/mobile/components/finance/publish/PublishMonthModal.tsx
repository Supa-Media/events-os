/**
 * PUBLISHING A MONTH WITHOUT LEAVING THE GRID.
 *
 * The second frame for `PublishMonthBody` — the first being the publish
 * console route. Founder, 2026-08-14: "I want to be able to preview and
 * publish from the same page — publish here takes me to a different page
 * entirely." Preview already happened on the band; this is the other half.
 *
 * ── NOTHING IS RE-IMPLEMENTED HERE ───────────────────────────────────────────
 * This file is a frame and a header. The flow inside it is the console's own
 * component, so the two-approver handoff, the amendment reason on a
 * re-publish, the `SNAPSHOT_TRUNCATED` refusal and every other refusal
 * `publicLedger` raises reach the publisher through exactly the same code path
 * they always did. Publishing from the grid is not a shortcut past the
 * ceremony; it is the ceremony, in a modal.
 *
 * ── A MODAL IN BOTH WIDTHS, UNLIKE A ROW'S RECORD ────────────────────────────
 * `ReconcileList.tsx#openRecord` puts a row's record in the side panel when
 * the screen is wide, because working rows is a stepper: open one, fix it,
 * step to the next with the list still in view. Publishing is not that. It is
 * one act on one month, it must not compete with the panel's row selection
 * (the panel IS the selected row), and a reader halfway through reading
 * disclosures should not have the thing they are about to stand behind
 * swapped out from under them by a stray click on the grid. So: modal, both
 * widths, dismissed deliberately.
 *
 * ── THE HEADER'S JOB IS TO NAME THE BOOK ─────────────────────────────────────
 * The console settles "which book is this" above its month list, and this
 * frame owes the same answer before anything is read — `scopeName` comes
 * straight from `console_`, the server's own name for the book it answered
 * about, so the header cannot be wrong about which book is on screen. The
 * grid's own book selector is what changes it; there is no `?scope=` to
 * refuse here, which is why there is no `BookScopeNotice`.
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  PublishMonthBody,
  PublishMonthNotes,
  type PublishBookScope,
  type PublishMonthSummary,
} from "./PublishMonth";
import { publicationBadge } from "./publishBandAction";

export function PublishMonthModal({
  month,
  scope,
  scopeName,
  canPublish,
  onClose,
}: {
  month: PublishMonthSummary;
  /** ONE book, never null: the merged all-books queue routes to the console
   *  instead of opening this (`publishBandAction`), because a month band there
   *  spans several books and this flow publishes exactly one. */
  scope: PublishBookScope;
  /** `console_.scopeName` — the server's name for the book being published. */
  scopeName: string;
  canPublish: boolean;
  onClose: () => void;
}) {
  const badge = publicationBadge({
    status: month.status,
    liveRevision: month.liveRevision,
  });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* No dismiss-on-backdrop-press. Every other finance modal closes when
          the scrim is tapped; this one holds a half-typed amendment sentence
          and a set of disclosures somebody is reading before they commit, and
          losing that to a mis-click beside the dialog is a worse failure than
          one extra tap on the X. */}
      <View className="flex-1 items-center justify-center bg-ink/30 p-6">
        <View className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop">
          <View className="flex-row items-center gap-3 border-b border-border px-5 py-4">
            <View className="flex-1">
              <Text className="font-display text-lg text-ink">
                {month.label}
              </Text>
              {/* WHICH BOOK. Named on the same line as the month, because
                  "publish March 2025" is not a complete sentence until it
                  says whose March 2025. */}
              <Text className="text-xs text-muted">{scopeName}</Text>
            </View>
            <Badge tone={badge.tone} label={badge.label} />
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[560px] px-5 pb-4">
            <Text className="mt-3 text-sm text-muted">
              What goes out can&apos;t be edited afterwards — only corrected in
              public.
            </Text>
            <PublishMonthNotes month={month} />
            <PublishMonthBody
              month={month}
              scope={scope}
              canPublish={canPublish}
              // "Explain them now" leaves for the grid's by-month view; close
              // first so the reader lands on it rather than under this.
              onLeave={onClose}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
