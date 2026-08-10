/**
 * ReceiptExceptionSection — the documentation-of-record panel on a
 * transaction: what stands in for a receipt, who put their name on it, and
 * who decided.
 *
 * Shows the FULL history, rejections and withdrawals included. That's
 * deliberate: "what was claimed, and who decided" is the audit story a
 * published ledger has to be able to answer, and a UI that only renders the
 * winning row can't tell it.
 *
 * Three affordances, each gated server-side by its own resolver
 * (`lib/receiptExceptionAccess.ts`) — this component only decides what to
 * SHOW, never what's allowed:
 *  - file (anyone who may attest — the cardholder on their own charge),
 *  - approve / reject (a Finance manager, and at or above the org threshold
 *    never the person who filed it),
 *  - withdraw (the filer, when the receipt turns up after all).
 *
 * Hidden entirely once a receipt is attached: a receipt outranks an exception
 * (`documentationState`), and the link path retires any approved one, so
 * offering to file another would be offering a no-op.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import {
  formatCents,
  type ExceptionAttestation,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  FileThumbnail,
  FileViewer,
  Icon,
  TextField,
  type BadgeTone,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { ReceiptExceptionModal } from "../modals/ReceiptExceptionModal";

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warn",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral",
};

function when(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

export function ReceiptExceptionSection({
  transactionId,
  amountCents,
  hasReceipt,
  readOnly,
  onError,
}: {
  transactionId: Id<"transactions">;
  amountCents: number;
  /** A receipt outranks an exception — the whole section goes away. */
  hasReceipt: boolean;
  /** Peek / below-bookkeeper: history stays visible, actions don't. */
  readOnly: boolean;
  onError: (err: unknown) => void;
}) {
  const rows = useQuery(
    api.receiptExceptions.listForTransaction,
    hasReceipt ? "skip" : { transactionId },
  );
  const attest = useMutation(api.receiptExceptions.attest);
  const approve = useMutation(api.receiptExceptions.approve);
  const reject = useMutation(api.receiptExceptions.reject);
  const withdraw = useMutation(api.receiptExceptions.withdraw);

  const [filing, setFiling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejectingId, setRejectingId] =
    useState<Id<"receiptExceptions"> | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  // The evidence file currently open full-size. The viewer shows ONE file, so
  // this holds that file rather than a list + index. It carries the CONTENT
  // TYPE now: the kind used to be sniffed from the url, which never worked
  // (see the `evidence` field's doc in `receiptExceptions.ts`).
  const [viewing, setViewing] = useState<{
    url: string;
    contentType: string | null;
  } | null>(null);

  // `listForTransaction` throws FORBIDDEN for a caller who may not even file
  // here; `useQuery` surfaces that as undefined, same as "still loading". Both
  // cases render nothing rather than an error state — there is no useful
  // action for that caller either way.
  if (hasReceipt || rows === undefined) return null;

  const pending = rows.find((r) => r.status === "pending") ?? null;
  const approved = rows.find((r) => r.status === "approved") ?? null;
  const history = rows.filter((r) => r.status !== "pending");

  async function run(fn: () => Promise<unknown>) {
    setSubmitting(true);
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View>
      <View className="mb-1.5 flex-row items-center justify-between">
        <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
          Receipt exception
        </Text>
        {!readOnly && !pending && !approved ? (
          <Pressable
            onPress={() => setFiling(true)}
            accessibilityRole="button"
            className="active:opacity-70"
          >
            <Text className="text-xs font-medium text-accent">
              No receipt exists?
            </Text>
          </Pressable>
        ) : null}
      </View>

      {rows.length === 0 ? (
        <Text className="text-xs text-muted">
          None filed. If a receipt exists, attach it — an exception is only for
          spend where one never existed or can&apos;t be obtained.
        </Text>
      ) : null}

      <View className="gap-2">
        {rows.map((row) => (
          <View
            key={row._id}
            className="rounded-lg border border-border bg-sunken px-3 py-2.5"
          >
            <View className="mb-1 flex-row items-center gap-2">
              <Badge
                label={
                  row.status === "pending"
                    ? "Awaiting approval"
                    : row.status === "approved"
                      ? "Approved"
                      : row.status === "rejected"
                        ? "Rejected"
                        : "Withdrawn"
                }
                tone={STATUS_TONE[row.status] ?? "neutral"}
              />
              <Text className="text-xs font-medium text-ink">
                {row.reasonLabel}
              </Text>
            </View>
            <Text className="text-xs text-ink">{row.note}</Text>
            <Text className="mt-1 text-2xs text-muted">
              Attested by {row.attestedByName ?? "someone no longer on the roster"} ·{" "}
              {when(row.attestedAt)}
              {row.decidedAt != null
                ? ` · decided by ${row.decidedByName ?? "—"} · ${when(row.decidedAt)}`
                : ""}
            </Text>
            {row.decisionNote ? (
              <Text className="mt-1 text-2xs italic text-muted">
                “{row.decisionNote}”
              </Text>
            ) : null}

            {/* WHAT THEY SAID THEY TRIED. The whole point of the staged
                questions: an approver should be able to read this row and
                understand the situation without asking anyone.

                Worded as ATTESTED, deliberately and everywhere. Nothing here
                was verified — a person can answer yes and be wrong — and copy
                that implied otherwise would turn a useful record into a false
                one. Absent on rows filed before this existed, which read as
                nothing recorded rather than as unanswered questions. */}
            {row.attestations.length > 0 ? (
              <View className="mt-2 rounded-md border border-border bg-sunken px-2.5 py-2">
                <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Attested by the filer — not verified
                </Text>
                {row.attestations.map((a) => (
                  <View key={a.key} className="flex-row items-start gap-1.5">
                    <Icon
                      name={a.answer ? "check" : "x"}
                      size={11}
                      color={a.answer ? colors.success : colors.muted}
                    />
                    <Text className="flex-1 text-2xs text-muted">
                      {a.prompt}{" "}
                      <Text className="font-semibold text-ink">
                        {a.answer ? "Yes" : "No"}
                      </Text>
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {row.evidence.length > 0 ? (
              <View className="mt-2">
                <View className="mb-1 flex-row items-center gap-1.5">
                  <Icon name="paperclip" size={11} color={colors.muted} />
                  <Text className="text-2xs text-muted">
                    Proof of purchase ({row.evidence.length}) — evidence,
                    not a receipt
                  </Text>
                </View>
                <View className="flex-row flex-wrap gap-2">
                  {row.evidence.map((file, i) => (
                    <Pressable
                      key={file.url}
                      onPress={() => setViewing(file)}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={`Evidence ${i + 1}`}
                      className="active:opacity-70"
                    >
                      <View className="h-14 w-14 overflow-hidden rounded-md border border-border bg-sunken">
                        <FileThumbnail uri={file.url} contentType={file.contentType} />
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {!readOnly && row.status === "pending" ? (
              <View className="mt-2 flex-row gap-2">
                <Button
                  title="Approve"
                  onPress={() =>
                    void run(() => approve({ exceptionId: row._id }))
                  }
                  loading={submitting}
                />
                <Button
                  title="Reject"
                  variant="secondary"
                  onPress={() => {
                    setRejectingId(row._id);
                    setRejectNote("");
                  }}
                />
                <Button
                  title="Withdraw"
                  variant="secondary"
                  onPress={() =>
                    void run(() => withdraw({ exceptionId: row._id }))
                  }
                />
              </View>
            ) : null}

            {!readOnly && row.status === "approved" ? (
              <View className="mt-2">
                <Button
                  title="Withdraw"
                  variant="secondary"
                  onPress={() =>
                    void run(() => withdraw({ exceptionId: row._id }))
                  }
                />
              </View>
            ) : null}

            {rejectingId === row._id ? (
              <View className="mt-2 gap-2">
                <TextField
                  value={rejectNote}
                  onChangeText={setRejectNote}
                  placeholder="Why not? The filer needs to know what would make it approvable."
                  multiline
                  numberOfLines={2}
                  autoFocus
                />
                <View className="flex-row gap-2">
                  <Button
                    title="Confirm rejection"
                    onPress={() =>
                      void run(async () => {
                        await reject({
                          exceptionId: row._id,
                          decisionNote: rejectNote.trim(),
                        });
                        setRejectingId(null);
                      })
                    }
                    disabled={!rejectNote.trim()}
                    loading={submitting}
                  />
                  <Button
                    title="Cancel"
                    variant="secondary"
                    onPress={() => setRejectingId(null)}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </View>

      {history.length > 0 && !pending && !approved && !readOnly ? (
        <Pressable
          onPress={() => setFiling(true)}
          accessibilityRole="button"
          className="mt-2 self-start active:opacity-70"
        >
          <Text className="text-xs font-medium text-accent">
            File another exception
          </Text>
        </Pressable>
      ) : null}

      {filing ? (
        <ReceiptExceptionModal
          amountCents={amountCents}
          submitting={submitting}
          onCancel={() => setFiling(false)}
          onConfirm={({
            reason,
            note,
            evidenceStorageIds,
            attestations,
          }: {
            reason: ReceiptExceptionReason;
            note: string;
            evidenceStorageIds: Id<"_storage">[];
            attestations: ExceptionAttestation[];
          }) =>
            void run(async () => {
              await attest({
                transactionId,
                reason,
                note,
                ...(evidenceStorageIds.length ? { evidenceStorageIds } : {}),
                // See CodingDocumentation — dropping these makes a `lost`
                // exception permanently unfilable.
                ...(attestations.length ? { attestations } : {}),
              });
              setFiling(false);
            })
          }
        />
      ) : null}

      {viewing ? (
        <FileViewer
          uri={viewing.url}
          visible
          caption="Evidence of purchase — not a receipt"
          contentType={viewing.contentType}
          onClose={() => setViewing(null)}
        />
      ) : null}

      {approved ? (
        <Text className="mt-2 text-2xs text-muted">
          This stands in for a receipt: {formatCents(Math.abs(amountCents))} is
          documented by attestation, not by a document. Attach a receipt any
          time and it takes over.
        </Text>
      ) : null}
    </View>
  );
}
