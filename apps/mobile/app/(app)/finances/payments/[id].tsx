/**
 * FINANCES · PAYMENTS · DETAIL — one contractor payment, and every decision
 * anyone can still make about it.
 *
 * The screen is ordered by who is blocked, not by what the record contains:
 * the reviewer's three doors first (when it's their turn), then the link (when
 * the contractor's turn), then the terms, the tax form, and the money rail.
 *
 * Four things here are load-bearing and easy to get subtly wrong:
 *
 *  1. THE LINK IS THE PRODUCT. `ContractLinkCard` is above the fold whenever
 *     the caller may compose and the record still has a live token — copying
 *     it is what a staffer came here to do.
 *  2. EDITING AGREED TERMS AFTER ACCEPTANCE VOIDS THE ACCEPTANCE. The work,
 *     the amount and the service date are what somebody signed; changing any
 *     of them bumps the terms version, clears the signature and walks the row
 *     back to `sent`. This screen WARNS before such a save and CONFIRMS after
 *     one, because the alternative — a record that says a person agreed to
 *     terms they never saw — is the single worst thing this feature could do.
 *     Coding and private notes are exempt (the contractor never agreed to
 *     which budget line pays them).
 *  3. THE TAX FORM STAYS SHUT. Metadata only; opening is a separate, logged
 *     press. See `TaxDocumentCard`.
 *  4. EVERY AFFORDANCE IS GATED ON THE SERVER'S OWN FLAGS — `canCompose`,
 *     `canApprove`, `canViewTaxDoc` come back from `get`. Nothing here
 *     re-derives a rank, and no control is rendered that the caller would be
 *     refused for pressing.
 */
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CONTRACTOR_PAYMENT_ORIGIN_LABELS,
  CONTRACTOR_PAYMENT_STATUS_LABELS,
  formatCents,
} from "@events-os/shared";
import {
  BackLink,
  Badge,
  Button,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  ToastView,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { formatDate, formatDateTime } from "../../../../lib/format";
import { confirmAction } from "../../../../lib/confirmAction";
import { useActionRunner } from "../../../../lib/useActionToast";
import { useContractLink } from "../../../../lib/contractLink";
import { FinanceBoundary } from "../../../../components/finance/dashboard/parts";
import {
  AgreementFields,
  decodeForValue,
  draftAmountCents,
  draftFromPayment,
  draftProblems,
  type AgreementDraft,
  type ForOptions,
} from "../../../../components/finance/payments/AgreementFields";
import { ContractLinkCard } from "../../../../components/finance/payments/ContractLinkCard";
import { LedgerPreviewCard } from "../../../../components/finance/payments/LedgerPreviewCard";
import { ReviewPanel } from "../../../../components/finance/payments/ReviewPanel";
import { TaxDocumentCard } from "../../../../components/finance/payments/TaxDocumentCard";
import {
  ORIGIN_BADGE,
  STATUS_BADGE,
  canCancel,
  canEditTerms,
  canPayOut,
  canSendLink,
  isTerminal,
  isWithContractor,
  needsReview,
  type ContractorPaymentDetail,
} from "../../../../components/finance/payments/helpers";

function PaymentDetail({ id }: { id: Id<"contractorPayments"> }) {
  const payment = useQuery(api.contractorPayments.get, {
    contractorPaymentId: id,
  });
  const options = useQuery(api.reimbursements.newRequestOptions, {});
  const categories = useQuery(api.finances.myChargeCategories, {});

  const send = useMutation(api.contractorPayments.send);
  const updateTerms = useMutation(api.contractorPayments.updateTerms);
  const cancel = useMutation(api.contractorPayments.cancel);
  const viewTaxDocument = useMutation(api.contractorPayments.viewTaxDocument);
  const markPaidManually = useMutation(
    api.contractorPayouts.markPaidManually,
  );
  const payContractor = useAction(api.contractorPayouts.payContractorPayment);
  const { run, toast, dismiss } = useActionRunner();

  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgreementDraft | null>(null);
  const [editProblem, setEditProblem] = useState<string | null>(null);
  /** Set after a save that voided an acceptance — confirmed in words, because
   *  the consequence (they have to sign again) happens off-screen. */
  const [voidedNotice, setVoidedNotice] = useState(false);

  const link = useContractLink(payment?.token ?? null);

  if (payment === undefined) return <Screen loading />;

  const status = STATUS_BADGE[payment.status];
  const origin = ORIGIN_BADGE[payment.origin];
  const terminal = isTerminal(payment.status);

  function startEditing(p: ContractorPaymentDetail) {
    setDraft(draftFromPayment(p));
    setEditProblem(null);
    setVoidedNotice(false);
    setEditing(true);
  }

  async function saveTerms(p: ContractorPaymentDetail) {
    if (!draft) return;
    const problems = draftProblems(draft);
    if (problems.length > 0) {
      setEditProblem(problems[0]);
      return;
    }
    const cents = draftAmountCents(draft);
    if (cents == null) {
      setEditProblem("Enter an amount.");
      return;
    }
    const ids = decodeForValue(draft.forValue);
    const clearing = draft.forValue === "";
    setBusy("edit");
    const result = await run(
      () =>
        updateTerms({
          contractorPaymentId: p._id,
          payeeName: draft.payeeName.trim(),
          payeeEmail: draft.payeeEmail.trim(),
          serviceDescription: draft.serviceDescription.trim(),
          ...(draft.serviceDate != null
            ? { serviceDate: draft.serviceDate }
            : {}),
          agreedAmountCents: cents,
          agreementNotes: draft.agreementNotes.trim(),
          // An absent key means "unchanged", so saying "none" has to be said
          // explicitly — that's what `clearAttribution` is for.
          ...(clearing ? { clearAttribution: true } : ids),
          ...(draft.categoryId
            ? { categoryId: draft.categoryId as Id<"budgetCategories"> }
            : {}),
        }),
      { errorTitle: "Couldn't save the terms" },
    );
    setBusy(null);
    if (result === undefined) return;
    setEditing(false);
    setDraft(null);
    setVoidedNotice(result.acceptanceVoided);
  }

  /** Warn BEFORE the save when the edit would void a signature — the founder
   *  should never learn about that from the confirmation. */
  function attemptSave(p: ContractorPaymentDetail) {
    const termsMoved =
      draft != null &&
      (draft.serviceDescription.trim() !== p.serviceDescription ||
        (draftAmountCents(draft) ?? -1) !== p.agreedAmountCents ||
        (draft.serviceDate ?? undefined) !== p.serviceDate);
    if (p.acceptedAt != null && termsMoved) {
      confirmAction({
        title: "This voids their acceptance",
        message:
          "They've already signed these terms. Saving a different amount, service or date cancels that signature and asks them to sign again — the payment goes back to waiting on them.",
        confirmLabel: "Save and re-ask",
        destructive: true,
        onConfirm: () => void saveTerms(p),
      });
      return;
    }
    void saveTerms(p);
  }

  function handleSend(p: ContractorPaymentDetail) {
    setBusy("send");
    void run(() => send({ contractorPaymentId: p._id }), {
      errorTitle: "Couldn't send it",
    }).then(() => setBusy(null));
  }

  function handleOpenTaxDoc(p: ContractorPaymentDetail) {
    setBusy("taxdoc");
    void run(() => viewTaxDocument({ contractorPaymentId: p._id }), {
      errorTitle: "Couldn't open the document",
    }).then((res) => {
      setBusy(null);
      if (res?.url) void Linking.openURL(res.url);
    });
  }

  function handlePay(p: ContractorPaymentDetail) {
    setBusy("pay");
    void run(() => payContractor({ contractorPaymentId: p._id }), {
      errorTitle: "Couldn't start the ACH payout",
    }).then(() => setBusy(null));
  }

  function handleMarkPaid(p: ContractorPaymentDetail) {
    confirmAction({
      title: "Mark this paid?",
      message:
        "Only do this once the transfer has actually left the chapter's account — it posts the payment to the ledger as paid.",
      confirmLabel: "Mark paid",
      onConfirm: () => {
        setBusy("markpaid");
        void run(() => markPaidManually({ contractorPaymentId: p._id }), {
          errorTitle: "Couldn't mark it paid",
        }).then(() => setBusy(null));
      },
    });
  }

  function handleCancel(p: ContractorPaymentDetail) {
    confirmAction({
      title: "Cancel this payment?",
      message:
        "The contractor's link stops working and nothing will be paid. This can't be undone.",
      confirmLabel: "Cancel it",
      destructive: true,
      onConfirm: () => {
        setBusy("cancel");
        void run(() => cancel({ contractorPaymentId: p._id }), {
          errorTitle: "Couldn't cancel it",
        }).then(() => setBusy(null));
      },
    });
  }

  return (
    <>
      <Screen maxWidth={860}>
        <Narrow width={860}>
          <BackLink fallback="/finances/payments" label="Payments" />

          {/* ── Who, what, how much, where it is ─────────────────────────── */}
          <View className="mb-1 flex-row flex-wrap items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="font-display text-2xl text-ink">
                {payment.payeeName}
              </Text>
              {payment.payeeBusinessName ? (
                <Text className="text-sm text-muted">
                  {payment.payeeBusinessName}
                </Text>
              ) : null}
              <Text className="mt-0.5 text-xs text-faint">
                {payment.reference} · created {formatDate(payment.createdAt)}
              </Text>
            </View>
            <View className="items-end gap-1.5">
              <Text
                className="font-display text-2xl text-ink"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatCents(payment.approvedCents ?? payment.agreedAmountCents)}
              </Text>
              <Badge
                label={CONTRACTOR_PAYMENT_STATUS_LABELS[payment.status]}
                tone={status.tone}
                icon={status.icon}
              />
              <Badge
                label={CONTRACTOR_PAYMENT_ORIGIN_LABELS[payment.origin]}
                tone={origin.tone}
                icon={origin.icon}
              />
            </View>
          </View>
          {payment.approvedCents != null &&
          payment.approvedCents !== payment.agreedAmountCents ? (
            <Text className="mb-3 text-xs text-warn">
              Approved at {formatCents(payment.approvedCents)} — less than the
              agreed {formatCents(payment.agreedAmountCents)}.
            </Text>
          ) : null}

          {/* ── The reviewer's turn ──────────────────────────────────────── */}
          {payment.canApprove && needsReview(payment.status) ? (
            <ReviewPanel
              payment={payment}
              forOptions={options?.forOptions as ForOptions | undefined}
            />
          ) : null}

          {/* ── The contractor's turn: the link ──────────────────────────── */}
          {payment.canCompose && !terminal ? (
            <ContractLinkCard
              link={link}
              unsent={payment.status === "draft"}
              onSend={
                canSendLink(payment.status)
                  ? () => handleSend(payment)
                  : undefined
              }
              sending={busy === "send"}
            />
          ) : null}

          {/* ── Where it stands, in words ────────────────────────────────── */}
          <StatusNote payment={payment} />
          {voidedNotice ? (
            <View className="mb-3 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2.5">
              <Icon name="alert-triangle" size={14} color={colors.warn} />
              <Text className="flex-1 text-xs text-warn">
                Saved — and their acceptance was voided. They&apos;ve been asked
                to read and sign the new terms; the payment is back with them.
              </Text>
            </View>
          ) : null}

          {/* ── The terms ────────────────────────────────────────────────── */}
          <SectionHeader
            title="The agreement"
            right={
              payment.canCompose && canEditTerms(payment.status) && !editing ? (
                <Button
                  title="Edit terms"
                  variant="secondary"
                  size="sm"
                  icon="edit-2"
                  onPress={() => startEditing(payment)}
                />
              ) : undefined
            }
          />

          {editing && draft ? (
            <View className="rounded-lg border border-border bg-raised px-4 py-4">
              <AgreementFields
                value={draft}
                onChange={(p) => {
                  setDraft((d) => (d ? { ...d, ...p } : d));
                  setEditProblem(null);
                }}
                forOptions={options?.forOptions as ForOptions | undefined}
                categories={categories}
                mode="edit"
                accepted={payment.acceptedAt != null}
              />
              <LedgerPreviewCard
                serviceDescription={draft.serviceDescription}
                amountCents={draftAmountCents(draft) ?? 0}
                serviceDate={draft.serviceDate}
              />
              {editProblem ? (
                <View className="mb-3 rounded-md bg-danger-bg px-3 py-2.5">
                  <Text className="text-xs text-danger">{editProblem}</Text>
                </View>
              ) : null}
              <View className="flex-row flex-wrap justify-end gap-2">
                <Button
                  title="Discard changes"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    setEditing(false);
                    setDraft(null);
                    setEditProblem(null);
                  }}
                />
                <Button
                  title="Save terms"
                  icon="check"
                  size="sm"
                  loading={busy === "edit"}
                  onPress={() => attemptSave(payment)}
                />
              </View>
            </View>
          ) : (
            <TermsCard payment={payment} forOptions={options?.forOptions} />
          )}

          {/* ── Their tax form ───────────────────────────────────────────── */}
          <SectionHeader title="Tax form" />
          <TaxDocumentCard
            taxDocument={payment.taxDocument}
            canViewTaxDoc={payment.canViewTaxDoc}
            onOpen={() => handleOpenTaxDoc(payment)}
            opening={busy === "taxdoc"}
          />

          {/* ── The money rail ───────────────────────────────────────────── */}
          <SectionHeader title="Payment" />
          <View className="rounded-lg border border-border bg-raised px-4 py-3">
            <DetailRow
              label="Bank destination"
              value={
                payment.hasBankDestination
                  ? `Linked${payment.bankAccountLast4 ? ` · ····${payment.bankAccountLast4}` : ""}`
                  : "Not linked yet — they add it from their link"
              }
            />
            {payment.payout ? (
              <DetailRow
                label="Payout"
                value={`${payment.payout.provider} · ${payment.payout.status}${
                  payment.payout.failureReason
                    ? ` — ${payment.payout.failureReason}`
                    : ""
                }`}
              />
            ) : null}
            {payment.paidAt != null ? (
              <DetailRow label="Paid" value={formatDateTime(payment.paidAt)} />
            ) : null}

            {payment.canApprove && canPayOut(payment.status) ? (
              <View className="mt-3 flex-row flex-wrap gap-2">
                <Button
                  title="Pay by ACH"
                  icon="send"
                  size="sm"
                  loading={busy === "pay"}
                  onPress={() => handlePay(payment)}
                />
                <Button
                  title="Mark paid"
                  variant="secondary"
                  size="sm"
                  icon="check"
                  loading={busy === "markpaid"}
                  onPress={() => handleMarkPaid(payment)}
                />
              </View>
            ) : null}
          </View>

          {/* ── Withdrawing it ───────────────────────────────────────────── */}
          {payment.canApprove && canCancel(payment.status) ? (
            <View className="mt-6 items-start">
              <Button
                title="Cancel this payment"
                variant="ghost"
                size="sm"
                icon="slash"
                loading={busy === "cancel"}
                onPress={() => handleCancel(payment)}
              />
            </View>
          ) : null}
        </Narrow>
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

/** Where it stands, said plainly — the sentence a badge can't carry. */
function StatusNote({ payment }: { payment: ContractorPaymentDetail }) {
  if (payment.status === "changes_requested" && payment.reviewNote) {
    return (
      <View className="mb-3 rounded-md border border-border bg-sunken px-3 py-2.5">
        <Text className="text-xs font-semibold text-ink">
          Sent back for a fix — waiting on them
        </Text>
        <Text className="mt-1 text-xs italic text-muted">
          “{payment.reviewNote}”
        </Text>
      </View>
    );
  }
  if (payment.status === "rejected" && payment.rejectedReason) {
    return (
      <View className="mb-3 rounded-md bg-danger-bg px-3 py-2.5">
        <Text className="text-xs font-semibold text-danger">Rejected</Text>
        <Text className="mt-1 text-xs text-danger">
          {payment.rejectedReason}
        </Text>
      </View>
    );
  }
  if (payment.acceptedAt != null) {
    const stale =
      payment.acceptedTermsVersion !== payment.agreementTermsVersion;
    return (
      <View className="mb-3 flex-row items-start gap-2 rounded-md bg-success-bg px-3 py-2.5">
        <Icon name="check" size={14} color={colors.success} />
        <Text className="flex-1 text-xs text-success">
          Accepted {formatDateTime(payment.acceptedAt)}
          {payment.acceptedSignature ? ` — signed “${payment.acceptedSignature}”` : ""}
          {stale
            ? ". The terms have changed since; they need to sign again."
            : "."}
        </Text>
      </View>
    );
  }
  if (isWithContractor(payment.status)) {
    return (
      <View className="mb-3 flex-row items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2.5">
        <Icon name="clock" size={14} color={colors.muted} />
        <Text className="flex-1 text-xs text-muted">
          Waiting on them to read the terms, sign, and file their tax form.
        </Text>
      </View>
    );
  }
  return null;
}

/** The read-only terms, including what the coding says this money is for. */
function TermsCard({
  payment,
  forOptions,
}: {
  payment: ContractorPaymentDetail;
  forOptions: ForOptions | undefined;
}) {
  const forLabel = attributionLabel(payment, forOptions);
  return (
    <View className="rounded-lg border border-border bg-raised px-4 py-3">
      <DetailRow label="The work" value={payment.serviceDescription} />
      <DetailRow
        label="Service date"
        value={
          payment.serviceDate != null
            ? formatDate(payment.serviceDate)
            : "Not set"
        }
      />
      <DetailRow
        label="Agreed amount"
        value={formatCents(payment.agreedAmountCents)}
      />
      <DetailRow
        label="What it's for"
        value={forLabel ?? "Not coded yet — it can't be approved until it is"}
        tone={payment.isCoded ? "default" : "warn"}
      />
      {payment.agreementNotes ? (
        <DetailRow
          label="Notes (private)"
          value={payment.agreementNotes}
        />
      ) : null}
      <DetailRow
        label="Terms version"
        value={`v${payment.agreementTermsVersion}`}
      />
    </View>
  );
}

/** The human name of whatever this payment is attributed to, resolved from the
 *  same picker options the editor uses. Falls back to a bare "coded" when the
 *  option list hasn't loaded (or the target isn't in it) so the row never
 *  claims something is uncoded when it isn't. */
function attributionLabel(
  payment: ContractorPaymentDetail,
  forOptions: ForOptions | undefined,
): string | null {
  if (payment.eventId) {
    const hit = forOptions?.events.find((e) => e.id === payment.eventId);
    return hit ? `Event · ${hit.label}` : "An event";
  }
  if (payment.projectId) {
    const hit = forOptions?.projects.find((p) => p.id === payment.projectId);
    return hit ? `Project · ${hit.label}` : "A project";
  }
  if (payment.budgetId) {
    const hit = forOptions?.budgets.find((b) => b.id === payment.budgetId);
    return hit ? `Budget · ${hit.label}` : "A budget";
  }
  return null;
}

function DetailRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  return (
    <View className="flex-row flex-wrap items-start gap-2 border-b border-border py-2">
      <Text className="w-32 text-xs font-semibold text-muted">{label}</Text>
      <Text
        className={`flex-1 text-sm ${tone === "warn" ? "text-warn" : "text-ink"}`}
      >
        {value}
      </Text>
    </View>
  );
}

export default function PaymentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) {
    return (
      <Screen maxWidth={860}>
        <Narrow width={860}>
          <BackLink fallback="/finances/payments" label="Payments" />
          <EmptyState
            icon="alert-triangle"
            title="No payment named"
            message="That link is missing the payment id."
          />
        </Narrow>
      </Screen>
    );
  }
  return (
    <FinanceBoundary
      fallback={
        <EmptyState
          icon="lock"
          title="Finance access needed"
          message="Ask a finance manager to grant you access to contractor payments."
        />
      }
    >
      <PaymentDetail id={id as Id<"contractorPayments">} />
    </FinanceBoundary>
  );
}
