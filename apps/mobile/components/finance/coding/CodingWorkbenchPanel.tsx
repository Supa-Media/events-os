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
 *
 * ── APPROVE IS ONE UNDOABLE TAP (2026-08-14) ─────────────────────────────────
 * Everything above stays true, and it is exactly what made Approve the most
 * consequential unconfirmed tap in the app: it PUBLISHES a sentence, it makes
 * the coding IMMUTABLE (`submitCoding` throws `CODING_APPROVED`), and then the
 * row leaves the list, so there was nothing left to look at and no way back on
 * this screen. For somebody writing four hundred of these, that meant you
 * could not re-read what you had just published, and the only reopen path
 * (`transactionCodings.requestChanges`) lived on another surface.
 *
 * Three things answer that, and they are deliberately small:
 *  1. A CONFIRM BEAT inside `ReviewActions` — one inline step naming the
 *     consequence, not a modal and not a typed confirmation. A wall on a
 *     screen someone works down four hundred times is either clicked through
 *     blind or makes the job untenable.
 *  2. AN UNDO WINDOW (`ApproveUndoBar`, ~10s) calling
 *     `transactionCodings.undoApproval` — a real state change, audited as an
 *     undo, which puts the coding back to `submitted` (the REVIEWER's queue,
 *     where it was) and tells nobody, because the author never saw the
 *     approval. Deliberately NOT `requestChanges`: that means "the author must
 *     act" and emails them saying so, neither of which is true of a mis-tap.
 *     See `ApproveUndoBar`'s own doc. It lives at PANEL level because
 *     `renderReview` unmounts the instant the coding stops being `submitted`.
 *  3. RE-READABILITY from the grid, which is the Reconcile grid's own
 *     `explained` facet (`RECONCILE_FILTER_LABELS.explained`): the complement
 *     of `needs_explaining`, one tap, and every approved row opens right back
 *     into this panel showing its final state.
 */
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  displayMerchantName,
  formatCents,
  rawBankLine,
  MAX_MERCHANT_NAME_LENGTH,
} from "@events-os/shared";
import { Badge, Button, InlineText, TextField } from "../../ui";
import { alertError } from "../../../lib/errors";
import {
  FinishChargeSheetBody,
  type CategoryOption,
} from "../myTransactions/FinishChargeSheet";
import type { ChargeTodo, MyTxnRow } from "../myTransactions/chargeTodo";
import { PublicPurposeEditor } from "./PublicPurposeEditor";
import { ReceiptPane } from "./ReceiptPane";
// The toast's own length. Its own module so `undoWindow.test.ts` can pin it
// below the server's `UNDO_APPROVAL_WINDOW_MS` without importing this file's
// react-native dependencies — see that constant's doc.
import { APPROVE_UNDO_SECONDS } from "./undoWindow";

/** `YYYY-MM-DD` in the finance timezone — same formatting as the modal
 *  sheet's own header, so the two read identically. */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** The row an undo is offered for, with the name the person was looking at
 *  when they approved it. Held by the PANEL, not by `ReviewActions`, because
 *  `renderReview` only mounts while a coding is `submitted` — the instant the
 *  approval lands, the component that made it is gone. */
interface PendingUndo {
  transactionId: Id<"transactions">;
  label: string;
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
  onApproved,
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
  /** Fired once the approval has actually landed — the panel arms its undo. */
  onApproved: () => void;
}) {
  const approve = useMutation(api.transactionCodings.approve);
  const requestChanges = useMutation(api.transactionCodings.requestChanges);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  // THE BEAT BEFORE PUBLISHING. Approve used to be one unconfirmed tap on a
  // button sitting inches from Prev/Next, and what it does is irreversible in
  // place (the coding becomes immutable) and PUBLIC (the sentence goes on the
  // ledger). Deliberately not a modal and not a typed confirmation: this is a
  // screen somebody works down four hundred times, and a wall would either be
  // clicked through blind or make the whole job untenable. One inline step
  // that names the consequence is the proportionate answer — and the undo
  // below it is what lets that step stay small.
  const [confirming, setConfirming] = useState(false);

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
            {confirming ? (
              // THE BEAT. Named consequence, then the same word on the button
              // that started the step, so nobody has to work out which of two
              // similar buttons commits.
              <View className="w-full gap-2 rounded-md border border-accent/50 bg-raised px-3 py-2.5">
                <Text className="text-xs text-ink">
                  This publishes the sentence above to the public ledger and
                  locks the coding — reopening it afterwards is its own recorded
                  decision.
                </Text>
                <View className="flex-row gap-2">
                  <Button
                    title="Approve & publish"
                    size="sm"
                    icon="check"
                    onPress={() =>
                      void runAction(async () => {
                        await approve({ transactionId });
                        setConfirming(false);
                        onApproved();
                      }, "Couldn't record that decision")
                    }
                  />
                  <Button
                    title="Cancel"
                    size="sm"
                    variant="secondary"
                    onPress={() => setConfirming(false)}
                  />
                </View>
              </View>
            ) : (
              <Button
                title="Approve"
                size="sm"
                onPress={() => {
                  setConfirming(true);
                  setSendingBack(false);
                }}
              />
            )}
            {!confirming ? (
              <Button
                title="Send back"
                size="sm"
                variant="secondary"
                onPress={() => {
                  setSendingBack((s) => !s);
                  setNote("");
                }}
              />
            ) : null}
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

/**
 * THE UNDO WINDOW — a real state change, not a hidden button.
 *
 * Approving is publishing, and the row it happened to LEAVES the list (an
 * approved coding is out of `needs_explaining`), so before this existed the
 * sequence was: tap, row vanishes, no way back on this screen. The only reopen
 * path lived on another surface.
 *
 * ## Why this calls `undoApproval` and NOT `requestChanges`
 *
 * It used to call `requestChanges`, and that was wrong in a way that looked
 * cosmetic and wasn't:
 *
 *  - `requestChanges` lands the coding in `changes_requested`, which means
 *    "the AUTHOR must act". It moves the row into the spender's queue and asks
 *    them to fix something. But an undo means the APPROVER mis-tapped — the
 *    coding was fine, it was awaiting review, and it should be awaiting review
 *    again. The undo was silently converting "waiting on a reviewer" into
 *    "waiting on the person who wrote it".
 *  - It also EMAILS the author (`cards.notifyCodingSentBack`), carrying the
 *    review note. The author never saw the approval, so they'd be told about a
 *    state that never existed on their side — with "undone by the approver"
 *    reading as feedback on work nobody criticised.
 *
 * `transactionCodings.undoApproval` restores `submitted`, clears what the
 * approval stamped, notifies nobody, and is audited as an undo (never as a
 * rejection). It is gated server-side to the identity that made the approval
 * and to `UNDO_APPROVAL_WINDOW_MS` — so the countdown below is a courtesy, not
 * the rule, and a paused tab cannot widen it.
 *
 * It stays a CONVENIENCE, not the only way back. When the seconds lapse the
 * row is still reopenable from this panel's own Send-back — which is the right
 * act by then, note and email included, because an approval that has stood a
 * while may have been acted on — and, with the grid's `explained` facet, still
 * findable. Nothing depends on catching the toast.
 */
function ApproveUndoBar({
  pending,
  onDone,
}: {
  pending: PendingUndo;
  onDone: () => void;
}) {
  const undoApproval = useMutation(api.transactionCodings.undoApproval);
  const [left, setLeft] = useState(APPROVE_UNDO_SECONDS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLeft(APPROVE_UNDO_SECONDS);
    const tick = setInterval(() => setLeft((n) => n - 1), 1000);
    return () => clearInterval(tick);
  }, [pending.transactionId]);

  useEffect(() => {
    if (left > 0) return;
    // NOT while an undo is in flight: the window lapsing must never dismiss a
    // request that is still going to land, or the person watches the bar
    // disappear with no idea whether it worked.
    if (busy) return;
    onDone();
    // Deliberately keyed on the countdown alone. `onDone` is an inline closure
    // from the parent and changes identity every render; listing it would
    // re-run this on every render rather than on every tick, which is not what
    // "when the window lapses" means. It is read from the latest render, which
    // is exactly the behaviour wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, busy]);

  return (
    <View className="flex-row items-center gap-3 border-t border-border bg-sunken px-4 py-2.5">
      <Text className="flex-1 text-xs text-ink" numberOfLines={2}>
        Published {pending.label}.
      </Text>
      <Button
        title={`Undo (${Math.max(left, 0)})`}
        size="sm"
        variant="secondary"
        icon="corner-up-left"
        loading={busy}
        onPress={() => {
          setBusy(true);
          // No note, because there is no complaint — the mutation records its
          // own audit reason naming this an undo. A send-back's note is the
          // author's instructions, and inventing one here would put words in
          // a reviewer's mouth about a coding nobody found fault with.
          undoApproval({ transactionId: pending.transactionId })
            .then(onDone)
            // A FAILED UNDO MUST BE LOUD and must NOT close the bar: the
            // coding is still approved, and silently dismissing would leave
            // the person believing they took it back.
            .catch(alertError)
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}

export function CodingWorkbenchPanel({
  txn,
  todo,
  categoryOptions,
  ownCharge,
  onDeselect,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  position,
  canViewReceiptList,
  canRename,
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
  categoryOptions: CategoryOption[];
  /** Forwarded verbatim to `FinishChargeSheetBody` — see that prop's own
   *  doc, and `planCategoryEdit` for why it matters. `coding.tsx` passes
   *  `true` (`finances.personTransactions` rows, own-by-construction);
   *  `explain.tsx` passes `false` (`finances.monthCodingWorklist` rows are
   *  the whole chapter's publishing population, not just the caller's own —
   *  the HIGH review finding this prop exists to fix). REQUIRED, not
   *  defaulted: a silent default here is exactly the kind of per-row guess
   *  that broke the Explain workbench in the first place. */
  ownCharge: boolean;
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
  /**
   * Whether this caller may rename the row's merchant here
   * (`finances.renameMerchant`, bookkeeper+). SERVER-ANSWERED — `explain.tsx`
   * passes `monthCodingWorklist.canRename`, because that screen's own floor is
   * VIEWER and an editable field a viewer's every keystroke would be refused
   * for is worse than no field. Omitted by `coding.tsx` (a cardholder working
   * their own charges has no finance seat to rename with).
   *
   * WHY RENAME LIVES HERE AT ALL (founder, 2026-08-13: "when doing the by
   * month reconciliation there is currently no way for me to edit the
   * transaction title"). It was reachable only from the Reconcile grid's
   * merchant cell — but the moment you NOTICE a bad title is while preparing a
   * month to publish, looking at this panel, and the specific thing she
   * noticed was a private individual's full name about to go on a public page.
   * Making her leave for another screen to fix it is how it doesn't get fixed.
   */
  canRename?: boolean;
}) {
  const transactionId = txn.id as Id<"transactions">;
  const shownMerchant = displayMerchantName(txn, "—");
  const renameMerchant = useMutation(api.finances.renameMerchant);
  const clearMerchantRename = useMutation(api.finances.clearMerchantRename);
  // The undo window lives HERE rather than in `ReviewActions`, because
  // `renderReview` only mounts while a coding is `submitted` — the instant the
  // approval lands the component that made it is unmounted, and on the
  // Reconcile grid the ROW ITSELF leaves the list a moment later (an approved
  // coding is out of `needs_explaining`, so the panel steps to the next row).
  // The undo has to outlive both, which is why it carries the transaction id
  // and the name that was on screen when the tap happened.
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  function onCommitMerchant(next: string) {
    const trimmed = next.trim();
    if (trimmed === shownMerchant) return; // untouched — never write, never log
    if (!trimmed) {
      // Nothing to revert to when no override is in place; `InlineText`
      // re-syncs from `value` on the next render.
      if (txn.merchantNameOverride == null) return;
      void clearMerchantRename({ transactionId }).catch(alertError);
      return;
    }
    void renameMerchant({ transactionId, merchantName: trimmed }).catch(alertError);
  }
  // FINDING 5 (UX audit, 2026-08-12): the raw bank/processor description,
  // shown beneath the cleaned name only when it says something different.
  const rawLine = rawBankLine(txn);
  // WHO TO ASK (founder, 2026-08-13: "I have to probably ping and message
  // them what it was for — but I don't even know who to ask").
  // `cardholderName` rides `monthCodingWorklist` rows; `coding.tsx`'s rows
  // are the caller's own, where the field is absent and the question is
  // moot. "No cardholder" is said out loud rather than omitted — a bank or
  // imported row genuinely has nobody to ping, and silence would read as a
  // data gap instead of a fact.
  const cardholderName = (txn as { cardholderName?: string | null }).cardholderName;
  const whose =
    cardholderName != null
      ? `${cardholderName} · card ••${txn.cardLast4 ?? "—"}`
      : txn.cardLast4
        ? `card ••${txn.cardLast4}`
        : cardholderName === null
          ? "no cardholder — bank/imported row"
          : null;
  // THE SPLIT (founder-approved, 2026-08-13): same optional, populated-only-
  // by-`monthCodingWorklist` field as `cardholderName` just above — `coding.tsx`
  // rows never carry it (the caller's own charges are never reconstructed
  // history), so `undefined` there quietly renders nothing.
  const reconstructed = (txn as { reconstructed?: boolean }).reconstructed === true;

  return (
    <View className="flex-1 rounded-xl border border-border bg-raised">
      <View className="flex-row items-start justify-between gap-3 border-b border-border px-4 py-3">
        <View className="flex-1">
          {/* numberOfLines={2}: the merchant name is the row's identity, and
              the founder hit it truncated to uselessness at one line ("the
              name of the transaction is kind of cut off"). Two lines covers
              every real descriptor; beyond that the raw line below has it. */}
          <View className="flex-row flex-wrap items-center gap-2">
            {canRename ? (
              // Same commit semantics as the Reconcile grid's own merchant
              // cell, deliberately: blank means "go back to what the bank
              // called it", which is `clearMerchantRename` rather than an
              // empty name. The provider's value is never overwritten either
              // way — `renameMerchant` writes a separate override — so a title
              // fixed here keeps the statement's own wording as provenance.
              <View className="min-w-0 flex-1">
                <InlineText
                  value={shownMerchant}
                  onCommit={onCommitMerchant}
                  maxLength={MAX_MERCHANT_NAME_LENGTH}
                  weight="medium"
                />
              </View>
            ) : (
              <Text className="text-base font-semibold text-ink" numberOfLines={2}>
                {shownMerchant}
              </Text>
            )}
            <Text className="text-base font-semibold text-ink">
              · {dateStr(txn.postedAt)}
            </Text>
            {reconstructed ? (
              <Badge tone="info" icon="archive" label="Imported record" />
            ) : null}
          </View>
          {canRename ? (
            // Said plainly, because the founder's reason for renaming was a
            // person's name heading for a public page and "will this actually
            // remove it" is the question that decides whether she trusts it.
            <Text className="text-2xs text-faint">
              Rename publishes; the bank&apos;s own wording is kept underneath.
            </Text>
          ) : null}
          <Text className="text-xs text-muted">
            {formatCents(Math.abs(txn.amountCents))}
            {whose ? ` · ${whose}` : ""}
            {position ? ` · ${position.index} of ${position.total}` : ""}
          </Text>
          {rawLine ? (
            <Text className="text-2xs text-faint" numberOfLines={1}>
              {rawLine}
            </Text>
          ) : null}
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
            // KEYED PER ROW: this panel persists across Prev/Next, but the
            // coding form's state must not — half-typed words, a prefill off
            // row A's reimbursement request (`reimbursementPrefill.ts`), or
            // a stale success banner following you to row B would all read
            // as row B's own. A row change is a fresh form, always.
            key={transactionId}
            txn={txn}
            todo={todo}
            categoryOptions={categoryOptions}
            ownCharge={ownCharge}
            renderReview={({ transactionId: tid, coding, canReview, runAction }) => (
              <ReviewActions
                transactionId={tid}
                coding={coding}
                canReview={canReview}
                runAction={runAction}
                onApproved={() => {
                  setPendingUndo({
                    transactionId: tid,
                    // The name that was on screen when they tapped — the undo
                    // may well outlive this row's place in the list.
                    label: `${shownMerchant} · ${dateStr(txn.postedAt)}`,
                  });
                }}
              />
            )}
          />
        </View>
      </ScrollView>

      {/* THE UNDO WINDOW, pinned to the bottom of the panel rather than
          floating over the grid: this belongs to the row that was just
          decided, and the panel is where that decision was made. */}
      {pendingUndo ? (
        <ApproveUndoBar
          key={pendingUndo.transactionId}
          pending={pendingUndo}
          onDone={() => setPendingUndo(null)}
        />
      ) : null}
    </View>
  );
}
