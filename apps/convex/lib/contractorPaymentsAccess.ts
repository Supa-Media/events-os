/**
 * CONTRACTOR PAYMENTS authorization — who may promise someone money, who may
 * approve it, and who may open the tax form with their SSN on it.
 *
 * Its own resolver rather than an inline finance-ladder check, per CLAUDE.md's
 * standing rule: the day this needs restricting is the day somebody sends a
 * contractor agreement they shouldn't have, and "we'll add permissions later"
 * turns a one-file change into a change at every call site. The bodies below
 * are today's finance ladder; the graduation names are reserved in each
 * function's doc so the eventual PR doesn't invent them under pressure.
 *
 * FOUR RUNGS, because they genuinely diverge:
 *
 *  - `requireContractorPaymentsView` — read the queue. Viewer floor, matching
 *    every other manager-facing finance read.
 *  - `requireContractorPaymentsCompose` — write terms and SEND a link. This one
 *    leaves the building: it puts a document in a stranger's inbox that says
 *    the org will pay them a specific amount for specific work. Manager.
 *  - `requireContractorPaymentsApprove` — release the money. Manager, PLUS a
 *    separation-of-duties check the caller must run separately (see
 *    `assertContractorApprovalSoD` in `contractorPayments.ts`) — a rank test
 *    answers "may this person approve payments", never "may this person
 *    approve THIS payment".
 *  - `requireContractorTaxDocView` — open the W-9 itself.
 *
 * Refusals throw `ConvexError({ code, message })` rather than degrading, same
 * as `repaymentsAccess.ts`: these guard a manager surface a member never
 * reaches by accident, so a permission wall is the honest answer and the app's
 * `FinanceBoundary` already renders it.
 */
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { getFinanceRole, requireFinanceRole } from "./finance";

/**
 * May the caller see the chapter's contractor payments — the queue, the terms,
 * the amounts, and who was paid?
 *
 * TODAY: viewer rank, the floor every manager-facing finance read uses.
 * Graduates to `finance.contractors.view`.
 */
export async function requireContractorPaymentsView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "viewer");
}

/** Non-throwing form, for deciding whether to OFFER an affordance. */
export async function hasContractorPaymentsCompose(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller draft terms and send a contractor a link?
 *
 * TODAY: finance manager (or central reach). A rung above viewing for the same
 * reason `requireRepaymentsCollect` is: this is the act that reaches a person
 * outside the org with a number attached, and "who can read the contractor
 * list" and "who can commit the org to paying someone" are not one question.
 * Graduates to `finance.contractors.compose`.
 */
export async function requireContractorPaymentsCompose(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}

/** Non-throwing form, for deciding whether to OFFER approve/reject controls. */
export async function hasContractorPaymentsApprove(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller approve a contractor payment — the decision that releases an
 * ACH?
 *
 * TODAY: finance manager (or central reach), which in the chapter chart is the
 * treasurer and the central FM. Deliberately the SAME rank as compose rather
 * than a higher one: the thing that keeps the composer from approving their own
 * agreement is separation of duties, not rank, and a rank gate here would give
 * a false sense that the SoD check is optional. It is not — every call site
 * pairs this with `assertContractorApprovalSoD`.
 *
 * Graduates to `finance.contractors.approve`, at which point the natural move
 * is to grant compose and approve to DIFFERENT seats and let the seat chart be
 * the honest answer to "who are the two parties?"
 */
export async function requireContractorPaymentsApprove(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}

/** Non-throwing form — lets a detail screen decide whether to render a "View
 *  W-9" control or the metadata-only line, without provoking a throw. */
export async function hasContractorTaxDocView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller open a contractor's actual tax document?
 *
 * This is the most sensitive read in the application. The file is a W-9 or W-8
 * with a Social Security or Employer Identification Number printed on it, and
 * `storage.getUrl` is gated only by `requireUserId` — so the storage id is the
 * whole ballgame and this resolver is what stands between a member account and
 * somebody's SSN.
 *
 * TODAY: finance manager or central reach — the chapter's treasurer and finance
 * managers alongside central (founder decision, 2026-08-14: the people who
 * approve the payment can also see the form, rather than routing every
 * "which year is this W-9?" question through central).
 *
 * Note this is a DELIBERATE widening over the tightest option, and it is the
 * reason `contractorPayments.viewTaxDocument` writes a `financeAuditLog` row on
 * every single view: when the gate is a role rather than a named individual,
 * the log is what makes the access answerable after the fact.
 *
 * Graduates to `finance.contractors.tax_docs` — and when it does, it should be
 * granted to specific seats rather than inherited from the finance ladder,
 * because "can approve a payment" and "can read a tax identification number"
 * are the clearest example in this codebase of two powers that only look alike.
 */
export async function requireContractorTaxDocView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}

// ── The contractor roster (who we have paid before) ─────────────────────────
/** Non-throwing form, for deciding whether to OFFER the "pick a contractor"
 *  affordance on the composer. */
export async function hasContractorRosterView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller browse the chapter's contractor roster — everyone it has paid
 * before, with what is on file for each?
 *
 * A RUNG ABOVE the payment queue's viewer floor, deliberately. The queue is a
 * list of transactions; this is a durable list of PEOPLE we pay, each row one
 * step from a tax document, and it is the object a curious member would most
 * like to browse and least need to. Graduates to
 * `finance.contractors.roster.view`.
 *
 * NOTE what this does NOT imply: roster access is not tax-document access.
 * `requireContractorTaxDocView` is unchanged and still gates the file itself —
 * making it easier to find a contractor must not make it easier to open their
 * W-9.
 */
export async function requireContractorRosterView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}

/** Non-throwing form, for deciding whether to OFFER roster editing. */
export async function hasContractorRosterManage(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller create or edit a contractor profile — save someone as a
 * returning contractor, correct their business name, record how they're
 * organised?
 *
 * Same rank as compose today: someone who can commit the org to paying a
 * contractor can also record who that contractor is. Graduates to
 * `finance.contractors.roster.manage`.
 */
export async function requireContractorRosterManage(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}

/** Non-throwing form, for deciding whether to OFFER the forget control. Kept
 *  SEPARATE from the manage check even though both bodies are the finance
 *  ladder today: the two graduate to different powers, and a screen that gates
 *  "forget" on "can manage" would start offering a button the server refuses
 *  the moment they diverge. */
export async function hasContractorForget(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller FORGET a contractor — destroy the remembered bank reference
 * and tax document ahead of the retention clock?
 *
 * Its own power because it is the one irreversible thing on this surface, and
 * because it is the request a contractor is entitled to make ("stop keeping my
 * details"). Held at the same rank today; graduates to
 * `finance.contractors.forget`, at which point it belongs to a NARROWER set
 * than roster management — deleting evidence and tidying a roster are not the
 * same act.
 *
 * It deliberately CANNOT destroy a document still inside the retention window
 * of a payment that actually paid out — see `contractorProfiles.forget`. A
 * power to delete records the org is required to keep is not one this resolver
 * should be able to grant.
 */
export async function requireContractorForget(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}
