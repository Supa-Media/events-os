/**
 * The reviewer's half of the Coding tab: every submitted coding they may
 * decide, as a list you work down, with one coding open at a time in
 * `ReviewDecisionPane` (the whole record plus the decision, pinned).
 *
 * ── HISTORY ──────────────────────────────────────────────────────────────────
 * 2026-08-24 — founder: "the review workflow is not as obvious, also when
 * reviewing it doesn't let me review all the fields they entered." That made
 * every row open into `ReviewRecord`, the whole record, receipt first. It
 * still holds: nobody approves what they haven't read.
 *
 * 2026-11-07 — Dev2, arriving from the "Codings need your review" email on a
 * phone: "UX for this is awful especially on mobile." The table that carried
 * the 08-24 design had five fixed-width columns. On a phone the Book, Charge,
 * Amount and Proved-by columns wrapped word by word, and the 260px decision
 * column sat past the right edge of the screen, so a reviewer could open a
 * record and never reach Approve. A three-step "how to review" strip sat above
 * it all. So:
 *
 *  - Rows are CARDS: the purpose leads, since it is the thing being judged,
 *    with amount, merchant, book, who, proof and age around it.
 *  - Phone: tapping a card opens the pane full screen, the decision pinned to
 *    the bottom. Deciding moves to the next coding; Undo stands for a few
 *    seconds after an approval.
 *  - Wide screen: list on the left, pane on the right, first coding open by
 *    default, J / K to move, S to send back, A to approve.
 *  - The steps strip is gone. Opening a card IS step one, and the pinned
 *    buttons are step three; the strip described a layout that no longer
 *    needs describing.
 *
 * Rows the caller may NOT decide come back `canReview: false` from the server
 * rather than hidden — in practice a reviewer's own coding. They sort LAST
 * (`reviewOrder`) under their own heading, and the pane says who decides them
 * instead of offering buttons.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, Icon, Pill, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { ApproveUndoBar, type PendingUndo } from "./CodingWorkbenchPanel";
import { panelPosition, selectionAfterRowsShrink, stepSelection } from "./panelNav";
import {
  daysWaiting,
  filterByReviewer,
  reviewerLine,
  reviewOrder,
  type ReviewerFilter,
} from "./queueDisplay";
import { ReviewDecisionPane, type Decision } from "./ReviewDecisionPane";
import {
  DOCUMENTATION_DISPLAY,
  money,
  shortDate,
  type ReviewQueueRow,
  type RunAction,
} from "./reviewQueueShared";
import type { Id } from "@events-os/convex/_generated/dataModel";

export type { ReviewQueueRow, RunAction } from "./reviewQueueShared";

export function ReviewQueue({
  rows,
  showBook,
  bookFilterName,
  runAction,
  wide,
  who,
  onWhoChange,
}: {
  rows: ReviewQueueRow[];
  /** "For me" (assigned to the caller) or "Everyone" they may decide. */
  who: ReviewerFilter;
  onWhoChange: (next: ReviewerFilter) => void;
  /** Name the book on each card — only meaningful when the queue spans books. */
  showBook: boolean;
  /** The book the queue is filtered to, for the empty state's wording. */
  bookFilterName: string | null;
  runAction: RunAction;
  /** List | record side by side. Below this the record is a full-screen sheet. */
  wide: boolean;
}) {
  const allRows = rows;
  const assignedCount = useMemo(
    () => allRows.filter((r) => r.assignedToMe).length,
    [allRows],
  );
  const shown = useMemo(() => filterByReviewer(allRows, who), [allRows, who]);
  const { decidable, waitingOnOthers } = useMemo(() => reviewOrder(shown), [shown]);
  const ordered = useMemo(
    () => [...decidable, ...waitingOnOthers],
    [decidable, waitingOnOthers],
  );
  const navRows = useMemo(
    () => ordered.map((r) => ({ id: r.transactionId })),
    [ordered],
  );

  // Which coding is open. On a wide screen `null` means "the first one" —
  // there is always something in the right half. On a phone `null` means the
  // sheet is closed.
  const [openId, setOpenId] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  const effectiveId =
    openId != null && navRows.some((r) => r.id === openId)
      ? openId
      : wide
        ? (navRows[0]?.id ?? null)
        : null;
  const openRow = ordered.find((r) => r.transactionId === effectiveId) ?? null;

  // ADVANCE ON DECIDE. A decided coding leaves the queue a beat later (the
  // query is live), so rather than guess the next row before the server
  // agrees, remember where the open row sat and land on whatever occupies
  // that slot once it's gone — the `panelNav` rule the workbench already uses.
  const lastIndex = useRef<number | null>(null);
  useEffect(() => {
    const i = navRows.findIndex((r) => r.id === openId);
    if (i !== -1) {
      lastIndex.current = i;
      return;
    }
    if (openId == null) return;
    setOpenId(selectionAfterRowsShrink(navRows, lastIndex.current));
  }, [navRows, openId]);

  // A different coding never inherits a half-written send-back note.
  useEffect(() => setSendingBack(false), [effectiveId]);

  const step = (delta: 1 | -1) => {
    const next = stepSelection(navRows, effectiveId, delta);
    if (next) setOpenId(next);
  };
  const hasPrev = stepSelection(navRows, effectiveId, -1) != null;
  const hasNext = stepSelection(navRows, effectiveId, 1) != null;

  function onDecided(decision: Decision, row: ReviewQueueRow) {
    // Pin the selection to the decided row so the shrink rule above fires
    // when it leaves, even on a wide screen where `openId` may still be null.
    setOpenId(row.transactionId);
    if (decision === "approved") {
      setPendingUndo({
        transactionId: row.transactionId as Id<"transactions">,
        label: `${money(row.amountCents)}${row.merchantName ? ` ${row.merchantName}` : ""}`,
      });
    }
  }

  // ── keyboard, wide web only: J/K or arrows to move, S send back, A approve.
  // Ignored while typing, so a note or a purpose edit never moves the queue.
  const approveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !wide || typeof document === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        step(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "s" && openRow?.canReview) {
        e.preventDefault();
        setSendingBack(true);
      } else if (e.key === "a" && openRow?.canReview && !openRow.budgetRequired) {
        e.preventDefault();
        approveRef.current?.();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, navRows, effectiveId, openRow]);

  // The phone sheet is its own Modal, so it needs its own error toast — the
  // screen's toast renders underneath it, where nobody would see a refusal.
  const sheetRunner = useActionRunner();
  const { height } = useWindowDimensions();

  // WHO REVIEWS WHAT. Each coding has an assigned reviewer (the chapter's
  // Treasurer / Central's Financial Manager, or the Chapter Director / ED
  // when the Treasurer / FM coded it). "For me" is that list; "Everyone" is
  // everything the caller may decide as backup. Shown only when the queue
  // has anything in it to filter.
  const whoChips =
    allRows.length > 0 ? (
      <View className="mb-3 flex-row flex-wrap items-center gap-2">
        <Pill
          size="sm"
          label="For me"
          count={assignedCount}
          selected={who === "me"}
          onPress={() => onWhoChange("me")}
        />
        <Pill
          size="sm"
          label="Everyone"
          count={allRows.length}
          selected={who === "all"}
          onPress={() => onWhoChange("all")}
        />
      </View>
    ) : null;

  if (shown.length === 0) {
    const assignedElsewhere = who === "me" && allRows.length > 0;
    return (
      <View className="gap-3">
        {whoChips}
        {pendingUndo ? (
          <UndoBar pending={pendingUndo} onDone={() => setPendingUndo(null)} />
        ) : null}
        <EmptyState
          title={
            bookFilterName
              ? `Nothing waiting on you in ${bookFilterName}`
              : "Nothing waiting on you"
          }
          message={
            assignedElsewhere
              ? "None of these are assigned to you. They're with their assigned reviewers; tap Everyone to step in as backup."
              : "Every coding you can decide has been decided. New ones land here the moment a cardholder submits."
          }
        />
      </View>
    );
  }

  const undoBanner = pendingUndo ? (
    <UndoBar pending={pendingUndo} onDone={() => setPendingUndo(null)} />
  ) : null;

  const list = (
    <View className="gap-2.5">
      {whoChips}
      {decidable.map((r) => (
        <ReviewCard
          key={r.transactionId}
          row={r}
          showBook={showBook}
          compact={wide}
          selected={wide && r.transactionId === effectiveId}
          onPress={() => setOpenId(r.transactionId)}
        />
      ))}
      {waitingOnOthers.length > 0 ? (
        <>
          <Text className="mt-3 text-2xs font-semibold uppercase tracking-wide text-muted">
            Yours — another reviewer decides
          </Text>
          {waitingOnOthers.map((r) => (
            <ReviewCard
              key={r.transactionId}
              row={r}
              showBook={showBook}
              compact={wide}
              selected={wide && r.transactionId === effectiveId}
              onPress={() => setOpenId(r.transactionId)}
            />
          ))}
        </>
      ) : null}
    </View>
  );

  const pane = (run: RunAction, onClose?: () => void) =>
    openRow ? (
      <ReviewDecisionPane
        key={openRow.transactionId}
        row={openRow}
        runAction={run}
        position={panelPosition(navRows, effectiveId)}
        onPrev={hasPrev ? () => step(-1) : null}
        onNext={hasNext ? () => step(1) : null}
        onClose={onClose}
        onDecided={onDecided}
        banner={undoBanner}
        sendingBack={sendingBack}
        onSendingBackChange={setSendingBack}
        approveRef={approveRef}
      />
    ) : null;

  if (wide) {
    const paneHeight = Math.max(560, height - 200);
    return (
      <View className="flex-row gap-4" style={{ alignItems: "flex-start" }}>
        <ScrollView style={{ width: 360, maxHeight: paneHeight }} contentContainerStyle={{ paddingRight: 4 }}>
          {list}
        </ScrollView>
        <View
          className="flex-1 overflow-hidden rounded-lg border border-border shadow-card"
          style={{ height: paneHeight, minWidth: 0 }}
        >
          {pane(runAction)}
        </View>
      </View>
    );
  }

  return (
    <View>
      {openRow == null ? undoBanner : null}
      {list}
      {openRow ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setOpenId(null)}
        >
          <SheetFrame>
            {pane(sheetRunner.run, () => setOpenId(null))}
            <ToastView toast={sheetRunner.toast} onDismiss={sheetRunner.dismiss} />
          </SheetFrame>
        </Modal>
      ) : null}
    </View>
  );
}

/** Safe-area padding for the full-screen sheet on a phone. */
function SheetFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-raised"
      style={Platform.OS === "web" ? undefined : { paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

function UndoBar({ pending, onDone }: { pending: PendingUndo; onDone: () => void }) {
  return <ApproveUndoBar key={pending.transactionId} pending={pending} onDone={onDone} />;
}

function ReviewCard({
  row,
  showBook,
  compact,
  selected,
  onPress,
}: {
  row: ReviewQueueRow;
  showBook: boolean;
  compact: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const doc = DOCUMENTATION_DISPLAY[row.documentation];
  const waited = daysWaiting(row.coding.submittedAt);
  const reviewedBy = reviewerLine(row);
  const meta = [
    showBook ? row.book.name : null,
    row.coding.codedByName,
    shortDate(row.postedAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Review ${money(row.amountCents)} ${row.merchantName ?? "charge"}`}
      accessibilityState={{ selected }}
      className={`gap-1.5 rounded-lg border p-3.5 ${
        selected ? "border-accent bg-accent-soft" : "border-border bg-raised shadow-card"
      }`}
    >
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted" numberOfLines={1}>
          {row.merchantName ?? "Charge"}
        </Text>
        <Text className="text-base font-bold text-ink">{money(row.amountCents)}</Text>
      </View>
      <Text className={`${compact ? "text-sm" : "text-base"} leading-snug text-ink`} numberOfLines={compact ? 2 : 3}>
        {row.coding.businessPurpose}
      </Text>
      <Text className="text-xs text-muted" numberOfLines={1}>
        {meta}
      </Text>
      {reviewedBy ? (
        <Text
          className={`text-xs ${row.assignedToMe ? "font-semibold text-accent-hover" : "text-muted"}`}
          numberOfLines={2}
        >
          {reviewedBy}
        </Text>
      ) : null}
      <View className="mt-0.5 flex-row flex-wrap items-center gap-1.5">
        <Tag icon={doc.icon} color={doc.color} label={doc.label} />
        <Tag
          icon="clock"
          color={waited >= 30 ? colors.warn : colors.muted}
          label={waited > 0 ? `${waited} day${waited === 1 ? "" : "s"}` : "Today"}
        />
        {row.canReview && row.budgetRequired ? (
          <Tag icon="alert-triangle" color={colors.warn} label="Needs a budget" />
        ) : null}
        {!compact ? (
          <View className="ml-auto flex-row items-center">
            <Text className="text-sm font-semibold text-accent-hover">Review</Text>
            <Icon name="chevron-right" size={16} color={colors.accentHover} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function Tag({
  icon,
  color,
  label,
}: {
  icon: "paperclip" | "file-text" | "clock" | "alert-triangle";
  color: string;
  label: string;
}) {
  return (
    <View className="flex-row items-center gap-1 rounded-pill bg-sunken px-2 py-0.5">
      <Icon name={icon} size={11} color={color} />
      <Text className="text-2xs font-semibold text-ink">{label}</Text>
    </View>
  );
}
