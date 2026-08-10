/**
 * The reviewer's half of the Coding tab: every submitted coding they may
 * decide, with enough of the record on the row to decide WITHOUT opening it.
 *
 * That last part is the whole design brief. A reviewer's real question is
 * "does this purpose, against this document, hold up to a stranger reading the
 * public ledger?" — and answering it used to mean opening each charge's detail
 * view one at a time. So each row carries the substantiation itself: the
 * purpose in full, the route on travel, the headcount or attendee breakdown on
 * meals, and what the charge is proved by. Approve and Send back sit on the
 * row.
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

export interface ReviewQueueRow {
  transactionId: string;
  book: { id: string; name: string };
  merchantName: string | null;
  amountCents: number;
  postedAt: number;
  documentation: "receipt" | "exception_approved" | "exception_pending" | "none";
  canReview: boolean;
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
  runAction,
}: {
  row: ReviewQueueRow;
  last: boolean;
  showBook: boolean;
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
        <Cell width={200} align="right">
          {row.canReview ? (
            <View className="flex-row flex-wrap justify-end gap-1.5">
              <Button
                title="Approve"
                size="sm"
                loading={busy}
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
            <Text className="text-2xs italic text-muted">
              Yours — another reviewer decides it
            </Text>
          )}
        </Cell>
      </Row>

      {/* The purpose is the substance of the review, so it gets its own line
          at full width rather than a truncated column. */}
      <View className="px-4 pb-3">
        <Text className="text-xs text-ink">{row.coding.businessPurpose}</Text>
        {substantiation ? (
          <Text className="mt-0.5 text-2xs text-muted">{substantiation}</Text>
        ) : null}
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
    <Table>
      <TableHeader>
        {showBook ? <HeaderCell width={110}>Book</HeaderCell> : null}
        <HeaderCell flex={3}>Charge</HeaderCell>
        <HeaderCell width={100} align="right">
          Amount
        </HeaderCell>
        <HeaderCell width={150}>Proved by</HeaderCell>
        <HeaderCell width={200} align="right">
          {" "}
        </HeaderCell>
      </TableHeader>
      {rows.map((r, i) => (
        <QueueRow
          key={r.transactionId}
          row={r}
          last={i === rows.length - 1}
          showBook={showBook}
          runAction={runAction}
        />
      ))}
    </Table>
  );
}
