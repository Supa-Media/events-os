/**
 * FINANCES · REIMBURSEMENTS · Revise — the in-app claimant's answer to a
 * send-back, and the twin of the revise form the accountless public token page
 * renders (`apps/convex/lib/reimbursePage.ts`).
 *
 * A reviewer who sends a request back (`requestChanges`) leaves a REQUIRED
 * note; this card shows it, re-opens each line's substantiation for editing,
 * and resubmits through `resubmitMyReimbursement`, which puts the request back
 * in front of the reviewer with the note cleared.
 *
 * WHY only the substantiation is editable: a send-back says "this record
 * doesn't yet justify the money" — the claimant answers by rewriting the
 * coding, or by replacing a receipt. Amounts and lines deliberately can't move
 * (the server refuses too): a resubmission must never silently change what's
 * being claimed under a reviewer who already saw a number. A wrong amount is a
 * rejection and a fresh request.
 *
 * Failures surface INLINE rather than through `useActionRunner` — this card
 * renders inside a member screen with no toast host, and the server's message
 * ("Snacks — a meal for 15 or fewer people needs every attendee named…") is
 * exactly what the claimant needs to read next to the field it's about.
 */
import { useState } from "react";
import { View, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  formatCents,
} from "@events-os/shared";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { errorMessage } from "../../../lib/errors";
import {
  CodingFields,
  codingArgs,
  codingFromLine,
  codingProblems,
  type LineCoding,
} from "./CodingFields";

/** One line of a sent-back request, as `myReimbursements` returns it. */
export type RevisableLine = {
  _id: Id<"reimbursementLineItems">;
  description: string;
  amountCents: number;
  hasReceipt: boolean;
  expenseType?: string | null;
  businessPurpose?: string | null;
  travelFrom?: string | null;
  travelTo?: string | null;
  headcount?: number | null;
  attendees?: { name: string; affiliation: string }[] | null;
  groupDescription?: string | null;
};

/** The request itself. Declared structurally (not derived from the generated
 *  return type) so this keeps compiling while `convex dev` catches up with the
 *  new query fields — the same lag `RequestCard.tsx` documents. */
export type RevisableRequest = {
  _id: Id<"reimbursementRequests">;
  reference: string;
  totalCents: number;
  reviewNote?: string | null;
  namesMaxHeadcount?: number;
  lines?: RevisableLine[];
};

export function ReviseForm({
  request,
  minPurposeLength,
}: {
  request: RevisableRequest;
  minPurposeLength: number;
}) {
  const resubmit = useMutation(api.reimbursements.resubmitMyReimbursement);
  const lines = request.lines ?? [];
  const namesMaxHeadcount =
    request.namesMaxHeadcount ?? DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT;

  // Seeded from what's on record — the claimant edits their OWN answers, and
  // nothing is pre-filled by anyone (or anything) else: substantiation is
  // human-authored end to end (owner decision, 2026-08-08).
  const [codings, setCodings] = useState<Record<string, LineCoding>>(() =>
    Object.fromEntries(lines.map((l) => [String(l._id), codingFromLine(l)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // FINDING 3 (UX audit, 2026-08-12): the card used to just vanish on success
  // ("the list re-queries and this card disappears with the status") — which
  // reads as nothing happened until the re-query lands, especially on a slow
  // connection. This is a TRANSIENT local flag painted for the moment between
  // "resubmit resolved" and "the query catches up and removes this card
  // entirely" — it doesn't fight the re-query above, it just makes the gap
  // before it unmistakable instead of silent.
  const [justResubmitted, setJustResubmitted] = useState(false);

  const codingFor = (line: RevisableLine): LineCoding =>
    codings[String(line._id)] ?? codingFromLine(line);

  async function handleResubmit() {
    setError(null);
    // The SHARED rules, checked before the round-trip — the server throws the
    // first of this same list, so the two can't disagree.
    for (const line of lines) {
      const problems = codingProblems(codingFor(line), namesMaxHeadcount);
      if (problems.length > 0) {
        setError(`${line.description} — ${problems[0].message}`);
        return;
      }
    }
    setBusy(true);
    try {
      await resubmit({
        reimbursementId: request._id,
        // `resubmitMyReimbursement`'s per-line shape is substantiation-only
        // (`reviseLineValidator` — no `categoryId`; category isn't part of
        // what a send-back is asking to fix, same posture as amounts/lines
        // being frozen on a revision), so `categoryId` is dropped here even
        // though `codingArgs` now returns one for the OTHER two hosts.
        lines: lines.map((l) => {
          const { categoryId: _categoryId, ...coding } = codingArgs(codingFor(l));
          return { lineId: l._id, ...coding };
        }),
      });
      // On success the list re-queries and this card disappears with the
      // status — no local "done" flag to drift out of sync with the server.
      // `justResubmitted` (below) only covers the moment before that happens.
      setJustResubmitted(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (justResubmitted) {
    return (
      <View className="mb-3.5 flex-row items-center gap-2 rounded-lg border border-success/40 bg-success-bg p-4 shadow-card">
        <Icon name="check-circle" size={18} color={colors.success} />
        <Text className="text-sm font-semibold text-success">
          Resubmitted for review ✓
        </Text>
      </View>
    );
  }

  return (
    <View className="mb-3.5 rounded-lg border border-warn bg-raised p-4 shadow-card">
      <View className="flex-row flex-wrap items-center gap-2">
        <Icon name="corner-up-left" size={16} color={colors.warn} />
        <Text className="flex-1 text-base font-semibold text-ink">
          {request.reference} — a reviewer needs one fix
        </Text>
        <Text className="text-base font-bold text-ink">
          {formatCents(request.totalCents)}
        </Text>
      </View>
      <Text className="mt-1 text-xs text-muted">
        This isn't a rejection and nothing is lost. Fix what's noted, then send
        it back for review.
      </Text>
      {request.reviewNote ? (
        <View className="mt-2 rounded-md bg-warn-bg px-3 py-2">
          <Text className="text-2xs font-bold uppercase tracking-wider text-warn">
            What to fix
          </Text>
          <Text className="mt-0.5 text-xs text-warn">{request.reviewNote}</Text>
        </View>
      ) : null}

      {lines.map((line) => (
        <View
          key={line._id}
          className="mt-3 rounded-md border border-border bg-sunken p-3"
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-sm font-medium text-ink">
              {line.description}
            </Text>
            <Text className="text-sm font-semibold text-ink">
              {formatCents(line.amountCents)}
            </Text>
          </View>
          <CodingFields
            value={codingFor(line)}
            namesMaxHeadcount={namesMaxHeadcount}
            minPurposeLength={minPurposeLength}
            onChange={(patch) =>
              setCodings((prev) => ({
                ...prev,
                [String(line._id)]: { ...codingFor(line), ...patch },
              }))
            }
          />
        </View>
      ))}

      {error ? (
        <View className="mt-3 rounded-md bg-danger-bg px-3 py-2.5">
          <Text className="text-xs text-danger">{error}</Text>
        </View>
      ) : null}

      <View className="mt-3 flex-row justify-end">
        <Button
          title="Update and resubmit"
          size="sm"
          icon="send"
          loading={busy}
          onPress={() => void handleResubmit()}
        />
      </View>
    </View>
  );
}
