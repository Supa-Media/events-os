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
 *
 * "IT'S THIS PERSON AGAIN" sits above everything (`ContractorPicker`). Picking
 * a returning contractor fills WHO THEY ARE — name, email, phone — and attaches
 * `personId` so the agreement lands on their existing profile, which is what
 * lets the server reuse the tax form and bank details they already filed. It
 * fills NOTHING ELSE, and that restraint is the feature rather than a
 * limitation: the amount, the service description and the service date are this
 * job's terms. A pre-filled amount is an amount nobody decided, and a
 * pre-filled description is a sentence that publishes verbatim and permanently
 * without anyone having written it for this piece of work. Their usual rate is
 * offered as a hint somebody has to press.
 */
import { useEffect, useRef, useState } from "react";
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
import {
  ScheduleBuilder,
  scheduleProblem,
  toInstallmentArgs,
  type InstallmentDraft,
} from "../../../../components/finance/payments/ScheduleBuilder";
import { ContractLinkCard } from "../../../../components/finance/payments/ContractLinkCard";
import { ContractorPicker } from "../../../../components/finance/payments/ContractorPicker";
import { contractorIdentityPatch } from "../../../../components/finance/payments/contractorHelpers";
import { LedgerPreviewCard } from "../../../../components/finance/payments/LedgerPreviewCard";
import { financeScopeOf } from "../../../../components/finance/payments/helpers";
import { useChapterContext } from "../../../../lib/ChapterContext";

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
  // WHOSE BOOKS this agreement will be paid from — the active desk's. Composing
  // at the Central desk now produces a CENTRAL agreement (central reviewers,
  // central's bank account, `/contract/central`) instead of quietly filing it
  // under the composer's home chapter. Declared before the queries below
  // because they read it.
  const { context } = useChapterContext();
  const scope = financeScopeOf(context);

  const options = useQuery(api.reimbursements.newRequestOptions, {});
  // The "For" list for THIS scope — central's own budgets at a central desk,
  // and at a chapter desk only the events/projects that chapter's budgets
  // actually fund. `newRequestOptions` above still supplies the funds and the
  // coding policy, which are the same question at either scope.
  const scopedFor = useQuery(
    api.contractorPayments.codingOptionsForScope,
    scope ? { scope } : "skip",
  );
  const categories = useQuery(api.finances.myChargeCategories, {});

  const createAgreement = useMutation(api.contractorPayments.createAgreement);
  const setSchedule = useMutation(api.contractorInstallments.setSchedule);
  const send = useMutation(api.contractorPayments.send);
  const { run, toast, dismiss } = useActionRunner();

  const [draft, setDraft] = useState<AgreementDraft>(emptyDraft());
  const [scheduleDraft, setScheduleDraft] = useState<InstallmentDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  /** The returning contractor this agreement is FOR, when one was picked. It
   *  lives here rather than in the draft because it is not a term — it is the
   *  identity the server hangs the reusable tax form and bank details off. */
  const [personId, setPersonId] = useState<Id<"people"> | null>(null);

  // The roster read is the composer's only new gate, and it is asked ONLY once
  // the server has said this caller may compose. Both powers are the finance
  // manager rung today, so the two answers agree — but skipping until we know
  // means a caller who may not compose never provokes a refusal the
  // `FinanceBoundary` would render over the whole screen.
  const roster = useQuery(
    api.contractorProfiles.list,
    access?.canCompose === true ? { limit: 200 } : "skip",
  );
  const onFile = useQuery(
    api.contractorProfiles.onFileFor,
    personId ? { personId } : "skip",
  );

  /** Which person the identity fields have already been filled from. Guards the
   *  effect below against re-writing a field a staffer has since corrected —
   *  the pick is a one-time fill, not a binding. */
  const filledFor = useRef<string | null>(null);

  // `onFileFor` is the only read that carries the phone (the roster rows don't),
  // so the fill completes when it lands. IDENTITY ONLY: `contractorIdentityPatch`
  // returns three keys and its unit test asserts it can never return a fourth.
  useEffect(() => {
    if (onFile == null || personId == null) return;
    if (filledFor.current === String(onFile.personId)) return;
    filledFor.current = String(onFile.personId);
    setDraft((d) => ({ ...d, ...contractorIdentityPatch(onFile) }));
  }, [onFile, personId]);

  const link = useContractLink(created?.token ?? null);
  const amountCents = draftAmountCents(draft) ?? 0;

  function patch(next: Partial<AgreementDraft>) {
    setDraft((d) => ({ ...d, ...next }));
    setProblem(null);
  }

  /** Start over — used by "Write another" and by dropping a picked contractor,
   *  so the two can't drift into leaving half a person behind. */
  function resetForm() {
    setDraft(emptyDraft());
    setPersonId(null);
    filledFor.current = null;
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
    const schedProblem = scheduleProblem(scheduleDraft, cents);
    if (schedProblem) {
      setProblem(schedProblem);
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
          // Only sent when a roster pick actually happened. Typing a returning
          // contractor's name by hand deliberately does NOT attach their
          // profile — a name match is not identity, and quietly filing a
          // payment under the wrong person is exactly what the backend's
          // "never auto-merge on a weak signal" rule refuses to do.
          ...(personId ? { personId } : {}),
          serviceDescription: draft.serviceDescription.trim(),
          ...(draft.serviceDate != null
            ? { serviceDate: draft.serviceDate }
            : {}),
          agreedAmountCents: cents,
          ...(scope ? { scope } : {}),
          ...(draft.additionalTerms.trim()
            ? { additionalTerms: draft.additionalTerms.trim() }
            : {}),
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

    // BEFORE the link goes out, always: the schedule is a term, and a
    // contractor who opens their agreement should read the plan they are being
    // asked to accept rather than discover it after signing. A failure here
    // leaves a correct DRAFT with no schedule, which the detail screen can fix
    // — the same "the record already exists" reasoning as the send step below.
    if (scheduleDraft.length > 0) {
      const scheduled = await run(
        () =>
          setSchedule({
            contractorPaymentId: result.contractorPaymentId,
            installments: toInstallmentArgs(scheduleDraft),
          }),
        { errorTitle: "Created it, but couldn't save the payment schedule" },
      );
      if (scheduled === undefined) {
        setBusy(null);
        setCreated({
          contractorPaymentId: result.contractorPaymentId,
          token: result.token,
          sent: false,
        });
        return;
      }
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
                  resetForm();
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

          <ContractorPicker
            contractors={roster?.contractors}
            onFile={onFile}
            picked={personId != null}
            onPick={(row) => {
              setPersonId(row.personId);
              filledFor.current = null;
              // Fill what the roster row already carries so the fields don't
              // sit empty for a frame; the phone arrives with `onFileFor` and
              // the effect above completes the patch. Identity only, both
              // times — see this screen's doc and `contractorIdentityPatch`.
              patch(
                contractorIdentityPatch({
                  name: row.name,
                  email: row.email,
                  phone: undefined,
                }),
              );
            }}
            onClear={() => {
              setPersonId(null);
              filledFor.current = null;
              patch({ payeeName: "", payeeEmail: "", payeePhone: "" });
            }}
            onUseUsualRate={(amountText) => patch({ amountText })}
          />

          {/* Say whose money this is BEFORE they write the terms — the
              composer is where the wrong answer used to be baked in. */}
          {scope ? (
            <View className="mb-4 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2.5">
              <Icon
                name={scope === "central" ? "globe" : "map-pin"}
                size={14}
                color={colors.muted}
              />
              <Text className="flex-1 text-xs text-muted">
                {scope === "central"
                  ? "This will be paid from the org's central books and central's bank account — not a chapter's. Switch desks to compose a chapter agreement."
                  : "This will be paid from this chapter's books and its bank account. Work funded by a central budget has to be composed at the Central desk."}
              </Text>
            </View>
          ) : null}

          <AgreementFields
            value={draft}
            onChange={patch}
            forOptions={scopedFor ?? options?.forOptions}
            categories={categories}
            mode="create"
          />

          <Text className="mb-1.5 mt-2 text-sm font-semibold text-ink">
            How they get paid
          </Text>
          <ScheduleBuilder
            rows={scheduleDraft}
            onChange={(rows) => {
              setScheduleDraft(rows);
              setProblem(null);
            }}
            agreedAmountCents={amountCents > 0 ? amountCents : null}
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
