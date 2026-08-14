/**
 * BULK EXPLANATION — writing one sentence once, for a selection of charges.
 *
 * The founder's case (2026-08-13, ~400 imported 2024-25 rows): forty identical
 * MTA fares are one fact about one month, and typing that fact forty times
 * makes the record no truer — it just makes the honest option expensive, which
 * is how a ledger ends up published with blanks in it. `BulkNoDocumentationModal`
 * is the same argument for the DOCUMENTATION half of a row; this is the
 * EXPLANATION half.
 *
 * ## What this screen is careful about
 *
 * IT IS NOT AI AUTHORSHIP, and the copy says so out loud. The org's standing
 * rule bans a MACHINE composing testimony; it does not ban a person reusing
 * their own words. Nothing here suggests, drafts, completes or ranks anything
 * — the box starts empty and stays empty until somebody types in it — and the
 * server records a real human author on every row it writes.
 *
 * IT REFUSES WHAT IT CANNOT HONOUR, here rather than forty validation errors
 * later. Meals are not offered at all: a meal's required §274(d) element is
 * WHO WAS THERE, which is a different fact for every meal, and one attendee
 * list applied across a selection would be asserting something nobody checked.
 * Travel and overnight stays ARE offered, because their required element is a
 * route or a place, and that genuinely is the same across a batch of identical
 * fares — supplied once here, applied to all.
 *
 * IT NEVER CLAIMS MORE THAN IT DID. `BulkExplainResults` below is not a
 * courtesy; it is the other half of the feature. The server reports every row
 * it refused, with its own reason, and this shows which charges those were, by
 * name — a bulk action that silently drops twelve rows is worse than no bulk
 * action, because the twelve look done.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import {
  EXPENSE_TYPE_LABELS,
  MIN_PURPOSE_LENGTH,
  type ExpenseType,
} from "@events-os/shared";
import { Button, Icon, Radio, RadioGroup, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import type { BulkExplainSummary } from "../reconcile/bulkExplainOutcome";

/** The types a shared sentence can honestly cover — see the module doc.
 *  `meal` is deliberately absent rather than disabled-with-a-tooltip: it is
 *  not a setting someone is missing, it is a different job. */
const BULK_EXPENSE_TYPES = ["general", "travel", "lodging"] as const;
type BulkExpenseType = (typeof BULK_EXPENSE_TYPES)[number];

const CHIP_LABELS: Record<BulkExpenseType, string> = {
  general: EXPENSE_TYPE_LABELS.general,
  travel: EXPENSE_TYPE_LABELS.travel,
  lodging: "Overnight stay",
};

export interface BulkExplainArgs {
  expenseType: ExpenseType;
  businessPurpose: string;
  travelFrom?: string;
  travelTo?: string;
}

export function BulkExplainModal({
  count,
  limit,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** How many charges are selected — stated plainly in the title and on the
   *  button, because this writes a public sentence onto every one of them. */
  count: number;
  /** The server's own cap (`BULK_EXPLANATION_MAX`), echoed rather than
   *  re-typed. Over it the confirm is refused HERE, with the number, instead
   *  of letting the mutation throw after they've written the sentence. */
  limit: number;
  onConfirm: (args: BulkExplainArgs) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [expenseType, setExpenseType] = useState<BulkExpenseType>("general");
  const [purpose, setPurpose] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const trimmed = purpose.trim();
  const purposeOk = trimmed.length >= MIN_PURPOSE_LENGTH;
  const needsRoute = expenseType === "travel";
  const needsPlace = expenseType === "lodging";
  const routeOk = needsRoute
    ? from.trim().length > 0 && to.trim().length > 0
    : needsPlace
      ? to.trim().length > 0
      : true;
  const overLimit = count > limit;
  const ready = purposeOk && routeOk && !overLimit;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              Explain {count} {count === 1 ? "charge" : "charges"}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[440px]">
            <View className="px-5 py-4">
              {/* SAID OUT LOUD, because it is the thing that makes this
                  legitimate: your words, your selection, your name on every
                  row. Nothing here is composed for you. */}
              <Text className="mb-4 text-xs text-muted">
                Your sentence, written once and recorded on every charge you
                selected — one coding each, under your name, with its own audit
                entry. Nothing is written for you and nothing is shared between
                the rows except the words you type here.
              </Text>

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                Which proof questions apply?
              </Text>
              <RadioGroup
                accessibilityLabel="Which proof questions apply?"
                horizontal
                className="mb-1 flex-row flex-wrap gap-1.5"
              >
                {BULK_EXPENSE_TYPES.map((t) => {
                  const selected = expenseType === t;
                  return (
                    <Radio
                      key={t}
                      checked={selected}
                      onSelect={() => setExpenseType(t)}
                      accessibilityLabel={CHIP_LABELS[t]}
                      className={`rounded-full border px-3 py-1.5 active:opacity-70 ${
                        selected
                          ? "border-accent bg-accent/10"
                          : "border-border bg-sunken"
                      }`}
                    >
                      <Text
                        className={`text-xs ${selected ? "font-semibold text-ink" : "text-muted"}`}
                      >
                        {CHIP_LABELS[t]}
                      </Text>
                    </Radio>
                  );
                })}
              </RadioGroup>
              {/* The absence of "Meal" is explained rather than left as a
                  gap someone hunts for. */}
              <Text className="mb-4 text-2xs text-faint">
                Meals aren&apos;t here on purpose — a meal&apos;s proof is who
                was at it, and that&apos;s different for every meal. Code those
                one at a time.
              </Text>

              {needsRoute ? (
                <View className="mb-4 gap-2">
                  <TextField
                    label="From"
                    value={from}
                    onChangeText={setFrom}
                    placeholder="Rosedale"
                  />
                  <TextField
                    label="To"
                    value={to}
                    onChangeText={setTo}
                    placeholder="Midtown Manhattan"
                  />
                  <Text className="text-2xs text-muted">
                    The same route is recorded on every selected charge — so
                    only bulk-explain fares that really did run it.
                  </Text>
                </View>
              ) : null}
              {needsPlace ? (
                <View className="mb-4 gap-2">
                  <TextField
                    label="Where you stayed"
                    value={to}
                    onChangeText={setTo}
                    placeholder="Philadelphia"
                  />
                  <Text className="text-2xs text-muted">
                    Recorded on every selected charge — one stay, its nights
                    billed separately, is the case this fits.
                  </Text>
                </View>
              ) : null}

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                What were they for?
              </Text>
              <TextField
                value={purpose}
                onChangeText={setPurpose}
                placeholder="e.g. Subway fares travelling between outreach sites in Queens for the Eden project"
                multiline
                numberOfLines={3}
              />
              {!purposeOk && trimmed.length > 0 ? (
                <Text className="mt-1 text-2xs text-muted">
                  Say what it was for and which org work it served — at least{" "}
                  {MIN_PURPOSE_LENGTH} characters.
                </Text>
              ) : null}
              <Text className="mt-1 text-2xs text-muted">
                This appears on the public ledger against every charge in the
                selection, so write one that&apos;s true of all of them.
                Charges that need different explanations want separate passes.
              </Text>

              <View className="mt-4 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
                <Icon name="info" size={13} color={colors.muted} />
                <Text className="flex-1 text-2xs text-muted">
                  Charges that can&apos;t take it — no receipt yet, or a coding
                  already approved — are refused one by one and listed back to
                  you. Nothing is skipped quietly.
                </Text>
              </View>

              {overLimit ? (
                <View className="mt-3 flex-row items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2">
                  <Icon name="alert-triangle" size={13} color={colors.muted} />
                  <Text className="flex-1 text-2xs text-ink">
                    {`Up to ${limit} at a time — you have ${count} selected. Doing the first ${limit} and staying quiet about the rest is exactly what this screen refuses to do, so narrow the selection.`}
                  </Text>
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={`Explain ${count}`}
              icon="check"
              disabled={!ready}
              loading={submitting}
              onPress={() => {
                if (!ready) return;
                onConfirm({
                  expenseType,
                  businessPurpose: trimmed,
                  ...(needsRoute ? { travelFrom: from.trim() } : {}),
                  ...(needsRoute || needsPlace ? { travelTo: to.trim() } : {}),
                });
              }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * WHAT ACTUALLY HAPPENED — the other half of the feature.
 *
 * Shown whenever a bulk apply refused at least one row. A plain toast would
 * say "28 applied, 12 skipped" and leave the person to work out which twelve
 * out of forty they still owe, which is worse than not offering the bulk
 * action at all. So the refusals are grouped by reason, each carrying the
 * server's own sentence once, and every charge is listed by the name the grid
 * gave it.
 *
 * The selection is deliberately left INTACT behind this (the host clears it
 * only on a clean pass) — the failed rows are still selected, so fixing them
 * is the next thing that happens rather than a re-hunt.
 */
export function BulkExplainResults({
  summary,
  onClose,
}: {
  summary: BulkExplainSummary;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">{summary.line}</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[400px]">
            <View className="gap-4 px-5 py-4">
              {summary.groups.map((group) => (
                <View key={group.code}>
                  <Text className="mb-1 text-sm font-semibold text-ink">
                    {group.transactionIds.length} {group.headline}
                  </Text>
                  <Text className="mb-2 text-2xs text-muted">
                    {group.message}
                  </Text>
                  <View className="gap-1 rounded-md border border-border bg-sunken px-3 py-2">
                    {group.labels.map((label, i) => (
                      <Text
                        key={`${group.transactionIds[i]}`}
                        className="text-2xs text-ink"
                        numberOfLines={1}
                      >
                        {label}
                      </Text>
                    ))}
                  </View>
                </View>
              ))}
              <Text className="text-2xs text-faint">
                These are still selected — sort out what they need and run it
                again.
              </Text>
            </View>
          </ScrollView>

          <View className="flex-row justify-end border-t border-border px-5 py-4">
            <Button title="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
