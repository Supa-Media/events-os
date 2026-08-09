/**
 * CodingDocumentation — the receipt half of a coding, wherever coding happens.
 *
 * OWNER DECISION, 2026-08-08: "they should just upload the receipt when
 * coding." Documentation stopped being a separate errand — `submitCoding`
 * refuses a coding on a charge that can't prove itself
 * (`DOCUMENTATION_REQUIRED`), so the receipt has to be reachable from INSIDE
 * the editor. A person must never fill in three fields and only then be told
 * no.
 *
 * So this block is mounted in two places at once and is the same code in both:
 * on `FinishChargeSheet` (the cardholder's desk) and inside
 * `TransactionCodingModal` itself (both hosts — the cardholder's sheet and the
 * reviewer's Reconcile panel, since a bookkeeper coding on someone's behalf
 * hits the identical gate).
 *
 * Three ways out, all without leaving the editor:
 *  1. CONFIRM A SUGGESTION. Emailed/texted receipts land in the person's
 *     library unlinked; the ones that look like this charge are offered here
 *     and one tap attaches. See `receiptSuggestions.ts` — and note that
 *     suggesting a DOCUMENT is not the AI the coding flow forbids: nothing
 *     here writes a word of the substantiation record.
 *  2. UPLOAD — the identical `ReceiptCell` the Reconcile grid uses, so
 *     attaching a receipt behaves the same everywhere.
 *  3. SAY THERE ISN'T ONE — the existing `ReceiptExceptionModal`, verbatim.
 *     Filing it (even unapproved) satisfies the gate, deliberately: the gate
 *     asks whether the AUTHOR finished their half.
 *
 * WHAT IT NEVER GUESSES: `hasDocumentation` is the server's own answer, and
 * `hasDocumentation === false` implies "no receipt and no standing exception"
 * with certainty — which is why the action paths need nothing else from the
 * host. The richer settled wording ("attached", "exception approved") needs
 * facts only the cardholder's row carries, so it's an optional `detail` prop
 * and its absence just makes the sentence more general, never wrong.
 */
import { useMemo, useState } from "react";
import { Image, Linking, Pressable, Text, View } from "react-native";
import {
  useMutation,
  useQueries,
  type RequestForQueries,
} from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { ReceiptExceptionReason } from "@events-os/shared";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { ReceiptCell } from "../reconcile/ReconcileList";
import { ReceiptExceptionModal } from "../modals/ReceiptExceptionModal";
import {
  CONFIRM_SUGGESTION_MUTATION,
  SUGGESTED_RECEIPTS_QUERY,
  adaptReceiptSuggestions,
  looksLikeDocument,
  suggestionMeta,
  suggestionTitle,
  suggestionWarning,
  type SuggestedReceipt,
} from "./receiptSuggestions";

/** The one sentence this rule is: said the same way in the sheet and in the
 *  editor, because they are the same requirement. */
export const DOCUMENTATION_RULE =
  "A receipt goes in with the coding — what the money was for and how it can be proved are one record, not two errands. No receipt at all? Say so here and that counts.";

export interface DocumentationDetail {
  hasReceipt: boolean;
  hasApprovedException: boolean;
  /** Reason label of an approved exception, when the host read one. */
  approvedReasonLabel?: string | null;
  /** Reason label of a filed-but-undecided exception. */
  pendingReasonLabel?: string | null;
  reminderStage?: "none" | "flagged" | "escalated";
}

export function CodingDocumentation({
  transactionId,
  amountCents,
  hasDocumentation,
  detail,
  runAction,
  busy,
}: {
  transactionId: Id<"transactions">;
  amountCents: number;
  /** `getForTransaction().hasDocumentation` — the same fact the submit gate
   *  reads, so this block and the server can never disagree. */
  hasDocumentation: boolean;
  /** What documents it, when the host knows. Omit and the settled state stays
   *  general rather than claiming a receipt that might be an exception. */
  detail?: DocumentationDetail | null;
  /** The host's own error/toast plumbing — the sheet's `guard`, the reconcile
   *  panel's `run`. One prop instead of this component owning a toast that
   *  would render in the wrong place in one of the two hosts. */
  runAction: (fn: () => Promise<unknown>, errorTitle: string) => Promise<unknown>;
  busy?: boolean;
}) {
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const attestException = useMutation(api.receiptExceptions.attest);
  const confirmSuggestion = useMutation(CONFIRM_SUGGESTION_MUTATION);

  const [filing, setFiling] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Read through `useQueries`, not `useQuery`: it RETURNS a failure instead of
  // throwing it during render, so a refused or unavailable suggestions query
  // degrades to "no suggestions" instead of taking the sheet down with it
  // (see `receiptSuggestions.ts`). Memoized because `useQueries`
  // re-subscribes on object identity.
  const request = useMemo<RequestForQueries>(() => {
    const req: RequestForQueries = {};
    // Nothing to suggest once the charge is documented — don't ask.
    if (!hasDocumentation) {
      req.suggested = {
        query: SUGGESTED_RECEIPTS_QUERY,
        args: { transactionId },
      };
    }
    return req;
  }, [hasDocumentation, transactionId]);
  const results = useQueries(request);
  const suggestions = adaptReceiptSuggestions(results.suggested);

  if (hasDocumentation) {
    const line = settledLine(detail);
    return (
      <View>
        <View className="flex-row items-start gap-2">
          <Icon name="check-circle" size={13} color={colors.success} />
          <Text className="flex-1 text-2xs text-muted">{line}</Text>
        </View>
        {detail ? (
          <View className="mt-2 flex-row items-center gap-3">
            <ReceiptCell
              hasReceipt={detail.hasReceipt}
              reminderStage={detail.reminderStage ?? "none"}
              transactionId={transactionId}
              libraryPicker={false}
              onUpload={async (storageId: Id<"_storage">) => {
                await runAction(
                  () => attachReceipt({ transactionId, storageId }),
                  "Couldn't attach receipt",
                );
              }}
              generateUploadUrl={generateUploadUrl}
            />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      <Text className="text-2xs text-muted">{DOCUMENTATION_RULE}</Text>

      {/* IS THIS THE ONE? Inbound receipts are never auto-attached to a
          guessed charge — a wrong guess is worse than no guess, because
          nobody re-checks a charge that already looks documented. So the
          person who was there confirms, in one tap. */}
      {suggestions.length > 0 ? (
        <View className="mt-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
          <Text className="text-2xs font-semibold uppercase tracking-wide text-accent">
            Is this the one?
          </Text>
          <Text className="mt-0.5 text-2xs text-muted">
            {suggestions.length === 1 ? "A receipt" : "Receipts"} you emailed or
            texted in that could belong to this charge. Nothing was attached for
            you — you say which.
          </Text>
          <View className="mt-2 gap-2">
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.receiptId}
                suggestion={s}
                chargeCents={amountCents}
                busy={confirmingId === s.receiptId}
                disabled={busy === true || confirmingId != null}
                onConfirm={() => {
                  setConfirmingId(s.receiptId);
                  void (async () => {
                    await runAction(
                      () =>
                        confirmSuggestion({
                          receiptId: s.receiptId,
                          transactionId,
                        }),
                      "Couldn't attach that receipt",
                    );
                    setConfirmingId(null);
                  })();
                }}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View className="mt-2 flex-row items-center gap-3">
        <ReceiptCell
          hasReceipt={false}
          reminderStage={detail?.reminderStage ?? "none"}
          transactionId={transactionId}
              libraryPicker={false}
          onUpload={async (storageId: Id<"_storage">) => {
            await runAction(
              () => attachReceipt({ transactionId, storageId }),
              "Couldn't attach receipt",
            );
          }}
          generateUploadUrl={generateUploadUrl}
        />
      </View>

      <Pressable
        onPress={() => setFiling(true)}
        accessibilityRole="button"
        className="mt-1 self-start active:opacity-70"
      >
        <Text className="text-xs font-medium text-accent">
          There is no receipt for this
        </Text>
      </Pressable>

      {filing ? (
        <ReceiptExceptionModal
          amountCents={amountCents}
          submitting={busy}
          onCancel={() => setFiling(false)}
          onConfirm={({
            reason,
            note,
            evidenceStorageIds,
          }: {
            reason: ReceiptExceptionReason;
            note: string;
            evidenceStorageIds: Id<"_storage">[];
          }) =>
            void (async () => {
              await runAction(async () => {
                await attestException({
                  transactionId,
                  reason,
                  note,
                  ...(evidenceStorageIds.length ? { evidenceStorageIds } : {}),
                });
                setFiling(false);
              }, "Couldn't file that exception");
            })()
          }
        />
      ) : null}
    </View>
  );
}

/** What documents this charge, in as much detail as the host actually knows.
 *  Never claims a receipt it wasn't told about. */
function settledLine(detail?: DocumentationDetail | null): string {
  if (!detail) {
    return "Documented — a receipt or a filed reason is on the record, so this coding can be submitted.";
  }
  if (detail.hasReceipt) {
    return "Receipt attached. Attach a different one any time and it takes over.";
  }
  if (detail.hasApprovedException) {
    return `Documented by an approved exception${
      detail.approvedReasonLabel
        ? ` — ${detail.approvedReasonLabel.toLowerCase()}`
        : ""
    }. Attach a receipt any time and it takes over.`;
  }
  return `Exception filed${
    detail.pendingReasonLabel ? ` (${detail.pendingReasonLabel.toLowerCase()})` : ""
  } — enough to submit this coding, but a Finance manager still has to approve it before the charge can be reconciled.`;
}

function SuggestionRow({
  suggestion,
  chargeCents,
  busy,
  disabled,
  onConfirm,
}: {
  suggestion: SuggestedReceipt;
  chargeCents: number;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const warning = suggestionWarning(suggestion, chargeCents);
  return (
    <View className="rounded-lg border border-border bg-raised px-2.5 py-2">
      <View className="flex-row items-center gap-2.5">
        <Thumb
          url={looksLikeDocument(suggestion) ? null : suggestion.url}
          onOpen={suggestion.url}
        />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            {suggestionTitle(suggestion)}
          </Text>
          <Text className="text-2xs text-muted" numberOfLines={1}>
            {suggestionMeta(suggestion)}
          </Text>
        </View>
        <Button
          title="That's the one"
          size="sm"
          onPress={onConfirm}
          loading={busy}
          disabled={disabled}
        />
      </View>
      {warning ? (
        <View className="mt-1.5 flex-row items-start gap-2 rounded-md border border-warn/40 bg-warn-bg px-2.5 py-1.5">
          <Icon name="alert-triangle" size={12} color={colors.warn} />
          <Text className="flex-1 text-2xs text-ink">{warning}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** 48px thumbnail with a fail-to-icon fallback — the same idea (and size) as
 *  `ReceiptAttachPicker`'s own `Thumb`, which is not exported. Tapping it
 *  opens the file, so "is this the one?" can be answered by LOOKING when the
 *  merchant line isn't enough. */
function Thumb({ url, onOpen }: { url: string | null; onOpen: string | null }) {
  const [failed, setFailed] = useState(false);
  const body =
    url && !failed ? (
      <Image
        source={{ uri: url }}
        style={{ width: "100%", height: "100%" }}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    ) : (
      <Icon name="file" size={16} color={colors.faint} />
    );
  const box = (
    <View className="h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-border bg-sunken">
      {body}
    </View>
  );
  if (!onOpen) return box;
  return (
    <Pressable
      // `Linking.openURL` is the precedent for opening a receipt file outside
      // the app (`ReceiptViewerModal`'s own non-previewable fallback).
      onPress={() => void Linking.openURL(onOpen)}
      accessibilityRole="button"
      accessibilityLabel="Open this receipt"
      className="active:opacity-70"
    >
      {box}
    </Pressable>
  );
}
