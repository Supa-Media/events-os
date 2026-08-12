/**
 * THE SIDE PANEL — a wide-screen host for one row's whole job. Shipped for
 * `explain.tsx`, then reused (not forked) by `coding.tsx`'s "Yours to code"
 * list — both mount the exact same component, list to the left, panel to the
 * right.
 *
 * Founder, verbatim: "if I'm seeing a database view when I'm coding, I'm
 * gonna have to be able to like see the receipts really well, like maybe in a
 * side panel"; "information that helps me quickly click in and click out,
 * rather than a modal that's in the middle of the screen that blocks your
 * ability to see other things and click quickly on other things." This is
 * that side panel: the list stays visible and scrollable to its left (the
 * host route renders it), this renders beside it, and clicking another row
 * swaps this panel's content in place — never a modal, never an overlay.
 *
 * THE TWO HOSTS DIFFER ON `todo` AND `canViewReceiptList` — both optional,
 * both default to `explain.tsx`'s original behavior (see each prop's own
 * doc): `todo` because `explain.tsx`'s rows are the publishing population,
 * not the chase state machine; `canViewReceiptList` because `coding.tsx`'s
 * caller can be a cardholder with no finance seat at all, unlike
 * `explain.tsx`'s (gated behind ledger-console access).
 *
 * Composition, top to bottom — deliberately in this order, receipt first:
 *   1. Header — merchant/amount, position in the list ("3 of 42"), Prev/Next.
 *   2. `ReceiptPane` — THE RECEIPT, BIG (see its own module doc).
 *   3. The reviewer's Approve/Send back, IF they can decide this row's coding
 *      — via `FinishChargeSheetBody`'s `renderReview` slot, right next to the
 *      coding it decides.
 *   4. `FinishChargeSheetBody` — THE SAME coding form the modal sheet shows.
 *      Not a second form: one form, two frames (see that file's module doc).
 *
 * SUBMITTING a coding does NOT auto-advance — the founder decides when to
 * move on. Nothing here calls `onNext` after that mutation succeeds; the
 * panel just stays on the same row and shows its new state, because
 * `FinishChargeSheetBody`'s own queries refetch reactively, and the row
 * itself stays right where it was in `rows` (a submitted-but-not-approved
 * coding doesn't remove a row from `monthCodingWorklist`'s pending list).
 *
 * APPROVING one is different, and can't behave the same way: an approved
 * coding DOES leave `monthCodingWorklist`'s pending population, so the row
 * this panel had open simply isn't in `rows` anymore once that mutation's
 * refetch lands — there is no "same row" left to stay on. `explain.tsx`
 * detects that (its own selection-integrity effect, next to `stepRow`) and
 * advances the selection to whichever row now occupies the approved row's
 * old position (`panelNav.ts#selectionAfterRowsShrink`) — the natural next
 * item for someone clearing a biggest-first list, not the auto-advance the
 * founder ruled out for submit, which is a live decision about a coding still
 * on the table, not the mechanical fact that a row physically left the list.
 */
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { displayMerchantName, formatCents } from "@events-os/shared";
import { Button, TextField } from "../../ui";
import { FinishChargeSheetBody } from "../myTransactions/FinishChargeSheet";
import type { ChargeTodo, MyTxnRow } from "../myTransactions/chargeTodo";
import { PublicPurposeEditor } from "./PublicPurposeEditor";
import { ReceiptPane } from "./ReceiptPane";

/** `YYYY-MM-DD` in the finance timezone — same formatting as the modal
 *  sheet's own header, so the two read identically. */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** The Approve/Send back block — the same `approve`/`requestChanges`
 *  mutations `ReviewQueue`'s `QueueRow` calls, wired into
 *  `FinishChargeSheetBody`'s `renderReview` slot so it renders right under
 *  the coding it decides. `canReview: false` (a reviewer looking at their
 *  own submitted coding — self-review) shows the same "waiting on someone
 *  else" line `ReviewQueue` shows in that case, never a working button that
 *  the server would refuse. */
function ReviewActions({
  transactionId,
  coding,
  canReview,
  runAction,
}: {
  transactionId: Id<"transactions">;
  coding: {
    businessPurpose: string;
    publicPurpose: string | null;
    publicPurposeByName: string | null;
    publicPurposeAt: number | null;
  };
  canReview: boolean;
  runAction: (fn: () => Promise<unknown>, errorTitle: string) => Promise<unknown>;
}) {
  const approve = useMutation(api.transactionCodings.approve);
  const requestChanges = useMutation(api.transactionCodings.requestChanges);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");

  // `PublicPurposeEditor` speaks `ReviewQueue`'s `RunAction` shape
  // (`options?: { errorTitle? }`); the panel's `runAction` is
  // `FinishChargeSheetBody`'s own `guard` (`errorTitle` as a plain second
  // arg) — same job, different call shape, so a one-line adapter instead of
  // changing either convention to match the other.
  const runActionForEditor = (
    action: () => Promise<unknown>,
    options?: { errorTitle?: string },
  ) => runAction(action, options?.errorTitle ?? "Couldn't save that");

  return (
    <View className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
      <Text className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-accent">
        Review this coding
      </Text>

      {canReview ? (
        <>
          <PublicPurposeEditor
            transactionId={transactionId}
            state={coding}
            runAction={runActionForEditor}
          />
          <View className="mt-2 flex-row flex-wrap gap-2">
            <Button
              title="Approve"
              size="sm"
              onPress={() =>
                void runAction(
                  () => approve({ transactionId }),
                  "Couldn't record that decision",
                )
              }
            />
            <Button
              title="Send back"
              size="sm"
              variant="secondary"
              onPress={() => {
                setSendingBack((s) => !s);
                setNote("");
              }}
            />
          </View>
          {sendingBack ? (
            <View className="mt-2 gap-2 rounded-md border border-border bg-raised px-3 py-2.5">
              <TextField
                label="What would make it approvable?"
                value={note}
                onChangeText={setNote}
                placeholder='e.g. "Receipt must show the exact amount"'
                multiline
                numberOfLines={2}
              />
              <View className="flex-row gap-2">
                <Button
                  title="Send back"
                  size="sm"
                  onPress={() =>
                    void runAction(async () => {
                      await requestChanges({ transactionId, reviewNote: note });
                      setSendingBack(false);
                    }, "Couldn't record that decision")
                  }
                />
                <Button
                  title="Cancel"
                  size="sm"
                  variant="secondary"
                  onPress={() => setSendingBack(false)}
                />
              </View>
            </View>
          ) : null}
        </>
      ) : (
        <Text className="text-xs italic text-muted">
          Yours — another reviewer decides it.
        </Text>
      )}
    </View>
  );
}

export function CodingWorkbenchPanel({
  txn,
  todo,
  categoryOptions,
  onDeselect,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  position,
  canViewReceiptList,
}: {
  txn: MyTxnRow;
  /** Forwarded verbatim to `FinishChargeSheetBody` — see that prop's own
   *  doc. Omitted by `explain.tsx` (whose rows are the publishing
   *  population, not the chase state machine — `chargeTodo` is the wrong
   *  lens there, see its own module doc); `coding.tsx` passes the SAME
   *  `chargeTodo` verdict its modal (`FinishChargeSheet`) passes today, so
   *  the panel and the modal it replaces on a wide screen never disagree
   *  about what a row still owes. */
  todo?: ChargeTodo;
  categoryOptions: { value: string; label: string }[];
  /** Clears the selection — collapses the panel, nothing left to close in a
   *  modal sense. */
  onDeselect: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  /** "3 of 42" — `null` when the row somehow isn't in the visible list
   *  (shouldn't happen; the header just omits the count if so). */
  position: { index: number; total: number } | null;
  /** Threaded straight to `ReceiptPane`'s own `canViewList` — see that
   *  file's module doc. Omitted (→ `undefined` → `ReceiptPane`'s own
   *  `true` default) by `explain.tsx`, which never needs to probe this;
   *  `coding.tsx` probes `receipts.canViewList` once per screen and passes
   *  the answer here, because ITS caller can be a cardholder with no
   *  finance seat at all. */
  canViewReceiptList?: boolean;
}) {
  const transactionId = txn.id as Id<"transactions">;
  const merchantLine = `${displayMerchantName(txn, "—")} · ${dateStr(txn.postedAt)}`;

  return (
    <View className="flex-1 rounded-xl border border-border bg-raised">
      <View className="flex-row items-start justify-between gap-3 border-b border-border px-4 py-3">
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>
            {merchantLine}
          </Text>
          <Text className="text-xs text-muted">
            {formatCents(Math.abs(txn.amountCents))}
            {txn.cardLast4 ? ` · card ••${txn.cardLast4}` : ""}
            {position ? ` · ${position.index} of ${position.total}` : ""}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            icon="chevron-up"
            title="Prev"
            disabled={!hasPrev}
            onPress={onPrev}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="chevron-down"
            title="Next"
            disabled={!hasNext}
            onPress={onNext}
          />
          <Button variant="secondary" size="sm" title="Close" onPress={onDeselect} />
        </View>
      </View>

      <ScrollView className="flex-1">
        <View className="gap-5 p-4">
          <ReceiptPane
            transactionId={transactionId}
            hasReceipt={txn.hasReceipt}
            hasApprovedException={txn.hasApprovedException}
            canViewList={canViewReceiptList}
          />
          <FinishChargeSheetBody
            txn={txn}
            todo={todo}
            categoryOptions={categoryOptions}
            renderReview={({ transactionId: tid, coding, canReview, runAction }) => (
              <ReviewActions
                transactionId={tid}
                coding={coding}
                canReview={canReview}
                runAction={runAction}
              />
            )}
          />
        </View>
      </ScrollView>
    </View>
  );
}
