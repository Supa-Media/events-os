/**
 * TransactionDocumentationModal — everything written down about one charge,
 * behind the speech-bubble on its row.
 *
 * Owner ask (2026-08-09), after a treasurer coded six charges properly and he
 * could not see a word of it anywhere: *"A lot of those coding rows should just
 * show up when I click on the comment field. When I click it I should see the
 * freeform bookkeeping comments, and then additional fields — who it was for,
 * from where to where if it's transportation, the names of the people and their
 * affiliation if it was food. We shouldn't have another table view for this,
 * especially since it's all here."*
 *
 * So this is the same modal the note always opened, grown to hold the record
 * the note was a stand-in for. Two things about one charge, in the order he
 * described them:
 *
 *  1. THE COMMENT — `transactions.note`, unchanged. A bookkeeper's freeform
 *     line, still editable here, still the only field on this screen that
 *     belongs to the finance team rather than to the person who spent the
 *     money.
 *  2. THE CODING — business purpose, route, headcount, attendees and their
 *     affiliations, its review state, and (for a manager who didn't write it)
 *     Approve / Send back. Rendered by `TransactionCodingSection`, the SAME
 *     component the dashboard drill-down uses. Deliberately not a second
 *     renderer: the substance of a coding is hard to render honestly — names
 *     are redacted per-caller, the affiliation breakdown is what publishes —
 *     and two copies of that logic is two chances to leak a name.
 *
 * The section self-hides for a caller the server won't project a coding to
 * (its query returns `undefined` on FORBIDDEN exactly as it does while
 * loading), so this modal shows strictly what its opener is allowed to read.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { MAX_NOTE_LENGTH } from "@events-os/shared";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { TransactionCodingSection } from "../reconcile/TransactionCodingSection";

export function TransactionDocumentationModal({
  transactionId,
  currentNote,
  merchantLine,
  amountCents,
  readOnly = false,
  onClose,
}: {
  transactionId: Id<"transactions">;
  currentNote: string | null;
  /** Merchant + date, for the header and the coding editor's own context line
   *  — a person cannot substantiate a charge they can't see. */
  merchantLine: string;
  amountCents: number;
  /** Peek / below-bookkeeper: the record stays readable, the writes don't. */
  readOnly?: boolean;
  onClose: () => void;
}) {
  const setNote = useMutation(api.finances.setTransactionNote);
  const [value, setValue] = useState(currentNote ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = (value.trim() || null) !== (currentNote?.trim() || null);

  async function saveNote() {
    setSaving(true);
    try {
      await setNote({ transactionId, note: value.trim() ? value : null });
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="flex-1 pr-3">
              <Text className="font-display text-lg text-ink">
                What this was for
              </Text>
              <Text className="text-xs text-muted" numberOfLines={1}>
                {merchantLine}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          {/* The panel can carry a full coding — purpose, route, a named
              attendee list — so it scrolls rather than growing past the
              viewport on a laptop. */}
          <ScrollView className="max-h-[70vh]" contentContainerClassName="px-5 py-4 gap-5">
            <View>
              <Text className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
                Comment
              </Text>
              <Text className="mb-2 text-xs text-muted">
                The finance team&apos;s own line about this charge. Internal —
                unlike the business purpose below, this never publishes.
              </Text>
              {readOnly ? (
                <Text className="text-xs text-ink">
                  {currentNote?.trim() || "No comment."}
                </Text>
              ) : (
                <>
                  <TextField
                    value={value}
                    onChangeText={setValue}
                    placeholder="e.g. Coffee with a prospective donor after service"
                    multiline
                    numberOfLines={3}
                    maxLength={MAX_NOTE_LENGTH}
                  />
                  {dirty ? (
                    <View className="mt-2 flex-row justify-end">
                      <Button
                        title="Save comment"
                        onPress={saveNote}
                        loading={saving}
                      />
                    </View>
                  ) : null}
                </>
              )}
            </View>

            {/* The record the comment was always standing in for. */}
            <TransactionCodingSection
              transactionId={transactionId}
              merchantLine={merchantLine}
              amountCents={amountCents}
              readOnly={readOnly}
              onError={alertError}
            />
          </ScrollView>

          <View className="flex-row justify-end border-t border-border px-5 py-4">
            <Button title="Done" variant="secondary" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
