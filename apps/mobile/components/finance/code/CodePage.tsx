/**
 * `/code` — THE PAGE YOU SEND PEOPLE.
 *
 * Founder ask: "we also just need a page that I can send people to, like
 * /code, where people can see their own transactions and go in and code it
 * pretty easily — upload receipts, state the reasons why."
 *
 * The content already existed; only its address was wrong. It was the top
 * half of `/finances/coding`, which for a seat holder sits two clicks down
 * inside a tab group and ABOVE a reviewer queue they didn't come for, and
 * which for a no-seat member disappears from the tab bar entirely once they
 * have nothing outstanding — so the link you'd send was dead for exactly the
 * people who were up to date.
 *
 * WHY IT LIVES OUTSIDE `(app)`. Same placement and the same reasoning as
 * `reimburse-request.tsx`: a share link wants no sidebar, no bottom nav, no
 * finance sub-tabs and no scope badge — just your charges and the sheet that
 * finishes one. `(app)`'s layout wraps everything it holds in `AppShell`, so
 * a route inside it cannot be chrome-free. Signed-in is still required (these
 * are YOUR charges), which this page enforces itself exactly the way
 * `reimburse-request` does, rather than by borrowing the group's gate.
 *
 * NO FINANCE SEAT IS NEEDED, and that is the whole point of the page existing
 * separately at all. `finances.personTransactions` is caller-scoped and asks
 * for no finance grant; so are `myChargeCategories` and
 * `transactionCodings.policy`. Every OTHER query in the finance area throws
 * for this audience. That permission boundary — not a difference in workflow
 * — is why the spender's surface is its own page instead of one more view of
 * the book.
 *
 * ONE FORM, MANY FRAMES. `ChargeRow` and `FinishChargeSheet` are the same
 * components `/finances/coding` mounts, imported as-is. A second, "simpler"
 * coding form written for this page would be the §274(d) substantiation
 * surface forked in two, which is the one place in this app that must never
 * have two implementations drifting apart.
 */
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { DEFAULT_CODING_REQUIRED_SINCE_MS } from "@events-os/shared";
import {
  EmptyState,
  HeaderCell,
  Icon,
  Narrow,
  RadioGroup,
  Screen,
  Table,
  TableHeader,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  ChargeRow,
  FilterChip,
} from "../myTransactions/ChargeRow";
import { FinishChargeSheet } from "../myTransactions/FinishChargeSheet";
import {
  chargeTodo,
  parseChargeFilter,
  sortByTodo,
  type ChargeFilter,
  type MyTxnRow,
} from "../myTransactions/chargeTodo";

function BrandMark() {
  return (
    <View className="mb-6 flex-row items-center gap-2.5">
      <View className="h-9 w-9 items-center justify-center rounded-md bg-accent">
        <Icon name="calendar" size={18} color="#FFFFFF" />
      </View>
      <View className="flex-row items-baseline gap-1">
        <Text className="font-display text-xl text-ink">Chapter</Text>
        <Text className="font-display text-xl text-accent">OS</Text>
      </View>
    </View>
  );
}

function CenteredMessage({
  icon,
  title,
  message,
}: {
  icon: string;
  title: string;
  message: string;
}) {
  return (
    <Screen>
      <Narrow width={520}>
        <BrandMark />
        <View className="items-center gap-3 rounded-lg border border-border bg-raised p-8">
          <Icon name={icon as never} size={28} color={colors.muted} />
          <Text className="text-center font-display text-xl text-ink">{title}</Text>
          <Text className="text-center text-sm text-muted">{message}</Text>
        </View>
      </Narrow>
    </Screen>
  );
}

export function CodePage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const me = useQuery(api.profiles.me, isAuthenticated ? {} : "skip");
  const reconcileMyPerson = useMutation(api.profiles.reconcileMyPerson);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/(auth)/login?redirect=/code");
    }
  }, [isLoading, isAuthenticated, router]);

  // A member who has never opened the main app still needs a People row
  // before `personTransactions` can attribute anything to them — the same
  // best-effort call `(app)/_layout.tsx` and `reimburse-request.tsx` both
  // make, and for the same reason: this page is somebody's FIRST screen.
  useEffect(() => {
    if (me && me.allowed !== false && me.hasChapter) {
      reconcileMyPerson().catch(() => {});
    }
  }, [me, reconcileMyPerson]);

  if (isLoading || !isAuthenticated || me === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 items-center justify-center bg-surface">
          <ActivityIndicator color={colors.accent} />
        </View>
      </>
    );
  }

  if (me === null || me.allowed === false) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <CenteredMessage
          icon="lock"
          title="No access"
          message="This account doesn't have access to Chapter OS. Ask an admin to add you."
        />
      </>
    );
  }

  if (!me.hasChapter) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <CenteredMessage
          icon="users"
          title="Ask your chapter director to add you"
          message="You're signed in, but you're not on a chapter roster yet, so there are no charges to show. Ask your director to add you, then open this link again."
        />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <MyCharges />
    </>
  );
}

function MyCharges() {
  // `?filter=uncoded` is what every coding reminder and send-back email
  // already carries. Those inboxes don't get rewritten, so the param keeps
  // meaning what it always meant.
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
  useEffect(() => {
    setFilter(parseChargeFilter(params.filter));
  }, [params.filter]);

  const [openId, setOpenId] = useState<string | null>(null);

  const sinceMs = policy?.sinceMs ?? DEFAULT_CODING_REQUIRED_SINCE_MS;

  const rows = useMemo(
    () =>
      (transactions ?? []).map((t: MyTxnRow) => ({
        txn: t,
        todo: chargeTodo(
          {
            postedAt: t.postedAt,
            flow: t.flow,
            status: t.status,
            isPersonal: t.isPersonal,
            hasReceipt: t.hasReceipt,
            hasApprovedException: t.hasApprovedException,
            codingStatus: t.codingState,
          },
          sinceMs,
        ),
      })),
    [transactions, sinceMs],
  );

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
    ...(categories ?? []).map((c) => ({
      value: c.id,
      label: c.name,
      expenseTypeHint: c.expenseTypeHint,
    })),
  ];
  // Looked up in `rows` — the whole ledger — not `visible`, which the filter
  // can narrow at any moment. Submitting inside the sheet flips
  // `todo.actionable` to false, which would drop the row out from under the
  // sheet the instant somebody finished the one thing they opened it to do.
  const openRow = rows.find((r) => r.txn.id === openId) ?? null;

  if (transactions === undefined) return <Screen loading />;

  return (
    <Screen>
      <Narrow width={860}>
        <BrandMark />

        {/* THE HEADLINE IS THE STATE, not a fixed title. Someone opening a
            link they were sent should know in one glance whether this is a
            chore or a receipt — a page that always says "Your charges" makes
            them read the list to find out. */}
        <Text className="font-display text-2xl text-ink">
          {actionableCount === 0
            ? "You're all caught up"
            : `${actionableCount} charge${actionableCount === 1 ? "" : "s"} need${
                actionableCount === 1 ? "s" : ""
              } a word from you`}
        </Text>
        <Text className="mb-5 mt-2 text-sm text-muted">
          For each one: what it bought, which of our work it served, and{" "}
          <Text className="text-ink">the receipt that proves it</Text> — the
          words and the proof are one record. If there genuinely is no receipt,
          say so right here and that counts. It&apos;s what keeps money you
          spent from becoming taxable income to you.
        </Text>

        {rows.length > 0 ? (
          <View className="mb-4 flex-row items-center gap-2">
            <RadioGroup
              accessibilityLabel="Which of your charges to show"
              horizontal
              className="flex-row items-center gap-2"
            >
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
            </RadioGroup>
            {actionableCount === 0 ? (
              <View className="flex-row items-center gap-1.5">
                <Icon name="check-circle" size={13} color={colors.success} />
                <Text className="text-xs text-muted">
                  Everything below is done, or with a reviewer.
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* THE LINK HAS TO WORK FOR PEOPLE WHO ARE ALREADY DONE. A page sent
            to forty people is opened by the twelve with nothing outstanding,
            and 404-ing or bouncing them is how a link stops getting clicked. */}
        {rows.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="Nothing to code"
            message="No charges are attributed to you right now. If you spent something on a chapter card, it'll appear here once the bank posts it — usually a day or two."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="Nothing needs you right now"
            message="Every charge of yours is coded, documented, or with a reviewer."
            action={
              <FilterChip
                label={`Show all (${rows.length})`}
                active={false}
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
                last={i === visible.length - 1}
                onOpen={() => setOpenId(r.txn.id)}
                onUpload={async (storageId, filename) => {
                  await run(
                    () =>
                      attachReceipt({
                        transactionId: r.txn.id as Id<"transactions">,
                        storageId,
                        ...(filename ? { filename } : {}),
                      }),
                    { errorTitle: "Couldn't attach receipt" },
                  );
                }}
                generateUploadUrl={generateUploadUrl}
              />
            ))}
          </Table>
        )}

        {openRow ? (
          <FinishChargeSheet
            txn={openRow.txn}
            todo={openRow.todo}
            categoryOptions={categoryOptions}
            // `personTransactions` rows are the caller's own ledger, always.
            ownCharge
            onClose={() => setOpenId(null)}
          />
        ) : null}
        <ToastView toast={toast} onDismiss={dismiss} />
      </Narrow>
    </Screen>
  );
}
