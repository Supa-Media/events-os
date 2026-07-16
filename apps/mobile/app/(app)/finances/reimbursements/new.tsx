/**
 * FINANCES · REIMBURSEMENTS · New — the in-app member submission form.
 *
 * The authenticated twin of the public /reimburse page: a logged-in member
 * requesting their own reimbursement, backed by `api.reimbursements.submitReimbursement`
 * (identity is server-derived from the caller's own roster row — this screen
 * only supplies editable DISPLAY overrides, never who the request is
 * attributed to). Line items are a spreadsheet-style grid — description,
 * qty × rate (amount is the product, editable line-by-line), and an optional
 * per-line receipt uploaded straight to Convex storage the moment it's picked
 * (mirrors `ReceiptButton`'s generate-url → POST → storageId flow) so the
 * `receiptStorageId` travels with the line on submit.
 *
 * Fund + name/email/phone prefill come from `api.reimbursements.newRequestOptions`
 * — a member-safe read with NO finance-role gate (unlike `finances.listFunds`),
 * since any chapter member needs it to submit, whether or not they hold a
 * finance grant.
 *
 * Built to `docs/plans/finance.md` (Reimbursements) + the public reimburse.html
 * visual spec, restyled onto the in-app finance theme (NativeWind + lib/theme).
 */
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import {
  Button,
  Field,
  Icon,
  Narrow,
  Screen,
  Select,
  TextField,
  ToastView,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { useActionRunner } from "../../../../lib/useActionToast";
import { formatMoney, parseDollars } from "../../../../components/event/ticketing/helpers";

/** One in-progress line item — pure client state until Submit builds the
 *  mutation payload. `qtyText`/`rateText` are raw strings so the user can type
 *  freely (a blank field ≠ 0); the amount shown is always their product. */
type DraftLine = {
  key: string;
  description: string;
  qtyText: string;
  rateText: string;
  receiptStorageId: Id<"_storage"> | null;
  receiptName: string | null;
  uploading: boolean;
};

function emptyLine(): DraftLine {
  return {
    key: Math.random().toString(36).slice(2),
    description: "",
    qtyText: "1",
    rateText: "",
    receiptStorageId: null,
    receiptName: null,
    uploading: false,
  };
}

/** qty × rate → integer cents (0 when either side is unparsable/blank). */
function lineAmountCents(line: DraftLine): number {
  const qty = Number(line.qtyText);
  const rateCents = parseDollars(line.rateText) ?? 0;
  if (!Number.isFinite(qty) || qty <= 0 || rateCents <= 0) return 0;
  return Math.round(qty * rateCents);
}

export default function NewReimbursementScreen() {
  const router = useRouter();
  const options = useQuery(api.reimbursements.newRequestOptions, {});
  const submit = useMutation(api.reimbursements.submitReimbursement);
  const linkBankAccount = useAction(api.reimbursements.linkBankAccount);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();

  const [payeeName, setPayeeName] = useState<string | null>(null);
  const [payeeEmail, setPayeeEmail] = useState<string | null>(null);
  const [bankLast4, setBankLast4] = useState("");
  // Full ACH destination (optional): when both are filled, we link a REAL
  // Increase External Account after submit so the payout can go out by actual
  // ACH instead of degrading to a manual one. Leaving these blank still works
  // exactly as before (last-4 only, manager pays by hand).
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [funding, setFunding] = useState<"checking" | "savings">("checking");
  const [fundId, setFundId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Prefill once options load; the user can still edit either field. `null`
  // means "not yet touched by the user", so a slow-arriving query doesn't
  // stomp on something they already typed.
  const nameValue = payeeName ?? options?.defaultPayeeName ?? "";
  const emailValue = payeeEmail ?? options?.defaultPayeeEmail ?? "";

  const fundOptions = useMemo(
    () => [
      { value: "", label: "— No fund —" },
      ...(options?.funds ?? []).map((f) => ({ value: f.id, label: f.name })),
    ],
    [options?.funds],
  );

  const totalCents = lines.reduce((sum, l) => sum + lineAmountCents(l), 0);

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((ls) => [...ls, emptyLine()]);
  }

  function removeLine(key: string) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));
  }

  async function uploadReceipt(key: string, blob: Blob, contentType: string, name: string) {
    updateLine(key, { uploading: true });
    const storageId = await run(
      async () => {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: blob,
        });
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        return storageId;
      },
      { errorTitle: "Couldn't attach receipt" },
    );
    if (storageId !== undefined) {
      updateLine(key, { receiptStorageId: storageId, receiptName: name, uploading: false });
    } else {
      updateLine(key, { uploading: false });
    }
  }

  function pickReceiptWeb(key: string) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadReceipt(key, file, file.type || "image/jpeg", file.name);
    };
    input.click();
  }

  async function pickReceiptNative(key: string) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadReceipt(key, blob, asset.mimeType || blob.type || "image/jpeg", asset.fileName ?? "Receipt");
  }

  function pickReceipt(key: string) {
    if (Platform.OS === "web") pickReceiptWeb(key);
    else void pickReceiptNative(key);
  }

  function clearReceipt(key: string) {
    updateLine(key, { receiptStorageId: null, receiptName: null });
  }

  function validate(): string | null {
    if (!nameValue.trim()) return "Add your name.";
    const usable = lines.filter((l) => l.description.trim() || lineAmountCents(l) > 0);
    if (usable.length === 0) return "Add at least one line item with an amount.";
    for (const l of usable) {
      if (!l.description.trim()) return "Every line needs a description.";
      if (lineAmountCents(l) <= 0) return "Every line needs a qty and rate that add up to more than $0.";
    }
    return null;
  }

  async function handleSubmit(requestPreApproval: boolean) {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const hasFullDestination = routingNumber.trim().length > 0 && accountNumber.trim().length > 0;
    if (routingNumber.trim() && !accountNumber.trim()) {
      setError("Add your account number too, or clear the routing number.");
      return;
    }
    if (accountNumber.trim() && !routingNumber.trim()) {
      setError("Add your routing number too, or clear the account number.");
      return;
    }
    const usable = lines.filter((l) => l.description.trim() || lineAmountCents(l) > 0);
    setSubmitting(true);
    const result = await run(
      () =>
        submit({
          payeeName: nameValue.trim(),
          payeeEmail: emailValue.trim() || undefined,
          // A full destination below supersedes last-4 — that gets set from
          // the real account number once `linkBankAccount` completes.
          bankAccountLast4: hasFullDestination ? undefined : bankLast4.trim() || undefined,
          purpose: notes.trim() || undefined,
          requestPreApproval,
          lines: usable.map((l) => ({
            description: l.description.trim(),
            amountCents: lineAmountCents(l),
            fundId: fundId ? (fundId as Id<"funds">) : undefined,
            receiptStorageId: l.receiptStorageId ?? undefined,
          })),
        }),
      { errorTitle: requestPreApproval ? "Couldn't request pre-approval" : "Couldn't submit" },
    );
    if (result !== undefined && hasFullDestination) {
      // Best-effort: a failure here never blocks the submission that already
      // succeeded — it just means a manager pays this one by hand instead.
      await run(
        () =>
          linkBankAccount({
            reimbursementId: result.reimbursementId,
            routingNumber: routingNumber.trim(),
            accountNumber: accountNumber.trim(),
            accountHolderName: nameValue.trim(),
            funding,
          }),
        { errorTitle: "Submitted, but couldn't link your bank account" },
      );
    }
    setSubmitting(false);
    if (result !== undefined) router.back();
  }

  if (options === undefined) return <Screen loading />;

  return (
    <>
      <Screen maxWidth={720}>
        <Narrow width={720}>
          <View className="mb-1 flex-row items-center gap-2">
            <Pressable onPress={() => router.back()} hitSlop={8} className="rounded-md p-1 active:opacity-70">
              <Icon name="arrow-left" size={18} color={colors.muted} />
            </Pressable>
            <Text className="font-display text-2xl text-ink">Request a reimbursement</Text>
          </View>
          <Text className="mb-5 text-sm text-muted">
            Tell us what you spent and we'll pay you back by direct deposit once a
            finance manager approves.
          </Text>

          <View className="flex-row gap-3">
            <View className="flex-1">
              <TextField
                label="Your name"
                value={nameValue}
                onChangeText={setPayeeName}
                placeholder="First and last name"
              />
            </View>
            <View className="flex-1">
              <TextField
                label="Email"
                value={emailValue}
                onChangeText={setPayeeEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="you@example.com"
              />
            </View>
          </View>

          <View className="flex-row gap-3">
            <View className="flex-1">
              <Select
                label="Fund"
                value={fundId}
                options={fundOptions}
                onChange={(v) => setFundId(v || null)}
                placeholder="— No fund —"
              />
            </View>
          </View>

          <Field label="Direct deposit — where we pay you">
            <View className="flex-row gap-3">
              <View className="flex-1">
                <TextField
                  label="Routing number"
                  value={routingNumber}
                  onChangeText={(v) => setRoutingNumber(v.replace(/[^0-9]/g, "").slice(0, 9))}
                  keyboardType="number-pad"
                  maxLength={9}
                  placeholder="9 digits"
                />
              </View>
              <View className="flex-1">
                <TextField
                  label="Account number"
                  value={accountNumber}
                  onChangeText={(v) => setAccountNumber(v.replace(/[^0-9]/g, "").slice(0, 17))}
                  keyboardType="number-pad"
                  maxLength={17}
                  placeholder="e.g. 000123456789"
                />
              </View>
              <View className="w-32">
                <Select
                  label="Type"
                  value={funding}
                  options={[
                    { value: "checking", label: "Checking" },
                    { value: "savings", label: "Savings" },
                  ]}
                  onChange={(v) => setFunding((v || "checking") as "checking" | "savings")}
                />
              </View>
            </View>
            <Text className="mt-1 text-2xs text-faint">
              Securely linked through our banking partner (Increase) — we never
              store your full account number. Prefer to just tell us the last 4
              digits? Leave these blank and a finance manager will pay you
              manually.
            </Text>
            {!routingNumber && !accountNumber ? (
              <TextField
                label="Pay to — bank last 4 (optional)"
                value={bankLast4}
                onChangeText={(v) => setBankLast4(v.replace(/[^0-9]/g, "").slice(0, 4))}
                keyboardType="number-pad"
                maxLength={4}
                placeholder="e.g. 3391"
              />
            ) : null}
          </Field>

          <Field label="Line items">
            <View className="mb-2 flex-row gap-2 px-1">
              <Text className="flex-1 text-2xs font-bold uppercase tracking-wider text-muted">
                Description
              </Text>
              <Text className="w-14 text-2xs font-bold uppercase tracking-wider text-muted">Qty</Text>
              <Text className="w-20 text-2xs font-bold uppercase tracking-wider text-muted">Rate</Text>
              <Text className="w-20 text-right text-2xs font-bold uppercase tracking-wider text-muted">
                Amount
              </Text>
              <View className="w-6" />
            </View>
            <View className="gap-3">
              {lines.map((line) => (
                <LineRow
                  key={line.key}
                  line={line}
                  canRemove={lines.length > 1}
                  onChange={(patch) => updateLine(line.key, patch)}
                  onRemove={() => removeLine(line.key)}
                  onPickReceipt={() => pickReceipt(line.key)}
                  onClearReceipt={() => clearReceipt(line.key)}
                />
              ))}
            </View>
            <Button
              title="Add line item"
              variant="ghost"
              size="sm"
              icon="plus"
              className="mt-2 self-start"
              onPress={addLine}
            />
          </Field>

          <TextField
            label="Notes (optional)"
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything the finance team should know…"
            multiline
            numberOfLines={3}
          />

          <View className="mt-2 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2.5">
            <Icon name="alert-triangle" size={14} color={colors.warn} />
            <Text className="flex-1 text-xs text-warn">
              Was this pre-approved? If it wasn't already in the budget, ask for
              pre-approval instead — surprises can be sent back.
            </Text>
          </View>

          {error ? (
            <View className="mt-3 rounded-md bg-danger-bg px-3 py-2.5">
              <Text className="text-xs text-danger">{error}</Text>
            </View>
          ) : null}

          <View className="mt-5 flex-row flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <View>
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Total to be reimbursed
              </Text>
              <Text className="font-display text-2xl text-ink">{formatMoney(totalCents)}</Text>
            </View>
            <View className="flex-row flex-wrap gap-2">
              <Button
                title="Ask for pre-approval"
                variant="secondary"
                icon="clock"
                disabled={submitting}
                onPress={() => void handleSubmit(true)}
              />
              <Button
                title="Submit request"
                icon="send"
                loading={submitting}
                onPress={() => void handleSubmit(false)}
              />
            </View>
          </View>
        </Narrow>
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

/** One line-item row: description, qty × rate (amount is their product), a
 *  receipt dropzone, and a remove button. */
function LineRow({
  line,
  canRemove,
  onChange,
  onRemove,
  onPickReceipt,
  onClearReceipt,
}: {
  line: DraftLine;
  canRemove: boolean;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
  onPickReceipt: () => void;
  onClearReceipt: () => void;
}) {
  const amountCents = lineAmountCents(line);
  return (
    <View className="rounded-md border border-border bg-raised p-2.5">
      <View className="flex-row items-center gap-2">
        <TextInputCell
          value={line.description}
          onChangeText={(v) => onChange({ description: v })}
          placeholder="What did you buy?"
          className="flex-1"
        />
        <TextInputCell
          value={line.qtyText}
          onChangeText={(v) => onChange({ qtyText: v })}
          placeholder="1"
          keyboardType="decimal-pad"
          className="w-14"
        />
        <TextInputCell
          value={line.rateText}
          onChangeText={(v) => onChange({ rateText: v })}
          placeholder="$0.00"
          keyboardType="decimal-pad"
          className="w-20"
        />
        <Text className="w-20 text-right text-sm font-semibold text-ink">
          {formatMoney(amountCents)}
        </Text>
        <Pressable
          onPress={onRemove}
          disabled={!canRemove}
          hitSlop={6}
          accessibilityLabel="Remove line"
          className={`w-6 items-center ${canRemove ? "active:opacity-70" : "opacity-30"}`}
        >
          <Icon name="x" size={15} color={colors.muted} />
        </Pressable>
      </View>

      {/* Per-line receipt dropzone. */}
      <View className="mt-2">
        {line.uploading ? (
          <View className="flex-row items-center gap-2 rounded-md border border-dashed border-border-strong bg-sunken px-3 py-2">
            <Icon name="upload" size={14} color={colors.muted} />
            <Text className="text-xs text-muted">Uploading…</Text>
          </View>
        ) : line.receiptStorageId ? (
          <View className="flex-row items-center justify-between rounded-md bg-success-bg px-3 py-2">
            <View className="flex-1 flex-row items-center gap-2">
              <Icon name="check" size={13} color={colors.success} />
              <Text className="flex-1 text-xs font-semibold text-success" numberOfLines={1}>
                {line.receiptName ?? "Receipt attached"}
              </Text>
            </View>
            <Pressable onPress={onClearReceipt} hitSlop={6} accessibilityLabel="Remove receipt">
              <Icon name="x" size={13} color={colors.success} />
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={onPickReceipt}
            className="flex-row items-center gap-2 rounded-md border border-dashed border-border-strong bg-sunken px-3 py-2 active:opacity-70"
          >
            <Icon name="upload" size={14} color={colors.muted} />
            <Text className="text-xs text-muted">Add a receipt for this line — photo or PDF</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Bare, un-labelled text input for grid cells (Field/TextField always render a
 *  label row, which the grid header already provides once for the column). */
function TextInputCell({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  className = "",
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "decimal-pad";
  className?: string;
}) {
  return (
    <View className={`rounded-md border border-border-strong bg-raised px-2.5 py-2 ${className}`}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        keyboardType={keyboardType}
        className="text-sm text-ink"
      />
    </View>
  );
}
