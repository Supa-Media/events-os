/**
 * PAYMENT SCHEDULES on a contractor agreement — "half now, half on delivery".
 *
 * Founder, 2026-08-28: "there's an agreed upon amount and… different payments,
 * agreed payment dates or agreed payment milestones… so we can go to the same
 * place and be like, oh, we know we've paid this halfway, and then we can go
 * manually in there and pay the full thing."
 *
 * WHAT THIS FILE OWNS: writing a schedule, cancelling a tranche of one, and
 * reading one back. It does NOT own paying a tranche — that is the payout rail
 * (`contractorPayouts.ts`), because releasing money is the same act with the
 * same separation-of-duties rules whether or not the agreement pays in parts,
 * and giving schedules their own private way to move money would be exactly the
 * kind of second door this codebase keeps refusing to build.
 *
 * THE FOUR RULES, in the order they bite:
 *
 *  1. THE SCHEDULE SUMS TO THE AGREED TOTAL, exactly. Enforced by the shared
 *     `contractorScheduleProblems`, which the composer runs inline and this
 *     server runs again. A schedule summing to less quietly under-pays someone
 *     who signed for the full number; one summing to more sends money nobody
 *     agreed to.
 *
 *  2. CHANGING A SCHEDULE IS CHANGING THE TERMS. "Half now, half on delivery"
 *     versus "all of it at the end" is a materially different deal, so writing
 *     a schedule onto an agreement the contractor has already accepted voids
 *     that acceptance and re-asks — the identical mechanism, for the identical
 *     reason, as `contractorPayments.ts#updateTerms`. The alternative is a
 *     record claiming somebody agreed to a payment plan they never saw.
 *
 *  3. NOTHING PAYS ITSELF. A due date makes a tranche *due*; it never makes it
 *     paid. Every tranche is released by a human with approval rights, exactly
 *     as an unscheduled agreement is. See `CONTRACTOR_INSTALLMENT_TRIGGERS`.
 *
 *  4. MONEY ALREADY MOVING IS NOT EDITABLE. Once a tranche is `paying` or
 *     `paid`, the schedule it belongs to is frozen against rewrites — you may
 *     cancel a future tranche, which only ever reduces what the org sends, but
 *     you may not re-cut a plan whose money has started leaving.
 */
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CONTRACTOR_INSTALLMENT_TRIGGERS,
  CONTRACTOR_INSTALLMENT_LABEL_MAX,
  CONTRACTOR_MILESTONE_NOTE_MAX,
  CONTRACTOR_PAYMENT_STATUS_LABELS,
  MAX_CONTRACTOR_INSTALLMENTS,
  contractorInstallmentIsDue,
  contractorScheduleProblems,
  summarizeContractorSchedule,
  type ContractorInstallmentDraft,
  type ContractorPaymentStatus,
} from "@events-os/shared";
import { requireChapterId, requireInChapter } from "./lib/context";
import { resolveCallerPersonId } from "./lib/finance";
import {
  requireContractorPaymentsView,
  requireContractorPaymentsCompose,
  requireContractorPaymentsApprove,
} from "./lib/contractorPaymentsAccess";
import { loadSchedule } from "./lib/contractorSchedule";

/** The statuses a schedule may be WRITTEN in — the same set
 *  `contractorPayments.ts` lets the terms themselves be edited in, because a
 *  schedule is terms. Past `approved`, the plan is what was approved. */
export const SCHEDULE_EDITABLE_STATUSES: ContractorPaymentStatus[] = [
  "draft",
  "sent",
  "submitted",
  "changes_requested",
];

/** The validator for one proposed tranche, shared by both write paths' args. */
export const installmentDraftValidator = v.object({
  label: v.string(),
  amountCents: v.number(),
  trigger: v.union(
    ...CONTRACTOR_INSTALLMENT_TRIGGERS.map((t) => v.literal(t)),
  ),
  dueDate: v.optional(v.number()),
  milestoneNote: v.optional(v.string()),
});

function trimTo(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/**
 * Run the SHARED schedule rule and throw the first problem in the writer's own
 * words.
 *
 * The same function the composer calls to render its inline errors, so a
 * schedule the form warned about cannot be forced through by posting directly —
 * the pattern `assertPublicDescription` and `assertAmount` already establish on
 * this rail.
 */
function assertSchedule(
  drafts: readonly ContractorInstallmentDraft[],
  agreedAmountCents: number,
): void {
  const problems = contractorScheduleProblems(drafts, agreedAmountCents);
  if (problems.length > 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: problems[0] });
  }
}

/**
 * REPLACE AN AGREEMENT'S SCHEDULE — the one write, shared by both mutations
 * that can produce one.
 *
 * `setSchedule` uses it to change a plan on its own; `contractorPayments.ts#
 * updateTerms` uses it to change a plan AND the total it splits in the same
 * transaction. That second caller is the reason this is a function rather than
 * inline: the two constraints are circular from outside a transaction — the
 * schedule must sum to the agreed total, and the agreed total may not move
 * while a schedule pins it — so a client trying to do both in two calls has no
 * legal order to do them in. Inside one mutation there is no ordering problem
 * at all: the new schedule is checked against the new total, once.
 *
 * Returns the drafts as written, so a caller can say how many there are in its
 * audit note.
 */
export async function writeSchedule(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  payment: Doc<"contractorPayments">,
  installments: readonly ContractorInstallmentDraft[],
  agreedAmountCents: number,
): Promise<ContractorInstallmentDraft[]> {
  const existing = await loadSchedule(ctx, payment._id);
  // Rule 4, as defence in depth. No path reaches here with a paid tranche
  // TODAY — a scheduled agreement sits in `approved` between tranches, which
  // `SCHEDULE_EDITABLE_STATUSES` already excludes, and `requestChanges` refuses
  // to walk it back from there. The check stays because the thing protecting
  // the money is currently a status LIST: add one status to it and this becomes
  // the difference between a rejected edit and a silently rewritten plan behind
  // half a payment that already left.
  if (existing.some((i) => i.status === "paid" || i.status === "paying")) {
    throw new ConvexError({
      code: "SCHEDULE_LOCKED",
      message:
        "Part of this schedule has already been paid, so it can't be re-cut. Cancel the payments that haven't gone out instead.",
    });
  }

  const drafts: ContractorInstallmentDraft[] = installments.map((i) => ({
    label: trimTo(i.label, CONTRACTOR_INSTALLMENT_LABEL_MAX),
    amountCents: i.amountCents,
    trigger: i.trigger,
    dueDate: i.dueDate,
    milestoneNote: i.milestoneNote
      ? trimTo(i.milestoneNote, CONTRACTOR_MILESTONE_NOTE_MAX)
      : undefined,
  }));
  assertSchedule(drafts, agreedAmountCents);

  const now = Date.now();
  for (const old of existing) await ctx.db.delete(old._id);
  for (const [i, d] of drafts.entries()) {
    await ctx.db.insert("contractorPaymentInstallments", {
      chapterId,
      contractorPaymentId: payment._id,
      seq: i + 1,
      label: d.label,
      amountCents: d.amountCents,
      trigger: d.trigger,
      // Only the trigger that MEANS them keeps these. A date left on a
      // milestone tranche would render as a promise the agreement does not
      // make, and would make the row read as due when it isn't.
      ...(d.trigger === "on_date" && d.dueDate != null
        ? { dueDate: d.dueDate }
        : {}),
      ...(d.trigger === "on_milestone" && d.milestoneNote
        ? { milestoneNote: d.milestoneNote }
        : {}),
      status: "scheduled",
      createdAt: now,
      updatedAt: now,
    });
  }
  return drafts;
}

/**
 * Write (or replace) an agreement's payment schedule.
 *
 * REPLACE, NOT PATCH. The invariant is about the schedule as a WHOLE — the
 * tranches sum to the agreed total — so there is no coherent way to edit one
 * row in isolation: raising the deposit without lowering the balance produces a
 * plan that over-pays, and an API that permits the intermediate state has to
 * decide whether to store it. Handing the whole list every time makes the
 * invariant checkable at exactly the moment it is written, which is the only
 * moment it can be enforced.
 *
 * Passing an EMPTY list clears the schedule and returns the agreement to a
 * single payment of the agreed amount — the shape it had before schedules
 * existed, and a real thing a composer needs to be able to undo to.
 */
export const setSchedule = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    installments: v.array(installmentDraftValidator),
  },
  handler: async (ctx, { contractorPaymentId, installments }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsCompose(ctx, chapterId);
    const payment = row!;

    if (!SCHEDULE_EDITABLE_STATUSES.includes(payment.status)) {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: `Can't change the payment schedule of an agreement that's ${CONTRACTOR_PAYMENT_STATUS_LABELS[payment.status]}. Cancel a scheduled payment instead, or write a new agreement.`,
      });
    }

    const drafts = await writeSchedule(
      ctx,
      chapterId,
      payment,
      installments,
      payment.agreedAmountCents,
    );

    // Rule 2 — THE VOID. A payment plan is a term. Changing one after somebody
    // signed means they signed for a different deal, so the acceptance goes and
    // they are asked again. Identical to `updateTerms`, deliberately: two ways
    // to void an acceptance that behaved differently would be two ways to get
    // it wrong.
    const now = Date.now();
    const voidsAcceptance = payment.acceptedAt != null;
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    await ctx.db.patch(contractorPaymentId, {
      ...(voidsAcceptance
        ? {
            agreementTermsVersion: payment.agreementTermsVersion + 1,
            acceptedAt: undefined,
            acceptedTermsVersion: undefined,
            acceptedSignature: undefined,
            acceptedIp: undefined,
            status: "sent" as const,
            submittedAt: undefined,
          }
        : {}),
      updatedAt: now,
    });
    await ctx.db.insert("approvals", {
      chapterId,
      subjectType: "contractor_payment",
      subjectId: String(contractorPaymentId),
      action: "edit",
      actorPersonId: callerPersonId,
      note:
        drafts.length === 0
          ? "Payment schedule removed — pays as a single payment."
          : `Payment schedule set: ${drafts.length} payment${drafts.length === 1 ? "" : "s"}.${
              voidsAcceptance
                ? " Acceptance voided, contractor re-notified."
                : ""
            }`,
      createdAt: now,
    });
    if (voidsAcceptance && payment.payeeEmail) {
      await ctx.scheduler.runAfter(
        0,
        internal.contractorPayments.sendAgreementInvite,
        { contractorPaymentId },
      );
    }
    return { count: drafts.length, acceptanceVoided: voidsAcceptance };
  },
});

/**
 * Call off a tranche that will never be sent — the shoot was cut, the second
 * half was renegotiated, the deliverable changed.
 *
 * APPROVE RIGHTS, NOT COMPOSE. Cancelling only ever reduces what the org pays,
 * so it cannot be used to send money — but it decides that a contractor will
 * NOT receive something they were promised, which is a money decision and
 * belongs with the people who make those. It is also the one schedule change
 * that stays legal after approval, precisely because it cannot increase what
 * leaves.
 *
 * A reason is REQUIRED. The agreed total and the total actually paid now
 * disagree, permanently, and a record that cannot say why is a record that
 * looks like an underpayment nobody can account for.
 */
export const cancelInstallment = mutation({
  args: {
    installmentId: v.id("contractorPaymentInstallments"),
    reason: v.string(),
  },
  handler: async (ctx, { installmentId, reason }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const inst = await ctx.db.get(installmentId);
    await requireInChapter(ctx, chapterId, inst, "Scheduled payment");
    await requireContractorPaymentsApprove(ctx, chapterId);
    const row = inst!;

    const note = reason.trim();
    if (!note) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Say why this payment is being called off.",
      });
    }
    if (row.status !== "scheduled") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message:
          row.status === "canceled"
            ? "That payment is already canceled."
            : "That payment has already been sent — it can't be called off.",
      });
    }

    const now = Date.now();
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    await ctx.db.patch(installmentId, {
      status: "canceled",
      canceledAt: now,
      canceledByPersonId: callerPersonId,
      canceledReason: trimTo(note, CONTRACTOR_MILESTONE_NOTE_MAX),
      updatedAt: now,
    });
    await ctx.db.insert("approvals", {
      chapterId,
      subjectType: "contractor_payment",
      subjectId: String(row.contractorPaymentId),
      action: "cancel",
      actorPersonId: callerPersonId,
      note: `Scheduled payment "${row.label}" canceled: ${note}`,
      createdAt: now,
    });

    // Cancelling the LAST open tranche finishes the agreement, and it has to be
    // said here rather than left to the payout rail: no money moves, so nothing
    // else will ever run to notice. Without this an agreement whose remaining
    // work was called off sits in `approved` forever, in a queue, looking like
    // it owes somebody money.
    await closeIfScheduleComplete(ctx, row.contractorPaymentId);
    return null;
  },
});

/**
 * Move a still-scheduled agreement to `paid` once every tranche has settled one
 * way or the other.
 *
 * THE ONLY PLACE A SCHEDULED AGREEMENT CLOSES WITHOUT MONEY MOVING (the settle
 * path in `lib/increasePayoutMachine.ts` owns the case where it does). Exported
 * because both callers need the identical test — an agreement that closes by
 * one rule when the last tranche is paid and another when the last one is
 * canceled would be two definitions of "finished".
 */
export async function closeIfScheduleComplete(
  ctx: MutationCtx,
  contractorPaymentId: Id<"contractorPayments">,
): Promise<boolean> {
  const rows = await loadSchedule(ctx, contractorPaymentId);
  if (rows.length === 0) return false;
  if (!rows.every((r) => r.status === "paid" || r.status === "canceled")) {
    return false;
  }
  const payment = await ctx.db.get(contractorPaymentId);
  if (!payment || payment.status === "paid") return false;
  // Every tranche canceled and none paid is a cancellation, not a payment. It
  // would be plainly wrong to stamp `paid` on an agreement under which the org
  // sent nothing at all.
  const anyPaid = rows.some((r) => r.status === "paid");
  const now = Date.now();
  await ctx.db.patch(contractorPaymentId, {
    status: anyPaid ? "paid" : "canceled",
    ...(anyPaid ? { paidAt: payment.paidAt ?? now } : {}),
    updatedAt: now,
  });
  return true;
}

/**
 * An agreement's schedule, with the totals every screen needs.
 *
 * Returns `scheduled: false` rather than an empty list for an agreement that
 * pays in one go, so a caller renders "one payment of $X" instead of an empty
 * table that reads as a schedule somebody forgot to fill in.
 */
export const listForPayment = query({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsView(ctx, chapterId);

    const rows = await loadSchedule(ctx, contractorPaymentId);
    const now = Date.now();
    return {
      scheduled: rows.length > 0,
      agreedAmountCents: row!.agreedAmountCents,
      maxInstallments: MAX_CONTRACTOR_INSTALLMENTS,
      summary: summarizeContractorSchedule(rows),
      installments: rows.map((i) => ({
        _id: i._id,
        seq: i.seq,
        label: i.label,
        amountCents: i.amountCents,
        trigger: i.trigger,
        dueDate: i.dueDate,
        milestoneNote: i.milestoneNote,
        status: i.status,
        paidAt: i.paidAt,
        releasedAt: i.releasedAt,
        releaseNote: i.releaseNote,
        canceledReason: i.canceledReason,
        // Derived, never stored: a date that has passed makes a tranche due,
        // and storing that would mean a cron writing rows to keep a clock
        // honest. `on_milestone` never answers true — a person decides that.
        due: contractorInstallmentIsDue(i, now),
      })),
    };
  },
});

/** The schedule rows for one agreement, for internal callers (the contractor's
 *  own public page projects from this shape). Kept as a plain helper rather
 *  than a query because its only callers already hold the row. */
export function projectSchedule(
  rows: readonly Doc<"contractorPaymentInstallments">[],
): Array<{
  seq: number;
  label: string;
  amountCents: number;
  trigger: Doc<"contractorPaymentInstallments">["trigger"];
  dueDate?: number;
  milestoneNote?: string;
  status: Doc<"contractorPaymentInstallments">["status"];
  paidAt?: number;
}> {
  return rows.map((i) => ({
    seq: i.seq,
    label: i.label,
    amountCents: i.amountCents,
    trigger: i.trigger,
    dueDate: i.dueDate,
    milestoneNote: i.milestoneNote,
    status: i.status,
    paidAt: i.paidAt,
  }));
}
