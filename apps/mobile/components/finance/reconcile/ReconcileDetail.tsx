/**
 * The right pane of Reconcile — the sticky detail for the selected transaction:
 * merchant + amount, a meta line, the receipt-state box, the AI-coding banner
 * (with fund/category/event + rationale + Accept & reconcile), editable
 * Fund/project · Category · Link-to-event fields, and the receipt-reminder
 * timeline.
 *
 * Coding edits call `categorizeTransaction` (via `onSaveCoding`); the AI banner's
 * "Accept & reconcile" calls `acceptSuggestion` (via `onAccept`); "Suggest
 * coding" asks `suggestCoding` for a fresh proposal (via `onRequestSuggestion`).
 */
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { BUDGET_SCOPE_LABELS, type BudgetScope } from "@events-os/shared";
import { Button, Card, Field, Icon, Select, type IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import { ReceiptTimeline } from "./ReceiptTimeline";
import {
  RECEIPT_COPY,
  cleanRationale,
  longDate,
  receiptStateForStatus,
  signedMoney,
  type CodingSuggestion,
  type TxnRow,
} from "./helpers";

const NUM = { fontVariant: ["tabular-nums" as const] };

type FundOpt = { id: string; name: string };
type CatOpt = { id: string; name: string; fundId: string };
type BudgetOpt = {
  id: string;
  label: string | null;
  scope: BudgetScope;
  level: "chapter" | "central";
};

/** Human name for a budget in the picker (its label, else its scope word). */
function budgetName(b: BudgetOpt): string {
  return b.label?.trim() || BUDGET_SCOPE_LABELS[b.scope];
}

const RECEIPT_ICON: Record<string, IconName> = {
  none: "file-text",
  due: "file-text",
  ok: "check-circle",
};
const RECEIPT_TONE: Record<string, { text: string; color: string }> = {
  faint: { text: "text-faint", color: colors.faint },
  warn: { text: "text-warn", color: colors.warn },
  success: { text: "text-success", color: colors.success },
};

export function ReconcileDetail({
  row,
  funds,
  categories,
  budgets,
  onSaveCoding,
  onAccept,
  onRequestSuggestion,
  onUploadReceipt,
}: {
  row: TxnRow;
  funds: FundOpt[];
  categories: CatOpt[];
  budgets: BudgetOpt[];
  onSaveCoding: (
    fundId: string | null,
    categoryId: string | null,
    // undefined → leave the budget link untouched; null → clear it.
    budgetId?: string | null,
  ) => Promise<void>;
  onAccept: () => Promise<void>;
  onRequestSuggestion: () => Promise<CodingSuggestion | null>;
  onUploadReceipt: () => void;
}) {
  const [fundId, setFundId] = useState<string | null>(row.fundId ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(
    row.categoryId ?? null,
  );
  // `listTransactions` doesn't surface the txn's existing budgetId, so this
  // starts unselected ("None") and only sends a change when the user picks one.
  const [budgetId, setBudgetId] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<CodingSuggestion | null>(null);
  const [busy, setBusy] = useState<"accept" | "suggest" | null>(null);

  // Re-seed the editable fields (and clear any prior proposal) when the selected
  // transaction changes.
  useEffect(() => {
    setFundId(row.fundId ?? null);
    setCategoryId(row.categoryId ?? null);
    setBudgetId(null);
    setSuggestion(null);
    setBusy(null);
  }, [row.id, row.fundId, row.categoryId]);

  const fundOptions = funds.map((f) => ({ value: f.id, label: f.name }));
  const categoryOptions = categories
    .filter((c) => !fundId || c.fundId === fundId)
    .map((c) => ({ value: c.id, label: c.name }));

  // Budget picker: "None" (clears) + budgets grouped under Chapter / Central.
  const chapterBudgets = budgets.filter((b) => b.level === "chapter");
  const centralBudgets = budgets.filter((b) => b.level === "central");
  const budgetOptions = [
    { value: "", label: "None" },
    ...(chapterBudgets.length > 0
      ? [{ value: "__grp_chapter", label: "Chapter", header: true }]
      : []),
    ...chapterBudgets.map((b) => ({ value: b.id, label: budgetName(b) })),
    ...(centralBudgets.length > 0
      ? [{ value: "__grp_central", label: "Central", header: true }]
      : []),
    ...centralBudgets.map((b) => ({ value: b.id, label: budgetName(b) })),
  ];

  async function handleBudget(value: string) {
    const next = value === "" ? null : value;
    setBudgetId(next);
    await onSaveCoding(fundId, categoryId, next);
  }

  async function handleFund(value: string) {
    // Clear the category if it no longer belongs to the chosen fund.
    const cat = categories.find((c) => c.id === categoryId);
    const nextCat = cat && cat.fundId !== value ? null : categoryId;
    setFundId(value);
    setCategoryId(nextCat);
    await onSaveCoding(value, nextCat);
  }

  async function handleCategory(value: string) {
    setCategoryId(value);
    await onSaveCoding(fundId, value);
  }

  async function handleAccept() {
    setBusy("accept");
    await onAccept();
    setSuggestion(null);
    setBusy(null);
  }

  async function handleSuggest() {
    setBusy("suggest");
    const result = await onRequestSuggestion();
    if (result) setSuggestion(result);
    setBusy(null);
  }

  const receipt = receiptStateForStatus(row.status);
  const receiptCopy = RECEIPT_COPY[receipt];
  const receiptTone = RECEIPT_TONE[receiptCopy.tone];
  const meta = [longDate(row.postedAt), row.description]
    .filter(Boolean)
    .join(" · ");

  const sFundName = suggestion?.fundId
    ? funds.find((f) => f.id === suggestion.fundId)?.name
    : undefined;
  const sCatName = suggestion?.categoryId
    ? categories.find((c) => c.id === suggestion.categoryId)?.name
    : undefined;
  const sRationale = cleanRationale(suggestion?.rationale);

  return (
    <Card>
      {/* Merchant + amount. */}
      <View className="flex-row items-start justify-between gap-3">
        <Text className="flex-1 font-display text-lg text-ink">
          {row.merchantName ?? "Unlabeled charge"}
        </Text>
        <Text className="text-lg font-bold text-ink" style={NUM}>
          {signedMoney(row.amountCents, row.flow)}
        </Text>
      </View>
      {meta ? <Text className="mt-1 text-xs text-faint">{meta}</Text> : null}

      {/* Receipt state box. */}
      <View className="mt-3 items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-sunken px-4 py-6">
        <Icon name={RECEIPT_ICON[receipt]} size={20} color={receiptTone.color} />
        <Text className={`text-sm font-medium ${receiptTone.text}`}>
          {receiptCopy.text}
        </Text>
        {receiptCopy.canUpload ? (
          <Button
            title="Upload receipt"
            variant="secondary"
            size="sm"
            icon="upload"
            onPress={onUploadReceipt}
          />
        ) : null}
      </View>

      {/* AI coding banner (when a proposal is present). */}
      {suggestion ? (
        <View
          className="mt-3 flex-row gap-2 rounded-md border px-3 py-2.5"
          style={{
            backgroundColor: "rgba(201,168,224,0.14)",
            borderColor: "rgba(201,168,224,0.5)",
          }}
        >
          <Icon name="sparkles" size={15} color={colors.statPurple} />
          <View className="flex-1">
            <Text className="text-sm text-muted">
              <Text className="font-semibold text-stat-purple">
                AI coded this{" "}
              </Text>
              {sRationale ?? "Review the proposed coding and accept."}
            </Text>
            {sFundName || sCatName || suggestion.eventId ? (
              <Text className="mt-1 text-xs text-muted">
                {[
                  sFundName ? `Fund · ${sFundName}` : null,
                  sCatName ? `Category · ${sCatName}` : null,
                  suggestion.eventId ? "Event · linked" : null,
                ]
                  .filter(Boolean)
                  .join("   ")}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* Editable coding fields. */}
      <View className="mt-4 flex-row gap-3">
        <View className="flex-1">
          <Select
            label="Fund / project"
            value={fundId}
            options={fundOptions}
            onChange={handleFund}
            placeholder="Choose a fund"
          />
        </View>
        <View className="flex-1">
          <Select
            label="Category"
            value={categoryId}
            options={categoryOptions}
            onChange={handleCategory}
            placeholder="Choose a category"
          />
        </View>
      </View>
      <Select
        label="Budget"
        value={budgetId ?? ""}
        options={budgetOptions}
        onChange={handleBudget}
        placeholder="None"
      />
      <Field
        label="Link to event / instance"
        hint="Event linking arrives with calendar sync."
      >
        <View className="flex-row items-center justify-between rounded-md border border-border-strong bg-sunken px-3 py-2.5">
          <Text className="text-base text-faint">
            No event that day — leave unlinked
          </Text>
          <Icon name="link" size={16} color={colors.faint} />
        </View>
      </Field>

      {/* Actions. */}
      <View className="mt-1 flex-row justify-end gap-2">
        <Button
          title={suggestion ? "Re-suggest" : "Suggest coding"}
          variant="secondary"
          size="sm"
          icon="sparkles"
          loading={busy === "suggest"}
          onPress={handleSuggest}
        />
        <Button
          title="Accept & reconcile"
          variant="primary"
          size="sm"
          icon="check"
          loading={busy === "accept"}
          onPress={handleAccept}
        />
      </View>

      {/* Receipt-reminder schedule. */}
      <View className="my-4 h-px bg-border" />
      <Text className="mb-3 text-2xs font-bold uppercase tracking-wider text-muted">
        Receipt reminder schedule
      </Text>
      <ReceiptTimeline postedAt={row.postedAt} receipt={receipt} />
    </Card>
  );
}
