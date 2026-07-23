/**
 * FINANCES · MY TRANSACTIONS — the member/cardholder's mini-reconcile (D3).
 *
 * A no-finance-seat caller's own transactions (`api.finances.personTransactions`
 * — caller-scoped: it returns the CALLER's own rows without needing a finance
 * grant). On their OWN card charge a cardholder can now PRE-FILL the
 * bookkeeper's Reconcile review "Concur-style": pick a spend category, write an
 * explanatory note (the who/why), upload a receipt, and mark it personal — all
 * through `api.finances.submitOwnCharge` (category + note + optional personal
 * flag) and `api.finances.attachReceipt` (receipt). This deliberately does NOT
 * expose fund/team/budget reattribution — that stays the bookkeeper's Reconcile
 * grid.
 *
 * Category options come from `api.finances.myChargeCategories`, a member-safe
 * read (no finance-role gate — membership is the gate, like `budgetsGlance`),
 * so a plain cardholder can pick a category without a finance grant.
 *
 * Owner decision: a member sees the bookkeeper's freeform `note` on their OWN
 * transactions; `personTransactions` enforces this server-side (nulls `note` on
 * any row that isn't the caller's own). The receipt-upload affordance is the
 * exact same `ReceiptCell` the Reconcile grid uses (exported from
 * `ReconcileList.tsx`) so uploading looks and behaves identically everywhere.
 */
import { Fragment, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  Field,
  HeaderCell,
  Icon,
  Narrow,
  Row,
  Screen,
  Select,
  Table,
  TableHeader,
  TextField,
  ToastView,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { SignedMoney, txnStatusTone } from "../../../components/finance/dashboard/parts";
import { ReceiptCell } from "../../../components/finance/reconcile/ReconcileList";

/** `YYYY-MM-DD` in the finance timezone for display (mirrors MemberView). */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

type Txn = {
  id: string;
  categoryId: string | null;
  note: string | null;
  isPersonal: boolean;
  cardLast4: string | null;
  status: string;
};

export default function MyTransactionsScreen() {
  const transactions = useQuery(api.finances.personTransactions, {});
  const categories = useQuery(api.finances.myChargeCategories, {});
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const flagPersonalCharge = useMutation(api.cards.flagPersonalCharge);
  const submitOwnCharge = useMutation(api.finances.submitOwnCharge);
  const { run, toast, dismiss } = useActionRunner();

  // Which row's inline "details" editor is open, plus its draft state (only one
  // is ever open at a time, so a single draft suffices). Drafts seed from the
  // live row when the editor opens.
  const [openId, setOpenId] = useState<string | null>(null);
  const [catDraft, setCatDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [personalDraft, setPersonalDraft] = useState(false);
  const [saving, setSaving] = useState(false);

  function openEditor(t: Txn) {
    setOpenId(t.id);
    setCatDraft(t.categoryId);
    setNoteDraft(t.note ?? "");
    setPersonalDraft(t.isPersonal);
  }

  async function handleFlag(id: string) {
    // No local flagged state needed (R1b follow-up): `personTransactions` rows
    // carry `isPersonal`, and the live subscription re-renders the row the
    // moment the flag commits — including a flag a manager made from Reconcile.
    await run(
      () => flagPersonalCharge({ transactionId: id as Id<"transactions"> }),
      { errorTitle: "Couldn't flag this charge" },
    );
  }

  async function handleSave(t: Txn) {
    setSaving(true);
    const res = await run(
      () =>
        submitOwnCharge({
          transactionId: t.id as Id<"transactions">,
          // Send the current draft (idempotent when unchanged); "" clears it.
          categoryId: (catDraft
            ? catDraft
            : null) as Id<"budgetCategories"> | null,
          note: noteDraft.trim() ? noteDraft.trim() : null,
          // Only ever flag ON (the flag is one-way, like `flagPersonalCharge`) —
          // omit when it was already personal or the member didn't toggle it.
          flagPersonal: personalDraft && !t.isPersonal ? true : undefined,
        }),
      { errorTitle: "Couldn't save charge details" },
    );
    setSaving(false);
    if (res !== undefined) setOpenId(null);
  }

  const categoryOptions = [
    { value: "", label: "No category" },
    ...(categories ?? []).map((c) => ({ value: c.id, label: c.name })),
  ];

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
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">My transactions</Text>
        </View>
        <Text className="mb-4 text-sm text-muted">
          Charges and entries attributed to you. On your own card charges, add a
          category and a note so the finance team knows who and why — attach a
          receipt, or flag a charge as personal.
        </Text>

        {transactions.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            message="Charges and entries attributed to you show up here."
          />
        ) : (
          <Table>
            <TableHeader>
              <HeaderCell flex={2}>Transaction</HeaderCell>
              <HeaderCell width={110} align="right">
                Amount
              </HeaderCell>
              <HeaderCell width={120} align="right">
                Status
              </HeaderCell>
              <HeaderCell width={130}>Receipt</HeaderCell>
              <HeaderCell width={150} align="right">
                Personal charge
              </HeaderCell>
            </TableHeader>
            {transactions.map((t, i) => {
              const status = txnStatusTone(t.status);
              // A person-attributed txn only ever gets `cardId` + `cardLast4`
              // set together, so `cardLast4` is the reliable "this is a card
              // charge the cardholder can self-service" signal (`submitOwnCharge`
              // and `flagPersonalCharge` both reject a non-card txn server-side).
              const isCardCharge = t.cardLast4 != null;
              const open = openId === t.id;
              return (
                <Fragment key={t.id}>
                  <Row last={i === transactions.length - 1 && !open}>
                    <Cell flex={2}>
                      <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                        {t.merchantName ?? t.description ?? "—"}
                      </Text>
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        {[dateStr(t.postedAt), t.merchantName ? t.description : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                      {t.note ? (
                        <Text className="mt-0.5 text-xs italic text-muted" numberOfLines={2}>
                          {t.note}
                        </Text>
                      ) : null}
                      {isCardCharge ? (
                        <Pressable
                          onPress={() => (open ? setOpenId(null) : openEditor(t))}
                          hitSlop={6}
                          className="mt-1 flex-row items-center gap-1 active:opacity-70"
                        >
                          <Icon
                            name={open ? "chevron-up" : "edit-2"}
                            size={12}
                            color={colors.accent}
                          />
                          <Text className="text-xs font-semibold text-accent">
                            {open ? "Close" : "Add category & note"}
                          </Text>
                        </Pressable>
                      ) : null}
                    </Cell>
                    <Cell width={110} align="right">
                      <SignedMoney
                        cents={t.amountCents}
                        flow={t.flow}
                        className="text-sm font-semibold"
                      />
                    </Cell>
                    <Cell width={120} align="right">
                      <Badge label={status.label} tone={status.tone} />
                    </Cell>
                    <Cell width={130}>
                      <ReceiptCell
                        hasReceipt={t.hasReceipt}
                        reminderStage={t.reminderStage}
                        transactionId={t.id as Id<"transactions">}
                        onUpload={async (storageId) => {
                          await run(
                            () =>
                              attachReceipt({
                                transactionId: t.id as Id<"transactions">,
                                storageId,
                              }),
                            { errorTitle: "Couldn't attach receipt" },
                          );
                        }}
                        generateUploadUrl={generateUploadUrl}
                      />
                    </Cell>
                    <Cell width={150} align="right">
                      {t.isPersonal ? (
                        <Badge label="Personal" tone="accent" />
                      ) : isCardCharge ? (
                        <Button
                          title="Flag personal"
                          variant="ghost"
                          size="sm"
                          icon="flag"
                          onPress={() => handleFlag(t.id)}
                        />
                      ) : null}
                    </Cell>
                  </Row>

                  {open ? (
                    <View
                      className={`bg-sunken px-4 py-4 ${
                        i === transactions.length - 1 ? "" : "border-b border-border"
                      }`}
                    >
                      <View className="gap-3">
                        <Select
                          label="Category"
                          hint="What kind of spend was this? The finance team can change it later."
                          value={catDraft ?? ""}
                          options={categoryOptions}
                          onChange={(v) => setCatDraft(v || null)}
                          placeholder="No category"
                        />
                        <TextField
                          label="Note — who was this for and why?"
                          value={noteDraft}
                          onChangeText={setNoteDraft}
                          placeholder="A short explanation the finance team can review at a glance…"
                          multiline
                          numberOfLines={3}
                        />
                        {t.isPersonal ? (
                          <View className="flex-row items-center gap-2">
                            <Icon name="check-circle" size={14} color={colors.accent} />
                            <Text className="text-xs text-muted">
                              Already flagged as a personal charge — pay it back
                              from the Cards tab.
                            </Text>
                          </View>
                        ) : (
                          <Pressable
                            onPress={() => setPersonalDraft((p) => !p)}
                            className="flex-row items-center gap-2 active:opacity-70"
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: personalDraft }}
                          >
                            <View
                              className={`h-5 w-5 items-center justify-center rounded border ${
                                personalDraft
                                  ? "border-accent bg-accent"
                                  : "border-border-strong bg-raised"
                              }`}
                            >
                              {personalDraft ? (
                                <Icon name="check" size={13} color={colors.accentText} />
                              ) : null}
                            </View>
                            <Text className="text-sm text-ink">
                              This was a personal charge — I&apos;ll pay it back
                            </Text>
                          </Pressable>
                        )}
                        <View className="flex-row justify-end gap-2">
                          <Button
                            title="Cancel"
                            variant="secondary"
                            size="sm"
                            disabled={saving}
                            onPress={() => setOpenId(null)}
                          />
                          <Button
                            title="Save"
                            size="sm"
                            icon="check"
                            loading={saving}
                            onPress={() => void handleSave(t)}
                          />
                        </View>
                      </View>
                    </View>
                  ) : null}
                </Fragment>
              );
            })}
          </Table>
        )}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
