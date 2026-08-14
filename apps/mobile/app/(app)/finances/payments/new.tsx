/**
 * FINANCES · PAYMENTS · NEW — pre-fill a contractor agreement and get the link.
 *
 * The founder's primary flow, in her words: "if I pre-do something, I'm able to
 * copy the link and send it to the contractor." So this screen writes
 * everything the ORG knows — who, what work, when, how much, which budget —
 * and leaves the contractor's side down to identity, tax form, and where the
 * money goes. Those terms are then FROZEN to them: the public page renders them
 * read-only and the server ignores those keys on submit.
 *
 * Two buttons, because writing terms and committing them to a stranger are two
 * different acts with two different moments to change your mind:
 *   · "Save as draft" — `createAgreement` only. Nothing has been promised, the
 *     link exists but nobody has it.
 *   · "Create & send link" — `createAgreement` then `send`. Emails them when we
 *     have an address, and either way hands the link straight back here, which
 *     is what the whole screen is for.
 *
 * On success the form is REPLACED by the link, not merely followed by a toast:
 * the next thing this person does is paste that URL into a text message, and
 * making them hunt for it on another screen is how a two-tap flow becomes a
 * five-tap one.
 *
 * The live ledger preview (`LedgerPreviewCard`) sits under the description
 * because the description publishes verbatim and permanently — see that
 * component's doc.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BackLink,
  Button,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  ToastView,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { useActionRunner } from "../../../../lib/useActionToast";
import { useContractLink } from "../../../../lib/contractLink";
import { FinanceBoundary } from "../../../../components/finance/dashboard/parts";
import {
  AgreementFields,
  decodeForValue,
  draftAmountCents,
  draftProblems,
  emptyDraft,
  type AgreementDraft,
} from "../../../../components/finance/payments/AgreementFields";
import { ContractLinkCard } from "../../../../components/finance/payments/ContractLinkCard";
import { LedgerPreviewCard } from "../../../../components/finance/payments/LedgerPreviewCard";

/** What the screen shows once the record exists. */
type Created = {
  contractorPaymentId: Id<"contractorPayments">;
  token: string;
  sent: boolean;
};

function NewAgreementScreen() {
  const router = useRouter();
  // `list` is also how this screen learns whether the caller may compose at
  // all — the same server-returned flag the queue gates its own button on,
  // rather than a rank re-derived here. One row is enough to ask the question.
  const access = useQuery(api.contractorPayments.list, { limit: 1 });
  const options = useQuery(api.reimbursements.newRequestOptions, {});
  const categories = useQuery(api.finances.myChargeCategories, {});

  const createAgreement = useMutation(api.contractorPayments.createAgreement);
  const send = useMutation(api.contractorPayments.send);
  const { run, toast, dismiss } = useActionRunner();

  const [draft, setDraft] = useState<AgreementDraft>(emptyDraft());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const link = useContractLink(created?.token ?? null);
  const amountCents = draftAmountCents(draft) ?? 0;

  function patch(next: Partial<AgreementDraft>) {
    setDraft((d) => ({ ...d, ...next }));
    setProblem(null);
  }

  async function submit(alsoSend: boolean) {
    const problems = draftProblems(draft);
    if (problems.length > 0) {
      setProblem(problems[0]);
      return;
    }
    const cents = draftAmountCents(draft);
    if (cents == null) {
      setProblem("Enter an amount.");
      return;
    }
    const ids = decodeForValue(draft.forValue);
    setBusy(alsoSend ? "send" : "draft");

    const result = await run(
      () =>
        createAgreement({
          payeeName: draft.payeeName.trim(),
          ...(draft.payeeEmail.trim()
            ? { payeeEmail: draft.payeeEmail.trim() }
            : {}),
          ...(draft.payeePhone.trim()
            ? { payeePhone: draft.payeePhone.trim() }
            : {}),
          serviceDescription: draft.serviceDescription.trim(),
          ...(draft.serviceDate != null
            ? { serviceDate: draft.serviceDate }
            : {}),
          agreedAmountCents: cents,
          ...(draft.agreementNotes.trim()
            ? { agreementNotes: draft.agreementNotes.trim() }
            : {}),
          ...ids,
          ...(draft.categoryId
            ? { categoryId: draft.categoryId as Id<"budgetCategories"> }
            : {}),
        }),
      { errorTitle: "Couldn't create the agreement" },
    );
    if (result === undefined) {
      setBusy(null);
      return;
    }

    if (!alsoSend) {
      setBusy(null);
      setCreated({
        contractorPaymentId: result.contractorPaymentId,
        token: result.token,
        sent: false,
      });
      return;
    }

    // The record already exists by the time we get here: a failed `send` means
    // a DRAFT that needs sending, never a lost agreement, so the screen still
    // hands over the link and says which state it's in.
    const sendResult = await run(
      () => send({ contractorPaymentId: result.contractorPaymentId }),
      { errorTitle: "Created it, but couldn't mark it sent" },
    );
    setBusy(null);
    setCreated({
      contractorPaymentId: result.contractorPaymentId,
      token: sendResult?.token ?? result.token,
      sent: sendResult !== undefined,
    });
  }

  if (access === undefined) return <Screen loading />;

  if (!access.canCompose) {
    return (
      <Screen maxWidth={720}>
        <Narrow width={720}>
          <BackLink fallback="/finances/payments" label="Payments" />
          <EmptyState
            icon="lock"
            title="You can't write agreements"
            message="Composing a contractor agreement commits the chapter to paying someone a specific amount, so it needs a finance manager. Ask one to send it, or file a request instead."
          />
        </Narrow>
      </Screen>
    );
  }

  // ── Done: the link, and nothing competing with it ──────────────────────────
  if (created) {
    return (
      <>
        <Screen maxWidth={720}>
          <Narrow width={720}>
            <BackLink fallback="/finances/payments" label="Payments" />
            <View className="mb-3 flex-row items-center gap-2">
              <Icon name="check-circle" size={20} color={colors.success} />
              <Text className="font-display text-2xl text-ink">
                {created.sent ? "Sent" : "Saved as a draft"}
              </Text>
            </View>
            <Text className="mb-4 text-sm text-muted">
              {created.sent
                ? "They'll get an email if you gave an address — but the fastest thing you can do is send them this link yourself."
                : "Nothing has been promised to anyone yet. Send it when you're ready, or copy the link and send it your own way."}
            </Text>

            <ContractLinkCard
              link={link}
              unsent={!created.sent}
              title={created.sent ? "Their link" : "Their link (not sent yet)"}
              onSend={
                created.sent
                  ? undefined
                  : () => {
                      setBusy("send");
                      void run(
                        () =>
                          send({
                            contractorPaymentId: created.contractorPaymentId,
                          }),
                        { errorTitle: "Couldn't send it" },
                      ).then((res) => {
                        setBusy(null);
                        if (res !== undefined) {
                          setCreated({ ...created, sent: true });
                        }
                      });
                    }
              }
              sending={busy === "send"}
            />

            <View className="flex-row flex-wrap gap-2">
              <Button
                title="Open the payment"
                icon="arrow-right"
                onPress={() =>
                  router.replace(
                    `/finances/payments/${created.contractorPaymentId}` as never,
                  )
                }
              />
              <Button
                title="Write another"
                variant="secondary"
                icon="plus"
                onPress={() => {
                  setDraft(emptyDraft());
                  setCreated(null);
                }}
              />
            </View>
          </Narrow>
        </Screen>
        <ToastView toast={toast} onDismiss={dismiss} />
      </>
    );
  }

  // ── The composer ───────────────────────────────────────────────────────────
  return (
    <>
      <Screen maxWidth={720}>
        <Narrow width={720}>
          <BackLink fallback="/finances/payments" label="Payments" />
          <Text className="mb-1 font-display text-2xl text-ink">
            New contractor agreement
          </Text>
          <Text className="mb-5 text-sm text-muted">
            Write the terms, send them the link. They read what you agreed, sign
            it, upload their W-9 and add their bank details — they can&apos;t
            change any of this.
          </Text>

          <AgreementFields
            value={draft}
            onChange={patch}
            forOptions={options?.forOptions}
            categories={categories}
            mode="create"
          />

          <LedgerPreviewCard
            serviceDescription={draft.serviceDescription}
            amountCents={amountCents}
            serviceDate={draft.serviceDate}
          />

          {problem ? (
            <View className="mb-3 rounded-md bg-danger-bg px-3 py-2.5">
              <Text className="text-xs text-danger">{problem}</Text>
            </View>
          ) : null}

          <View className="mt-2 flex-row flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button
              title="Save as draft"
              variant="secondary"
              icon="file-text"
              loading={busy === "draft"}
              disabled={busy !== null}
              onPress={() => void submit(false)}
            />
            <Button
              title="Create & send link"
              icon="send"
              loading={busy === "send"}
              disabled={busy !== null}
              onPress={() => void submit(true)}
            />
          </View>
        </Narrow>
      </Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

export default function NewPaymentScreen() {
  return (
    <FinanceBoundary>
      <NewAgreementScreen />
    </FinanceBoundary>
  );
}
