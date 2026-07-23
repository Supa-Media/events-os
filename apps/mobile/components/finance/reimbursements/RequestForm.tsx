/**
 * FINANCES · REIMBURSEMENTS · Request form — the in-app member submission
 * form, extracted so it can be embedded from two places: the authenticated
 * `(app)/finances/reimbursements/new` screen (back arrow, `router.back()` on
 * success) and the standalone `/reimburse-request` share-link page (no back
 * arrow, no dashboard chrome — see that route's doc comment for the auth
 * gate in front of it). Both go through the SAME `submitReimbursement`
 * mutation, so there is exactly one place that knows how to build a request.
 *
 * The authenticated twin of the public /reimburse page: a logged-in member
 * requesting their own reimbursement, backed by `api.reimbursements.submitReimbursement`
 * (identity is server-derived from the caller's own roster row — this screen
 * only supplies editable DISPLAY overrides, never who the request is
 * attributed to). Line items are a spreadsheet-style grid — description,
 * qty × rate (amount is the product, editable line-by-line), a REQUIRED
 * per-line receipt uploaded straight to Convex storage the moment it's picked
 * (mirrors `ReceiptButton`'s generate-url → POST → storageId flow) so the
 * `receiptStorageId` travels with the line on submit, and a REQUIRED per-line
 * transaction date. Submission is blocked — with an inline, itemized error —
 * until every line clears all three.
 *
 * Name/email/phone prefill, funds, and the "For" (event/project/recurring
 * budget) tag options come from `api.reimbursements.newRequestOptions` — a
 * member-safe read with NO finance-role gate, since any chapter member needs
 * it to submit, whether or not they hold a finance grant. There's no fund
 * picker (funds are backend-only, WP-1.4): every line silently lands on the
 * chapter's General Fund server-side. The "For" tag is purely informational
 * (an event, a project, or a recurring budget — never more than one) — it
 * never feeds budget-vs-actual math.
 *
 * "Ask for pre-approval" can carry an OPTIONAL planned purchase date (the
 * picker lives inside the pre-approval callout): it tells the approver when
 * the spend is coming and drives the reminder cron's post-date "submit your
 * receipts" follow-up. Never sent on a plain submission — the backend rejects
 * one there.
 *
 * Direct deposit is REQUIRED, not optional: a full ACH destination (routing +
 * account + type) must be linked via `linkBankAccount` BEFORE the request is
 * created — there is no more last-4-only / "a manager pays you manually"
 * fallback. The form therefore links FIRST and passes the resulting
 * `externalAccountId` through to `submitReimbursement`; if linking fails, the
 * submission never happens (surfaced as an inline error, not a silent
 * degrade).
 *
 * Built to `docs/plans/finance.md` (Reimbursements) + the public reimburse.html
 * visual spec, restyled onto the in-app finance theme (NativeWind + lib/theme).
 */
import { useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { BUDGET_CADENCE_LABELS, type BudgetCadence } from "@events-os/shared";
import {
  Button,
  Field,
  Icon,
  Narrow,
  Screen,
  Select,
  TextField,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { useActionRunner } from "../../../lib/useActionToast";
import { formatMoney, parseDollars } from "../../event/ticketing/helpers";
import { Calendar } from "../../ui/Calendar";
import { Popover } from "../../ui/Popover";
import { useAnchor } from "../../ui/useAnchor";

// ── Backend contract types. These mirror the `api.reimbursements.*` shapes
// (`purpose`, per-line `transactionDate`, `externalAccountId`, `budgetId`,
// the widened `newRequestOptions`/`linkBankAccount`) — the generated types
// lag until `convex dev` regenerates, so the casts below keep this file
// honest against the real validators in apps/convex/reimbursements.ts.
type ForOptionRow = { id: string; label: string };
type BudgetOptionRow = { id: string; label: string; cadence: BudgetCadence };

type NewRequestOptionsResult = {
  defaultPayeeName: string;
  defaultPayeeEmail: string;
  defaultPayeePhone: string;
  funds: { id: string; name: string }[];
  forOptions: {
    events: ForOptionRow[];
    projects: ForOptionRow[];
    budgets: BudgetOptionRow[];
  };
};
type NewRequestOptionsFn = FunctionReference<
  "query",
  "public",
  Record<string, never>,
  NewRequestOptionsResult
>;

type LinkBankAccountArgs = {
  routingNumber: string;
  accountNumber: string;
  accountHolderName?: string;
  funding?: "checking" | "savings";
};
type LinkBankAccountResult = {
  linked: boolean;
  externalAccountId?: string;
  last4?: string;
};
type LinkBankAccountFn = FunctionReference<
  "action",
  "public",
  LinkBankAccountArgs,
  LinkBankAccountResult
>;

type SubmitLineArg = {
  description: string;
  amountCents: number;
  receiptStorageId: Id<"_storage">;
  transactionDate: number;
};
type SubmitReimbursementArgs = {
  payeeName?: string;
  payeeEmail?: string;
  payeePhone?: string;
  purpose: string;
  requestPreApproval?: boolean;
  plannedPurchaseDate?: number;
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  budgetId?: Id<"budgets">;
  externalAccountId: string;
  bankAccountLast4?: string;
  lines: SubmitLineArg[];
};
type SubmitReimbursementResult = {
  reimbursementId: Id<"reimbursementRequests">;
  reference: string;
};
type SubmitReimbursementFn = FunctionReference<
  "mutation",
  "public",
  SubmitReimbursementArgs,
  SubmitReimbursementResult
>;

/** A line's transaction date can't be more than 48h in the future… */
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000;
/** …or more than ~3 years in the past (mirrors the backend's own bound). */
const MAX_PAST_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/** The planned purchase date (pre-approval asks only) runs the OTHER way —
 *  a forward-looking plan can't be more than 48h in the past… */
const MAX_PLANNED_PAST_MS = 48 * 60 * 60 * 1000;
/** …or more than a year out (both mirror the backend's own bounds). */
const MAX_PLANNED_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

/** One in-progress line item — pure client state until Submit builds the
 *  mutation payload. `qtyText`/`rateText` are raw strings so the user can type
 *  freely (a blank field ≠ 0); the amount shown is always their product.
 *  `receiptStorageId` and `transactionDate` are both REQUIRED at submit — the
 *  backend rejects a line missing either. */
type DraftLine = {
  key: string;
  description: string;
  qtyText: string;
  rateText: string;
  receiptStorageId: Id<"_storage"> | null;
  receiptName: string | null;
  uploading: boolean;
  /** Defaults to "now" (always inside the valid window) so a member who
   *  never touches the picker still submits a legal date. */
  transactionDate: number;
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
    transactionDate: Date.now(),
  };
}

/** qty × rate → integer cents (0 when either side is unparsable/blank). */
function lineAmountCents(line: DraftLine): number {
  const qty = Number(line.qtyText);
  const rateCents = parseDollars(line.rateText) ?? 0;
  if (!Number.isFinite(qty) || qty <= 0 || rateCents <= 0) return 0;
  return Math.round(qty * rateCents);
}

/** The "For" picker's value encoding: `""` (none), `event:<id>`,
 *  `project:<id>`, or `budget:<id>` — one `Select` standing in for three
 *  mutually-exclusive optional ids, decoded back into `eventId`/`projectId`/
 *  `budgetId` args on submit (client-side mirror of the backend's own
 *  mutual-exclusion rule). */
function decodeForValue(
  value: string,
): { eventId?: Id<"events">; projectId?: Id<"projects">; budgetId?: Id<"budgets"> } {
  if (value.startsWith("event:")) return { eventId: value.slice(6) as Id<"events"> };
  if (value.startsWith("project:")) return { projectId: value.slice(8) as Id<"projects"> };
  if (value.startsWith("budget:")) return { budgetId: value.slice(7) as Id<"budgets"> };
  return {};
}

type ForOptions = {
  events: ForOptionRow[];
  projects: ForOptionRow[];
  budgets?: BudgetOptionRow[];
};

function buildForOptions(options: ForOptions | undefined) {
  if (!options) return [{ value: "", label: "None" }];
  const items: { value: string; label: string; header?: boolean }[] = [
    { value: "", label: "None" },
  ];
  if (options.events.length > 0) {
    items.push({ value: "__grp_events", label: "Events", header: true });
    for (const e of options.events) items.push({ value: `event:${e.id}`, label: e.label });
  }
  if (options.projects.length > 0) {
    items.push({ value: "__grp_projects", label: "Projects", header: true });
    for (const p of options.projects) items.push({ value: `project:${p.id}`, label: p.label });
  }
  if (options.budgets && options.budgets.length > 0) {
    items.push({ value: "__grp_budgets", label: "Budgets", header: true });
    for (const b of options.budgets) {
      items.push({
        value: `budget:${b.id}`,
        label: `${b.label} · ${BUDGET_CADENCE_LABELS[b.cadence]}`,
      });
    }
  }
  return items;
}

type Props = {
  /** Called once the request is successfully submitted. When omitted, the
   *  form shows its own inline "Request submitted" confirmation instead of
   *  relying on the caller to navigate somewhere — the share-link page has no
   *  natural "back" to return to. */
  onSubmitted?: () => void;
  /** Shows a back arrow above the title when provided. */
  onBack?: () => void;
  title?: string;
  subtitle?: string;
};

export function ReimbursementRequestForm({
  onSubmitted,
  onBack,
  title = "Request a reimbursement",
  subtitle = "Tell us what you spent and we'll pay you back by direct deposit once a finance manager approves.",
}: Props) {
  const options = useQuery(api.reimbursements.newRequestOptions as unknown as NewRequestOptionsFn, {});
  const submit = useMutation(api.reimbursements.submitReimbursement as unknown as SubmitReimbursementFn);
  const linkBankAccount = useAction(api.reimbursements.linkBankAccount as unknown as LinkBankAccountFn);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();

  const [payeeName, setPayeeName] = useState<string | null>(null);
  const [payeeEmail, setPayeeEmail] = useState<string | null>(null);
  // Full ACH destination — REQUIRED. Linked BEFORE submit (see `handleSubmit`)
  // so the resulting `externalAccountId` can travel with the create call; the
  // last-4-only / manual-payment fallback is gone.
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [funding, setFunding] = useState<"checking" | "savings">("checking");
  // The required "why" — what the request is for, sent as `purpose`.
  const [purpose, setPurpose] = useState("");
  // When the member plans to buy — OPTIONAL, and only sent with "Ask for
  // pre-approval" (the backend rejects one on a plain submission). `null` =
  // not set.
  const [plannedPurchaseDate, setPlannedPurchaseDate] = useState<number | null>(null);
  const [forValue, setForValue] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  // Prefill once options load; the user can still edit either field. `null`
  // means "not yet touched by the user", so a slow-arriving query doesn't
  // stomp on something they already typed.
  const nameValue = payeeName ?? options?.defaultPayeeName ?? "";
  const emailValue = payeeEmail ?? options?.defaultPayeeEmail ?? "";

  const totalCents = lines.reduce((sum, l) => sum + lineAmountCents(l), 0);
  const forOptions = buildForOptions(options?.forOptions);

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

  /** Lines with a description or an amount — the same "usable" filter used to
   *  both validate and build the submit payload. */
  function usableLines(): DraftLine[] {
    return lines.filter((l) => l.description.trim() || lineAmountCents(l) > 0);
  }

  function validate(): string | null {
    if (!nameValue.trim()) return "Add your name.";
    if (!purpose.trim()) return "What was this for? Why was it needed?";
    const usable = usableLines();
    if (usable.length === 0) return "Add at least one line item with an amount.";
    for (const l of usable) {
      if (!l.description.trim()) return "Every line needs a description.";
      if (lineAmountCents(l) <= 0) return "Every line needs a qty and rate that add up to more than $0.";
      if (l.transactionDate > Date.now() + MAX_FUTURE_MS) {
        return `"${l.description.trim() || "Untitled line"}" — the transaction date can't be more than 48 hours in the future.`;
      }
      if (l.transactionDate < Date.now() - MAX_PAST_MS) {
        return `"${l.description.trim() || "Untitled line"}" — the transaction date can't be more than 3 years old.`;
      }
    }
    // Every line needs a receipt — list which ones don't, rather than a single
    // generic error, so it's obvious what's still missing.
    const missingReceipts = usable.filter((l) => !l.receiptStorageId);
    if (missingReceipts.length > 0) {
      const names = missingReceipts.map((l, i) => l.description.trim() || `Line ${i + 1}`);
      return `Add a receipt for: ${names.join(", ")}.`;
    }
    if (!routingNumber.trim() || !accountNumber.trim()) {
      return "Add your routing and account number so we can pay you by direct deposit.";
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
    // The planned purchase date only travels with a pre-approval ask, and must
    // sit inside the backend's own sanity window (mirrored here so the member
    // hears about it before the network round-trip).
    if (requestPreApproval && plannedPurchaseDate != null) {
      if (plannedPurchaseDate < Date.now() - MAX_PLANNED_PAST_MS) {
        setError("The planned purchase date can't be in the past.");
        return;
      }
      if (plannedPurchaseDate > Date.now() + MAX_PLANNED_FUTURE_MS) {
        setError("The planned purchase date must be within the next year.");
        return;
      }
    }
    const usable = usableLines();
    const forIds = decodeForValue(forValue);
    setSubmitting(true);

    // Link FIRST: the backend rejects a create without an already-linked full
    // ACH destination, so the External Account must exist before we submit.
    const linked = await run(
      () =>
        linkBankAccount({
          routingNumber: routingNumber.trim(),
          accountNumber: accountNumber.trim(),
          accountHolderName: nameValue.trim(),
          funding,
        }),
      { errorTitle: "Couldn't link your bank account" },
    );
    if (linked === undefined || !linked.linked || !linked.externalAccountId) {
      setSubmitting(false);
      if (linked !== undefined) {
        setError(
          "We couldn't verify your bank account — double-check the routing and account numbers and try again.",
        );
      }
      return;
    }
    // Captured as a plain local (rather than re-reading `linked.externalAccountId`
    // inside the closure below) so the narrowing above actually sticks — TS
    // doesn't retain property-truthiness narrowing across a closure boundary.
    const externalAccountId = linked.externalAccountId;

    const result = await run(
      () =>
        submit({
          payeeName: nameValue.trim(),
          payeeEmail: emailValue.trim() || undefined,
          purpose: purpose.trim(),
          requestPreApproval,
          // Only rides with a pre-approval ask — the backend rejects it on a
          // plain submission.
          plannedPurchaseDate:
            requestPreApproval && plannedPurchaseDate != null
              ? plannedPurchaseDate
              : undefined,
          eventId: forIds.eventId,
          projectId: forIds.projectId,
          budgetId: forIds.budgetId,
          externalAccountId,
          // Display-only last-4, known at link time (the public flow passes it
          // the same way) — so the queue shows "····1234" for in-app requests.
          bankAccountLast4: linked.last4,
          lines: usable.map((l) => ({
            description: l.description.trim(),
            amountCents: lineAmountCents(l),
            receiptStorageId: l.receiptStorageId as Id<"_storage">,
            transactionDate: l.transactionDate,
          })),
        }),
      { errorTitle: requestPreApproval ? "Couldn't request pre-approval" : "Couldn't submit" },
    );
    setSubmitting(false);
    if (result !== undefined) {
      if (onSubmitted) onSubmitted();
      else setJustSubmitted(true);
    }
  }

  if (options === undefined) return <Screen loading />;

  if (justSubmitted) {
    return (
      <Screen maxWidth={720}>
        <Narrow width={720}>
          <View className="items-center gap-3 rounded-lg border border-border bg-raised p-8 text-center">
            <Icon name="check-circle" size={32} color={colors.success} />
            <Text className="font-display text-xl text-ink">Request submitted</Text>
            <Text className="text-center text-sm text-muted">
              A finance manager will review it and you'll be paid by direct
              deposit once it's approved.
            </Text>
            <Button
              title="Submit another request"
              variant="secondary"
              size="sm"
              onPress={() => {
                setLines([emptyLine()]);
                setPurpose("");
                setPlannedPurchaseDate(null);
                setForValue("");
                setJustSubmitted(false);
              }}
            />
          </View>
        </Narrow>
      </Screen>
    );
  }

  return (
    <>
      <Screen maxWidth={720}>
        <Narrow width={720}>
          <View className="mb-1 flex-row items-center gap-2">
            {onBack ? (
              <Pressable onPress={onBack} hitSlop={8} className="rounded-md p-1 active:opacity-70">
                <Icon name="arrow-left" size={18} color={colors.muted} />
              </Pressable>
            ) : null}
            <Text className="font-display text-2xl text-ink">{title}</Text>
          </View>
          <Text className="mb-5 text-sm text-muted">{subtitle}</Text>

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

          <Select
            label="What's this for?"
            hint="Tag an event, a project, or one of the chapter's recurring budgets so the finance team can see what it relates to."
            value={forValue}
            options={forOptions}
            onChange={setForValue}
            placeholder="None"
          />

          <TextField
            label="What was this for? Why was it needed?"
            value={purpose}
            onChangeText={setPurpose}
            placeholder="A short note the finance team can review at a glance…"
            multiline
            numberOfLines={3}
          />

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
              store your full account number. Required: a request can't be
              submitted without a linked bank account, and approval pays it
              out directly.
            </Text>
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

          <View className="mt-2 rounded-md bg-warn-bg px-3 py-2.5">
            <View className="flex-row items-start gap-2">
              <Icon name="alert-triangle" size={14} color={colors.warn} />
              <Text className="flex-1 text-xs text-warn">
                Was this pre-approved? If it wasn't already in the budget, ask
                for pre-approval instead — surprises can be sent back.
              </Text>
            </View>
            {/* Planned purchase date — optional, and only sent when the member
                taps "Ask for pre-approval" (hence its home inside this
                callout): tells the approver when the spend is coming, and
                drives the post-date "submit your receipts" follow-up email. */}
            <View className="mt-2 flex-row flex-wrap items-center gap-2">
              <Text className="text-xs font-semibold text-warn">
                Asking for pre-approval? When do you plan to buy?
              </Text>
              <PlannedDateCell
                value={plannedPurchaseDate}
                onChange={setPlannedPurchaseDate}
              />
            </View>
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

      {/* Per-line transaction date — required. */}
      <View className="mt-2 flex-row items-center gap-2">
        <Text className="text-xs font-semibold text-muted">Transaction date</Text>
        <TransactionDateCell
          value={line.transactionDate}
          onChange={(ms) => onChange({ transactionDate: ms })}
        />
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

/** A line's required transaction date — the same Calendar/Popover idiom the
 *  rest of the app uses for a day-only pick (mirrors `DueDateCell`), without
 *  the DUE↔TIMING offset math that cell adds: this is a plain day picker, no
 *  time-of-day component, since only the calendar day matters for the
 *  48h-future / 3y-old bounds the backend enforces. */
function TransactionDateCell({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-raised px-2.5 py-1.5 active:opacity-80"
      >
        <Icon name="calendar" size={13} color={colors.muted} />
        <Text className="text-sm text-ink">{formatDate(value)}</Text>
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={288}>
        <Calendar
          selected={value}
          seed={value}
          onSelect={(dayMs) => {
            onChange(dayMs);
            close();
          }}
        />
      </Popover>
    </>
  );
}

/** The OPTIONAL planned purchase date (pre-approval asks only) — the same
 *  Calendar/Popover day-pick idiom as `TransactionDateCell`, but nullable:
 *  unset renders a "Pick a date" affordance, and a set date carries an inline
 *  clear so the member can go back to "no date" without submitting one. */
function PlannedDateCell({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (ms: number | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-raised px-2.5 py-1.5 active:opacity-80"
      >
        <Icon name="calendar" size={13} color={colors.muted} />
        <Text className={value != null ? "text-sm text-ink" : "text-sm text-faint"}>
          {value != null ? formatDate(value) : "Pick a date (optional)"}
        </Text>
        {value != null ? (
          <Pressable
            onPress={() => onChange(null)}
            hitSlop={6}
            accessibilityLabel="Clear planned purchase date"
          >
            <Icon name="x" size={13} color={colors.muted} />
          </Pressable>
        ) : null}
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={288}>
        <Calendar
          selected={value}
          seed={value ?? Date.now()}
          onSelect={(dayMs) => {
            onChange(dayMs);
            close();
          }}
        />
      </Popover>
    </>
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
