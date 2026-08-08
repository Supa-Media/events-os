/**
 * FINANCES · MY TRANSACTIONS — the cardholder's own desk.
 *
 * Phase 2 of `docs/plans/transaction-coding.md`. This screen used to be a
 * read-mostly list with a small "add a category and a note" editor. It is now
 * the place a cardholder FINISHES a charge: the reminder digest ("you have 3
 * charges to code") deep-links straight here with `?filter=uncoded`, and
 * everything that link promises — the substantiation record, the receipt, and
 * the no-receipt exception when one never existed — happens in
 * `FinishChargeSheet` without leaving the row and without a finance role.
 *
 * Three things this screen owes the person reading it, in order:
 *  1. WHAT STILL OWES SOMETHING, first. `chargeTodo` ranks every row and the
 *     actionable ones sort to the top, in the digest's own words, so the
 *     screen and the email can't disagree about what's outstanding.
 *  2. THE REVIEWER'S NOTE, loudly. A charge a reviewer sent back gets the note
 *     rendered under its row, quoted — for the person who has to act on it
 *     that sentence is the most useful string on the page, and it is worth
 *     more room than any badge.
 *  3. The old affordances, unbroken: `personTransactions` is caller-scoped
 *     (it returns the CALLER's own rows with no finance grant), the
 *     bookkeeper's `note` is still visible on the member's OWN rows, the
 *     category/personal-flag editor still exists (inside the sheet now), and
 *     receipt upload is still the exact same `ReceiptCell` the Reconcile grid
 *     uses, so uploading looks identical everywhere.
 *
 * DATA NOTE — why `ChargeStateProbe` exists: `personTransactions` projects
 * `txnSummary`, which carries neither `codingState` nor documentation state,
 * and this screen has to sort and filter on both. See that component's doc
 * comment for the backend change that would delete it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { DEFAULT_CODING_REQUIRED_SINCE_MS } from "@events-os/shared";
import {
  Button,
  EmptyState,
  HeaderCell,
  Icon,
  Narrow,
  Screen,
  Table,
  TableHeader,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { ChargeStateProbe } from "../../../components/finance/myTransactions/ChargeStateProbe";
import {
  ChargeRow,
  FilterChip,
} from "../../../components/finance/myTransactions/ChargeRow";
import { FinishChargeSheet } from "../../../components/finance/myTransactions/FinishChargeSheet";
import {
  chargeTodo,
  isSpendCharge,
  parseChargeFilter,
  sortByTodo,
  type ChargeCodingState,
  type ChargeFilter,
  type MyTxnRow,
} from "../../../components/finance/myTransactions/chargeTodo";

export default function MyTransactionsScreen() {
  // The reminder email's deep link (`/finances/my-transactions?filter=uncoded`).
  const params = useLocalSearchParams<{ filter?: string }>();
  const transactions = useQuery(api.finances.personTransactions, {});
  const categories = useQuery(api.finances.myChargeCategories, {});
  const policy = useQuery(api.transactionCodings.policy, {});
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();

  const [filter, setFilter] = useState<ChargeFilter>(() =>
    parseChargeFilter(params.filter),
  );
  // The param can arrive after the first render (deep link → auth → screen),
  // so follow it rather than only seeding from it.
  useEffect(() => {
    setFilter(parseChargeFilter(params.filter));
  }, [params.filter]);

  const [openId, setOpenId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ChargeCodingState>>({});
  const onResolved = useCallback(
    (transactionId: string, state: ChargeCodingState) => {
      setStates((prev) => {
        const current = prev[transactionId];
        // Bail on an unchanged report: every probe re-reports whenever its
        // query pushes, and re-sorting the list underneath somebody's cursor
        // for no reason is its own kind of bug.
        if (
          current &&
          current.codingStatus === state.codingStatus &&
          current.reviewNote === state.reviewNote &&
          current.hasApprovedException === state.hasApprovedException &&
          current.hasPendingException === state.hasPendingException
        ) {
          return prev;
        }
        return { ...prev, [transactionId]: state };
      });
    },
    [],
  );

  // The policy date decides which rows are CHASED for a coding at all
  // (pre-2026-09-01 spend is the voluntary on-ramp). Falling back to the
  // shared default keeps the first paint honest instead of briefly claiming
  // every old charge needs coding.
  const sinceMs = policy?.sinceMs ?? DEFAULT_CODING_REQUIRED_SINCE_MS;

  const rows = useMemo(() => {
    return (transactions ?? []).map((t: MyTxnRow) => {
      const state = states[t.id];
      const facts = {
        postedAt: t.postedAt,
        flow: t.flow,
        status: t.status,
        isPersonal: t.isPersonal,
        hasReceipt: t.hasReceipt,
        ...(state
          ? {
              hasApprovedException: state.hasApprovedException,
              codingStatus: state.codingStatus,
            }
          : {}),
      };
      return {
        txn: t,
        todo: chargeTodo(facts, sinceMs),
        reviewNote: state?.reviewNote ?? null,
        /** Only rows that could owe something get a live probe — see the
         *  component's doc comment on why the count matters. */
        probe: isSpendCharge(facts),
      };
    });
  }, [transactions, states, sinceMs]);

  const actionableCount = rows.filter((r) => r.todo.actionable).length;
  const visible = useMemo(() => {
    const subset =
      filter === "uncoded" ? rows.filter((r) => r.todo.actionable) : rows;
    return sortByTodo(subset, (r) => ({
      rank: r.todo.rank,
      postedAt: r.txn.postedAt,
    }));
  }, [rows, filter]);

  const categoryOptions = [
    { value: "", label: "No category" },
    ...(categories ?? []).map((c) => ({ value: c.id, label: c.name })),
  ];
  const openRow = rows.find((r) => r.txn.id === openId) ?? null;

  if (transactions === undefined) {
    return (
      <Screen>
        <Narrow>
          <EmptyState title="Loading your transactions…" />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen maxWidth={1080}>
      <Narrow>
        {/* The probes are mounted OUTSIDE the filtered list on purpose: a row
            hidden by the "Needs you" filter must keep its subscription, or a
            charge a reviewer sends back while this screen is open would never
            reappear. They render nothing. */}
        {rows.map((r) =>
          r.probe ? (
            <ChargeStateProbe
              key={`probe-${r.txn.id}`}
              transactionId={r.txn.id as Id<"transactions">}
              hasReceipt={r.txn.hasReceipt}
              onResolved={onResolved}
            />
          ) : null,
        )}

        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">My transactions</Text>
        </View>
        <Text className="mb-3 text-sm text-muted">
          Every charge attributed to you, and what each one still needs. Coding
          a charge means saying — in your own words — what it bought, which org
          work it served, and who was there; that answer is yours to write, and
          it&apos;s what keeps the money you spent from becoming taxable income
          to you.
        </Text>

        {transactions.length > 0 ? (
          <View className="mb-4 flex-row items-center gap-2">
            <FilterChip
              label={`Needs you${actionableCount > 0 ? ` (${actionableCount})` : ""}`}
              active={filter === "uncoded"}
              onPress={() => setFilter("uncoded")}
            />
            <FilterChip
              label={`All (${rows.length})`}
              active={filter === "all"}
              onPress={() => setFilter("all")}
            />
            {actionableCount === 0 ? (
              <View className="flex-row items-center gap-1.5">
                <Icon name="check-circle" size={13} color={colors.success} />
                <Text className="text-xs text-muted">
                  Nothing outstanding — you&apos;re square.
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {transactions.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            message="Charges and entries attributed to you show up here."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="Nothing needs you right now"
            message="Every charge of yours is coded, documented, or with a reviewer."
            action={
              <Button
                title="Show all"
                variant="secondary"
                size="sm"
                onPress={() => setFilter("all")}
              />
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <HeaderCell flex={2}>Transaction</HeaderCell>
              <HeaderCell width={110} align="right">
                Amount
              </HeaderCell>
              <HeaderCell width={185}>Still needs</HeaderCell>
              <HeaderCell width={130}>Receipt</HeaderCell>
              <HeaderCell width={110} align="right">
                {" "}
              </HeaderCell>
            </TableHeader>
            {visible.map((r, i) => (
              <ChargeRow
                key={r.txn.id}
                txn={r.txn}
                todo={r.todo}
                reviewNote={r.reviewNote}
                last={i === visible.length - 1}
                onOpen={() => setOpenId(r.txn.id)}
                onUpload={async (storageId) => {
                  await run(
                    () =>
                      attachReceipt({
                        transactionId: r.txn.id as Id<"transactions">,
                        storageId,
                      }),
                    { errorTitle: "Couldn't attach receipt" },
                  );
                }}
                generateUploadUrl={generateUploadUrl}
              />
            ))}
          </Table>
        )}
      </Narrow>

      {openRow ? (
        <FinishChargeSheet
          txn={openRow.txn}
          categoryOptions={categoryOptions}
          onClose={() => setOpenId(null)}
        />
      ) : null}
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
