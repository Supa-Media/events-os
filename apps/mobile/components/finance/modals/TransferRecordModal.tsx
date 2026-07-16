/**
 * TransferRecordModal — record (or initiate for real) a City Launch Fund
 * transfer from the central dashboard (WP-4.1 skim in · WP-4.2 grant out).
 *
 * Minimal + honest, mirroring how the reimbursement queue surfaces a manual vs a
 * real ACH payout:
 *  - "Record" ALWAYS writes the ledger truth for money that moved outside the app
 *    (`recordSkimTransfer` / `recordLaunchGrant`).
 *  - "Initiate real transfer" appears ONLY when both accounts are live in this
 *    mode (`transferReadiness.canMoveReal`) and performs the actual Increase
 *    account-to-account transfer (`initiateSkimTransfer` / `initiateLaunchGrant`).
 *
 * A skim (chapter → central) can be computed from the month's backer revenue
 * (15%) or entered directly. A grant (central → chapter) defaults to the
 * playbook launch total and stamps the launch budget on the receiving chapter.
 */
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CENTRAL_SKIM_PCT,
  formatCents,
  launchTemplateTotalCents,
  skimAmountCents,
} from "@events-os/shared";
import { Button, Field, Icon, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

type Direction = "skim" | "grant";
type SkimBasis = "revenue" | "amount";

const DIRECTION_OPTIONS = [
  { value: "skim", label: "Skim in (chapter → central)" },
  { value: "grant", label: "Grant out (central → chapter)" },
];
const BASIS_OPTIONS = [
  { value: "revenue", label: "Compute 15% of backer revenue" },
  { value: "amount", label: "Enter the amount directly" },
];

function dollarsToCents(text: string): number | null {
  const dollars = parseFloat(text);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export function TransferRecordModal({
  chapters,
  onClose,
}: {
  /** The real chapters money can move to/from (from `dashboardCentral`). */
  chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>;
  onClose: () => void;
}) {
  const recordSkim = useMutation(api.transfers.recordSkimTransfer);
  const recordGrant = useMutation(api.transfers.recordLaunchGrant);
  const initiateSkim = useAction(api.transfers.initiateSkimTransfer);
  const initiateGrant = useAction(api.transfers.initiateLaunchGrant);

  const now = new Date();
  const [direction, setDirection] = useState<Direction>("skim");
  const [chapterId, setChapterId] = useState<string | null>(
    chapters[0]?.chapterId ?? null,
  );
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [basis, setBasis] = useState<SkimBasis>("revenue");
  const [revenue, setRevenue] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Whether a REAL Increase transfer is possible for the selected chapter.
  const readiness = useQuery(
    api.transfers.transferReadiness,
    chapterId ? { chapterId: chapterId as Id<"chapters"> } : "skip",
  );
  const canMoveReal = readiness?.canMoveReal ?? false;

  const chapterOptions = useMemo(
    () =>
      chapters.map((c) => ({ value: c.chapterId, label: c.chapterName })),
    [chapters],
  );

  // Live preview of a revenue-basis skim (15%, integer-rounded).
  const revenueCents = dollarsToCents(revenue);
  const computedSkimCents =
    revenueCents != null ? skimAmountCents(revenueCents) : null;

  function commonArgsValid(): Id<"chapters"> | null {
    if (!chapterId) {
      alertError(new Error("Pick a chapter."));
      return null;
    }
    return chapterId as Id<"chapters">;
  }

  function skimAmountArgs():
    | { monthlyBackerRevenueCents: number }
    | { amountCents: number }
    | null {
    if (basis === "revenue") {
      if (revenueCents == null || revenueCents <= 0) {
        alertError(new Error("Enter the month's backer revenue."));
        return null;
      }
      return { monthlyBackerRevenueCents: revenueCents };
    }
    const cents = dollarsToCents(amount);
    if (cents == null || cents <= 0) {
      alertError(new Error("Enter a valid amount."));
      return null;
    }
    return { amountCents: cents };
  }

  async function run(real: boolean) {
    const chId = commonArgsValid();
    if (!chId) return;
    setSaving(true);
    try {
      if (direction === "skim") {
        const amtArgs = skimAmountArgs();
        if (!amtArgs) return;
        const args = {
          chapterId: chId,
          year: parseInt(year, 10),
          month: parseInt(month, 10),
          ...amtArgs,
          ...(note.trim() ? { note: note.trim() } : {}),
        };
        if (real) await initiateSkim(args);
        else await recordSkim(args);
      } else {
        const cents = dollarsToCents(amount);
        const args = {
          chapterId: chId,
          ...(cents && cents > 0 ? { amountCents: cents } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        };
        if (real) await initiateGrant(args);
        else await recordGrant(args);
      }
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  const grantDefault = formatCents(launchTemplateTotalCents());

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
            <Text className="font-display text-lg text-ink">Record transfer</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px] px-5 py-4">
            <Select
              label="Direction"
              value={direction}
              options={DIRECTION_OPTIONS}
              onChange={(v) => {
                // `amount` is shared between the skim's "enter directly" basis
                // and the grant's amount field — reset it on a direction
                // switch so a skim dollar figure doesn't carry over and get
                // silently submitted as the grant amount (or vice versa).
                setDirection(v as Direction);
                setAmount("");
              }}
            />
            <Select
              label="Chapter"
              value={chapterId}
              options={chapterOptions}
              onChange={(v) => setChapterId(v || null)}
              placeholder="Pick a chapter"
            />

            {direction === "skim" ? (
              <>
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <TextField
                      label="Year"
                      value={year}
                      onChangeText={setYear}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View className="flex-1">
                    <TextField
                      label="Month"
                      value={month}
                      onChangeText={setMonth}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <Select
                  label="Amount basis"
                  value={basis}
                  options={BASIS_OPTIONS}
                  onChange={(v) => setBasis(v as SkimBasis)}
                />
                {basis === "revenue" ? (
                  <>
                    <TextField
                      label="Monthly backer revenue (USD)"
                      value={revenue}
                      onChangeText={setRevenue}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                    />
                    <Text className="mb-2 text-xs text-muted">
                      Skim ({Math.round(CENTRAL_SKIM_PCT * 100)}%):{" "}
                      {computedSkimCents != null
                        ? formatCents(computedSkimCents)
                        : "—"}
                    </Text>
                  </>
                ) : (
                  <TextField
                    label="Skim amount (USD)"
                    value={amount}
                    onChangeText={setAmount}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                  />
                )}
              </>
            ) : (
              <TextField
                label={`Grant amount (USD) — defaults to ${grantDefault}`}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder={grantDefault}
              />
            )}

            <Field label="Note (optional)">
              <TextField
                label=""
                value={note}
                onChangeText={setNote}
                placeholder="What moved, and where the money went"
              />
            </Field>

            {direction === "grant" ? (
              <Text className="text-xs text-muted">
                Stamps the playbook launch budget (equipment + training trip) on
                the receiving chapter.
              </Text>
            ) : null}
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button
              title="Record (manual)"
              variant={canMoveReal ? "secondary" : "primary"}
              onPress={() => run(false)}
              loading={saving}
            />
            {canMoveReal ? (
              <Button
                title="Initiate real transfer"
                onPress={() => run(true)}
                loading={saving}
              />
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
