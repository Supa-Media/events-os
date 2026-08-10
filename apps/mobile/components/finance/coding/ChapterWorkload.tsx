/**
 * The by-chapter roll-up on the Coding tab — how much coding work is open in
 * each book, for the two seats that can act on all of them (ED, FM).
 *
 * WORKLOAD, NOT A SCOREBOARD. The owner's framing, and it decides the design:
 * this is here so a Financial Manager can find the book that needs help
 * without visiting five of them, not so anyone can be ranked. So the rows sit
 * in a stable order (central, then chapters as the server returns them) rather
 * than sorted worst-first, there is no target, no trend arrow and no colour
 * scale, and the header says what the numbers are for. A chapter with the
 * biggest number is the one with the most work, which is a fact about a
 * calendar, not about a person.
 *
 * Tapping a row filters the queue below to that book — the same drill-down
 * `CentralView`'s `ReviewSplitTile` does, and the same one Reconcile's
 * `?chapterId=` pill does.
 */
import { Pressable, Text, View } from "react-native";
import { Cell, HeaderCell, Row, Table, TableHeader } from "../../ui";

export interface WorkloadRow {
  id: string;
  name: string;
  toCode: number;
  awaitingReview: number;
}

export function ChapterWorkload({
  rows,
  selectedBookId,
  onSelectBook,
}: {
  rows: WorkloadRow[];
  /** The book the queue is currently filtered to, or null for "all books". */
  selectedBookId: string | null;
  onSelectBook: (bookId: string | null) => void;
}) {
  if (rows.length === 0) return null;
  const totalToCode = rows.reduce((n, r) => n + r.toCode, 0);
  const totalAwaiting = rows.reduce((n, r) => n + r.awaitingReview, 0);

  return (
    <View className="mb-5">
      <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
        Where the coding work is
      </Text>
      <Text className="mb-2 text-xs text-muted">
        Open work per book, so you can see which one could use a hand. Tap a
        book to work only its queue.
      </Text>
      <Table>
        <TableHeader>
          <HeaderCell flex={2}>Book</HeaderCell>
          <HeaderCell width={120} align="right">
            To code
          </HeaderCell>
          <HeaderCell width={150} align="right">
            Awaiting review
          </HeaderCell>
        </TableHeader>
        {rows.map((r, i) => {
          const selected = selectedBookId === r.id;
          return (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              accessibilityLabel={`${r.name}: ${r.toCode} to code, ${r.awaitingReview} awaiting review`}
              accessibilityState={{ selected }}
              onPress={() => onSelectBook(selected ? null : r.id)}
              className={selected ? "bg-sunken" : "active:opacity-70"}
            >
              <Row last={i === rows.length - 1}>
                <Cell flex={2}>
                  <Text
                    className={`text-sm ${selected ? "font-semibold text-ink" : "text-ink"}`}
                  >
                    {r.name}
                  </Text>
                </Cell>
                <Cell width={120} align="right">
                  <Text
                    className={`text-sm ${r.toCode > 0 ? "text-ink" : "text-muted"}`}
                  >
                    {r.toCode}
                  </Text>
                </Cell>
                <Cell width={150} align="right">
                  <Text
                    className={`text-sm ${r.awaitingReview > 0 ? "text-ink" : "text-muted"}`}
                  >
                    {r.awaitingReview}
                  </Text>
                </Cell>
              </Row>
            </Pressable>
          );
        })}
      </Table>
      <Text className="mt-1.5 text-2xs text-muted">
        {totalToCode} charge{totalToCode === 1 ? "" : "s"} still with their
        cardholders · {totalAwaiting} coding
        {totalAwaiting === 1 ? "" : "s"} waiting on a reviewer, org-wide.
      </Text>
    </View>
  );
}
