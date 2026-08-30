/**
 * FINANCES · LEDGER — the org's money, read-only, for everyone on the team.
 *
 * Founder, 2026-08-30 (verbatim): "they can see the ledger too. They can see
 * the full thing because ... it's publicly set anyways, um, but they just
 * can't edit."
 *
 * ── WHY THIS SCREEN EXISTS RATHER THAN OPENING "BOOK" ───────────────────────
 * The Book (`reconcile.tsx`) is where the ledger is WORKED: bulk categorize,
 * mark refund/transfer/payout, chase receipts, nudge holders, open the publish
 * console. Handing a member a read-only copy of it would mean auditing ~2,600
 * lines of edit affordances for the ones that must disappear, and re-auditing
 * every time that screen grows a control. This screen instead has no write
 * path to hide: it renders `publicLedger.teamStatement`, which is the same
 * snapshot the PUBLIC page is built from, and there is nothing on it to press.
 *
 * That reuse is also the privacy guarantee. Attendee names, contractor payees
 * and donor identities are redacted by the snapshot builder for the public
 * page; because this reads the same builder, they are redacted here for free
 * and cannot drift apart later. What a member sees is exactly what the world
 * will see when the month is published — just earlier, and including months
 * still open.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * Not the dashboard (that stays the seat holder's working summary, with its
 * drill-downs and chase queues) and not a substitute for `/code`, where a
 * member codes their OWN charges. This answers "where is the organization's
 * money going", for anybody who is trusted with a card.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import {
  Card,
  EmptyState,
  FilterSelect,
  Narrow,
  PageHeader,
  Screen,
  SectionHeader,
} from "../../ui";

type Statement = FunctionReturnType<typeof api.publicLedger.teamStatement>;
type Entry = Statement["entries"][number];

/** Which book is on screen. A member reads their own chapter and central — the
 *  two scopes their own spending can land in (a central-account card charge
 *  belongs to the chapter person who swiped it). Another chapter's book isn't
 *  offered, and the query refuses it regardless of what the client asks for. */
type Book = "mine" | "central";

/** Money in is green, money out is plain ink, and an internal transfer is
 *  muted — it publishes as a line but counts in no total (the builder's
 *  `countsInTotals: false`), so colouring it like real spend would make the
 *  page argue with its own arithmetic. */
function amountClass(direction: Entry["direction"]): string {
  if (direction === "in") return "text-success";
  if (direction === "internal") return "text-faint";
  return "text-ink";
}

function EntryRow({ entry, first }: { entry: Entry; first: boolean }) {
  const meta = [
    entry.categoryLabel,
    entry.budgetLabel,
    entry.eventLabel ?? entry.projectLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const sign =
    entry.direction === "in" ? "+" : entry.direction === "out" ? "−" : "";
  return (
    <View
      className={`flex-row items-start gap-3 px-4 py-3 ${first ? "" : "border-t border-border"}`}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-ink">{entry.counterparty ?? "—"}</Text>
        {entry.purpose ? (
          <Text className="text-xs text-muted">{entry.purpose}</Text>
        ) : null}
        {meta ? <Text className="text-xs text-faint">{meta}</Text> : null}
      </View>
      <View className="items-end">
        <Text className={`text-sm font-semibold ${amountClass(entry.direction)}`}>
          {sign}
          {formatCents(entry.amountCents)}
        </Text>
        <Text className="text-xs text-muted">
          {new Date(entry.occurredAt).toLocaleDateString()}
        </Text>
      </View>
    </View>
  );
}

/** The three figures the month comes down to. `netCents` is income minus
 *  expense over the entries that COUNT — money moving between our own books is
 *  excluded by the builder, so this can't double-count a transfer. */
function Totals({ statement }: { statement: Statement }) {
  const cells = [
    { label: "Money in", value: statement.incomeCents, tone: "text-success" },
    { label: "Money out", value: statement.expenseCents, tone: "text-ink" },
    {
      label: "Net",
      value: statement.netCents,
      tone: statement.netCents < 0 ? "text-danger" : "text-success",
    },
  ];
  return (
    <View className="mb-4 flex-row gap-3">
      {cells.map((c) => (
        <Card key={c.label} className="flex-1" padding="md">
          <Text className="text-xs text-muted">{c.label}</Text>
          <Text className={`font-display text-xl ${c.tone}`}>
            {formatCents(c.value)}
          </Text>
        </Card>
      ))}
    </View>
  );
}

export function LedgerScreen() {
  const [book, setBook] = useState<Book>("mine");
  const months = useQuery(api.publicLedger.teamLedgerMonths, { book });
  const [periodKey, setPeriodKey] = useState<string | null>(null);
  // Default to the newest month the PICKER offers rather than to a month
  // computed here: the server's calendar is Eastern, and a client an hour the
  // other side of midnight would otherwise ask for a month it doesn't list.
  const period = periodKey ?? months?.[0]?.periodKey ?? null;
  const statement = useQuery(
    api.publicLedger.teamStatement,
    period ? { periodKey: period, book } : "skip",
  );

  if (months === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow>
        <PageHeader
          title="Ledger"
          subtitle="Every dollar this organization moved. Read-only — the same lines the public finances page publishes."
        />

        <View className="mb-4 flex-row flex-wrap gap-2">
          <FilterSelect
            label="Month"
            value={period ?? ""}
            options={(months ?? []).map((m) => ({
              value: m.periodKey,
              label: m.label,
            }))}
            onChange={(v) => setPeriodKey(v)}
          />
          <FilterSelect
            label="Book"
            value={book}
            options={[
              { value: "mine", label: "My chapter" },
              { value: "central", label: "Central" },
            ]}
            onChange={(v) => {
              setBook(v as Book);
              // The two books don't share a calendar (one may reach further
              // back than the other), so drop the pinned month rather than
              // carry a key the new book's picker might not list.
              setPeriodKey(null);
            }}
          />
        </View>

        {statement === undefined ? (
          <Text className="text-sm text-muted">Loading the month…</Text>
        ) : statement.entryCount === 0 && statement.giftCount === 0 ? (
          <EmptyState
            icon="book"
            title="Nothing on the books yet"
            message={`No money moved in ${statement.bookLabel} during ${statement.label}.`}
          />
        ) : (
          <>
            <Totals statement={statement} />

            <Text className="mb-4 text-xs text-muted">
              {statement.books.length > 0
                ? `Published to the public finances page (revision ${statement.books[0].revision}).`
                : "Not published yet — these lines are still being coded and reconciled, so they can still change."}
            </Text>

            <SectionHeader
              title={`${statement.bookLabel} · ${statement.label}`}
              count={statement.entryCount}
            />
            <Card padding="none">
              {statement.entries.map((e, i) => (
                <EntryRow key={`${e.occurredAt}-${i}`} entry={e} first={i === 0} />
              ))}
            </Card>

            {statement.entriesTruncated ? (
              <Text className="mt-3 text-xs text-muted">
                Showing the first lines of a long month. The published month and
                its CSV on the public finances page are never truncated.
              </Text>
            ) : null}

            {statement.giftCount > 0 ? (
              <Text className="mt-3 text-xs text-muted">
                {statement.giftCount}{" "}
                {statement.giftCount === 1 ? "gift" : "gifts"} came in this month.
                Donors are never named — here or publicly.
              </Text>
            ) : null}
          </>
        )}
      </Narrow>
    </Screen>
  );
}
