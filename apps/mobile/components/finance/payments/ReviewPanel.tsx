/**
 * FINANCES · PAYMENTS · The reviewer's three doors — and why a door is shut.
 *
 * Approve · Send back · Reject, exactly the shape the reimbursement queue
 * established (the softer door always next to the harder one, because most
 * review outcomes are "almost — fix this one thing" and a flow whose only
 * send-back is a rejection teaches people that review means losing their
 * money).
 *
 * WHAT THIS FILE IS REALLY FOR: `approve` has three refusals that are not the
 * reviewer's fault and are meaningless as raw errors —
 *
 *   · `NOT_CODED`            — nothing says which budget pays for this. A
 *                              self-serve request ALWAYS arrives this way.
 *   · `FOREIGN_PAYEE_REVIEW` — a W-8 is on file, so withholding may apply and
 *                              this app doesn't compute withholding.
 *   · `SOD_VIOLATION`        — the caller wrote the agreement, or is the payee.
 *
 * Two of the three are visible BEFORE the button is pressed (`isCoded`,
 * `taxDocument.isForeign` both ride on the detail query), so they're shown as
 * standing blockers rather than as a surprise after a press. The third can
 * only be known by asking, so a refusal that comes back from the server is
 * rendered as the same kind of explanation rather than a toast full of
 * shouting-case error codes.
 *
 * And where the fix is "code it", the control to code it is RIGHT HERE
 * (`updateTerms`) — sending someone to another screen to unblock the screen
 * they're on is how a queue stops being worked.
 *
 * The panel owns its own mutations (unlike `reimbursements/RequestCard`, which
 * takes callbacks) precisely because the refusal explanation is intrinsic to
 * the call: the code that names the door is the code that has to explain it.
 */
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { contractorAmountProblems, formatCents } from "@events-os/shared";
import { Button, Icon, Select } from "../../ui";
import { colors } from "../../../lib/theme";
import { errorCode, errorMessage } from "../../../lib/errors";
import { parseDollars } from "../../event/ticketing/helpers";
import {
  buildForOptions,
  decodeForValue,
  type ForOptions,
} from "./AgreementFields";
import { centsToAmountText, type ContractorPaymentDetail } from "./helpers";

type Props = {
  payment: ContractorPaymentDetail;
  forOptions: ForOptions | undefined;
};

type Refusal = { code: string | null; message: string };

/** A refusal in human words: what happened, and what to do next. `codeHere`
 *  marks the one whose fix is a control this panel can render. */
function explainRefusal(refusal: Refusal): {
  title: string;
  body: string;
  codeHere: boolean;
} {
  switch (refusal.code) {
    case "NOT_CODED":
      return {
        title: "Nothing says what this money is for",
        body: "An approval has to be answerable to a budget line. Pick the event, project, or budget this payment belongs to and try again — a request someone filed themselves always arrives uncoded, because their own claim about which budget pays them isn't evidence.",
        codeHere: true,
      };
    case "FOREIGN_PAYEE_REVIEW":
      return {
        title: "This payee isn't a US person",
        body: "They filed a W-8, and foreign payments can carry withholding obligations this app doesn't compute. Handle this one outside the app rather than paying it at 0% — then cancel this record, or leave it for the finance lead.",
        codeHere: false,
      };
    case "SOD_VIOLATION":
      return {
        title: "Someone else has to approve this one",
        body: "You either wrote this agreement or you're the person being paid. One person can't both decide the org owes money and release it — ask another finance manager to review it. (You can still edit the terms or send it back.)",
        codeHere: false,
      };
    case "ILLEGAL_TRANSITION":
      return {
        title: "This has already moved on",
        body: `${refusal.message} Reload the screen to see where it is now.`,
        codeHere: false,
      };
    default:
      return {
        title: "Couldn't approve it",
        body: refusal.message,
        codeHere: false,
      };
  }
}

export function ReviewPanel({ payment, forOptions }: Props) {
  const approve = useMutation(api.contractorPayments.approve);
  const requestChanges = useMutation(api.contractorPayments.requestChanges);
  const reject = useMutation(api.contractorPayments.reject);
  const updateTerms = useMutation(api.contractorPayments.updateTerms);

  const [mode, setMode] = useState<"none" | "sendback" | "reject" | "partial">(
    "none",
  );
  const [note, setNote] = useState("");
  const [partialText, setPartialText] = useState(
    centsToAmountText(payment.agreedAmountCents),
  );
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The inline "code it" control's own picker state.
  const [forValue, setForValue] = useState("");
  const [coding, setCoding] = useState(false);

  const notCoded = !payment.isCoded;
  const foreign = payment.taxDocument?.isForeign === true;

  async function run(
    action: () => Promise<unknown>,
    onDone?: () => void,
  ): Promise<void> {
    setBusy(true);
    setRefusal(null);
    setProblem(null);
    try {
      await action();
      onDone?.();
    } catch (err) {
      setRefusal({ code: errorCode(err), message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function handleApprove(approvedCents?: number) {
    void run(
      () =>
        approve({
          contractorPaymentId: payment._id,
          ...(approvedCents != null ? { approvedCents } : {}),
        }),
      () => setMode("none"),
    );
  }

  function handleApprovePartial() {
    const cents = parseDollars(partialText);
    if (cents == null) {
      setProblem("Enter an amount.");
      return;
    }
    const problems = contractorAmountProblems(cents);
    if (problems.length > 0) {
      setProblem(problems[0]);
      return;
    }
    if (cents > payment.agreedAmountCents) {
      setProblem(
        `You can't approve more than the agreed ${formatCents(payment.agreedAmountCents)} — change the terms instead, which re-asks them to accept.`,
      );
      return;
    }
    handleApprove(cents);
  }

  function handleSendBack() {
    if (note.trim().length < 3) {
      setProblem("Say what needs fixing — the contractor sees this note.");
      return;
    }
    void run(
      () =>
        requestChanges({
          contractorPaymentId: payment._id,
          note: note.trim(),
        }),
      () => {
        setNote("");
        setMode("none");
      },
    );
  }

  function handleReject() {
    if (note.trim().length < 3) {
      setProblem("Say why — this is a person waiting on money.");
      return;
    }
    void run(
      () =>
        reject({ contractorPaymentId: payment._id, reason: note.trim() }),
      () => {
        setNote("");
        setMode("none");
      },
    );
  }

  /** The unblock-it-here control for `NOT_CODED`. Writes through `updateTerms`,
   *  which is why it only appears for a caller who may compose. */
  function handleCodeIt() {
    const ids = decodeForValue(forValue);
    if (!ids.eventId && !ids.projectId && !ids.budgetId) {
      setProblem("Pick what this payment is for.");
      return;
    }
    setCoding(true);
    setProblem(null);
    updateTerms({ contractorPaymentId: payment._id, ...ids })
      .then(() => {
        setRefusal(null);
        setForValue("");
      })
      .catch((err: unknown) => setProblem(errorMessage(err)))
      .finally(() => setCoding(false));
  }

  const explained = refusal ? explainRefusal(refusal) : null;
  const showCodeControl =
    payment.canCompose && (notCoded || explained?.codeHere === true);

  return (
    <View className="mb-4 rounded-lg border border-warn/40 bg-warn-bg px-4 py-3.5">
      <View className="flex-row items-center gap-2">
        <Icon name="clock" size={15} color={colors.warn} />
        <Text className="flex-1 text-sm font-semibold text-ink">
          Waiting on your decision
        </Text>
        <Text
          className="text-sm font-semibold text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(payment.agreedAmountCents)}
        </Text>
      </View>

      {/* ── Standing blockers, shown before anything is pressed ───────────── */}
      {foreign ? (
        <Blocker
          title="Approval is blocked: this payee filed a W-8"
          body="They're not a US person, and foreign payments can carry withholding this app doesn't compute. Handle this one outside the app rather than paying it at 0%."
        />
      ) : null}
      {notCoded ? (
        <Blocker
          title="Not coded yet — approval will refuse"
          body={
            payment.origin === "self_serve"
              ? "This came in as a request, so nobody in the org has said which budget pays for it yet. Pick one below."
              : "Nothing says which event, project, or budget this belongs to. Pick one below."
          }
        />
      ) : null}

      {/* ── A refusal that came back from the server ──────────────────────── */}
      {explained ? (
        <View className="mt-3 rounded-md border border-danger/40 bg-danger-bg px-3 py-2.5">
          <View className="flex-row items-start gap-2">
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <View className="flex-1">
              <Text className="text-xs font-semibold text-danger">
                {explained.title}
              </Text>
              <Text className="mt-1 text-xs text-danger">{explained.body}</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ── Code it, right here ───────────────────────────────────────────── */}
      {showCodeControl ? (
        <View className="mt-3">
          <Select
            label="What is this payment for?"
            value={forValue}
            options={buildForOptions(forOptions)}
            onChange={setForValue}
            placeholder="Pick an event, project, or budget"
            searchable
          />
          <Button
            title="Save the coding"
            icon="check"
            variant="secondary"
            size="sm"
            className="self-start"
            loading={coding}
            onPress={handleCodeIt}
          />
        </View>
      ) : notCoded ? (
        <Text className="mt-2 text-xs text-warn">
          Ask someone who can edit the agreement to say what it&apos;s for —
          you can&apos;t approve it until they have.
        </Text>
      ) : null}

      {/* ── The note composer (send back / reject share it) ───────────────── */}
      {mode === "sendback" || mode === "reject" ? (
        <View className="mt-3">
          <Text className="mb-1.5 text-xs font-semibold text-ink">
            {mode === "sendback"
              ? "What needs fixing? (they'll see this)"
              : "Why are you rejecting it? (they'll see this)"}
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={
              mode === "sendback"
                ? "e.g. Your W-9 is from 2019 — please upload the current one."
                : "e.g. We're not going ahead with this engagement."
            }
            placeholderTextColor={colors.faint}
            multiline
            numberOfLines={3}
            className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-sm text-ink"
          />
        </View>
      ) : null}

      {/* ── Partial approval ─────────────────────────────────────────────── */}
      {mode === "partial" ? (
        <View className="mt-3">
          <Text className="mb-1.5 text-xs font-semibold text-ink">
            Approve a different amount (never more than the agreed{" "}
            {formatCents(payment.agreedAmountCents)})
          </Text>
          <TextInput
            value={partialText}
            onChangeText={setPartialText}
            keyboardType="decimal-pad"
            placeholder="$0.00"
            placeholderTextColor={colors.faint}
            className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-sm text-ink"
          />
        </View>
      ) : null}

      {problem ? (
        <Text className="mt-2 text-xs font-semibold text-danger">{problem}</Text>
      ) : null}

      {/* ── The three doors ──────────────────────────────────────────────── */}
      <View className="mt-3 flex-row flex-wrap items-center gap-2">
        {mode === "none" ? (
          <>
            <Button
              title="Reject"
              icon="x-circle"
              variant="danger"
              size="sm"
              onPress={() => {
                setNote("");
                setProblem(null);
                setMode("reject");
              }}
            />
            <Button
              title="Send back…"
              icon="corner-up-left"
              variant="secondary"
              size="sm"
              onPress={() => {
                setNote("");
                setProblem(null);
                setMode("sendback");
              }}
            />
            <Button
              title="Approve a different amount…"
              icon="edit-2"
              variant="ghost"
              size="sm"
              onPress={() => {
                setProblem(null);
                setMode("partial");
              }}
            />
            <Button
              title={`Approve ${formatCents(payment.agreedAmountCents)}`}
              icon="check"
              size="sm"
              loading={busy}
              disabled={notCoded || foreign}
              onPress={() => handleApprove()}
            />
          </>
        ) : (
          <>
            <Button
              title="Cancel"
              variant="ghost"
              size="sm"
              onPress={() => {
                setMode("none");
                setProblem(null);
              }}
            />
            {mode === "sendback" ? (
              <Button
                title="Send it back"
                icon="corner-up-left"
                variant="secondary"
                size="sm"
                loading={busy}
                onPress={handleSendBack}
              />
            ) : null}
            {mode === "reject" ? (
              <Button
                title="Reject it"
                icon="x-circle"
                variant="danger"
                size="sm"
                loading={busy}
                onPress={handleReject}
              />
            ) : null}
            {mode === "partial" ? (
              <Button
                title="Approve this amount"
                icon="check"
                size="sm"
                loading={busy}
                disabled={notCoded || foreign}
                onPress={handleApprovePartial}
              />
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

/** A standing "this will refuse" notice — the same voice as a refusal, shown
 *  before the press rather than after it. */
function Blocker({ title, body }: { title: string; body: string }) {
  return (
    <View className="mt-3 flex-row items-start gap-2 rounded-md bg-raised px-3 py-2.5">
      <Icon name="alert-triangle" size={14} color={colors.warn} />
      <View className="flex-1">
        <Text className="text-xs font-semibold text-ink">{title}</Text>
        <Text className="mt-1 text-xs text-muted">{body}</Text>
      </View>
    </View>
  );
}
