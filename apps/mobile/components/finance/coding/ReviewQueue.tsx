/**
 * The reviewer's half of the Coding tab: every submitted coding they may
 * decide, with enough of the record on the row to decide WITHOUT opening it —
 * and the whole record one tap away when the row isn't enough.
 *
 * The first half is the original design brief. A reviewer's real question is
 * "does this purpose, against this document, hold up to a stranger reading the
 * public ledger?" — and answering it used to mean opening each charge's detail
 * view one at a time. So each row carries the substantiation itself: the
 * purpose in full, the route on travel, the headcount or attendee breakdown on
 * meals, and what the charge is proved by. Approve and Send back sit on the
 * row.
 *
 * ── THE SECOND HALF: REVIEW, THEN DECIDE (2026-08-24) ────────────────────────
 * Founder, on this exact screen: "the review workflow is not as obvious, also
 * when reviewing it doesn't let me review all the fields they entered, like if
 * it's a meal, I should see people's names listed for the meal, I should also
 * be able to review receipts or receipt exception requests."
 *
 * Both halves of that are the same gap. The row is a SUMMARY, and a summary is
 * a thing you skim — so a queue that offers only a summary and two decision
 * buttons is a queue that asks people to approve what they haven't read. The
 * attendee names, the travelers, the category and budget, the send-back
 * conversation, the receipt itself and the exception request standing in for a
 * missing one were all real, all recorded, and all on other screens.
 *
 * So every row now OPENS, in place, into `ReviewRecord` — the whole record,
 * receipt first, fed by one VIEW-gated query. The decision buttons stay on the
 * row where they always were, so opening a record and deciding it is one
 * motion down one column rather than two button sets in two places. One row is
 * open at a time (`openId` lives on the queue, not the row): this is a list
 * somebody works down, not a set of panels to arrange.
 *
 * And the workflow says its own name now — the steps strip above the table
 * ("open the record → read the proof → approve or send back") plus an explicit
 * Review button on every row, because a bare pair of Approve/Send back buttons
 * reads as a form to fill, not a job to do.
 *
 * Rows the caller may NOT decide come back `canReview: false` from the server
 * rather than being hidden — the Reconcile `canEdit` posture. In practice
 * that's a reviewer's own coding sitting in their own queue: it should be
 * visible (it IS outstanding work) and it should be obvious that it's waiting
 * on somebody else. The buttons are replaced by the reason, never by nothing.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { ATTENDEE_AFFILIATION_LABELS } from "@events-os/shared";
import {
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Icon,
  Row,
  Table,
  TableHeader,
  TextField,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { daysWaiting, substantiationLine } from "./queueDisplay";
import {
  PublicPurposeEditor,
  PublicPurposeNotice,
} from "./PublicPurposeEditor";
import { ReviewRecord } from "./ReviewRecord";

export interface ReviewQueueRow {
  transactionId: string;
  book: { id: string; name: string };
  merchantName: string | null;
  amountCents: number;
  postedAt: number;
  documentation: "receipt" | "exception_approved" | "exception_pending" | "none";
  canReview: boolean;
  /** This charge owes a budget and hasn't got one — `approve` refuses it
   *  (founder, 2026-09-02: "we shouldn't be letting things go through without
   *  a budget"). The row says so and opens the record, where the reviewer can
   *  now set it themselves, instead of offering a button that throws. */
  budgetRequired: boolean;
  coding: {
    expenseType: string;
    expenseTypeLabel: string;
    businessPurpose: string;
    travelFrom: string | null;
    travelTo: string | null;
    headcount: number | null;
    attendees: { name: string; affiliation: string }[] | null;
    affiliationBreakdown: Record<string, number>;
    groupDescription: string | null;
    publicPurpose: string | null;
    publicPurposeByName: string | null;
    publicPurposeAt: number | null;
    codedByName: string | null;
    submittedAt: number;
  };
}

function money(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const DOCUMENTATION_DISPLAY: Record<
  ReviewQueueRow["documentation"],
  { label: string; icon: "paperclip" | "file-text" | "clock" | "alert-triangle"; color: string }
> = {
  receipt: { label: "Receipt", icon: "paperclip", color: colors.success },
  exception_approved: {
    label: "Exception approved",
    icon: "file-text",
    color: colors.success,
  },
  exception_pending: {
    label: "Exception pending",
    icon: "clock",
    color: colors.warn,
  },
  // Unreachable on a submitted coding — the documentation gate refuses one.
  // Rendered loudly rather than silently, because if it ever appears it means
  // a rule stopped holding, not that a row is untidy.
  none: { label: "No proof", icon: "alert-triangle", color: colors.danger },
};


/** The screen's `useActionRunner().run` — it owns the error toast, so a
 *  refused decision surfaces the server's own message rather than a generic
 *  one invented here. */
export type RunAction = (
  action: () => Promise<unknown>,
  options?: { errorTitle?: string },
) => Promise<unknown>;

function QueueRow({
  row,
  last,
  showBook,
  open,
  onToggle,
  runAction,
}: {
  row: ReviewQueueRow;
  last: boolean;
  showBook: boolean;
  /** Whether THIS row's full record is expanded. Owned by the queue so only
   *  one is ever open — see the module doc. */
  open: boolean;
  onToggle: () => void;
  runAction: RunAction;
}) {
  const approve = useMutation(api.transactionCodings.approve);
  const requestChanges = useMutation(api.transactionCodings.requestChanges);
  const [busy, setBusy] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");

  const doc = DOCUMENTATION_DISPLAY[row.documentation];
  const substantiation = substantiationLine(
    row.coding,
    ATTENDEE_AFFILIATION_LABELS,
  );
  const waited = daysWaiting(row.coding.submittedAt);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await runAction(fn, { errorTitle: "Couldn't record that decision" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className={last ? "" : "border-b border-border"}>
      <Row last>
        {showBook ? (
          <Cell width={110}>
            <Text className="text-xs text-muted">{row.book.name}</Text>
          </Cell>
        ) : null}
        <Cell flex={3}>
          <Text className="text-sm font-medium text-ink" numberOfLines={1}>
            {row.merchantName ?? "—"}
          </Text>
          <Text className="text-2xs text-muted">
            {shortDate(row.postedAt)} · {row.coding.expenseTypeLabel} ·{" "}
            {row.coding.codedByName ?? "—"}
          </Text>
        </Cell>
        <Cell width={100} align="right">
          <Text className="text-sm text-ink">{money(row.amountCents)}</Text>
        </Cell>
        <Cell width={150}>
          <View className="flex-row items-center gap-1.5">
            <Icon name={doc.icon} size={12} color={doc.color} />
            <Text className="text-2xs text-muted">{doc.label}</Text>
          </View>
          {waited > 0 ? (
            <Text className="text-2xs text-muted">
              waiting {waited} day{waited === 1 ? "" : "s"}
            </Text>
          ) : null}
        </Cell>
        <Cell width={260} align="right">
          <View className="flex-row flex-wrap justify-end gap-1.5">
            {/* FIRST, and first for everyone — including the caller who may
                not decide this row. Reviewing is reading; deciding is the
                separate thing the server gates. Putting the two decision
                buttons alone on a row is what made this queue read as
                "approve this" rather than "review this". */}
            <Button
              title={open ? "Hide record" : "Review record"}
              size="sm"
              variant="secondary"
              onPress={onToggle}
            />
          </View>
          {row.canReview ? (
            <View className="mt-1.5 flex-row flex-wrap justify-end gap-1.5">
              {/* NO BUDGET, NO APPROVE — and the reason, next to the button
                  it disables. The server refuses this row (`BUDGET_REQUIRED`)
                  and it would have been a toast AFTER the tap; saying it here
                  costs nothing and points at the fix, which as of this change
                  is one tap away on this same row rather than a send-back.
                  Send back stays live: a missing budget is not the only thing
                  that can be wrong with a coding. */}
              <Button
                title="Approve"
                size="sm"
                loading={busy}
                disabled={row.budgetRequired}
                onPress={() =>
                  void run(() =>
                    approve({
                      transactionId: row.transactionId as Id<"transactions">,
                    }),
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
          ) : (
            // The one case that reaches here: their own coding. Say so — an
            // empty cell reads as a bug, and "waiting on someone else" is
            // genuinely the status.
            <Text className="mt-1.5 text-2xs italic text-muted">
              Yours — another reviewer decides it
            </Text>
          )}
          {row.canReview && row.budgetRequired ? (
            <Text className="mt-1 text-right text-2xs text-warn">
              Needs a budget — open the record to set it
            </Text>
          ) : null}
        </Cell>
      </Row>

      {/* The purpose is the substance of the review, so it gets its own line
          at full width rather than a truncated column — and, for whoever can
          decide the row, the place to strip a name out of it before it
          publishes rather than bouncing the whole coding back over one. */}
      <View className="px-4 pb-3">
        <Text className="text-xs text-ink">{row.coding.businessPurpose}</Text>
        {substantiation ? (
          <Text className="mt-0.5 text-2xs text-muted">{substantiation}</Text>
        ) : null}
        {row.canReview ? (
          <PublicPurposeEditor
            transactionId={row.transactionId}
            state={row.coding}
            runAction={runAction}
          />
        ) : (
          <PublicPurposeNotice state={row.coding} />
        )}
      </View>

      {sendingBack ? (
        <View className="gap-2 border-t border-border bg-sunken px-4 py-3">
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
              loading={busy}
              onPress={() =>
                void run(async () => {
                  await requestChanges({
                    transactionId: row.transactionId as Id<"transactions">,
                    reviewNote: note,
                  });
                  setSendingBack(false);
                })
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

      {/* THE WHOLE RECORD, in place. Mounted only while open so a queue of a
          hundred rows doesn't fire a hundred record queries — and unmounted on
          collapse so reopening a row re-reads it rather than showing a
          decision-stale copy. */}
      {open ? (
        <ReviewRecord
          transactionId={row.transactionId}
          runAction={runAction}
        />
      ) : null}
    </View>
  );
}

/** The three beats of a review, said out loud above the table.
 *
 *  Founder: "the review workflow is not as obvious." It wasn't stated
 *  anywhere — the queue showed rows and two buttons, and a reader had to infer
 *  that opening the record was a step at all (it wasn't, before this) let
 *  alone the FIRST one. Three short beats, not a lesson: this is a strip
 *  somebody reads once and then stops seeing. */
const REVIEW_STEPS: { icon: "file-text" | "search" | "check-circle"; text: string }[] = [
  { icon: "search", text: "Open the record" },
  { icon: "file-text", text: "Read the proof and who was there" },
  { icon: "check-circle", text: "Approve, or send it back with a note" },
];

function ReviewSteps() {
  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border bg-sunken px-3 py-2">
      {REVIEW_STEPS.map((step, i) => (
        <View key={step.text} className="flex-row items-center gap-2">
          {i > 0 ? (
            <Icon name="chevron-right" size={12} color={colors.faint} />
          ) : null}
          <View className="flex-row items-center gap-1.5">
            <Icon name={step.icon} size={12} color={colors.muted} />
            <Text className="text-2xs text-muted">
              <Text className="font-semibold text-ink">{i + 1}.</Text> {step.text}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function ReviewQueue({
  rows,
  showBook,
  bookFilterName,
  runAction,
}: {
  rows: ReviewQueueRow[];
  /** Show the Book column — only meaningful when the queue spans books. */
  showBook: boolean;
  /** The book the queue is filtered to, for the empty state's wording. */
  bookFilterName: string | null;
  runAction: RunAction;
}) {
  // ONE open record at a time. This is a list somebody works down — a stack of
  // expanded panels turns it into a thing to scroll past rather than a queue
  // to clear, and each open record is a live query.
  const [openId, setOpenId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          bookFilterName
            ? `Nothing waiting on you in ${bookFilterName}`
            : "Nothing waiting on you"
        }
        message="Every coding you can decide has been decided. New ones land here the moment a cardholder submits."
      />
    );
  }

  return (
    <View>
      <ReviewSteps />
      <Table>
        <TableHeader>
          {showBook ? <HeaderCell width={110}>Book</HeaderCell> : null}
          <HeaderCell flex={3}>Charge</HeaderCell>
          <HeaderCell width={100} align="right">
            Amount
          </HeaderCell>
          <HeaderCell width={150}>Proved by</HeaderCell>
          <HeaderCell width={260} align="right">
            {" "}
          </HeaderCell>
        </TableHeader>
        {rows.map((r, i) => (
          <QueueRow
            key={r.transactionId}
            row={r}
            last={i === rows.length - 1}
            showBook={showBook}
            open={openId === r.transactionId}
            onToggle={() =>
              setOpenId((current) =>
                current === r.transactionId ? null : r.transactionId,
              )
            }
            runAction={runAction}
          />
        ))}
      </Table>
    </View>
  );
}
